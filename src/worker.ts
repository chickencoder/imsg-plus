import { type QueueDB, type QueueJob } from "./queue.js"
import { send } from "./send.js"
import type { DB } from "./db.js"

export interface WorkerOptions {
  /** Milliseconds between queue polls (default: 1000) */
  pollMs?: number
  /** Seconds before a 'processing' job is considered stale and reclaimed (default: 120) */
  reapStaleSecs?: number
  /** Log function (default: stderr) */
  log?: (msg: string) => void
  /** Called before a job is sent (e.g. for typing indicators) */
  beforeSend?: (job: QueueJob) => Promise<void>
  /** Called after a job is sent (e.g. to turn off typing) */
  afterSend?: (job: QueueJob) => void
  /** Called when a job is sent */
  onSent?: (job: QueueJob) => void
  /** Called when a job fails (may be retried) */
  onFail?: (job: QueueJob, error: string) => void
  /** AbortSignal to stop the worker */
  signal?: AbortSignal
}

export async function runWorker(
  queue: QueueDB,
  db: DB,
  opts: WorkerOptions = {}
): Promise<void> {
  const pollMs = opts.pollMs ?? 1000
  const reapStaleSecs = opts.reapStaleSecs ?? 120
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg + "\n"))
  const signal = opts.signal

  log(`[worker] started, polling every ${pollMs}ms`)

  // Reap stale jobs on startup and periodically
  const reapInterval = setInterval(() => {
    const reclaimed = queue.reapStale(reapStaleSecs)
    if (reclaimed > 0) log(`[worker] reclaimed ${reclaimed} stale job(s)`)
  }, reapStaleSecs * 1000)
  signal?.addEventListener("abort", () => clearInterval(reapInterval), { once: true })

  // Reap once at startup
  const reclaimed = queue.reapStale(reapStaleSecs)
  if (reclaimed > 0) log(`[worker] reclaimed ${reclaimed} stale job(s) on startup`)

  while (!signal?.aborted) {
    const job = queue.dequeue()

    if (!job) {
      await sleep(pollMs, signal)
      continue
    }

    log(`[worker] processing job ${job.id}: to=${job.to ?? ""} chat=${job.chatId ?? ""} text=${(job.text ?? "").slice(0, 40)}`)

    try {
      await opts.beforeSend?.(job)

      await send(
        {
          to: job.to ?? undefined,
          chatId: job.chatId ?? undefined,
          chatIdentifier: job.chatIdentifier ?? undefined,
          chatGuid: job.chatGuid ?? undefined,
          text: job.text ?? undefined,
          file: job.file ?? undefined,
          service: job.service,
          region: job.region,
        },
        db
      )

      opts.afterSend?.(job)
      queue.complete(job.id)
      log(`[worker] job ${job.id} sent`)
      opts.onSent?.(job)
    } catch (err: any) {
      const errMsg = err.message ?? String(err)
      queue.fail(job.id, errMsg)

      const updated = queue.all().find((j) => j.id === job.id)
      const willRetry = updated?.status === "pending"
      log(`[worker] job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${errMsg}${willRetry ? " — will retry" : " — giving up"}`)
      opts.onFail?.(updated ?? job, errMsg)
    }
  }

  clearInterval(reapInterval)
  log("[worker] stopped")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
