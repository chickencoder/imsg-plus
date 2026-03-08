import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { openQueue, type QueueDB } from "../queue.js"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

let queue: QueueDB
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "imsg-queue-test-"))
  queue = openQueue(join(tmpDir, "queue.db"))
})

afterEach(() => {
  queue.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("openQueue", () => {
  it("creates the database and table", () => {
    expect(queue.all()).toEqual([])
  })
})

describe("enqueue", () => {
  it("adds a job with pending status", () => {
    const job = queue.enqueue({ to: "+15551234567", text: "hello" })
    expect(job.id).toBe(1)
    expect(job.status).toBe("pending")
    expect(job.to).toBe("+15551234567")
    expect(job.text).toBe("hello")
    expect(job.attempts).toBe(0)
    expect(job.maxAttempts).toBe(3)
    expect(job.service).toBe("auto")
    expect(job.region).toBe("US")
  })

  it("preserves all send options", () => {
    const job = queue.enqueue({
      chatId: 42,
      chatIdentifier: "chat;+;group",
      chatGuid: "iMessage;+;chat123",
      text: "hey group",
      file: "/tmp/photo.jpg",
      service: "imessage",
      region: "GB",
      maxAttempts: 5,
    })
    expect(job.chatId).toBe(42)
    expect(job.chatIdentifier).toBe("chat;+;group")
    expect(job.chatGuid).toBe("iMessage;+;chat123")
    expect(job.file).toBe("/tmp/photo.jpg")
    expect(job.service).toBe("imessage")
    expect(job.region).toBe("GB")
    expect(job.maxAttempts).toBe(5)
  })

  it("assigns incrementing IDs", () => {
    const a = queue.enqueue({ to: "a", text: "1" })
    const b = queue.enqueue({ to: "b", text: "2" })
    expect(b.id).toBe(a.id + 1)
  })
})

describe("dequeue", () => {
  it("returns null when queue is empty", () => {
    expect(queue.dequeue()).toBeNull()
  })

  it("returns the oldest pending job (FIFO)", () => {
    queue.enqueue({ to: "first", text: "1" })
    queue.enqueue({ to: "second", text: "2" })

    const job = queue.dequeue()!
    expect(job.to).toBe("first")
    expect(job.status).toBe("processing")
    expect(job.attempts).toBe(1)
  })

  it("does not return already-processing jobs", () => {
    queue.enqueue({ to: "first", text: "1" })
    queue.enqueue({ to: "second", text: "2" })

    queue.dequeue() // claims "first"
    const next = queue.dequeue()!
    expect(next.to).toBe("second")
  })
})

describe("complete", () => {
  it("marks a job as sent", () => {
    queue.enqueue({ to: "x", text: "hi" })
    const job = queue.dequeue()!
    queue.complete(job.id)

    const all = queue.all()
    expect(all[0].status).toBe("sent")
  })
})

describe("fail", () => {
  it("returns job to pending if under max attempts", () => {
    queue.enqueue({ to: "x", text: "hi", maxAttempts: 3 })
    const job = queue.dequeue()! // attempt 1
    queue.fail(job.id, "timeout")

    const all = queue.all()
    expect(all[0].status).toBe("pending")
    expect(all[0].lastError).toBe("timeout")
  })

  it("marks job as failed when max attempts reached", () => {
    queue.enqueue({ to: "x", text: "hi", maxAttempts: 1 })
    const job = queue.dequeue()! // attempt 1 (== maxAttempts)
    queue.fail(job.id, "gave up")

    const all = queue.all()
    expect(all[0].status).toBe("failed")
    expect(all[0].lastError).toBe("gave up")
  })
})

describe("counts", () => {
  it("returns counts by status", () => {
    queue.enqueue({ to: "a", text: "1" })
    queue.enqueue({ to: "b", text: "2" })
    queue.enqueue({ to: "c", text: "3" })

    // Complete "a", claim "b" (leaves it processing), "c" stays pending
    const j1 = queue.dequeue()!
    queue.complete(j1.id)
    queue.dequeue() // claims "b"

    const counts = queue.counts()
    expect(counts.sent).toBe(1)
    expect(counts.pending).toBe(1)
    expect(counts.processing).toBe(1)
  })
})

describe("purge", () => {
  it("removes sent and failed jobs", () => {
    queue.enqueue({ to: "a", text: "1" })
    queue.enqueue({ to: "b", text: "2", maxAttempts: 1 })
    queue.enqueue({ to: "c", text: "3" })

    // Complete first job
    const j1 = queue.dequeue()!
    queue.complete(j1.id)

    // Fail second job
    const j2 = queue.dequeue()!
    queue.fail(j2.id, "error")

    const removed = queue.purge()
    expect(removed).toBe(2)

    const remaining = queue.all()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].to).toBe("c")
  })
})

describe("FIFO ordering", () => {
  it("processes jobs in insertion order", () => {
    const ids = []
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ to: `user${i}`, text: `msg ${i}` })
    }

    for (let i = 0; i < 5; i++) {
      const job = queue.dequeue()!
      ids.push(job.to)
      queue.complete(job.id)
    }

    expect(ids).toEqual(["user0", "user1", "user2", "user3", "user4"])
  })
})
