import type { Message, Attachment, UndeliveredMessage } from "./types.js"

export function serializeMessage(msg: Message, attachments: Attachment[] = []) {
  return {
    id: msg.id,
    // `rowid` is an alias for `id` so callers that key off the chat.db column
    // name (e.g. the messages.dev daemon) don't have to know about the rename.
    rowid: msg.id,
    chat_id: msg.chatId,
    guid: msg.guid,
    reply_to_guid: msg.replyToGuid,
    sender: msg.sender,
    is_from_me: msg.isFromMe,
    is_audio_message: msg.isAudioMessage,
    associated_message_type: msg.associatedMessageType,
    associated_message_guid: msg.associatedMessageGuid,
    text: msg.text,
    created_at: msg.date.toISOString(),
    attachments: attachments.map(serializeAttachment),
  }
}

export function serializeUndelivered(msg: UndeliveredMessage) {
  return {
    id: msg.id,
    guid: msg.guid,
    chat_id: msg.chatId,
    text: msg.text,
    created_at: msg.date.toISOString(),
  }
}

export function serializeAttachment(a: Attachment) {
  return {
    filename: a.filename,
    transfer_name: a.transferName,
    uti: a.uti,
    mime_type: a.mimeType,
    total_bytes: a.totalBytes,
    is_sticker: a.isSticker,
    original_path: a.path,
    missing: a.missing,
  }
}
