import { describe, it, expect, vi } from "vitest"
import { PassThrough } from "node:stream"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Chat, Message } from "../types.js"

// Mock node:fs to prevent real fs.watch in watch.ts
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    watch: (_path: string, cb?: () => void) => {
      const id = setInterval(() => cb?.(), 50)
      return { close: () => clearInterval(id) }
    },
  }
})

// Mock send module so the send RPC handler doesn't invoke real osascript
vi.mock("../send.js", () => ({
  send: vi.fn().mockResolvedValue(undefined),
  react: vi.fn().mockResolvedValue(undefined),
}))

const { serve } = await import("../rpc.js")

function makeChat(id: number): Chat {
  return {
    id,
    guid: `iMessage;-;chat${id}`,
    identifier: `+1555000${id}`,
    name: `Chat ${id}`,
    service: "iMessage",
    isGroup: false,
    lastMessageAt: new Date("2024-06-01"),
  }
}

function makeMessage(id: number, chatId: number): Message {
  return {
    id,
    chatId,
    guid: `msg-${id}`,
    replyToGuid: null,
    sender: "+15550001",
    text: `Message ${id}`,
    date: new Date("2024-06-01"),
    isFromMe: false,
    service: "iMessage",
    attachments: 0,
  }
}

interface TestHarness {
  stdin: PassThrough
  stdout: PassThrough
  serverDone: Promise<void>
  sendRequest: (obj: unknown) => void
  readResponse: () => Promise<any>
  readResponseById: (id: number) => Promise<any>
  readAllResponses: (count: number) => Promise<any[]>
}

function createHarness(dbOverrides: Record<string, any> = {}, bridgeOverrides: Record<string, any> = {}): TestHarness {
  const stdin = new PassThrough()
  const stdout = new PassThrough()

  const mockDb = {
    path: "/tmp/fake.db",
    maxRowId: () => 100,
    chats: (limit: number) => [makeChat(1), makeChat(2)].slice(0, limit),
    chat: (id: number) => (id === 1 ? makeChat(1) : null),
    participants: () => ["+15550001", "+15550002"],
    messages: (chatId: number) => [makeMessage(1, chatId), makeMessage(2, chatId)],
    messagesAfter: () => [],
    attachments: () => [],
    undeliveredMessages: () => [],
    findSentMessage: () => null,
    ...dbOverrides,
  }

  const mockBridge = {
    available: false,
    dylibPath: null,
    setTyping: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    sendVoiceNote: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    ...bridgeOverrides,
  }

  // Swap stdin/stdout
  const origStdin = process.stdin
  const origStdout = process.stdout
  Object.defineProperty(process, "stdin", { value: stdin, writable: true, configurable: true })
  Object.defineProperty(process, "stdout", { value: stdout, writable: true, configurable: true })

  // Each test gets an isolated queue database
  const tmpDir = mkdtempSync(join(tmpdir(), "imsg-rpc-test-"))
  const queuePath = join(tmpDir, "queue.db")

  const serverDone = serve(mockDb as any, mockBridge, { queuePath }).finally(() => {
    Object.defineProperty(process, "stdin", { value: origStdin, writable: true, configurable: true })
    Object.defineProperty(process, "stdout", { value: origStdout, writable: true, configurable: true })
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  function sendRequest(obj: unknown) {
    stdin.write(JSON.stringify(obj) + "\n")
  }

  // Buffer-based response reader: queues all JSON lines from stdout
  // so multi-line chunks don't lose data
  const responseQueue: any[] = []
  const waiters: Array<(value: any) => void> = []

  stdout.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean)
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)
        const waiter = waiters.shift()
        if (waiter) waiter(parsed)
        else responseQueue.push(parsed)
      } catch {}
    }
  })

  function readResponse(): Promise<any> {
    const queued = responseQueue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = waiters.indexOf(resolve)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error("Timeout waiting for response"))
      }, 5000)
      waiters.push((value) => { clearTimeout(timeout); resolve(value) })
    })
  }

  async function readAllResponses(count: number): Promise<any[]> {
    const results: any[] = []
    for (let i = 0; i < count; i++) {
      results.push(await readResponse())
    }
    return results
  }

  // Read responses until one with the given id is found (skips notifications)
  async function readResponseById(id: number): Promise<any> {
    while (true) {
      const res = await readResponse()
      if (res.id === id) return res
      // Put non-matching notifications back for other readers
      responseQueue.push(res)
    }
  }

  return { stdin, stdout, serverDone, sendRequest, readResponse, readResponseById, readAllResponses }
}

describe("RPC integration", () => {
  it("chats.list returns correct shape", async () => {
    const h = createHarness()
    h.sendRequest({ jsonrpc: "2.0", id: 1, method: "chats.list", params: { limit: 2 } })
    const res = await h.readResponse()

    expect(res.jsonrpc).toBe("2.0")
    expect(res.id).toBe(1)
    expect(res.result.chats).toHaveLength(2)
    expect(res.result.chats[0]).toHaveProperty("id")
    expect(res.result.chats[0]).toHaveProperty("identifier")
    expect(res.result.chats[0]).toHaveProperty("participants")
    expect(res.result.chats[0]).toHaveProperty("is_group")

    h.stdin.end()
    await h.serverDone
  })

  it("messages.history with filter passes through", async () => {
    let receivedOpts: any
    const h = createHarness({
      messages: (_chatId: number, opts: any) => {
        receivedOpts = opts
        return [makeMessage(1, 1)]
      },
    })

    h.sendRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "messages.history",
      params: { chat_id: 1, limit: 10, participants: "alice" },
    })

    const res = await h.readResponse()
    expect(res.id).toBe(2)
    expect(res.result.messages).toHaveLength(1)
    expect(receivedOpts.filter).toBeDefined()

    h.stdin.end()
    await h.serverDone
  })

  it("subscribe → message → unsubscribe lifecycle", async () => {
    let callCount = 0
    const h = createHarness({
      messagesAfter: () => {
        callCount++
        if (callCount === 1) return [makeMessage(101, 1)]
        return []
      },
    })

    // Subscribe
    h.sendRequest({ jsonrpc: "2.0", id: 3, method: "watch.subscribe", params: {} })
    const subRes = await h.readResponse()
    expect(subRes.result.subscription).toBe(1)

    // Wait for the notification
    const notification = await h.readResponse()
    expect(notification.method).toBe("message")
    expect(notification.params.subscription).toBe(1)
    expect(notification.params.message).toHaveProperty("text")

    // Unsubscribe
    h.sendRequest({ jsonrpc: "2.0", id: 4, method: "watch.unsubscribe", params: { subscription: 1 } })
    const unsubRes = await h.readResponse()
    expect(unsubRes.result.ok).toBe(true)

    h.stdin.end()
    await h.serverDone
  })

  it("stdin close aborts all subscriptions", async () => {
    const h = createHarness()

    // Create 2 subscriptions
    h.sendRequest({ jsonrpc: "2.0", id: 5, method: "watch.subscribe", params: {} })
    h.sendRequest({ jsonrpc: "2.0", id: 6, method: "watch.subscribe", params: {} })

    const [res1, res2] = await h.readAllResponses(2)
    expect(res1.result.subscription).toBe(1)
    expect(res2.result.subscription).toBe(2)

    // Close stdin — should abort both subscriptions
    h.stdin.end()
    await h.serverDone
    // If we get here without hanging, subscriptions were properly cleaned up
  })

  it("malformed JSON returns parse error (-32700)", async () => {
    const h = createHarness()
    h.stdin.write("this is not json\n")
    const res = await h.readResponse()

    expect(res.error.code).toBe(-32700)
    expect(res.error.message).toBe("Parse error")

    h.stdin.end()
    await h.serverDone
  })

  it("unknown method returns -32601", async () => {
    const h = createHarness()
    h.sendRequest({ jsonrpc: "2.0", id: 7, method: "fake.method", params: {} })
    const res = await h.readResponse()

    expect(res.id).toBe(7)
    expect(res.error.code).toBe(-32601)
    expect(res.error.message).toBe("Method not found")

    h.stdin.end()
    await h.serverDone
  })

  it("InvalidParams propagates correctly (-32602)", async () => {
    const h = createHarness()
    // messages.history requires chat_id
    h.sendRequest({ jsonrpc: "2.0", id: 8, method: "messages.history", params: {} })
    const res = await h.readResponse()

    expect(res.id).toBe(8)
    expect(res.error.code).toBe(-32602)
    expect(res.error.message).toBe("Invalid params")
    expect(res.error.data).toContain("chat_id")

    h.stdin.end()
    await h.serverDone
  })

  it("subscription preserves cursor across restart", async () => {
    const afterRowIds: (number | undefined)[] = []
    let callCount = 0
    const h = createHarness({
      messagesAfter: (afterRowId: number) => {
        callCount++
        afterRowIds.push(afterRowId)
        if (callCount === 1) return [makeMessage(201, 1)]
        if (callCount === 2) throw new Error("database is locked")
        if (callCount === 3) return [makeMessage(301, 1)]
        return []
      },
    })

    h.sendRequest({ jsonrpc: "2.0", id: 20, method: "watch.subscribe", params: {} })

    // Subscribe response + first message notification
    const first2 = await h.readAllResponses(2)
    const subRes = first2.find((r) => r.id === 20)!
    expect(subRes.result.subscription).toBe(1)

    // Error notification from call 2
    const errNotif = await h.readResponse()
    expect(errNotif.method).toBe("error")
    expect(errNotif.params.recovering).toBe(true)

    // After retry, message 301 delivered
    const msg = await h.readResponse()
    expect(msg.method).toBe("message")
    expect(msg.params.message.text).toBe("Message 301")

    // Key assertion: after delivering msg 201, restart should use 201 as cursor, not maxRowId (100)
    expect(afterRowIds[2]).toBe(201)

    h.sendRequest({ jsonrpc: "2.0", id: 21, method: "watch.unsubscribe", params: { subscription: 1 } })
    await h.readResponse()
    h.stdin.end()
    await h.serverDone
  })

  it("send enqueues and returns id", async () => {
    const h = createHarness()

    h.sendRequest({
      jsonrpc: "2.0",
      id: 30,
      method: "send",
      params: { to: "+15550001", text: "Hi" },
    })

    const res = await h.readResponseById(30)
    expect(res.result.ok).toBe(true)
    expect(res.result.queued).toBe(true)
    expect(res.result.id).toBeGreaterThan(0)
    expect(res.result.duplicate).toBe(false)

    h.stdin.end()
    await h.serverDone
  })

  it("send deduplicates by idempotency_key", async () => {
    const h = createHarness()

    h.sendRequest({
      jsonrpc: "2.0",
      id: 31,
      method: "send",
      params: { to: "+15550001", text: "Hi", idempotency_key: "test-key-1" },
    })
    const res1 = await h.readResponseById(31)
    expect(res1.result.duplicate).toBe(false)

    h.sendRequest({
      jsonrpc: "2.0",
      id: 32,
      method: "send",
      params: { to: "+15550001", text: "Hi", idempotency_key: "test-key-1" },
    })
    const res2 = await h.readResponseById(32)
    expect(res2.result.duplicate).toBe(true)
    expect(res2.result.id).toBe(res1.result.id)

    h.stdin.end()
    await h.serverDone
  })

  it("stale_send notification is emitted for undelivered messages", async () => {
    const staleMsg = {
      id: 201,
      guid: "guid-stale-201",
      chatId: 1,
      text: "Hey are you there?",
      date: new Date("2024-06-01T12:00:00Z"),
    }
    const h = createHarness({
      undeliveredMessages: () => [staleMsg],
    })

    // Subscribe with a fast stale check interval (100ms) via internal param
    h.sendRequest({ jsonrpc: "2.0", id: 40, method: "watch.subscribe", params: { _stale_check_ms: 100 } })
    const subRes = await h.readResponse()
    expect(subRes.result.subscription).toBe(1)

    // Wait for the stale_send notification (should arrive within ~100ms)
    const notification = await h.readResponse()
    expect(notification.method).toBe("stale_send")
    expect(notification.params.subscription).toBe(1)
    expect(notification.params.message.id).toBe(201)
    expect(notification.params.message.guid).toBe("guid-stale-201")
    expect(notification.params.message.text).toBe("Hey are you there?")

    h.sendRequest({ jsonrpc: "2.0", id: 41, method: "watch.unsubscribe", params: { subscription: 1 } })
    await h.readResponse()
    h.stdin.end()
    await h.serverDone
  })

  it("stale_send does not re-alert for the same message id", async () => {
    const staleMsg = {
      id: 300,
      guid: "guid-300",
      chatId: 1,
      text: "Test",
      date: new Date("2024-06-01"),
    }
    let callCount = 0
    const h = createHarness({
      undeliveredMessages: () => {
        callCount++
        return [staleMsg]
      },
    })

    h.sendRequest({ jsonrpc: "2.0", id: 50, method: "watch.subscribe", params: { _stale_check_ms: 100 } })
    await h.readResponse() // subscribe response

    // First stale notification
    const first = await h.readResponse()
    expect(first.method).toBe("stale_send")
    expect(first.params.message.id).toBe(300)

    // Wait for several more check cycles — no duplicate should arrive
    await new Promise((r) => setTimeout(r, 500))

    // Verify undeliveredMessages was called multiple times but no extra stale_send emitted
    expect(callCount).toBeGreaterThan(1)

    // Unsubscribe — this response should be next (no stale_send in between)
    h.sendRequest({ jsonrpc: "2.0", id: 51, method: "watch.unsubscribe", params: { subscription: 1 } })
    const unsubRes = await h.readResponse()
    expect(unsubRes.id).toBe(51)
    expect(unsubRes.result.ok).toBe(true)

    h.stdin.end()
    await h.serverDone
  })

  it("subscription auto-restarts after watch error", async () => {
    // Throw on first poll so the error happens immediately (no 5s fs-watch fallback wait).
    // After the 2s retry, the second watch's first poll returns a message.
    let callCount = 0
    const h = createHarness({
      messagesAfter: () => {
        callCount++
        if (callCount === 1) throw new Error("database is locked")
        if (callCount === 2) return [makeMessage(202, 1)]
        return []
      },
    })

    // Subscribe — error notification and subscribe response arrive in either order
    // (microtask scheduling: generator rejection can beat the await handler(...) continuation)
    h.sendRequest({ jsonrpc: "2.0", id: 10, method: "watch.subscribe", params: {} })
    const first2 = await h.readAllResponses(2)
    const subRes = first2.find((r) => r.id === 10)!
    const errNotif = first2.find((r) => r.method === "error")!

    expect(subRes.result.subscription).toBe(1)
    expect(errNotif.params.error.message).toBe("database is locked")
    expect(errNotif.params.recovering).toBe(true)

    // After 2s retry, message delivered from restarted watch
    const msg = await h.readResponse()
    expect(msg.method).toBe("message")
    expect(msg.params.message.text).toBe("Message 202")

    // Clean up
    h.sendRequest({ jsonrpc: "2.0", id: 11, method: "watch.unsubscribe", params: { subscription: 1 } })
    await h.readResponse()
    h.stdin.end()
    await h.serverDone
  })
})
