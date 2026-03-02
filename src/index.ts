#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { open, type DB } from "./db.js"
import { send } from "./send.js"
import { watch } from "./watch.js"
import { createBridge } from "./bridge.js"
import { serve } from "./rpc.js"
import type { Message, Attachment, Filter } from "./types.js"

// --- Flag parsing ---

function parseFlags(args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue
    const key = args[i].slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

type Flags = Record<string, string | true>
function flag(f: Flags, key: string): boolean { return f[key] === true }
function str(f: Flags, key: string): string | undefined { const v = f[key]; return typeof v === "string" ? v : undefined }
function num(f: Flags, key: string): number | undefined { const v = str(f, key); return v ? Number(v) : undefined }

// --- Output helpers ---

function iso(date: Date): string {
  return date.toISOString()
}

function jsonl(obj: unknown) {
  console.log(JSON.stringify(obj))
}

// --- Main ---

const args = process.argv.slice(2)
const command = args[0]
const flags_ = parseFlags(args.slice(1))
const json = flag(flags_, "json")

main().catch((err) => {
  if (json) {
    jsonl({ error: err.message })
  } else {
    console.error(err.message ?? err)
  }
  process.exit(1)
})

async function main() {
  if (!command || command === "--help" || command === "-h") return help()
  if (command === "--version" || command === "-V") return version()

  switch (command) {
    case "chats": return await chatsCmd()
    case "history": return await historyCmd()
    case "watch": return await watchCmd()
    case "send": return await sendCmd()
    case "typing": return await typingCmd()
    case "read": return await readCmd()
    case "status": return statusCmd()
    case "launch": return launchCmd()
    case "rpc": return await rpcCmd()
    default:
      console.error(`Unknown command: ${command}\n`)
      help()
      process.exit(1)
  }
}

// --- Commands ---

async function chatsCmd() {
  const db = openDB()
  const limit = num(flags_, "limit") ?? 20
  const chats = db.chats(limit)

  if (json) {
    for (const chat of chats) jsonl({ id: chat.id, name: chat.name, identifier: chat.identifier, service: chat.service, last_message_at: iso(chat.lastMessageAt) })
  } else {
    for (const chat of chats) console.log(`[${chat.id}] ${chat.name} (${chat.identifier}) last=${iso(chat.lastMessageAt)}`)
  }
}

async function historyCmd() {
  const chatId = num(flags_, "chat-id")
  if (chatId == null) bail("--chat-id is required")

  const db = openDB()
  const limit = num(flags_, "limit") ?? 50
  const showAttachments = flag(flags_, "attachments")
  const filter = buildFilter()
  const messages = db.messages(chatId, { limit, filter })

  for (const msg of messages) {
    if (json) {
      const atts = db.attachments(msg.id)
      jsonl(messageJson(msg, atts))
    } else {
      const dir = msg.isFromMe ? "sent" : "recv"
      console.log(`${iso(msg.date)} [${dir}] ${msg.sender}: ${msg.text}`)
      if (msg.attachments > 0) {
        if (showAttachments) {
          for (const a of db.attachments(msg.id)) {
            console.log(`  attachment: name=${a.transferName || a.filename || "(unknown)"} mime=${a.mimeType} missing=${a.missing} path=${a.path}`)
          }
        } else {
          console.log(`  (${msg.attachments} attachment${msg.attachments === 1 ? "" : "s"})`)
        }
      }
    }
  }
}

async function watchCmd() {
  const db = openDB()
  const chatId = num(flags_, "chat-id")
  const sinceRowId = num(flags_, "since-rowid")
  const debounce = parseDebounce(str(flags_, "debounce") ?? "250ms")
  const showAttachments = flag(flags_, "attachments")
  const filter = buildFilter()

  for await (const msg of watch(db, { chatId, sinceRowId, debounce, filter })) {
    if (json) {
      const atts = showAttachments ? db.attachments(msg.id) : []
      jsonl(messageJson(msg, atts))
    } else {
      const dir = msg.isFromMe ? "sent" : "recv"
      console.log(`${iso(msg.date)} [${dir}] ${msg.sender}: ${msg.text}`)
      if (msg.attachments > 0 && showAttachments) {
        for (const a of db.attachments(msg.id)) {
          console.log(`  attachment: name=${a.transferName || a.filename || "(unknown)"} mime=${a.mimeType} missing=${a.missing} path=${a.path}`)
        }
      }
    }
  }
}

async function sendCmd() {
  const db = openDB()
  await send({
    to: str(flags_, "to"),
    chatId: num(flags_, "chat-id"),
    chatIdentifier: str(flags_, "chat-identifier"),
    chatGuid: str(flags_, "chat-guid"),
    text: str(flags_, "text"),
    file: str(flags_, "file"),
    service: str(flags_, "service") as any,
    region: str(flags_, "region"),
  }, db)

  if (json) jsonl({ status: "sent" })
  else console.log("sent")
}

async function typingCmd() {
  const handle = str(flags_, "handle")
  if (!handle) bail("--handle is required")
  const state = str(flags_, "state")
  if (state !== "on" && state !== "off") bail("--state must be 'on' or 'off'")

  const bridge = createBridge()
  if (!bridge.available) return bail("dylib not found — run: make build-dylib")

  await bridge.setTyping(handle, state === "on")

  if (json) {
    jsonl({ success: true, handle, typing: state === "on" })
  } else {
    console.log(`Typing indicator ${state === "on" ? "enabled" : "disabled"} for ${handle}`)
  }
}

async function readCmd() {
  const handle = str(flags_, "handle")
  if (!handle) bail("--handle is required")

  const bridge = createBridge()
  if (!bridge.available) return bail("dylib not found — run: make build-dylib")

  await bridge.markRead(handle)

  if (json) {
    jsonl({ success: true, handle, marked_as_read: true })
  } else {
    console.log(`Marked messages as read for ${handle}`)
  }
}

function statusCmd() {
  const bridge = createBridge()

  if (json) {
    jsonl({
      basic_features: true,
      advanced_features: bridge.available,
      typing_indicators: bridge.available,
      read_receipts: bridge.available,
    })
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
  const bridge = createBridge(str(flags_, "dylib"))
  const killOnly = flag(flags_, "kill-only")
  const quiet = flag(flags_, "quiet")

  if (!quiet && !json) console.log("Killing Messages.app...")
  bridge.kill()

  if (killOnly) {
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

async function rpcCmd() {
  const db = openDB()
  const bridge = createBridge()
  await serve(db, bridge, {
    verbose: flag(flags_, "verbose"),
    autoRead: flag(flags_, "no-auto-read") ? false : undefined,
    autoTyping: flag(flags_, "no-auto-typing") ? false : undefined,
  })
}

// --- Helpers ---

function openDB(): DB {
  return open(str(flags_, "db"))
}

function buildFilter(): Filter | undefined {
  const participants = str(flags_, "participants")?.split(",").map(s => s.trim()).filter(Boolean)
  const after = str(flags_, "start") ? new Date(str(flags_, "start")!) : undefined
  const before = str(flags_, "end") ? new Date(str(flags_, "end")!) : undefined
  if (!participants?.length && !after && !before) return undefined
  return { participants, after, before }
}

function messageJson(msg: Message, attachments: Attachment[]) {
  return {
    id: msg.id,
    chat_id: msg.chatId,
    guid: msg.guid,
    ...(msg.replyToGuid ? { reply_to_guid: msg.replyToGuid } : {}),
    sender: msg.sender,
    is_from_me: msg.isFromMe,
    text: msg.text,
    created_at: iso(msg.date),
    attachments: attachments.map(a => ({
      filename: a.filename,
      transfer_name: a.transferName,
      uti: a.uti,
      mime_type: a.mimeType,
      total_bytes: a.totalBytes,
      is_sticker: a.isSticker,
      original_path: a.path,
      missing: a.missing,
    })),
  }
}

function parseDebounce(value: string): number {
  const units: [string, number][] = [["ms", 1], ["s", 1000], ["m", 60000], ["h", 3600000]]
  for (const [suffix, mult] of units) {
    if (value.endsWith(suffix)) {
      const n = Number(value.slice(0, -suffix.length))
      return isNaN(n) ? 250 : n * mult
    }
  }
  const n = Number(value)
  return isNaN(n) ? 250 : n
}

function bail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function help() {
  const v = version(true)
  console.log(`imsg-plus ${v}
Send and read iMessage / SMS from the terminal

Usage:
  imsg-plus <command> [options]

Commands:
  chats       List recent conversations
  history     Show messages for a chat
  watch       Stream incoming messages
  send        Send a message (text and/or attachment)
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

function version(returnOnly?: boolean): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"))
    const v = process.env.IMSG_VERSION || pkg.version || "0.0.0"
    if (!returnOnly) console.log(v)
    return v
  } catch {
    const v = process.env.IMSG_VERSION || "0.0.0"
    if (!returnOnly) console.log(v)
    return v
  }
}
