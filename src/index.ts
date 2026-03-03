#!/usr/bin/env node

import arg from "arg"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { open, type DB } from "./db.js"
import { send, react, cleanStagedAttachments, type TapbackType } from "./send.js"
import { watch } from "./watch.js"
import { createBridge } from "./bridge.js"
import { serve } from "./rpc.js"
import { messageToJSON } from "./json.js"
import type { Message, Filter } from "./types.js"

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
    "--debounce": String,
    "--to": String,
    "--text": String,
    "--file": String,
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
    "-h": "--help",
    "-V": "--version",
  },
  { permissive: true }
)

const [command] = args._
const json = args["--json"] ?? false

// --- Output ---

const jsonl = (obj: unknown) => console.log(JSON.stringify(obj))

function printMessage(msg: Message, db: DB) {
  if (json) {
    jsonl(messageToJSON(msg, args["--attachments"] ? db.attachments(msg.id) : []))
  } else {
    const dir = msg.isFromMe ? "sent" : "recv"
    console.log(`${msg.date.toISOString()} [${dir}] ${msg.sender}: ${msg.text}`)
    if (msg.attachments > 0 && args["--attachments"]) {
      for (const a of db.attachments(msg.id)) {
        console.log(`  ${a.transferName || a.filename || "(unknown)"} — ${a.mimeType}${a.missing ? " (missing)" : ""}`)
      }
    } else if (msg.attachments > 0 && !json) {
      console.log(`  (${msg.attachments} attachment${msg.attachments === 1 ? "" : "s"})`)
    }
  }
}

// --- Main ---

main().catch((err) => {
  if (json) jsonl({ error: err.message })
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
    if (json) jsonl({ id: c.id, name: c.name, identifier: c.identifier, service: c.service, last_message_at: c.lastMessageAt.toISOString() })
    else console.log(`[${c.id}] ${c.name} (${c.identifier}) last=${c.lastMessageAt.toISOString()}`)
  }
}

function historyCmd() {
  const chatId = args["--chat-id"]
  if (chatId == null) bail("--chat-id is required")

  const db = openDB()
  for (const msg of db.messages(chatId, { limit: args["--limit"] ?? 50, filter: buildFilter() })) {
    printMessage(msg, db)
  }
}

async function watchCmd() {
  const db = openDB()
  for await (const msg of watch(db, {
    chatId: args["--chat-id"] ?? undefined,
    sinceRowId: args["--since-rowid"] ?? undefined,
    debounce: parseDebounce(args["--debounce"] ?? "250ms"),
    filter: buildFilter(),
  })) {
    printMessage(msg, db)
  }
}

async function sendCmd() {
  await send(
    {
      to: args["--to"] ?? undefined,
      chatId: args["--chat-id"] ?? undefined,
      chatIdentifier: args["--chat-identifier"] ?? undefined,
      chatGuid: args["--chat-guid"] ?? undefined,
      text: args["--text"] ?? undefined,
      file: args["--file"] ?? undefined,
      service: args["--service"] as any,
      region: args["--region"] ?? undefined,
    },
    openDB()
  )
  if (json) jsonl({ status: "sent" })
  else console.log("sent")
}

async function typingCmd() {
  const handle = args["--handle"]
  if (!handle) bail("--handle is required")
  const state = args["--state"]
  if (state !== "on" && state !== "off") bail("--state must be 'on' or 'off'")

  const bridge = createBridge()
  if (!bridge.available) bail("dylib not found — run: make build-dylib")
  await bridge.setTyping(handle, state === "on")

  if (json) jsonl({ success: true, handle, typing: state === "on" })
  else console.log(`Typing indicator ${state === "on" ? "enabled" : "disabled"} for ${handle}`)
}

async function readCmd() {
  const handle = args["--handle"]
  if (!handle) bail("--handle is required")

  const bridge = createBridge()
  if (!bridge.available) bail("dylib not found — run: make build-dylib")
  await bridge.markRead(handle)

  if (json) jsonl({ success: true, handle, marked_as_read: true })
  else console.log(`Marked messages as read for ${handle}`)
}

function statusCmd() {
  const bridge = createBridge()
  if (json) {
    jsonl({ basic_features: true, advanced_features: bridge.available, typing_indicators: bridge.available, read_receipts: bridge.available })
  } else {
    console.log("imsg-plus Status Report")
    console.log("========================")
    console.log("\nBasic features (send, receive, history):\n  Available")
    console.log("\nAdvanced features (typing indicators, read receipts):")
    if (bridge.available) {
      console.log("  Available — IMCore framework loaded")
      console.log("\n  imsg-plus typing --handle <phone> --state on|off")
      console.log("  imsg-plus read --handle <phone>")
    } else {
      console.log("  Not available")
      console.log("\n  To enable: disable SIP, run make build-dylib, grant Full Disk Access")
    }
  }
}

function launchCmd() {
  const bridge = createBridge(args["--dylib"] ?? undefined)
  const quiet = args["--quiet"] ?? false

  if (!quiet && !json) console.log("Killing Messages.app...")
  bridge.kill()

  if (args["--kill-only"]) {
    if (json) jsonl({ success: true, action: "kill" })
    else if (!quiet) console.log("Messages.app terminated")
    return
  }

  if (!quiet && !json && bridge.dylibPath) console.log(`Using dylib: ${bridge.dylibPath}`)
  if (!quiet && !json) console.log("Launching Messages.app with injection...")

  try {
    bridge.launch({ quiet })
    if (json) jsonl({ success: true, action: "launch", dylib: bridge.dylibPath })
    else if (!quiet) console.log("Messages.app launched with dylib injection")
  } catch (err: any) {
    if (json) jsonl({ success: false, error: err.message })
    else if (!quiet) console.error(`Failed to launch: ${err.message}`)
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

  await react({
    to,
    guid,
    type,
    service: args["--service"] as any,
    region: args["--region"] ?? undefined,
  })

  if (json) jsonl({ status: "reacted", type })
  else console.log(`Sent ${type} reaction`)
}

async function cleanupCmd() {
  const removed = await cleanStagedAttachments()
  if (json) jsonl({ removed })
  else console.log(`Removed ${removed} old staged attachment${removed === 1 ? "" : "s"}`)
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
  return open(args["--db"] ?? undefined)
}

function buildFilter(): Filter | undefined {
  const participants = args["--participants"]?.split(",").map((s) => s.trim()).filter(Boolean)
  const after = args["--start"] ? new Date(args["--start"]) : undefined
  const before = args["--end"] ? new Date(args["--end"]) : undefined
  if (!participants?.length && !after && !before) return undefined
  return { participants, after, before }
}

function parseDebounce(value: string): number {
  const units: [string, number][] = [["ms", 1], ["s", 1000], ["m", 60000]]
  for (const [suffix, mult] of units) {
    if (value.endsWith(suffix)) return (Number(value.slice(0, -suffix.length)) || 250) * mult
  }
  return Number(value) || 250
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
