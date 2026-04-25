#!/usr/bin/env node

import arg from "arg"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { open, type DB } from "./db.js"
import { send, sendContactCard, react, cleanStagedAttachments, type TapbackType } from "./send.js"
import { watch } from "./watch.js"
import { createBridge } from "./bridge.js"
import { serve } from "./rpc.js"
import { serializeMessage } from "./json.js"
import { parseFilter } from "./filter.js"
import { parseService } from "./types.js"
import { openQueue } from "./queue.js"
import { runWorker } from "./worker.js"
import type { Message, Attachment } from "./types.js"

// --- Args ---

const args = arg(
  {
    "--help": Boolean,
    "--version": Boolean,
    "--json": Boolean,
    "--db": String,
    "--limit": Number,
    "--chat-id": Number,
    "--attachments": Boolean,
    "--participants": String,
    "--start": String,
    "--end": String,
    "--since-rowid": Number,
    "--debounce": Number,
    "--to": String,
    "--text": String,
    "--file": String,
    "--contact-card": String,
    "--service": String,
    "--region": String,
    "--chat-identifier": String,
    "--chat-guid": String,
    "--guid": String,
    "--type": String,
    "--handle": String,
    "--state": String,
    "--dylib": String,
    "--kill-only": Boolean,
    "--quiet": Boolean,
    "--verbose": Boolean,
    "--no-auto-read": Boolean,
    "--no-auto-typing": Boolean,
    "--poll": Number,
    "--retries": Number,
    "-h": "--help",
    "-V": "--version",
  },
  { permissive: true }
)

const [command] = args._
const json = args["--json"] ?? false

// --- Output ---

function output(data: unknown, text: string) {
  if (json) console.log(JSON.stringify(data))
  else console.log(text)
}

function printMessage(msg: Message, attachments: Attachment[]) {
  if (json) {
    console.log(JSON.stringify(serializeMessage(msg, attachments)))
  } else {
    const dir = msg.isFromMe ? "sent" : "recv"
    console.log(`${msg.date.toISOString()} [${dir}] ${msg.sender}: ${msg.text}`)
    if (attachments.length) {
      for (const a of attachments) {
        console.log(`  ${a.transferName || a.filename || "(unknown)"} — ${a.mimeType}${a.missing ? " (missing)" : ""}`)
      }
    } else if (msg.attachments > 0) {
      console.log(`  (${msg.attachments} attachment${msg.attachments === 1 ? "" : "s"})`)
    }
  }
}

// --- Main ---

main().catch((err) => {
  if (json) console.log(JSON.stringify({ error: err.message }))
  else console.error(err.message ?? err)
  process.exit(1)
})

async function main() {
  if (args["--version"]) return console.log(getVersion())
  if (args["--help"] || !command) return help()

  switch (command) {
    case "chats": return chatsCmd()
    case "history": return historyCmd()
    case "watch": return watchCmd()
    case "send": return sendCmd()
    case "typing": return typingCmd()
    case "read": return readCmd()
    case "status": return statusCmd()
    case "launch": return launchCmd()
    case "react": return reactCmd()
    case "cleanup": return cleanupCmd()
    case "enqueue": return enqueueCmd()
    case "worker": return workerCmd()
    case "queue": return queueCmd()
    case "rpc": return rpcCmd()
    default:
      console.error(`Unknown command: ${command}\n`)
      help()
      process.exit(1)
  }
}

// --- Commands ---

function chatsCmd() {
  const db = openDB()
  for (const c of db.chats(args["--limit"] ?? 20)) {
    output(
      { id: c.id, name: c.name, identifier: c.identifier, guid: c.guid, service: c.service, is_group: c.isGroup, last_message_at: c.lastMessageAt?.toISOString() ?? null },
      `[${c.id}] ${c.name} (${c.identifier}) last=${c.lastMessageAt?.toISOString() ?? "unknown"}`
    )
  }
}

function historyCmd() {
  const chatId = args["--chat-id"]
  if (chatId == null) bail("--chat-id is required")

  const db = openDB()
  const showAttachments = args["--attachments"] ?? false
  for (const msg of db.messages(chatId, { limit: args["--limit"] ?? 50, filter: buildFilter() })) {
    printMessage(msg, showAttachments ? db.attachments(msg.id) : [])
  }
}

async function watchCmd() {
  const db = openDB()
  const showAttachments = args["--attachments"] ?? false
  for await (const msg of watch(db, {
    chatId: args["--chat-id"],
    sinceRowId: args["--since-rowid"],
    debounce: args["--debounce"] ?? 250,
    filter: buildFilter(),
  })) {
    printMessage(msg, showAttachments ? db.attachments(msg.id) : [])
  }
}

async function sendCmd() {
  const service = parseService(args["--service"])
  const contactCard = args["--contact-card"]

  if (contactCard) {
    if (args["--text"] || args["--file"]) {
      bail("--contact-card is exclusive with --text and --file")
    }
    const bridge = createBridge()
    await sendContactCard(
      {
        to: args["--to"],
        chatId: args["--chat-id"],
        chatIdentifier: args["--chat-identifier"],
        chatGuid: args["--chat-guid"],
        contactCard,
        service,
        region: args["--region"],
      },
      bridge,
      openDB()
    )
    output({ status: "sent", mode: "contact-card" }, "sent")
    return
  }

  await send(
    {
      to: args["--to"],
      chatId: args["--chat-id"],
      chatIdentifier: args["--chat-identifier"],
      chatGuid: args["--chat-guid"],
      text: args["--text"],
      file: args["--file"],
      service,
      region: args["--region"],
    },
    openDB()
  )
  output({ status: "sent" }, "sent")
}

async function typingCmd() {
  const handle = args["--handle"]
  if (!handle) bail("--handle is required")
  const state = args["--state"]
  if (state !== "on" && state !== "off") bail("--state must be 'on' or 'off'")

  const bridge = createBridge()
  if (!bridge.available) bail("dylib not found — run: make build-dylib")
  await bridge.setTyping(handle, state === "on")

  output(
    { success: true, handle, typing: state === "on" },
    `Typing indicator ${state === "on" ? "enabled" : "disabled"} for ${handle}`
  )
}

async function readCmd() {
  const handle = args["--handle"]
  if (!handle) bail("--handle is required")

  const bridge = createBridge()
  if (!bridge.available) bail("dylib not found — run: make build-dylib")
  await bridge.markRead(handle)

  output(
    { success: true, handle, marked_as_read: true },
    `Marked messages as read for ${handle}`
  )
}

function statusCmd() {
  const bridge = createBridge()
  if (json) {
    console.log(JSON.stringify({ basic_features: true, advanced_features: bridge.available, typing_indicators: bridge.available, read_receipts: bridge.available, contact_card_send: bridge.available }))
  } else {
    console.log("imsg-plus Status Report")
    console.log("========================")
    console.log("\nBasic features (send, receive, history):\n  Available")
    console.log("\nAdvanced features (typing indicators, read receipts, contact-card balloons):")
    if (bridge.available) {
      console.log("  Available — IMCore framework loaded")
      console.log("\n  imsg-plus typing --handle <phone> --state on|off")
      console.log("  imsg-plus read --handle <phone>")
      console.log("  imsg-plus send --to <phone> --contact-card <path.vcf>")
    } else {
      console.log("  Not available")
      console.log("\n  To enable: disable SIP, run make build-dylib, grant Full Disk Access")
    }
  }
}

async function launchCmd() {
  const bridge = createBridge(args["--dylib"])
  const quiet = args["--quiet"] ?? false

  if (!quiet && !json) console.log("Killing Messages.app...")
  bridge.kill()

  if (args["--kill-only"]) {
    output({ success: true, action: "kill" }, quiet ? "" : "Messages.app terminated")
    return
  }

  if (!quiet && !json && bridge.dylibPath) console.log(`Using dylib: ${bridge.dylibPath}`)
  if (!quiet && !json) console.log("Launching Messages.app with injection...")

  try {
    await bridge.launch({ quiet })
    output(
      { success: true, action: "launch", dylib: bridge.dylibPath },
      quiet ? "" : "Messages.app launched with dylib injection"
    )
  } catch (err: any) {
    output({ success: false, error: err.message }, "")
    if (!json && !quiet) console.error(`Failed to launch: ${err.message}`)
    process.exit(1)
  }
}

async function reactCmd() {
  const to = args["--to"]
  if (!to) bail("--to is required")
  const guid = args["--guid"]
  if (!guid) bail("--guid is required")
  const type = args["--type"] as TapbackType
  if (!type) bail("--type is required (love, like, dislike, laugh, emphasis, question)")

  const service = parseService(args["--service"])
  await react({
    to,
    guid,
    type,
    service: service === "auto" ? undefined : service,
    region: args["--region"],
  })

  output({ status: "reacted", type }, `Sent ${type} reaction`)
}

async function cleanupCmd() {
  const removed = await cleanStagedAttachments()
  output({ removed }, `Removed ${removed} old staged attachment${removed === 1 ? "" : "s"}`)
}

function enqueueCmd() {
  const service = parseService(args["--service"])
  const queue = openQueue()
  const { job, duplicate } = queue.enqueue({
    to: args["--to"],
    chatId: args["--chat-id"],
    chatIdentifier: args["--chat-identifier"],
    chatGuid: args["--chat-guid"],
    text: args["--text"],
    file: args["--file"],
    service,
    region: args["--region"],
    maxAttempts: args["--retries"] ?? 3,
  })
  queue.close()
  output(
    { status: duplicate ? "duplicate" : "queued", id: job.id },
    duplicate ? `duplicate (existing job ${job.id})` : `queued (job ${job.id})`
  )
}

async function workerCmd() {
  const queue = openQueue()
  const db = openDB()
  const ac = new AbortController()

  process.on("SIGINT", () => ac.abort())
  process.on("SIGTERM", () => ac.abort())

  await runWorker(queue, db, {
    pollMs: args["--poll"] ?? 1000,
    signal: ac.signal,
    onSent: (job) => {
      if (json) console.log(JSON.stringify({ event: "sent", id: job.id }))
    },
    onFail: (job, error) => {
      if (json) console.log(JSON.stringify({ event: "failed", id: job.id, error, status: job.status }))
    },
  })

  queue.close()
}

function queueCmd() {
  const queue = openQueue()
  const sub = args._[1]

  if (sub === "purge") {
    const removed = queue.purge()
    queue.close()
    output({ removed }, `Purged ${removed} completed/failed job${removed === 1 ? "" : "s"}`)
    return
  }

  if (sub === "counts") {
    const counts = queue.counts()
    queue.close()
    if (json) console.log(JSON.stringify(counts))
    else {
      for (const [status, count] of Object.entries(counts)) {
        console.log(`${status}: ${count}`)
      }
    }
    return
  }

  // Default: list all jobs
  const jobs = queue.all()
  queue.close()
  for (const job of jobs) {
    if (json) {
      console.log(JSON.stringify(job))
    } else {
      const target = job.to ?? `chat:${job.chatId ?? job.chatIdentifier ?? job.chatGuid}`
      const text = (job.text ?? "(attachment)").slice(0, 50)
      console.log(`[${job.id}] ${job.status} → ${target}: ${text} (attempt ${job.attempts}/${job.maxAttempts})`)
    }
  }
}

async function rpcCmd() {
  const db = openDB()
  const bridge = createBridge()
  await serve(db, bridge, {
    verbose: args["--verbose"] ?? false,
    autoRead: args["--no-auto-read"] ? false : undefined,
    autoTyping: args["--no-auto-typing"] ? false : undefined,
  })
}

// --- Helpers ---

function openDB(): DB {
  return open(args["--db"])
}

function buildFilter() {
  return parseFilter({
    participants: args["--participants"],
    start: args["--start"],
    end: args["--end"],
  })
}

function bail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"))
    return process.env.IMSG_VERSION || pkg.version || "0.0.0"
  } catch {
    return process.env.IMSG_VERSION || "0.0.0"
  }
}

function help() {
  console.log(`imsg-plus ${getVersion()}
Send and read iMessage / SMS from the terminal

Usage:
  imsg-plus <command> [options]

Commands:
  chats       List recent conversations
  history     Show messages for a chat
  watch       Stream incoming messages
  send        Send a message (text and/or attachment)
  enqueue     Queue a message for background delivery (same args as send)
  worker      Run background worker to process the message queue
  queue       List queued jobs (subcommands: counts, purge)
  react       Send a tapback reaction (love, like, dislike, laugh, emphasis, question)
  cleanup     Remove old staged attachments
  typing      Control typing indicator
  read        Mark messages as read
  status      Check feature availability
  launch      Launch Messages.app with dylib injection
  rpc         Run JSON-RPC server over stdin/stdout

Global options:
  --json      Output as JSON lines
  --db <path> Path to chat.db (default: ~/Library/Messages/chat.db)

Run 'imsg-plus <command> --help' for command-specific options.`)
}
