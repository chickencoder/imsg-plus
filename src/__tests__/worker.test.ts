import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { openQueue, type QueueDB } from "../queue.js"
import { runWorker } from "../worker.js"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

// Mock the send module
vi.mock("../send.js", () => ({
  send: vi.fn(),
}))

import { send } from "../send.js"
const mockSend = vi.mocked(send)

let queue: QueueDB
let tmpDir: string
const fakeDb = {} as any

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "imsg-worker-test-"))
  queue = openQueue(join(tmpDir, "queue.db"))
  mockSend.mockReset()
})

afterEach(() => {
  queue.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("runWorker", () => {
  it("processes a queued job and marks it sent", async () => {
    mockSend.mockResolvedValue(undefined)
    queue.enqueue({ to: "+15551234567", text: "hello" })

    const ac = new AbortController()
    const sent: number[] = []

    // Run worker briefly
    const workerPromise = runWorker(queue, fakeDb, {
      pollMs: 50,
      signal: ac.signal,
      log: () => {},
      onSent: (job) => {
        sent.push(job.id)
        ac.abort() // stop after first send
      },
    })

    await workerPromise

    expect(sent).toEqual([1])
    expect(mockSend).toHaveBeenCalledOnce()
    expect(queue.all()[0].status).toBe("sent")
  })

  it("retries failed jobs up to maxAttempts", async () => {
    mockSend.mockRejectedValue(new Error("AppleScript timed out"))
    queue.enqueue({ to: "+15551234567", text: "hello", maxAttempts: 2 })

    const ac = new AbortController()
    const failures: string[] = []

    const workerPromise = runWorker(queue, fakeDb, {
      pollMs: 50,
      signal: ac.signal,
      log: () => {},
      onFail: (job, error) => {
        failures.push(job.status)
        // After second failure (max reached), stop
        if (job.status === "failed") ac.abort()
      },
    })

    await workerPromise

    expect(failures).toEqual(["pending", "failed"])
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  it("passes correct send options from job", async () => {
    mockSend.mockResolvedValue(undefined)

    queue.enqueue({
      to: "+15551234567",
      text: "test message",
      service: "sms",
      region: "GB",
    })

    const ac = new AbortController()
    await runWorker(queue, fakeDb, {
      pollMs: 50,
      signal: ac.signal,
      log: () => {},
      onSent: () => ac.abort(),
    })

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        text: "test message",
        service: "sms",
        region: "GB",
      }),
      fakeDb
    )
  })

  it("processes jobs in FIFO order", async () => {
    mockSend.mockResolvedValue(undefined)
    queue.enqueue({ to: "first", text: "1" })
    queue.enqueue({ to: "second", text: "2" })
    queue.enqueue({ to: "third", text: "3" })

    const ac = new AbortController()
    const order: string[] = []

    await runWorker(queue, fakeDb, {
      pollMs: 50,
      signal: ac.signal,
      log: () => {},
      onSent: (job) => {
        order.push(job.to!)
        if (order.length === 3) ac.abort()
      },
    })

    expect(order).toEqual(["first", "second", "third"])
  })

  it("stops when aborted", async () => {
    const ac = new AbortController()

    // Abort immediately
    setTimeout(() => ac.abort(), 100)

    await runWorker(queue, fakeDb, {
      pollMs: 50,
      signal: ac.signal,
      log: () => {},
    })

    // Should exit cleanly without hanging
    expect(true).toBe(true)
  })
})
