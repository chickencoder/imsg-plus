import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
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
  const to = opts.to ?? ""
  let chatId = opts.chatId ?? null
  let chatIdentifier = opts.chatIdentifier ?? ""
  let chatGuid = opts.chatGuid ?? ""
  const text = opts.text ?? ""
  const file = opts.file ?? ""
  const service = opts.service ?? "auto"
  const region = opts.region ?? "US"

  const hasChat = chatId != null || chatIdentifier !== "" || chatGuid !== ""
  if (hasChat && to) throw new Error("Use --to or --chat-*, not both")
  if (!hasChat && !to) throw new Error("--to is required for direct sends")
  if (!text && !file) throw new Error("--text or --file is required")

  // Resolve chat target from chat-id
  if (chatId != null && db) {
    const info = db.chatInfo(chatId)
    if (!info) throw new Error(`Unknown chat id ${chatId}`)
    chatIdentifier = info.identifier
    chatGuid = info.guid
  }

  // Figure out routing: chat-based or direct send
  let recipient = to
  let useChat = false
  let target = ""

  if (hasChat) {
    if (chatIdentifier && looksLikeHandle(chatIdentifier)) {
      // It's really a direct handle, not a group chat
      recipient = recipient || chatIdentifier
    } else if (chatGuid) {
      useChat = true
      target = chatGuid
    } else if (chatIdentifier) {
      useChat = true
      target = chatIdentifier
    } else {
      throw new Error("Missing chat identifier or guid")
    }
  }

  // Normalize phone number for direct sends
  if (!useChat) {
    recipient = normalize(recipient, region)
  }

  // Stage attachment
  const attachment = file ? stage(file) : ""

  // Build and run AppleScript
  await osascript(SEND_SCRIPT, [
    recipient,
    text.trim(),
    useChat ? service : service === "auto" ? "imessage" : service,
    attachment,
    attachment ? "1" : "0",
    target,
    useChat ? "1" : "0",
  ])
}

function normalize(input: string, region: string): string {
  try {
    const parsed = parsePhoneNumber(input, region as any)
    return parsed?.format("E.164") ?? input
  } catch {
    return input
  }
}

function looksLikeHandle(value: string): boolean {
  if (!value) return false
  const lower = value.toLowerCase()
  if (lower.startsWith("imessage:") || lower.startsWith("sms:") || lower.startsWith("auto:")) return true
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
