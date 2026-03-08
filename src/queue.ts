import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Service } from "./types.js"

export interface QueueJob {
  id: number
  idempotencyKey: string | null
  status: "pending" | "processing" | "sent" | "failed"
  createdAt: string
  updatedAt: string
  attempts: number
  maxAttempts: number
  lastError: string | null
  to: string | null
  chatId: number | null
  chatIdentifier: string | null
  chatGuid: string | null
  text: string | null
  file: string | null
  service: Service
  region: string
}

export type QueueDB = ReturnType<typeof openQueue>

const DEFAULT_QUEUE_PATH = join(homedir(), ".imsg-plus", "queue.db")

export function openQueue(path = DEFAULT_QUEUE_PATH) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      "to" TEXT,
      chat_id INTEGER,
      chat_identifier TEXT,
      chat_guid TEXT,
      text TEXT,
      file TEXT,
      service TEXT NOT NULL DEFAULT 'auto',
      region TEXT NOT NULL DEFAULT 'US'
    )
  `)

  const stmts = {
    insert: db.prepare(`
      INSERT INTO jobs (idempotency_key, "to", chat_id, chat_identifier, chat_guid, text, file, service, region, max_attempts)
      VALUES (@idempotencyKey, @to, @chatId, @chatIdentifier, @chatGuid, @text, @file, @service, @region, @maxAttempts)
    `),

    findByKey: db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`),

    // Atomically claim the oldest pending job
    dequeue: db.prepare(`
      UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = datetime('now')
      WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1)
      RETURNING *
    `),

    complete: db.prepare(`
      UPDATE jobs SET status = 'sent', updated_at = datetime('now') WHERE id = ?
    `),

    fail: db.prepare(`
      UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
        last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `),

    pending: db.prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY id ASC`),
    all: db.prepare(`SELECT * FROM jobs ORDER BY id ASC`),
    counts: db.prepare(`SELECT status, COUNT(*) as count FROM jobs GROUP BY status`),
    purge: db.prepare(`DELETE FROM jobs WHERE status IN ('sent', 'failed')`),
    reapStale: db.prepare(`
      UPDATE jobs SET status = 'pending', updated_at = datetime('now')
      WHERE status = 'processing'
        AND updated_at <= datetime('now', '-' || ? || ' seconds')
    `),
  }

  function rowToJob(row: any): QueueJob {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      to: row.to,
      chatId: row.chat_id,
      chatIdentifier: row.chat_identifier,
      chatGuid: row.chat_guid,
      text: row.text,
      file: row.file,
      service: row.service as Service,
      region: row.region,
    }
  }

  return {
    enqueue(opts: {
      to?: string
      chatId?: number
      chatIdentifier?: string
      chatGuid?: string
      text?: string
      file?: string
      service?: Service
      region?: string
      maxAttempts?: number
      idempotencyKey?: string
    }): { job: QueueJob; duplicate: boolean } {
      // Dedup: if a key is provided and already exists, return the existing job
      if (opts.idempotencyKey) {
        const existing = stmts.findByKey.get(opts.idempotencyKey)
        if (existing) return { job: rowToJob(existing), duplicate: true }
      }

      const result = stmts.insert.run({
        idempotencyKey: opts.idempotencyKey ?? null,
        to: opts.to ?? null,
        chatId: opts.chatId ?? null,
        chatIdentifier: opts.chatIdentifier ?? null,
        chatGuid: opts.chatGuid ?? null,
        text: opts.text ?? null,
        file: opts.file ?? null,
        service: opts.service ?? "auto",
        region: opts.region ?? "US",
        maxAttempts: opts.maxAttempts ?? 3,
      })
      const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.lastInsertRowid)
      return { job: rowToJob(row), duplicate: false }
    },

    dequeue(): QueueJob | null {
      const row = stmts.dequeue.get()
      return row ? rowToJob(row) : null
    },

    complete(id: number): void {
      stmts.complete.run(id)
    },

    fail(id: number, error: string): void {
      stmts.fail.run(error, id)
    },

    pending(): QueueJob[] {
      return stmts.pending.all().map(rowToJob)
    },

    all(): QueueJob[] {
      return stmts.all.all().map(rowToJob)
    },

    counts(): Record<string, number> {
      const rows = stmts.counts.all() as Array<{ status: string; count: number }>
      const result: Record<string, number> = { pending: 0, processing: 0, sent: 0, failed: 0 }
      for (const row of rows) result[row.status] = row.count
      return result
    },

    purge(): number {
      return stmts.purge.run().changes
    },

    /** Reclaim jobs stuck in 'processing' for longer than staleSeconds */
    reapStale(staleSeconds = 120): number {
      return stmts.reapStale.run(String(staleSeconds)).changes
    },

    close(): void {
      db.close()
    },
  }
}
