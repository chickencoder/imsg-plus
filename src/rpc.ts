import { createInterface } from "node:readline"
import type { DB } from "./db.js"
import type { Bridge } from "./bridge.js"
import type { Chat, Service } from "./types.js"
import { serializeMessage, serializeUndelivered } from "./json.js"
import { parseFilter } from "./filter.js"
import { watch } from "./watch.js"
import { send, react, type TapbackType } from "./send.js"
import { openQueue, type QueueDB } from "./queue.js"
import { runWorker } from "./worker.js"

interface RPCOptions {
  verbose?: boolean
  autoRead?: boolean
  autoTyping?: boolean
  /** Path to queue database (default: ~/.imsg-plus/queue.db) */
  queuePath?: string
}

// Simple TTL cache: entries expire after 5 minutes
const CACHE_TTL = 5 * 60 * 1000

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

function ttlCache<K, V>() {
  const store = new Map<K, CacheEntry<V>>()
  return {
    get(key: K): V | undefined {
      const entry = store.get(key)
      if (!entry) return undefined
      if (Date.now() > entry.expiresAt) { store.delete(key); return undefined }
      return entry.value
    },
    set(key: K, value: V): void {
      store.set(key, { value, expiresAt: Date.now() + CACHE_TTL })
    },
  }
}

export async function serve(db: DB, bridge: Bridge, opts: RPCOptions = {}): Promise<void> {
  const autoRead = opts.autoRead ?? bridge.available
  const autoTyping = opts.autoTyping ?? bridge.available
  const verbose = opts.verbose ?? false

  // --- Caches ---

  const chatCache = ttlCache<number, Chat | null>()
  const participantCache = ttlCache<number, string[]>()

  function cachedChat(id: number): Chat | null {
    let c = chatCache.get(id)
    if (c === undefined) {
      c = db.chat(id)
      chatCache.set(id, c)
    }
    return c
  }

  function cachedParticipants(id: number): string[] {
    let p = participantCache.get(id)
    if (p === undefined) {
      p = db.participants(id)
      participantCache.set(id, p)
    }
    return p
  }

  // --- Wire format ---

  function toWireMessage(msg: ReturnType<DB["messages"]>[number], attachments: ReturnType<DB["attachments"]> = []) {
    const chat = cachedChat(msg.chatId)
    return {
      ...serializeMessage(msg, attachments),
      chat_identifier: chat?.identifier ?? "",
      chat_guid: chat?.guid ?? "",
      chat_name: chat?.name ?? "",
      participants: cachedParticipants(msg.chatId),
      is_group: chat?.isGroup ?? false,
    }
  }

  function toWireChat(chat: Chat) {
    return {
      id: chat.id,
      identifier: chat.identifier,
      guid: chat.guid,
      name: chat.name,
      service: chat.service,
      last_message_at: chat.lastMessageAt?.toISOString() ?? null,
      participants: cachedParticipants(chat.id),
      is_group: chat.isGroup,
    }
  }

  // --- Auto-behaviors (bridge handles availability check) ---

  function autoMarkRead(msg: ReturnType<DB["messages"]>[number]) {
    if (!autoRead || msg.isFromMe) return
    const handle = cachedChat(msg.chatId)?.identifier ?? msg.sender
    if (!handle) return
    setTimeout(() => {
      bridge.markRead(handle).catch((err) => log(`[auto-read] error: ${err.message}`))
    }, 1000)
  }

  async function autoType(handle: string, textLength: number) {
    if (!autoTyping || !handle) return
    try {
      await bridge.setTyping(handle, true)
      await new Promise((r) => setTimeout(r, Math.min(1.5 + (textLength / 80) * 2.5, 4) * 1000))
    } catch (err: any) {
      log(`[auto-typing] error: ${err.message}`)
    }
  }

  function autoTypeOff(handle: string) {
    if (!autoTyping || !handle) return
    bridge.setTyping(handle, false).catch((err) => log(`[auto-typing] off: ${err.message}`))
  }

  // --- In-process queue + worker ---

  const queue = openQueue(opts.queuePath)
  const workerAc = new AbortController()

  runWorker(queue, db, {
    pollMs: 500,
    reapStaleSecs: 60,
    signal: workerAc.signal,
    log,
    beforeSend: async (job) => {
      const handle = job.to || job.chatIdentifier || job.chatGuid || ""
      if (!job.idempotencyKey) return // CLI-enqueued, no typing
      await autoType(handle, (job.text ?? "").length)
    },
    afterSend: (job) => {
      const handle = job.to || job.chatIdentifier || job.chatGuid || ""
      if (!job.idempotencyKey) return
      autoTypeOff(handle)
    },
    onSent: (job) => {
      // Try to find the sent message in chat.db for the notification
      const msg = db.findSentMessage(job.id)
      notify("queue.sent", {
        job_id: job.id,
        idempotency_key: job.idempotencyKey,
        ...(msg ? { message_id: msg.id, guid: msg.guid } : {}),
      })
    },
    onFail: (job, error) => {
      notify("queue.failed", {
        job_id: job.id,
        idempotency_key: job.idempotencyKey,
        error,
        status: job.status,
        attempts: job.attempts,
        max_attempts: job.maxAttempts,
      })
    },
  }).catch((err) => log(`[worker] fatal: ${err.message}`))

  // --- Subscriptions ---

  let nextSubId = 1
  const subs = new Map<number, AbortController>()

  function abortAllSubscriptions() {
    for (const ac of subs.values()) ac.abort()
    subs.clear()
  }

  function startSubscription(subId: number, ac: AbortController, watchOpts: Parameters<typeof watch>[1], includeAttachments: boolean, staleSecs = 30, staleCheckMs = 15_000) {
    const RETRY_MS = 2000
    let lastRowId = watchOpts?.sinceRowId

    // Stale send checker
    const notifiedStale = new Set<number>()
    const staleInterval = setInterval(() => {
      if (ac.signal.aborted) return
      try {
        const stale = db.undeliveredMessages(staleSecs)
        for (const msg of stale) {
          if (notifiedStale.has(msg.id)) continue
          notifiedStale.add(msg.id)
          notify("stale_send", { subscription: subId, message: serializeUndelivered(msg) })
        }
      } catch (err: any) {
        log(`[sub ${subId}] stale check error: ${err.message}`)
      }
    }, staleCheckMs)
    ac.signal.addEventListener("abort", () => clearInterval(staleInterval))

    // Heartbeat: keep the health monitor from mistaking idle silence for a dead socket.
    // iMessage has no protocol-level heartbeat, so we synthesize one every 15 min.
    const heartbeatInterval = setInterval(() => {
      if (ac.signal.aborted) return
      notify("heartbeat", { subscription: subId })
    }, 15 * 60 * 1000)
    ac.signal.addEventListener("abort", () => clearInterval(heartbeatInterval))

    ;(async () => {
      while (!ac.signal.aborted) {
        try {
          for await (const msg of watch(db, { ...watchOpts, sinceRowId: lastRowId })) {
            if (ac.signal.aborted) return
            lastRowId = msg.id
            notify("message", { subscription: subId, message: toWireMessage(msg, includeAttachments ? db.attachments(msg.id) : []) })
            autoMarkRead(msg)
          }
          return // generator completed normally
        } catch (err: any) {
          if (ac.signal.aborted) return
          log(`[sub ${subId}] watch error: ${err.message}, restarting in ${RETRY_MS}ms`)
          notify("error", { subscription: subId, error: { message: err.message }, recovering: true })
          await new Promise((r) => setTimeout(r, RETRY_MS))
        }
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

  type Params = Record<string, any>

  const methods: Record<string, (p: Params) => unknown> = {
    "chats.list"(p) {
      return { chats: db.chats(Math.max(int(p.limit) ?? 20, 1)).map(toWireChat) }
    },

    "messages.history"(p) {
      const chatId = need(int(p.chat_id), "chat_id")
      const atts = bool(p.attachments) ?? false
      return {
        messages: db
          .messages(chatId, { limit: Math.max(int(p.limit) ?? 50, 1), filter: parseFilter(p) })
          .map((m) => toWireMessage(m, atts ? db.attachments(m.id) : [])),
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
        bool(p.attachments) ?? false,
        int(p.stale_threshold) ?? 30,
        int(p._stale_check_ms) ?? 15_000
      )
      return { subscription: subId }
    },

    "watch.unsubscribe"(p) {
      const subId = need(int(p.subscription), "subscription")
      subs.get(subId)?.abort()
      subs.delete(subId)
      return { ok: true }
    },

    send(p) {
      const { job, duplicate } = queue.enqueue({
        to: str(p.to) ?? undefined,
        chatId: int(p.chat_id) ?? undefined,
        chatIdentifier: str(p.chat_identifier) ?? undefined,
        chatGuid: str(p.chat_guid) ?? undefined,
        text: str(p.text) ?? undefined,
        file: str(p.file) ?? undefined,
        service: (str(p.service) ?? "auto") as Service,
        region: str(p.region) ?? undefined,
        idempotencyKey: str(p.idempotency_key) ?? undefined,
      })
      return { ok: true, queued: true, job_id: job.id, duplicate }
    },

    "queue.status"() {
      return queue.counts()
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
      await bridge.setTyping(handle, state === "on")
      return { ok: true }
    },

    async "messages.markRead"(p) {
      const handle = need(str(p.handle), "handle")
      await bridge.markRead(handle)
      return { ok: true }
    },
  }

  // --- Main loop ---

  const rl = createInterface({ input: process.stdin, terminal: false })

  // Abort all subscriptions and worker when stdin closes
  process.stdin.on("end", () => {
    abortAllSubscriptions()
    workerAc.abort()
  })

  for await (const line of rl) {
    if (!line.trim()) continue

    let req: Params
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

  abortAllSubscriptions()
  workerAc.abort()
  queue.close()
}

// --- Helpers ---

export class InvalidParams extends Error {}

export function need<T>(value: T | null | undefined, name: string): NonNullable<T> {
  if (value == null) throw new InvalidParams(`${name} is required`)
  return value!
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  return null
}

export function int(v: unknown): number | null {
  if (typeof v === "number") return Math.floor(v)
  if (typeof v === "string") {
    const n = parseInt(v, 10)
    return isNaN(n) ? null : n
  }
  return null
}

export function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return null
}
