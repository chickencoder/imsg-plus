import Foundation

// MARK: - Data Models

public struct Chat: Sendable, Equatable {
  public let id: Int64
  public let identifier: String
  public let name: String
  public let service: String
  public let lastMessageAt: Date

  public init(id: Int64, identifier: String, name: String, service: String, lastMessageAt: Date) {
    self.id = id
    self.identifier = identifier
    self.name = name
    self.service = service
    self.lastMessageAt = lastMessageAt
  }
}

public struct ChatInfo: Sendable, Equatable {
  public let id: Int64
  public let identifier: String
  public let guid: String
  public let name: String
  public let service: String

  public init(id: Int64, identifier: String, guid: String, name: String, service: String) {
    self.id = id
    self.identifier = identifier
    self.guid = guid
    self.name = name
    self.service = service
  }
}

public struct Message: Sendable, Equatable {
  public let rowID: Int64
  public let chatID: Int64
  public let guid: String
  public let replyToGUID: String?
  public let sender: String
  public let text: String
  public let date: Date
  public let isFromMe: Bool
  public let service: String
  public let handleID: Int64?
  public let attachmentsCount: Int

  public init(
    rowID: Int64,
    chatID: Int64,
    sender: String,
    text: String,
    date: Date,
    isFromMe: Bool,
    service: String,
    handleID: Int64?,
    attachmentsCount: Int,
    guid: String = "",
    replyToGUID: String? = nil
  ) {
    self.rowID = rowID
    self.chatID = chatID
    self.guid = guid
    self.replyToGUID = replyToGUID
    self.sender = sender
    self.text = text
    self.date = date
    self.isFromMe = isFromMe
    self.service = service
    self.handleID = handleID
    self.attachmentsCount = attachmentsCount
  }
}

public struct AttachmentMeta: Sendable, Equatable {
  public let filename: String
  public let transferName: String
  public let uti: String
  public let mimeType: String
  public let totalBytes: Int64
  public let isSticker: Bool
  public let originalPath: String
  public let missing: Bool

  public init(
    filename: String,
    transferName: String,
    uti: String,
    mimeType: String,
    totalBytes: Int64,
    isSticker: Bool,
    originalPath: String,
    missing: Bool
  ) {
    self.filename = filename
    self.transferName = transferName
    self.uti = uti
    self.mimeType = mimeType
    self.totalBytes = totalBytes
    self.isSticker = isSticker
    self.originalPath = originalPath
    self.missing = missing
  }
}

public struct MessageFilter: Sendable, Equatable {
  public let participants: [String]
  public let startDate: Date?
  public let endDate: Date?

  public init(participants: [String] = [], startDate: Date? = nil, endDate: Date? = nil) {
    self.participants = participants
    self.startDate = startDate
    self.endDate = endDate
  }

  public static func fromISO(participants: [String], startISO: String?, endISO: String?) throws
    -> MessageFilter
  {
    let start = startISO.flatMap { ISO8601Parser.parse($0) }
    if let startISO, start == nil { throw IMsgError.invalidISODate(startISO) }
    let end = endISO.flatMap { ISO8601Parser.parse($0) }
    if let endISO, end == nil { throw IMsgError.invalidISODate(endISO) }
    return MessageFilter(participants: participants, startDate: start, endDate: end)
  }

  public func allows(_ message: Message) -> Bool {
    if let startDate, message.date < startDate { return false }
    if let endDate, message.date >= endDate { return false }
    if !participants.isEmpty {
      guard participants.contains(where: {
        $0.caseInsensitiveCompare(message.sender) == .orderedSame
      }) else { return false }
    }
    return true
  }
}

// MARK: - Errors

public enum IMsgError: LocalizedError, Sendable {
  case permissionDenied(path: String, underlying: Error)
  case invalidISODate(String)
  case invalidService(String)
  case invalidChatTarget(String)
  case appleScriptFailure(String)
  case invalidArgument(String)

  public var errorDescription: String? {
    switch self {
    case .permissionDenied(let path, let underlying):
      return """
        \(underlying)

        ⚠️  Permission Error: Cannot access Messages database

        The Messages database at \(path) requires Full Disk Access permission.

        To fix:
        1. Open System Settings → Privacy & Security → Full Disk Access
        2. Add your terminal application (Terminal.app, iTerm, etc.)
        3. Restart your terminal
        4. Try again
        """
    case .invalidISODate(let value):
      return "Invalid ISO8601 date: \(value)"
    case .invalidService(let value):
      return "Invalid service: \(value)"
    case .invalidChatTarget(let value):
      return "Invalid chat target: \(value)"
    case .appleScriptFailure(let message):
      return "AppleScript failed: \(message)"
    case .invalidArgument(let message):
      return "Invalid argument: \(message)"
    }
  }
}

// MARK: - ISO8601 Helpers

enum ISO8601Parser {
  static func parse(_ value: String) -> Date? {
    if value.isEmpty { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    let standard = ISO8601DateFormatter()
    standard.formatOptions = [.withInternetDateTime]
    return standard.date(from: value)
  }

  static func format(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}
