import Foundation

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
