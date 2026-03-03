import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { parsePhoneNumber } from "libphonenumber-js"
import type { DB } from "./db.js"

export interface SendOptions {
  to?: string
  chatId?: number
  chatIdentifier?: string
  chatGuid?: string
  text?: string
  file?: string
  service?: "imessage" | "sms" | "auto"
  region?: string
}

export async function send(opts: SendOptions, db?: DB): Promise<void> {
  if (!opts.text && !opts.file) throw new Error("--text or --file is required")

  const { recipient, chatTarget, service } = resolveTarget(opts, db)
  const attachment = opts.file ? stage(opts.file) : ""

  // Clean up old staged attachments in the background (don't block the send)
  cleanStagedAttachments().catch(() => {})

  await osascript(SEND_SCRIPT, [
    recipient,
    (opts.text ?? "").trim(),
    service,
    attachment,
    attachment ? "1" : "0",
    chatTarget,
    chatTarget ? "1" : "0",
  ])
}

// --- Attachment cleanup ---

const STAGED_DIR = join(homedir(), "Library/Messages/Attachments/imsg")

export async function cleanStagedAttachments(maxAgeMs = 3600000): Promise<number> {
  if (!existsSync(STAGED_DIR)) return 0

  const now = Date.now()
  let removed = 0

  for (const entry of readdirSync(STAGED_DIR)) {
    const dirPath = join(STAGED_DIR, entry)
    try {
      const age = now - statSync(dirPath).mtimeMs
      if (age > maxAgeMs) {
        rmSync(dirPath, { recursive: true, force: true })
        removed++
      }
    } catch {
      // Directory may have been removed between listing and stat — that's fine
    }
  }

  return removed
}

// --- Reactions ---

export type TapbackType = "love" | "like" | "dislike" | "laugh" | "emphasis" | "question"

const TAPBACK_MAP: Record<TapbackType, number> = {
  love: 2000,
  like: 2001,
  dislike: 2002,
  laugh: 2003,
  emphasis: 2004,
  question: 2005,
}

export interface ReactOptions {
  to: string
  guid: string
  type: TapbackType
  service?: "imessage" | "sms"
  region?: string
}

export async function react(opts: ReactOptions): Promise<void> {
  if (!TAPBACK_MAP[opts.type]) throw new Error(`Unknown tapback type: ${opts.type}`)

  const service = opts.service ?? "imessage"
  const recipient = normalize(opts.to, opts.region ?? "US")
  const tapbackIndex = TAPBACK_MAP[opts.type]

  await osascript(REACT_SCRIPT, [recipient, opts.guid, String(tapbackIndex), service])
}

const REACT_SCRIPT = `
on run argv
    set theRecipient to item 1 of argv
    set theGuid to item 2 of argv
    set tapbackType to item 3 of argv as integer
    set theService to item 4 of argv

    tell application "Messages"
        if theService is "sms" then
            set targetService to first service whose service type is SMS
        else
            set targetService to first service whose service type is iMessage
        end if
        set targetBuddy to buddy theRecipient of targetService
        send theGuid to targetBuddy with tapback tapbackType
    end tell
end run
`.trim()

// Pure function: options in → exactly one of recipient/chatTarget out

function resolveTarget(opts: SendOptions, db?: DB) {
  const service = opts.service ?? "auto"
  const region = opts.region ?? "US"
  const directService = service === "auto" ? "imessage" : service
  const hasChat = opts.chatId != null || opts.chatIdentifier || opts.chatGuid

  if (opts.to && hasChat) throw new Error("Use --to or --chat-*, not both")
  if (!opts.to && !hasChat) throw new Error("--to or --chat-id is required")

  // Direct send to a phone/email
  if (opts.to) {
    return { recipient: normalize(opts.to, region), chatTarget: "", service: directService }
  }

  // Look up chat by numeric ID
  let identifier = opts.chatIdentifier ?? ""
  let guid = opts.chatGuid ?? ""
  if (opts.chatId != null) {
    const info = db?.chatInfo(opts.chatId)
    if (!info) throw new Error(`Unknown chat id ${opts.chatId}`)
    identifier = info.identifier
    guid = info.guid
  }

  // If the identifier is really just a phone/email, send directly
  if (identifier && looksLikeHandle(identifier)) {
    return { recipient: normalize(identifier, region), chatTarget: "", service: directService }
  }

  // Chat-based send (group chats, named chats)
  const target = guid || identifier
  if (!target) throw new Error("Missing chat identifier or guid")
  return { recipient: "", chatTarget: target, service }
}

function normalize(input: string, region: string): string {
  try {
    return parsePhoneNumber(input, region as any)?.format("E.164") ?? input
  } catch {
    return input
  }
}

function looksLikeHandle(value: string): boolean {
  if (value.includes("@")) return true
  return /^[+\d\s()\-]+$/.test(value)
}

function stage(filePath: string): string {
  const src = resolve(filePath.replace(/^~/, homedir()))
  if (!existsSync(src)) throw new Error(`Attachment not found: ${src}`)

  const dir = join(homedir(), "Library/Messages/Attachments/imsg", randomUUID())
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, basename(src))
  copyFileSync(src, dest)
  return dest
}

function osascript(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-l", "AppleScript", "-", ...args])
    let stderr = ""
    child.stderr?.on("data", (d: Buffer) => (stderr += d))
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `osascript exited with code ${code}`))
    })
    child.stdin?.end(script)
  })
}

const SEND_SCRIPT = `
on run argv
    set theRecipient to item 1 of argv
    set theMessage to item 2 of argv
    set theService to item 3 of argv
    set theFilePath to item 4 of argv
    set useAttachment to item 5 of argv
    set chatId to item 6 of argv
    set useChat to item 7 of argv

    tell application "Messages"
        if useChat is "1" then
            set targetChat to chat id chatId
            if theMessage is not "" then
                send theMessage to targetChat
            end if
            if useAttachment is "1" then
                set theFile to POSIX file theFilePath as alias
                send theFile to targetChat
            end if
        else
            if theService is "sms" then
                set targetService to first service whose service type is SMS
            else
                set targetService to first service whose service type is iMessage
            end if
            set targetBuddy to buddy theRecipient of targetService
            if theMessage is not "" then
                send theMessage to targetBuddy
            end if
            if useAttachment is "1" then
                set theFile to POSIX file theFilePath as alias
                send theFile to targetBuddy
            end if
        end if
    end tell
end run
`.trim()
