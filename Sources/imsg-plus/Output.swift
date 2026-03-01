import Foundation
import IMsgCore

// MARK: - Date Formatting

enum CLIISO8601 {
  static func format(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

// MARK: - JSON Encoding

enum JSONLines {
  private static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return encoder
  }()

  static func encode<T: Encodable>(_ value: T) throws -> String {
    let data = try encoder.encode(value)
    return String(data: data, encoding: .utf8) ?? ""
  }

  static func print<T: Encodable>(_ value: T) throws {
    let line = try encode(value)
    if !line.isEmpty { Swift.print(line) }
  }
}

extension JSONSerialization {
  static func string(from object: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
      let string = String(data: data, encoding: .utf8)
    else { return "{}" }
    return string
  }
}

// MARK: - Display Helpers

func pluralSuffix(for count: Int) -> String { count == 1 ? "" : "s" }

func displayName(for meta: AttachmentMeta) -> String {
  if !meta.transferName.isEmpty { return meta.transferName }
  if !meta.filename.isEmpty { return meta.filename }
  return "(unknown)"
}

func isGroupHandle(identifier: String, guid: String) -> Bool {
  let handle = identifier.isEmpty ? guid : identifier
  return handle.contains(";+;") || handle.contains(";-;")
}

// MARK: - Codable Payloads (CLI JSON output)

struct ChatPayload: Codable {
  let id: Int64
  let name: String
  let identifier: String
  let service: String
  let lastMessageAt: String

  init(chat: Chat) {
    self.id = chat.id
    self.name = chat.name
    self.identifier = chat.identifier
    self.service = chat.service
    self.lastMessageAt = CLIISO8601.format(chat.lastMessageAt)
  }

  enum CodingKeys: String, CodingKey {
    case id, name, identifier, service
    case lastMessageAt = "last_message_at"
  }
}

struct MessagePayload: Codable {
  let id: Int64
  let chatID: Int64
  let guid: String
  let replyToGUID: String?
  let sender: String
  let isFromMe: Bool
  let text: String
  let createdAt: String
  let attachments: [AttachmentPayload]

  init(message: Message, attachments: [AttachmentMeta]) {
    self.id = message.rowID
    self.chatID = message.chatID
    self.guid = message.guid
    self.replyToGUID = message.replyToGUID
    self.sender = message.sender
    self.isFromMe = message.isFromMe
    self.text = message.text
    self.createdAt = CLIISO8601.format(message.date)
    self.attachments = attachments.map { AttachmentPayload(meta: $0) }
  }

  enum CodingKeys: String, CodingKey {
    case id, guid, sender, text, attachments
    case chatID = "chat_id"
    case replyToGUID = "reply_to_guid"
    case isFromMe = "is_from_me"
    case createdAt = "created_at"
  }
}

struct AttachmentPayload: Codable {
  let filename: String
  let transferName: String
  let uti: String
  let mimeType: String
  let totalBytes: Int64
  let isSticker: Bool
  let originalPath: String
  let missing: Bool

  init(meta: AttachmentMeta) {
    self.filename = meta.filename
    self.transferName = meta.transferName
    self.uti = meta.uti
    self.mimeType = meta.mimeType
    self.totalBytes = meta.totalBytes
    self.isSticker = meta.isSticker
    self.originalPath = meta.originalPath
    self.missing = meta.missing
  }

  enum CodingKeys: String, CodingKey {
    case filename, uti, missing
    case transferName = "transfer_name"
    case mimeType = "mime_type"
    case totalBytes = "total_bytes"
    case isSticker = "is_sticker"
    case originalPath = "original_path"
  }
}

// MARK: - RPC Payload Builders (dictionary-based for JSON-RPC)

func chatPayload(
  id: Int64, identifier: String, guid: String, name: String,
  service: String, lastMessageAt: Date, participants: [String]
) -> [String: Any] {
  return [
    "id": id, "identifier": identifier, "guid": guid, "name": name,
    "service": service, "last_message_at": CLIISO8601.format(lastMessageAt),
    "participants": participants,
    "is_group": isGroupHandle(identifier: identifier, guid: guid),
  ]
}

func messagePayload(
  message: Message, chatInfo: ChatInfo?, participants: [String], attachments: [AttachmentMeta]
) -> [String: Any] {
  let identifier = chatInfo?.identifier ?? ""
  let guid = chatInfo?.guid ?? ""
  let name = chatInfo?.name ?? ""
  var payload: [String: Any] = [
    "id": message.rowID, "chat_id": message.chatID, "guid": message.guid,
    "sender": message.sender, "is_from_me": message.isFromMe, "text": message.text,
    "created_at": CLIISO8601.format(message.date),
    "attachments": attachments.map { attachmentPayload($0) },
    "chat_identifier": identifier, "chat_guid": guid, "chat_name": name,
    "participants": participants,
    "is_group": isGroupHandle(identifier: identifier, guid: guid),
  ]
  if let replyToGUID = message.replyToGUID, !replyToGUID.isEmpty {
    payload["reply_to_guid"] = replyToGUID
  }
  return payload
}

func attachmentPayload(_ meta: AttachmentMeta) -> [String: Any] {
  return [
    "filename": meta.filename, "transfer_name": meta.transferName,
    "uti": meta.uti, "mime_type": meta.mimeType,
    "total_bytes": meta.totalBytes, "is_sticker": meta.isSticker,
    "original_path": meta.originalPath, "missing": meta.missing,
  ]
}

// MARK: - RPC Parameter Parsing

func stringParam(_ value: Any?) -> String? {
  if let value = value as? String { return value }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func intParam(_ value: Any?) -> Int? {
  if let value = value as? Int { return value }
  if let value = value as? NSNumber { return value.intValue }
  if let value = value as? String { return Int(value) }
  return nil
}

func int64Param(_ value: Any?) -> Int64? {
  if let value = value as? Int64 { return value }
  if let value = value as? Int { return Int64(value) }
  if let value = value as? NSNumber { return value.int64Value }
  if let value = value as? String { return Int64(value) }
  return nil
}

func boolParam(_ value: Any?) -> Bool? {
  if let value = value as? Bool { return value }
  if let value = value as? NSNumber { return value.boolValue }
  if let value = value as? String {
    if value == "true" { return true }
    if value == "false" { return false }
  }
  return nil
}

func stringArrayParam(_ value: Any?) -> [String] {
  if let list = value as? [String] { return list }
  if let list = value as? [Any] { return list.compactMap { stringParam($0) } }
  if let str = value as? String {
    return str.split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }
  return []
}

// MARK: - Watch Event Models

enum WatchEventType: String, Codable {
  case message, typing, read, delivered
}

protocol WatchEvent: Codable {
  var type: WatchEventType { get }
  var timestamp: String { get }
}

struct MessageEvent: WatchEvent {
  let type = WatchEventType.message
  let timestamp: String
  let id: Int64
  let chatID: Int64
  let guid: String
  let replyToGUID: String?
  let sender: String
  let isFromMe: Bool
  let text: String
  let attachments: [AttachmentPayload]

  init(message: Message, attachments: [AttachmentMeta]) {
    self.timestamp = CLIISO8601.format(Date())
    self.id = message.rowID
    self.chatID = message.chatID
    self.guid = message.guid
    self.replyToGUID = message.replyToGUID
    self.sender = message.sender
    self.isFromMe = message.isFromMe
    self.text = message.text
    self.attachments = attachments.map { AttachmentPayload(meta: $0) }
  }

  enum CodingKeys: String, CodingKey {
    case type, timestamp, id, guid, sender, text, attachments
    case chatID = "chat_id"
    case replyToGUID = "reply_to_guid"
    case isFromMe = "is_from_me"
  }
}

struct TypingEvent: WatchEvent {
  let type = WatchEventType.typing
  let timestamp: String
  let sender: String
  let chatID: String
  let started: Bool

  init(sender: String, chatID: String, started: Bool) {
    self.timestamp = CLIISO8601.format(Date())
    self.sender = sender
    self.chatID = chatID
    self.started = started
  }

  enum CodingKeys: String, CodingKey {
    case type, timestamp, sender, started
    case chatID = "chat_id"
  }
}

struct ReadEvent: WatchEvent {
  let type = WatchEventType.read
  let timestamp: String
  let by: String
  let messageGUID: String
  let chatID: String

  init(by: String, messageGUID: String, chatID: String) {
    self.timestamp = CLIISO8601.format(Date())
    self.by = by
    self.messageGUID = messageGUID
    self.chatID = chatID
  }

  enum CodingKeys: String, CodingKey {
    case type, timestamp, by
    case messageGUID = "message_guid"
    case chatID = "chat_id"
  }
}

struct DeliveredEvent: WatchEvent {
  let type = WatchEventType.delivered
  let timestamp: String
  let messageGUID: String
  let to: String

  init(messageGUID: String, to: String) {
    self.timestamp = CLIISO8601.format(Date())
    self.messageGUID = messageGUID
    self.to = to
  }

  enum CodingKeys: String, CodingKey {
    case type, timestamp, to
    case messageGUID = "message_guid"
  }
}
