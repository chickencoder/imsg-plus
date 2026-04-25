import { execFile, execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { parsePhoneNumber } from "libphonenumber-js"
import type { Bridge } from "./bridge.js"
import type { DB } from "./db.js"
import type { Service } from "./types.js"

export interface SendOptions {
  to?: string
  chatId?: number
  chatIdentifier?: string
  chatGuid?: string
  text?: string
  file?: string
  service?: Service
  region?: string
}

export async function send(opts: SendOptions, db?: DB): Promise<void> {
  if (!opts.text && !opts.file) throw new Error("--text or --file is required")

  const { recipient, chatTarget, service } = pickRecipient(opts, db)
  // The RPC `send` handler stages the file at enqueue time so the source
  // can disappear before the worker runs (the original caller may have
  // pointed us at a temp file they're about to clean up). Detect that and
  // skip re-staging — re-staging an already-staged file would create a
  // second redundant copy and break attachment-cleanup invariants.
  const attachment = opts.file
    ? (isAlreadyStaged(opts.file) ? resolve(opts.file.replace(/^~/, homedir())) : stage(opts.file))
    : ""

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

// --- Voice-note send (native audio message) ---

export interface VoiceNoteOptions {
  to?: string
  chatId?: number
  chatIdentifier?: string
  chatGuid?: string
  voiceNote: string
  service?: Service
  region?: string
  /** Test seam: stub the afconvert invocation. */
  runAfconvert?: (args: string[]) => void
}

// Sends an audio file as a native iMessage voice note (waveform balloon with
// play button), not a generic file pill. Bypasses AppleScript and goes through
// the dylib bridge so the audio-message flag bit (0x200000) can be set on the
// IMMessage at construction time. Hard-fails when the dylib path isn't
// available.
//
// We always transcode the input to CAF/Opus mono 24 kHz and stage it as
// `Audio Message.caf` — the format Apple's own voice notes use over iMessage.
// PCM (LEI16) inside a CAF container delivers OK but the receiver renders an
// empty bubble: Messages.app on the receive side decodes voice notes as Opus
// and silently ignores the attachment otherwise. Verified empirically against
// chat.db on Sequoia: Apple-recorded voice notes have uti=public.opus-audio /
// data format=opus inside caff.
export async function sendVoiceNote(
  opts: VoiceNoteOptions,
  bridge: Bridge,
  db?: DB
): Promise<void> {
  if (!opts.voiceNote) throw new Error("--voice-note path is required")

  const service = opts.service ?? "imessage"
  if (service === "sms") {
    throw new Error("voice notes do not render over SMS; use --service imessage")
  }

  const { recipient, chatTarget } = pickRecipient(
    {
      to: opts.to,
      chatId: opts.chatId,
      chatIdentifier: opts.chatIdentifier,
      chatGuid: opts.chatGuid,
      service,
      region: opts.region,
      // pickRecipient requires text or file in the SendOptions sense, but
      // we're only using it for target resolution — pass a placeholder.
      text: " ",
    },
    db
  )
  const target = chatTarget || recipient
  if (!target) throw new Error("missing recipient or chat target")

  const srcPath = resolve(opts.voiceNote.replace(/^~/, homedir()))
  if (!existsSync(srcPath)) throw new Error(`audio not found: ${srcPath}`)

  const stagedPath = transcodeToCaf(srcPath, opts.runAfconvert)

  await bridge.sendVoiceNote(target, stagedPath)
}

// Transcodes any audio source to the CAF/Opus format Messages.app expects on
// the receive side (Opus, mono, 24 kHz) and stages it under the standard imsg
// attachment dir with the canonical filename `Audio Message.caf`. Returns the
// staged path.
//
// Recipe rationale: this is the codec Apple itself uses for voice notes
// over iMessage (verified by inspecting received voice notes — caff
// container, opus data format, mono, 24 kHz). The receiver-side waveform
// renderer in Messages.app appears to require Opus specifically; PCM
// (LEI16) inside a CAF container delivers but renders as an empty bubble.
// afconvert ships with Opus support natively (no ffmpeg dependency).
//
// `runAfconvert` is injectable so tests can stub the binary call without
// spying on ESM module namespaces.
export function transcodeToCaf(
  srcPath: string,
  runAfconvert: (args: string[]) => void = defaultRunAfconvert
): string {
  const dir = join(homedir(), "Library/Messages/Attachments/imsg", randomUUID())
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, "Audio Message.caf")
  const tmpDest = join(dir, ".tmp-Audio Message.caf")

  try {
    runAfconvert(["-f", "caff", "-d", "opus", "-c", "1", srcPath, tmpDest])
  } catch (err: any) {
    rmSync(dir, { recursive: true, force: true })
    const stderr = err.stderr?.toString().trim() || err.message
    throw new Error(`afconvert failed: ${stderr}`)
  }

  renameSync(tmpDest, dest)
  return dest
}

function defaultRunAfconvert(args: string[]): void {
  execFileSync("/usr/bin/afconvert", args, { stdio: ["ignore", "ignore", "pipe"] })
}

// --- Attachment cleanup ---

const STAGED_DIR = join(homedir(), "Library/Messages/Attachments/imsg")

function isAlreadyStaged(filePath: string): boolean {
  const real = resolve(filePath.replace(/^~/, homedir()))
  return real.startsWith(STAGED_DIR + "/")
}

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
    } catch (err: any) {
      process.stderr.write(`[cleanup] failed to remove ${dirPath}: ${err.message}\n`)
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

export function pickRecipient(opts: SendOptions, db?: DB) {
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
    const info = db?.chat(opts.chatId)
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

export function normalize(input: string, region: string): string {
  try {
    return parsePhoneNumber(input, region as any)?.format("E.164") ?? input
  } catch {
    return input
  }
}

export function looksLikeHandle(value: string): boolean {
  if (value.includes("@")) return true
  return /^[+\d\s()\-]+$/.test(value)
}

export function stage(filePath: string): string {
  const src = resolve(filePath.replace(/^~/, homedir()))
  if (!existsSync(src)) throw new Error(`Attachment not found: ${src}`)

  const dir = join(homedir(), "Library/Messages/Attachments/imsg", randomUUID())
  mkdirSync(dir, { recursive: true })
  const tmpDest = join(dir, `.tmp-${basename(src)}`)
  const dest = join(dir, basename(src))

  // Stage atomically: copy to .tmp path first, rename on success
  copyFileSync(src, tmpDest)
  renameSync(tmpDest, dest)
  return dest
}

// Parse AppleScript error numbers from stderr into readable messages
const APPLESCRIPT_ERRORS: Record<number, string> = {
  [-1728]: "Messages.app cannot find the specified recipient",
  [-1712]: "AppleScript timed out waiting for Messages.app",
  [-10004]: "Messages.app is not available or not responding",
  [-1708]: "Messages.app does not understand the command (may need a newer macOS version)",
}

function osascript(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-l", "AppleScript", "-", ...args])
    let stderr = ""
    child.stderr?.on("data", (d: Buffer) => (stderr += d))
    child.on("close", (code) => {
      if (code === 0) return resolve()

      const trimmed = stderr.trim()
      const match = trimmed.match(/\((-?\d+)\)/)
      if (match) {
        const errorNum = parseInt(match[1], 10)
        const readable = APPLESCRIPT_ERRORS[errorNum]
        if (readable) return reject(new Error(`${readable} (error ${errorNum})`))
      }
      reject(new Error(trimmed || `osascript exited with code ${code}`))
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
