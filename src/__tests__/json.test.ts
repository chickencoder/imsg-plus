import { describe, it, expect } from "vitest"
import { serializeMessage, serializeAttachment } from "../json.js"
import type { Message, Attachment } from "../types.js"

describe("serializeMessage", () => {
  const baseMessage: Message = {
    id: 1,
    chatId: 10,
    guid: "msg-guid-123",
    replyToGuid: null,
    sender: "+15551234567",
    text: "Hello, world!",
    date: new Date("2024-06-15T12:00:00.000Z"),
    isFromMe: false,
    service: "iMessage",
    attachments: 0,
    isAudioMessage: false,
    associatedMessageType: null,
    associatedMessageGuid: null,
  }

  it("produces correct shape with all fields", () => {
    const result = serializeMessage(baseMessage)
    expect(result).toEqual({
      id: 1,
      rowid: 1,
      chat_id: 10,
      guid: "msg-guid-123",
      reply_to_guid: null,
      sender: "+15551234567",
      is_from_me: false,
      is_audio_message: false,
      associated_message_type: null,
      associated_message_guid: null,
      text: "Hello, world!",
      created_at: "2024-06-15T12:00:00.000Z",
      attachments: [],
    })
  })

  it("always includes reply_to_guid even when null", () => {
    const result = serializeMessage(baseMessage)
    expect("reply_to_guid" in result).toBe(true)
    expect(result.reply_to_guid).toBeNull()
  })

  it("includes reply_to_guid when present", () => {
    const msg = { ...baseMessage, replyToGuid: "reply-guid-456" }
    const result = serializeMessage(msg)
    expect(result.reply_to_guid).toBe("reply-guid-456")
  })

  it("serializes attachments when provided", () => {
    const attachments: Attachment[] = [
      {
        filename: "/path/to/image.jpg",
        transferName: "image.jpg",
        uti: "public.jpeg",
        mimeType: "image/jpeg",
        totalBytes: 12345,
        isSticker: false,
        path: "/expanded/path/to/image.jpg",
        missing: false,
      },
    ]

    const result = serializeMessage(baseMessage, attachments)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].transfer_name).toBe("image.jpg")
  })

  it("handles is_from_me correctly", () => {
    const sent = { ...baseMessage, isFromMe: true }
    expect(serializeMessage(sent).is_from_me).toBe(true)
  })
})

describe("serializeAttachment", () => {
  it("maps all fields to snake_case", () => {
    const attachment: Attachment = {
      filename: "~/Library/Messages/Attachments/image.jpg",
      transferName: "photo.jpg",
      uti: "public.jpeg",
      mimeType: "image/jpeg",
      totalBytes: 54321,
      isSticker: true,
      path: "/Users/test/Library/Messages/Attachments/image.jpg",
      missing: false,
    }

    const result = serializeAttachment(attachment)
    expect(result).toEqual({
      filename: "~/Library/Messages/Attachments/image.jpg",
      transfer_name: "photo.jpg",
      uti: "public.jpeg",
      mime_type: "image/jpeg",
      total_bytes: 54321,
      is_sticker: true,
      original_path: "/Users/test/Library/Messages/Attachments/image.jpg",
      missing: false,
    })
  })
})
