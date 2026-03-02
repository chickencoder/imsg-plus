import { createInterface } from "node:readline"
import type { DB } from "./db.js"
import type { Bridge } from "./bridge.js"
import type { Message, ChatInfo, Attachment } from "./types.js"
import { watch } from "./watch.js"
import { send } from "./send.js"

interface RPCOptions {
  verbose?: boolean
  autoRead?: boolean
  autoTyping?: boolean
}

export async function serve(db: DB, bridge: Bridge, opts: RPCOptions = {}): Promise<void> {
  const autoRead = opts.autoRead ?? bridge.available
  const autoTyping = opts.autoTyping ?? bridge.available
  const verbose = opts.verbose ?? false

  // Chat info/participants cache
  const infoCache = new Map<number, ChatInfo | null>()
  const partCache = new Map<number, string[]>()

  function cachedInfo(chatId: number): ChatInfo | null {
    if (!infoCache.has(chatId)) infoCache.set(chatId, db.chatInfo(chatId))
    return infoCache.get(chatId)!
  }

  function cachedParticipants(chatId: number): string[] {
    if (!partCache.has(chatId)) partCache.set(chatId, db.participants(chatId))
    return partCache.get(chatId)!
  }

  // Subscriptions
  let nextSubId = 1
  const subs = new Map<number, AbortController>()

  // I/O
  function respond(id: unknown, result: unknown) {
    if (id == null) return
    write({ jsonrpc: "2.0", id, result })
  }

  function error(id: unknown, code: number, message: string, data?: string) {
    write({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } })
  }

  function notify(method: string, params: unknown) {
    write({ jsonrpc: "2.0", method, params })
  }

  function write(obj: unknown) {
    process.stdout.write(JSON.stringify(obj) + "\n")
  }

  function log(msg: string) {
    if (verbose) process.stderr.write(msg + "\n")
  }

  // Message payload builder
  function messagePayload(msg: Message, attachments: Attachment[] = []) {
    const info = cachedInfo(msg.chatId)
    const participants = cachedParticipants(msg.chatId)
    const identifier = info?.identifier ?? ""
    const guid = info?.guid ?? ""
    const isGroup = identifier.includes(";+;") || identifier.includes(";-;") || guid.includes(";+;")

    return {
      id: msg.id,
      chat_id: msg.chatId,
      guid: msg.guid,
      ...(msg.replyToGuid ? { reply_to_guid: msg.replyToGuid } : {}),
      sender: msg.sender,
      is_from_me: msg.isFromMe,
      text: msg.text,
      created_at: msg.date.toISOString(),
      attachments: attachments.map(attachmentPayload),
      chat_identifier: identifier,
      chat_guid: guid,
      chat_name: info?.name ?? "",
      participants,
      is_group: isGroup,
    }
  }

  function attachmentPayload(a: Attachment) {
    return {
      filename: a.filename,
      transfer_name: a.transferName,
      uti: a.uti,
      mime_type: a.mimeType,
      total_bytes: a.totalBytes,
      is_sticker: a.isSticker,
      original_path: a.path,
      missing: a.missing,
    }
  }

  function chatPayload(chat: { id: number; identifier: string; name: string; service: string; lastMessageAt: Date }) {
    const info = cachedInfo(chat.id)
    const participants = cachedParticipants(chat.id)
    const identifier = info?.identifier ?? chat.identifier
    const guid = info?.guid ?? ""
    const name = (info?.name && info.name !== info.identifier ? info.name : null) ?? chat.name
    const isGroup = identifier.includes(";+;") || guid.includes(";+;")

    return {
      id: chat.id,
      identifier,
      guid,
      name,
      service: info?.service ?? chat.service,
      last_message_at: chat.lastMessageAt.toISOString(),
      participants,
      is_group: isGroup,
    }
  }

  // --- Method handlers ---

  async function handle(req: Record<string, any>) {
    const id = req.id
    const method = req.method as string
    const params = (req.params ?? {}) as Record<string, any>

    switch (method) {
      case "chats.list": {
        const limit = Math.max(int(params.limit) ?? 20, 1)
        const chats = db.chats(limit).map(chatPayload)
        return respond(id, { chats })
      }

      case "messages.history": {
        const chatId = int(params.chat_id)
        if (chatId == null) throw new InvalidParams("chat_id is required")
        const limit = Math.max(int(params.limit) ?? 50, 1)
        const filter = parseFilter(params)
        const includeAttachments = bool(params.attachments) ?? false
        const messages = db.messages(chatId, { limit, filter }).map((m) =>
          messagePayload(m, includeAttachments ? db.attachments(m.id) : [])
        )
        return respond(id, { messages })
      }

      case "watch.subscribe": {
        const chatId = int(params.chat_id) ?? undefined
        const sinceRowId = int(params.since_rowid) ?? undefined
        const includeAttachments = bool(params.attachments) ?? false
        const filter = parseFilter(params)
        const subId = nextSubId++
        const ac = new AbortController()
        subs.set(subId, ac)

        // Run in background
        ;(async () => {
          try {
            for await (const msg of watch(db, { chatId, sinceRowId, filter })) {
              if (ac.signal.aborted) return
              const payload = messagePayload(msg, includeAttachments ? db.attachments(msg.id) : [])
              notify("message", { subscription: subId, message: payload })

              // Auto-read for incoming messages
              if (autoRead && bridge.available && !msg.isFromMe) {
                const handle = cachedInfo(msg.chatId)?.identifier ?? msg.sender
                if (handle) {
                  setTimeout(async () => {
                    try {
                      await bridge.markRead(handle)
                      log(`[auto-read] marked read for ${handle}`)
                    } catch (err: any) {
                      log(`[auto-read] error: ${err.message}`)
                    }
                  }, 1000)
                }
              }
            }
          } catch (err: any) {
            if (!ac.signal.aborted) {
              notify("error", { subscription: subId, error: { message: err.message } })
            }
          }
        })()

        return respond(id, { subscription: subId })
      }

      case "watch.unsubscribe": {
        const subId = int(params.subscription)
        if (subId == null) throw new InvalidParams("subscription is required")
        subs.get(subId)?.abort()
        subs.delete(subId)
        return respond(id, { ok: true })
      }

      case "send": {
        const to = str(params.to)
        const chatId = int(params.chat_id) ?? undefined
        const chatIdentifier = str(params.chat_identifier) ?? ""
        const chatGuid = str(params.chat_guid) ?? ""
        const text = str(params.text) ?? ""
        const file = str(params.file) ?? ""
        const service = (str(params.service) ?? "auto") as "imessage" | "sms" | "auto"
        const region = str(params.region) ?? "US"

        // Auto-typing before send
        if (autoTyping && bridge.available) {
          const handle = to || chatIdentifier || chatGuid
          if (handle) {
            try {
              await bridge.setTyping(handle, true)
              log(`[auto-typing] ON for ${handle}`)
              const delay = Math.min(1.5 + (text.length / 80) * 2.5, 4) * 1000
              await new Promise((r) => setTimeout(r, delay))
            } catch (err: any) {
              log(`[auto-typing] error: ${err.message}`)
            }
          }
        }

        await send({ to: to ?? undefined, chatId, chatIdentifier, chatGuid, text, file, service, region }, db)

        // Auto-typing off (fire and forget)
        if (autoTyping && bridge.available) {
          const handle = to || chatIdentifier || chatGuid
          if (handle) {
            bridge.setTyping(handle, false).catch((err) => log(`[auto-typing] off error: ${err.message}`))
          }
        }

        return respond(id, { ok: true })
      }

      case "typing.set": {
        const handle = str(params.handle)
        if (!handle) throw new InvalidParams("handle is required")
        const state = str(params.state)
        if (state !== "on" && state !== "off") throw new InvalidParams("state must be 'on' or 'off'")
        if (!bridge.available) throw new Error("IMCoreBridge not available")
        await bridge.setTyping(handle, state === "on")
        return respond(id, { ok: true })
      }

      case "messages.markRead": {
        const handle = str(params.handle)
        if (!handle) throw new InvalidParams("handle is required")
        if (!bridge.available) throw new Error("IMCoreBridge not available")
        await bridge.markRead(handle)
        return respond(id, { ok: true })
      }

      default:
        error(id, -32601, "Method not found", method)
    }
  }

  // --- Main loop ---

  const rl = createInterface({ input: process.stdin, terminal: false })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let req: Record<string, any>
    try {
      req = JSON.parse(trimmed)
    } catch {
      error(null, -32700, "Parse error")
      continue
    }

    if (typeof req !== "object" || req === null) {
      error(null, -32600, "Invalid Request", "request must be an object")
      continue
    }

    if (req.jsonrpc && req.jsonrpc !== "2.0") {
      error(req.id, -32600, "Invalid Request", "jsonrpc must be 2.0")
      continue
    }

    if (!req.method || typeof req.method !== "string") {
      error(req.id, -32600, "Invalid Request", "method is required")
      continue
    }

    try {
      await handle(req)
    } catch (err: any) {
      if (err instanceof InvalidParams) {
        error(req.id, -32602, "Invalid params", err.message)
      } else {
        error(req.id, -32603, "Internal error", err.message)
      }
    }
  }

  // Clean up subscriptions
  for (const ac of subs.values()) ac.abort()
}

// --- Helpers ---

class InvalidParams extends Error {}

function str(v: unknown): string | null {
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  return null
}

function int(v: unknown): number | null {
  if (typeof v === "number") return Math.floor(v)
  if (typeof v === "string") { const n = parseInt(v, 10); return isNaN(n) ? null : n }
  return null
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return null
}

function parseFilter(params: Record<string, any>) {
  const participants = stringArray(params.participants)
  const after = params.start ? new Date(params.start) : undefined
  const before = params.end ? new Date(params.end) : undefined
  if (!participants.length && !after && !before) return undefined
  return { participants: participants.length ? participants : undefined, after, before }
}

function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean)
  return []
}
