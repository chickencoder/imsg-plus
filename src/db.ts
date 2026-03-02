import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Chat, ChatInfo, Message, Attachment, Filter } from "./types.js"

const APPLE_EPOCH = 978307200
const NANOS = 1e9
const DEFAULT_PATH = join(homedir(), "Library/Messages/chat.db")

function toDate(nanos: number | null): Date {
  if (!nanos) return new Date(APPLE_EPOCH * 1000)
  return new Date((nanos / NANOS + APPLE_EPOCH) * 1000)
}

function toNanos(date: Date): number {
  return (date.getTime() / 1000 - APPLE_EPOCH) * NANOS
}

export type DB = ReturnType<typeof open>

export function open(path = DEFAULT_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `Cannot open ${path}\n\n` +
        "Grant Full Disk Access to your terminal:\n" +
        "  System Settings → Privacy & Security → Full Disk Access\n"
    )
  }

  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma("busy_timeout = 5000")

  const has = detect(db)

  return {
    path,
    chats,
    chatInfo,
    participants,
    messages,
    messagesAfter,
    attachments,
    maxRowId,
    close: (): void => { db.close() },
  }

  function chats(limit = 20): Chat[] {
    return db
      .prepare(
        `SELECT c.ROWID as id,
            IFNULL(c.display_name, c.chat_identifier) as name,
            c.chat_identifier as identifier,
            c.service_name as service,
            MAX(m.date) as lastDate
         FROM chat c
         JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
         JOIN message m ON m.ROWID = cmj.message_id
         GROUP BY c.ROWID
         ORDER BY lastDate DESC
         LIMIT ?`
      )
      .all(limit)
      .map((r: any) => ({
        id: r.id,
        identifier: r.identifier,
        name: r.name,
        service: r.service,
        lastMessageAt: toDate(r.lastDate),
      }))
  }

  function chatInfo(chatId: number): ChatInfo | null {
    const r: any = db
      .prepare(
        `SELECT c.ROWID as id,
            IFNULL(c.chat_identifier, '') as identifier,
            IFNULL(c.guid, '') as guid,
            IFNULL(c.display_name, c.chat_identifier) as name,
            IFNULL(c.service_name, '') as service
         FROM chat c WHERE c.ROWID = ? LIMIT 1`
      )
      .get(chatId)
    return r ? { id: r.id, identifier: r.identifier, guid: r.guid, name: r.name, service: r.service } : null
  }

  function participants(chatId: number): string[] {
    return db
      .prepare(
        `SELECT h.id as handle
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
         WHERE chj.chat_id = ?
         ORDER BY h.id ASC`
      )
      .all(chatId)
      .map((r: any) => r.handle as string)
      .filter((h, i, arr) => h && arr.indexOf(h) === i)
  }

  function messages(chatId: number, opts: { limit?: number; filter?: Filter } = {}): Message[] {
    const limit = opts.limit ?? 50
    const f = opts.filter
    const bindings: any[] = [chatId]

    let where = ""
    if (f?.after) {
      where += " AND m.date >= ?"
      bindings.push(toNanos(f.after))
    }
    if (f?.before) {
      where += " AND m.date < ?"
      bindings.push(toNanos(f.before))
    }
    if (f?.participants?.length) {
      const ph = f.participants.map(() => "?").join(",")
      where += ` AND COALESCE(NULLIF(h.id,''), ${has.destinationCallerId ? "m.destination_caller_id" : "''"}) COLLATE NOCASE IN (${ph})`
      bindings.push(...f.participants)
    }
    bindings.push(limit)

    return db
      .prepare(
        `SELECT m.ROWID as id, m.handle_id as handleId, h.id as sender,
            IFNULL(m.text, '') as text, m.date as dateNanos, m.is_from_me as isFromMe,
            m.service, ${col(has, "audioMessage")} as isAudio,
            ${col(has, "destinationCallerId")} as destCaller,
            ${col(has, "guid")} as guid, ${col(has, "associatedGuid")} as assocGuid,
            ${col(has, "associatedType")} as assocType,
            (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) as attachCount,
            ${col(has, "body")} as body
         FROM message m
         JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
         LEFT JOIN handle h ON m.handle_id = h.ROWID
         WHERE cmj.chat_id = ?${reactionFilter(has)}${where}
         ORDER BY m.date DESC LIMIT ?`
      )
      .all(...bindings)
      .map((r: any) => parseRow(r, chatId, has, db))
  }

  function messagesAfter(afterRowId: number, opts: { chatId?: number; limit?: number } = {}): Message[] {
    const limit = opts.limit ?? 100
    const bindings: any[] = [afterRowId]
    let chatWhere = ""
    if (opts.chatId != null) {
      chatWhere = " AND cmj.chat_id = ?"
      bindings.push(opts.chatId)
    }
    bindings.push(limit)

    return db
      .prepare(
        `SELECT m.ROWID as id, cmj.chat_id as chatId, m.handle_id as handleId,
            h.id as sender, IFNULL(m.text, '') as text, m.date as dateNanos,
            m.is_from_me as isFromMe, m.service,
            ${col(has, "audioMessage")} as isAudio,
            ${col(has, "destinationCallerId")} as destCaller,
            ${col(has, "guid")} as guid, ${col(has, "associatedGuid")} as assocGuid,
            ${col(has, "associatedType")} as assocType,
            (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) as attachCount,
            ${col(has, "body")} as body
         FROM message m
         LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
         LEFT JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ?${reactionFilter(has)}${chatWhere}
         ORDER BY m.ROWID ASC LIMIT ?`
      )
      .all(...bindings)
      .map((r: any) => parseRow(r, r.chatId ?? opts.chatId ?? 0, has, db))
  }

  function attachments(messageId: number): Attachment[] {
    return db
      .prepare(
        `SELECT a.filename, a.transfer_name as transferName, a.uti,
            a.mime_type as mimeType, a.total_bytes as totalBytes, a.is_sticker as isSticker
         FROM message_attachment_join maj
         JOIN attachment a ON a.ROWID = maj.attachment_id
         WHERE maj.message_id = ?`
      )
      .all(messageId)
      .map((r: any) => {
        const resolved = resolvePath(r.filename ?? "")
        return {
          filename: r.filename ?? "",
          transferName: r.transferName ?? "",
          uti: r.uti ?? "",
          mimeType: r.mimeType ?? "",
          totalBytes: Number(r.totalBytes ?? 0),
          isSticker: !!r.isSticker,
          path: resolved.path,
          missing: resolved.missing,
        }
      })
  }

  function maxRowId(): number {
    const r: any = db.prepare("SELECT MAX(ROWID) as id FROM message").get()
    return Number(r?.id ?? 0)
  }
}

// --- Schema detection ---

interface Schema {
  attributedBody: boolean
  reactionColumns: boolean
  destinationCallerId: boolean
  audioMessage: boolean
  attachmentUserInfo: boolean
}

function detect(db: Database.Database): Schema {
  const msgCols = columnNames(db, "message")
  const attCols = columnNames(db, "attachment")
  return {
    attributedBody: msgCols.has("attributedbody"),
    reactionColumns:
      msgCols.has("guid") && msgCols.has("associated_message_guid") && msgCols.has("associated_message_type"),
    destinationCallerId: msgCols.has("destination_caller_id"),
    audioMessage: msgCols.has("is_audio_message"),
    attachmentUserInfo: attCols.has("user_info"),
  }
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows: any[] = db.prepare(`PRAGMA table_info(${table})`).all()
  return new Set(rows.map((r) => (r.name as string).toLowerCase()))
}

function col(has: Schema, name: string): string {
  switch (name) {
    case "body":
      return has.attributedBody ? "m.attributedBody" : "NULL"
    case "guid":
      return has.reactionColumns ? "m.guid" : "NULL"
    case "associatedGuid":
      return has.reactionColumns ? "m.associated_message_guid" : "NULL"
    case "associatedType":
      return has.reactionColumns ? "m.associated_message_type" : "NULL"
    case "destinationCallerId":
      return has.destinationCallerId ? "m.destination_caller_id" : "NULL"
    case "audioMessage":
      return has.audioMessage ? "m.is_audio_message" : "0"
    default:
      return "NULL"
  }
}

function reactionFilter(has: Schema): string {
  if (!has.reactionColumns) return ""
  return " AND (m.associated_message_type IS NULL OR m.associated_message_type < 2000 OR m.associated_message_type > 3006)"
}

// --- Row parsing ---

function parseRow(r: any, chatId: number, has: Schema, db: Database.Database): Message {
  let sender: string = r.sender ?? ""
  if (!sender && r.destCaller) sender = r.destCaller

  let text: string = r.text
  if (!text && r.body) text = parseAttributedBody(r.body)
  if (r.isAudio && has.attachmentUserInfo) {
    const t = audioTranscription(db, r.id)
    if (t) text = t
  }

  return {
    id: r.id,
    chatId,
    guid: r.guid ?? "",
    replyToGuid: extractReplyGuid(r.assocGuid, r.assocType),
    sender,
    text,
    date: toDate(r.dateNanos),
    isFromMe: !!r.isFromMe,
    service: r.service ?? "",
    attachments: r.attachCount ?? 0,
  }
}

function extractReplyGuid(guid: string | null, type: number | null): string | null {
  if (!guid) return null
  const slash = guid.lastIndexOf("/")
  const normalized = slash >= 0 && slash < guid.length - 1 ? guid.slice(slash + 1) : guid
  if (!normalized) return null
  if (type != null && type >= 2000 && type <= 3006) return null
  return normalized
}

function audioTranscription(db: Database.Database, messageId: number): string | null {
  const r: any = db
    .prepare(
      `SELECT a.user_info FROM message_attachment_join maj
       JOIN attachment a ON a.ROWID = maj.attachment_id
       WHERE maj.message_id = ? LIMIT 1`
    )
    .get(messageId)
  if (!r?.user_info) return null
  try {
    // user_info is a binary plist — use macOS plutil to parse it
    const { execFileSync } = require("node:child_process")
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: r.user_info,
      encoding: "utf8",
    })
    const data = JSON.parse(json)
    return data["audio-transcription"] || null
  } catch {
    return null
  }
}

// --- TypedStream parser (attributedBody column) ---

function parseAttributedBody(blob: Buffer | null): string {
  if (!blob || !blob.length) return ""
  const bytes = Buffer.from(blob)
  const START = Buffer.from([0x01, 0x2b])
  const END = Buffer.from([0x86, 0x84])
  let best = ""

  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== START[0] || bytes[i + 1] !== START[1]) continue
    const from = i + 2
    const to = bytes.indexOf(END, from)
    if (to === -1) continue

    let segment = bytes.subarray(from, to)
    if (segment.length > 1 && segment[0] === segment.length - 1) {
      segment = segment.subarray(1)
    }
    const candidate = segment.toString("utf8").replace(/[\x00-\x1f]/g, "").trim()
    if (candidate.length > best.length) best = candidate
  }

  return best || bytes.toString("utf8").replace(/[\x00-\x1f]/g, "").trim()
}

// --- Path resolution ---

function resolvePath(filename: string): { path: string; missing: boolean } {
  if (!filename) return { path: "", missing: true }
  const expanded = filename.replace(/^~/, homedir())
  return { path: expanded, missing: !existsSync(expanded) }
}

// Re-export for use in toNanos by other modules
export function dateToAppleNanos(date: Date): number {
  return toNanos(date)
}
