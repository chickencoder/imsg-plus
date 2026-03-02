export interface Chat {
  id: number
  identifier: string
  name: string
  service: string
  lastMessageAt: Date
}

export interface ChatInfo {
  id: number
  identifier: string
  guid: string
  name: string
  service: string
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
