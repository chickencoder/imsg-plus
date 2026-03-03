import { createInterface } from "node:readline"
import type { DB } from "./db.js"
import type { Bridge } from "./bridge.js"
import type { ChatInfo } from "./types.js"
import { messageToJSON, isGroupChat } from "./json.js"
import { watch } from "./watch.js"
import { send, react, type TapbackType } from "./send.js"

interface RPCOptions {
  verbose?: boolean
  autoRead?: boolean
  autoTyping?: boolean
}

export async function serve(db: DB, bridge: Bridge, opts: RPCOptions = {}): Promise<void> {
  const autoRead = opts.autoRead ?? bridge.available
  const autoTyping = opts.autoTyping ?? bridge.available
  const verbose = opts.verbose ?? false

  // --- Caches ---

  const infoCache = new Map<number, ChatInfo | null>()
  const partCache = new Map<number, string[]>()

  function cachedInfo(id: number) {
    if (!infoCache.has(id)) infoCache.set(id, db.chatInfo(id))
    return infoCache.get(id)!
  }

  function cachedParticipants(id: number) {
    if (!partCache.has(id)) partCache.set(id, db.participants(id))
    return partCache.get(id)!
  }

  // --- Wire format ---

  function enrichMessage(msg: ReturnType<DB["messages"]>[number], attachments: ReturnType<DB["attachments"]> = []) {
    const info = cachedInfo(msg.chatId)
    const identifier = info?.identifier ?? ""
    const guid = info?.guid ?? ""
    return {
      ...messageToJSON(msg, attachments),
      chat_identifier: identifier,
      chat_guid: guid,
      chat_name: info?.name ?? "",
      participants: cachedParticipants(msg.chatId),
      is_group: isGroupChat(identifier, guid),
    }
  }

  function enrichChat(chat: { id: number; identifier: string; name: string; service: string; lastMessageAt: Date }) {
    const info = cachedInfo(chat.id)
    const identifier = info?.identifier ?? chat.identifier
    const guid = info?.guid ?? ""
    return {
      id: chat.id,
      identifier,
      guid,
      name: (info?.name && info.name !== info.identifier ? info.name : null) ?? chat.name,
      service: info?.service ?? chat.service,
      last_message_at: chat.lastMessageAt.toISOString(),
      participants: cachedParticipants(chat.id),
      is_group: isGroupChat(identifier, guid),
    }
  }

  // --- Auto-behaviors ---

  function autoMarkRead(msg: ReturnType<DB["messages"]>[number]) {
    if (!autoRead || !bridge.available || msg.isFromMe) return
    const handle = cachedInfo(msg.chatId)?.identifier ?? msg.sender
    if (!handle) return
    setTimeout(() => {
      bridge.markRead(handle).catch((err) => log(`[auto-read] error: ${err.message}`))
    }, 1000)
  }

  async function autoType(handle: string, textLength: number) {
    if (!autoTyping || !bridge.available || !handle) return
    try {
      await bridge.setTyping(handle, true)
      await new Promise((r) => setTimeout(r, Math.min(1.5 + (textLength / 80) * 2.5, 4) * 1000))
    } catch (err: any) {
      log(`[auto-typing] error: ${err.message}`)
    }
  }

  function autoTypeOff(handle: string) {
    if (!autoTyping || !bridge.available || !handle) return
    bridge.setTyping(handle, false).catch((err) => log(`[auto-typing] off: ${err.message}`))
  }

  // --- Subscriptions ---

  let nextSubId = 1
  const subs = new Map<number, AbortController>()

  function startSubscription(subId: number, ac: AbortController, watchOpts: Parameters<typeof watch>[1], includeAttachments: boolean) {
    ;(async () => {
      for await (const msg of watch(db, watchOpts)) {
        if (ac.signal.aborted) return
        notify("message", { subscription: subId, message: enrichMessage(msg, includeAttachments ? db.attachments(msg.id) : []) })
        autoMarkRead(msg)
      }
    })().catch((err) => {
      if (!ac.signal.aborted) notify("error", { subscription: subId, error: { message: err.message } })
    })
  }

  // --- I/O ---

  function respond(id: unknown, result: unknown) {
    if (id != null) emit({ jsonrpc: "2.0", id, result })
  }

  function error(id: unknown, code: number, message: string, data?: string) {
    emit({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } })
  }

  function notify(method: string, params: unknown) {
    emit({ jsonrpc: "2.0", method, params })
  }

  function emit(obj: unknown) {
    process.stdout.write(JSON.stringify(obj) + "\n")
  }

  function log(msg: string) {
    if (verbose) process.stderr.write(msg + "\n")
  }

  // --- Method map ---

  type P = Record<string, any>

  const methods: Record<string, (p: P) => unknown> = {
    "chats.list"(p) {
      return { chats: db.chats(Math.max(int(p.limit) ?? 20, 1)).map(enrichChat) }
    },

    "messages.history"(p) {
      const chatId = need(int(p.chat_id), "chat_id")
      const atts = bool(p.attachments) ?? false
      return {
        messages: db
          .messages(chatId, { limit: Math.max(int(p.limit) ?? 50, 1), filter: parseFilter(p) })
          .map((m) => enrichMessage(m, atts ? db.attachments(m.id) : [])),
      }
    },

    "watch.subscribe"(p) {
      const subId = nextSubId++
      const ac = new AbortController()
      subs.set(subId, ac)
      startSubscription(
        subId,
        ac,
        { chatId: int(p.chat_id) ?? undefined, sinceRowId: int(p.since_rowid) ?? undefined, filter: parseFilter(p) },
        bool(p.attachments) ?? false
      )
      return { subscription: subId }
    },

    "watch.unsubscribe"(p) {
      const subId = need(int(p.subscription), "subscription")
      subs.get(subId)?.abort()
      subs.delete(subId)
      return { ok: true }
    },

    async send(p) {
      const to = str(p.to)
      const text = str(p.text) ?? ""
      const handle = to || str(p.chat_identifier) || str(p.chat_guid) || ""

      await autoType(handle, text.length)
      await send(
        {
          to: to ?? undefined,
          chatId: int(p.chat_id) ?? undefined,
          chatIdentifier: str(p.chat_identifier) ?? undefined,
          chatGuid: str(p.chat_guid) ?? undefined,
          text,
          file: str(p.file) ?? undefined,
          service: (str(p.service) ?? "auto") as any,
          region: str(p.region) ?? undefined,
        },
        db
      )
      autoTypeOff(handle)
      return { ok: true }
    },

    async "messages.react"(p) {
      const to = need(str(p.to), "to")
      const guid = need(str(p.guid), "guid")
      const type = need(str(p.type), "type") as TapbackType
      const validTypes = ["love", "like", "dislike", "laugh", "emphasis", "question"]
      if (!validTypes.includes(type)) throw new InvalidParams(`type must be one of: ${validTypes.join(", ")}`)

      await react({ to, guid, type, service: (str(p.service) ?? "imessage") as any, region: str(p.region) ?? undefined })
      return { ok: true }
    },

    async "typing.set"(p) {
      const handle = need(str(p.handle), "handle")
      const state = need(str(p.state), "state")
      if (state !== "on" && state !== "off") throw new InvalidParams("state must be 'on' or 'off'")
      if (!bridge.available) throw new Error("IMCoreBridge not available")
      await bridge.setTyping(handle, state === "on")
      return { ok: true }
    },

    async "messages.markRead"(p) {
      const handle = need(str(p.handle), "handle")
      if (!bridge.available) throw new Error("IMCoreBridge not available")
      await bridge.markRead(handle)
      return { ok: true }
    },
  }

  // --- Main loop ---

  const rl = createInterface({ input: process.stdin, terminal: false })

  for await (const line of rl) {
    if (!line.trim()) continue

    let req: P
    try {
      req = JSON.parse(line)
    } catch {
      error(null, -32700, "Parse error")
      continue
    }

    if (!req?.method || typeof req.method !== "string") {
      error(req?.id, -32600, "Invalid Request")
      continue
    }

    const handler = methods[req.method]
    if (!handler) {
      error(req.id, -32601, "Method not found", req.method)
      continue
    }

    try {
      respond(req.id, await handler(req.params ?? {}))
    } catch (err: any) {
      const code = err instanceof InvalidParams ? -32602 : -32603
      error(req.id, code, err instanceof InvalidParams ? "Invalid params" : "Internal error", err.message)
    }
  }

  for (const ac of subs.values()) ac.abort()
}

// --- Helpers ---

class InvalidParams extends Error {}

function need<T>(value: T | null | undefined, name: string): NonNullable<T> {
  if (value == null) throw new InvalidParams(`${name} is required`)
  return value!
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  return null
}

function int(v: unknown): number | null {
  if (typeof v === "number") return Math.floor(v)
  if (typeof v === "string") {
    const n = parseInt(v, 10)
    return isNaN(n) ? null : n
  }
  return null
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return null
}

function parseFilter(p: Record<string, any>) {
  const participants = stringArray(p.participants)
  const after = p.start ? new Date(p.start) : undefined
  const before = p.end ? new Date(p.end) : undefined
  if (!participants.length && !after && !before) return undefined
  return { participants: participants.length ? participants : undefined, after, before }
}

function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean)
  return []
}
