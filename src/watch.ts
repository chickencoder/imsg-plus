import { watch as fsWatch, type FSWatcher } from "node:fs"
import type { DB } from "./db.js"
import type { Message, Filter } from "./types.js"

export interface WatchOptions {
  chatId?: number
  sinceRowId?: number
  debounce?: number
  filter?: Filter
}

export async function* watch(db: DB, opts: WatchOptions = {}): AsyncGenerator<Message> {
  let cursor = opts.sinceRowId ?? db.maxRowId()
  const interval = opts.debounce ?? 250
  const filter = opts.filter

  // Poll for new messages
  function poll(): Message[] {
    const msgs = db.messagesAfter(cursor, { chatId: opts.chatId, limit: 100 })
    for (const msg of msgs) {
      if (msg.id > cursor) cursor = msg.id
    }
    return filter ? msgs.filter((m) => allows(m, filter)) : msgs
  }

  // Watch the db files for changes, resolve a promise on each change
  let notify: (() => void) | null = null
  const watchers: FSWatcher[] = []

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const w = fsWatch(db.path + suffix, () => notify?.())
      watchers.push(w)
    } catch {
      // File may not exist yet — that's fine
    }
  }

  try {
    // Yield forever until cancelled
    while (true) {
      const msgs = poll()
      for (const msg of msgs) yield msg

      // Wait for next fs change
      await new Promise<void>((resolve) => {
        notify = resolve
        // Fallback poll in case fs events are missed
        setTimeout(resolve, 5000)
      })

      // Debounce
      if (interval > 0) {
        await new Promise<void>((r) => setTimeout(r, interval))
      }
    }
  } finally {
    for (const w of watchers) w.close()
  }
}

function allows(msg: Message, filter: Filter): boolean {
  if (filter.after && msg.date < filter.after) return false
  if (filter.before && msg.date >= filter.before) return false
  if (filter.participants?.length) {
    if (!filter.participants.some((p) => p.toLowerCase() === msg.sender.toLowerCase())) return false
  }
  return true
}
