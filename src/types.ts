export interface Chat {
  id: number
  guid: string
  identifier: string
  name: string
  service: string
  isGroup: boolean
  lastMessageAt?: Date
}

export interface Message {
  id: number
  chatId: number
  guid: string
  replyToGuid: string | null
  sender: string
  text: string
  date: Date
  isFromMe: boolean
  service: string
  attachments: number
}

export interface Attachment {
  filename: string
  transferName: string
  uti: string
  mimeType: string
  totalBytes: number
  isSticker: boolean
  path: string
  missing: boolean
}

export interface Filter {
  participants?: string[]
  after?: Date
  before?: Date
}

export interface UndeliveredMessage {
  id: number
  guid: string
  chatId: number
  text: string
  date: Date
}

export type Service = "imessage" | "sms" | "auto"

export function parseService(value: string | undefined): Service {
  if (value === "imessage" || value === "sms" || value === "auto") return value
  if (!value) return "auto"
  throw new Error(`Invalid service: ${value}. Must be imessage, sms, or auto`)
}
