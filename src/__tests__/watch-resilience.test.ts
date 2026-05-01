import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Message } from "../types.js"

// Track all watcher close() calls across tests
const closeSpies: ReturnType<typeof vi.fn>[] = []

vi.mock("node:fs", () => ({
  watch: () => {
    const closeFn = vi.fn()
    closeSpies.push(closeFn)
    return { close: closeFn }
  },
}))

const { watch } = await import("../watch.js")

function makeMsg(id: number, text: string): Message {
  return {
    id,
    chatId: 1,
    guid: `g${id}`,
    replyToGuid: null,
    sender: "alice",
    text,
    date: new Date("2024-06-01"),
    isFromMe: false,
    service: "iMessage",
    attachments: 0,
    isAudioMessage: false,
    associatedMessageType: null,
    associatedMessageGuid: null,
  }
}

describe("watch resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    closeSpies.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("yields messages and advances cursor", async () => {
    let callCount = 0
    const mockDb = {
      path: "/tmp/fake.db",
      maxRowId: () => 100,
      messagesAfter: (afterRowId: number) => {
        callCount++
        if (callCount === 1) {
          expect(afterRowId).toBe(100)
          return [makeMsg(101, "hi"), makeMsg(102, "hey")]
        }
        return []
      },
    }

    const gen = watch(mockDb as any, { debounce: 0 })

    // First next: poll returns 2 messages, yields the first
    const r1 = await gen.next()
    expect(r1.value.text).toBe("hi")
    expect(r1.value.id).toBe(101)

    // Second next: yields the second message from the same poll batch
    const r2 = await gen.next()
    expect(r2.value.text).toBe("hey")
    expect(r2.value.id).toBe(102)

    // Clean up
    await gen.return(undefined as any)
  })

  it("DB error kills generator (does not hang)", async () => {
    let callCount = 0
    const mockDb = {
      path: "/tmp/fake.db",
      maxRowId: () => 100,
      messagesAfter: () => {
        callCount++
        if (callCount === 1) return [makeMsg(101, "msg1")]
        throw new Error("WAL corruption")
      },
    }

    const gen = watch(mockDb as any, { debounce: 0 })

    // First poll succeeds, yields msg1
    const r1 = await gen.next()
    expect(r1.value.text).toBe("msg1")

    // Second next: generator resumes after yield, inner loop done,
    // awaits 5s setTimeout. We advance fake timers to resolve it,
    // which triggers poll #2 → throws.
    // Pre-attach catch handler to avoid unhandled rejection warning.
    let caughtError: Error | null = null
    const nextP = gen.next().catch((err) => { caughtError = err })
    await vi.advanceTimersByTimeAsync(5100)
    await nextP

    expect(caughtError).not.toBeNull()
    expect(caughtError!.message).toBe("WAL corruption")
  })

  it("generator cleanup on .return() closes watchers", async () => {
    let pollCount = 0
    const mockDb = {
      path: "/tmp/fake.db",
      maxRowId: () => 0,
      messagesAfter: () => {
        pollCount++
        if (pollCount === 1) return [makeMsg(1, "hello")]
        return []
      },
    }

    const gen = watch(mockDb as any, { debounce: 0 })

    // First next: yields msg
    const r = await gen.next()
    expect(r.value.text).toBe("hello")

    // Generator is now at the yield point. Calling .return() will
    // resume it, it finishes inner loop, hits await 5s. Return is queued.
    const returnP = gen.return(undefined as any)
    await vi.advanceTimersByTimeAsync(5100)
    const result = await returnP

    expect(result.done).toBe(true)

    // Verify all watchers were closed (finally block ran)
    for (const fn of closeSpies) {
      expect(fn).toHaveBeenCalled()
    }
  })

  it("empty polls don't yield messages but generator stays alive", async () => {
    let pollCount = 0
    const mockDb = {
      path: "/tmp/fake.db",
      maxRowId: () => 100,
      messagesAfter: () => {
        pollCount++
        if (pollCount === 3) return [makeMsg(101, "finally")]
        return []
      },
    }

    const gen = watch(mockDb as any, { debounce: 0 })

    // gen.next() starts the generator. Polls #1 and #2 are empty (no yield).
    // We advance timers to get through the 5s waits. Poll #3 returns a msg.
    const nextP = gen.next()

    // Advance past first empty poll's 5s wait
    await vi.advanceTimersByTimeAsync(5100)
    // Advance past second empty poll's 5s wait
    await vi.advanceTimersByTimeAsync(5100)

    const result = await nextP
    expect(result.done).toBe(false)
    expect(result.value.text).toBe("finally")
    expect(pollCount).toBeGreaterThanOrEqual(3)

    await gen.return(undefined as any)
  })
})
