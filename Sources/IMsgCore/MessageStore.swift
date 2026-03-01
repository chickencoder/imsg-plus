import Foundation
import SQLite

public final class MessageStore: @unchecked Sendable {
  public static let appleEpochOffset: TimeInterval = 978_307_200

  public static var defaultPath: String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return NSString(string: home).appendingPathComponent("Library/Messages/chat.db")
  }

  public let path: String

  private let connection: Connection
  private let queue: DispatchQueue
  private let queueKey = DispatchSpecificKey<Void>()
  let hasAttributedBody: Bool
  let hasReactionColumns: Bool
  let hasDestinationCallerID: Bool
  let hasAudioMessageColumn: Bool
  let hasAttachmentUserInfo: Bool

  public init(path: String = MessageStore.defaultPath) throws {
    let normalized = NSString(string: path).expandingTildeInPath
    self.path = normalized
    self.queue = DispatchQueue(label: "imsg.db", qos: .userInitiated)
    self.queue.setSpecific(key: queueKey, value: ())
    do {
      let uri = URL(fileURLWithPath: normalized).absoluteString
      let location = Connection.Location.uri(uri, parameters: [.mode(.readOnly)])
      self.connection = try Connection(location, readonly: true)
      self.connection.busyTimeout = 5
      self.hasAttributedBody = Self.hasColumn("attributedBody", in: "message", connection: connection)
      self.hasReactionColumns = Self.detectReactionColumns(connection: connection)
      self.hasDestinationCallerID = Self.hasColumn(
        "destination_caller_id", in: "message", connection: connection)
      self.hasAudioMessageColumn = Self.hasColumn(
        "is_audio_message", in: "message", connection: connection)
      self.hasAttachmentUserInfo = Self.hasColumn(
        "user_info", in: "attachment", connection: connection)
    } catch {
      throw Self.enhance(error: error, path: normalized)
    }
  }

  init(
    connection: Connection,
    path: String,
    hasAttributedBody: Bool? = nil,
    hasReactionColumns: Bool? = nil,
    hasDestinationCallerID: Bool? = nil,
    hasAudioMessageColumn: Bool? = nil,
    hasAttachmentUserInfo: Bool? = nil
  ) throws {
    self.path = path
    self.queue = DispatchQueue(label: "imsg.db.test", qos: .userInitiated)
    self.queue.setSpecific(key: queueKey, value: ())
    self.connection = connection
    self.connection.busyTimeout = 5
    self.hasAttributedBody =
      hasAttributedBody ?? Self.hasColumn("attributedBody", in: "message", connection: connection)
    self.hasReactionColumns =
      hasReactionColumns ?? Self.detectReactionColumns(connection: connection)
    self.hasDestinationCallerID =
      hasDestinationCallerID
      ?? Self.hasColumn("destination_caller_id", in: "message", connection: connection)
    self.hasAudioMessageColumn =
      hasAudioMessageColumn
      ?? Self.hasColumn("is_audio_message", in: "message", connection: connection)
    self.hasAttachmentUserInfo =
      hasAttachmentUserInfo
      ?? Self.hasColumn("user_info", in: "attachment", connection: connection)
  }

  // MARK: - Chat Queries

  public func listChats(limit: Int) throws -> [Chat] {
    let sql = """
      SELECT c.ROWID, IFNULL(c.display_name, c.chat_identifier) AS name, c.chat_identifier, c.service_name,
             MAX(m.date) AS last_date
      FROM chat c
      JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
      JOIN message m ON m.ROWID = cmj.message_id
      GROUP BY c.ROWID
      ORDER BY last_date DESC
      LIMIT ?
      """
    return try withConnection { db in
      var chats: [Chat] = []
      for row in try db.prepare(sql, limit) {
        chats.append(
          Chat(
            id: int64Value(row[0]) ?? 0,
            identifier: stringValue(row[2]),
            name: stringValue(row[1]),
            service: stringValue(row[3]),
            lastMessageAt: appleDate(from: int64Value(row[4]))
          ))
      }
      return chats
    }
  }

  public func chatInfo(chatID: Int64) throws -> ChatInfo? {
    let sql = """
      SELECT c.ROWID, IFNULL(c.chat_identifier, '') AS identifier, IFNULL(c.guid, '') AS guid,
             IFNULL(c.display_name, c.chat_identifier) AS name, IFNULL(c.service_name, '') AS service
      FROM chat c
      WHERE c.ROWID = ?
      LIMIT 1
      """
    return try withConnection { db in
      for row in try db.prepare(sql, chatID) {
        return ChatInfo(
          id: int64Value(row[0]) ?? 0,
          identifier: stringValue(row[1]),
          guid: stringValue(row[2]),
          name: stringValue(row[3]),
          service: stringValue(row[4])
        )
      }
      return nil
    }
  }

  public func participants(chatID: Int64) throws -> [String] {
    let sql = """
      SELECT h.id
      FROM chat_handle_join chj
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = ?
      ORDER BY h.id ASC
      """
    return try withConnection { db in
      var results: [String] = []
      var seen = Set<String>()
      for row in try db.prepare(sql, chatID) {
        let handle = stringValue(row[0])
        if !handle.isEmpty && seen.insert(handle).inserted {
          results.append(handle)
        }
      }
      return results
    }
  }

  // MARK: - Message Queries

  public func messages(chatID: Int64, limit: Int) throws -> [Message] {
    return try messages(chatID: chatID, limit: limit, filter: nil)
  }

  public func messages(chatID: Int64, limit: Int, filter: MessageFilter?) throws -> [Message] {
    let columns = dynamicColumns()
    var sql = """
      SELECT m.ROWID, m.handle_id, h.id, IFNULL(m.text, '') AS text, m.date, m.is_from_me, m.service,
             \(columns.audioMessage) AS is_audio_message, \(columns.destinationCaller) AS destination_caller_id,
             \(columns.guid) AS guid, \(columns.associatedGuid) AS associated_guid, \(columns.associatedType) AS associated_type,
             (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) AS attachments,
             \(columns.body) AS body
      FROM message m
      JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE cmj.chat_id = ?\(columns.reactionFilter)
      """
    var bindings: [Binding?] = [chatID]

    if let filter {
      if let startDate = filter.startDate {
        sql += " AND m.date >= ?"
        bindings.append(Self.appleEpoch(startDate))
      }
      if let endDate = filter.endDate {
        sql += " AND m.date < ?"
        bindings.append(Self.appleEpoch(endDate))
      }
      if !filter.participants.isEmpty {
        let placeholders = Array(repeating: "?", count: filter.participants.count).joined(
          separator: ",")
        sql +=
          " AND COALESCE(NULLIF(h.id,''), \(columns.destinationCaller)) COLLATE NOCASE IN (\(placeholders))"
        for participant in filter.participants {
          bindings.append(participant)
        }
      }
    }

    sql += " ORDER BY m.date DESC LIMIT ?"
    bindings.append(limit)

    return try withConnection { db in
      try db.prepare(sql, bindings).map { row in
        try parseMessage(row: row, chatID: chatID)
      }
    }
  }

  public func messagesAfter(afterRowID: Int64, chatID: Int64?, limit: Int) throws -> [Message] {
    let columns = dynamicColumns()
    var sql = """
      SELECT m.ROWID, cmj.chat_id, m.handle_id, h.id, IFNULL(m.text, '') AS text, m.date, m.is_from_me, m.service,
             \(columns.audioMessage) AS is_audio_message, \(columns.destinationCaller) AS destination_caller_id,
             \(columns.guid) AS guid, \(columns.associatedGuid) AS associated_guid, \(columns.associatedType) AS associated_type,
             (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) AS attachments,
             \(columns.body) AS body
      FROM message m
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.ROWID > ?\(columns.reactionFilter)
      """
    var bindings: [Binding?] = [afterRowID]
    if let chatID {
      sql += " AND cmj.chat_id = ?"
      bindings.append(chatID)
    }
    sql += " ORDER BY m.ROWID ASC LIMIT ?"
    bindings.append(limit)

    return try withConnection { db in
      var messages: [Message] = []
      for row in try db.prepare(sql, bindings) {
        let rowID = int64Value(row[0]) ?? 0
        let resolvedChatID = int64Value(row[1]) ?? chatID ?? 0
        var sender = stringValue(row[3])
        let destinationCallerID = stringValue(row[9])
        if sender.isEmpty && !destinationCallerID.isEmpty { sender = destinationCallerID }
        let text = stringValue(row[4])
        let body = dataValue(row[14])
        var resolvedText = text.isEmpty ? TypedStreamParser.parseAttributedBody(body) : text
        if boolValue(row[8]), let transcription = try audioTranscription(for: rowID) {
          resolvedText = transcription
        }
        messages.append(
          Message(
            rowID: rowID,
            chatID: resolvedChatID,
            sender: sender,
            text: resolvedText,
            date: appleDate(from: int64Value(row[5])),
            isFromMe: boolValue(row[6]),
            service: stringValue(row[7]),
            handleID: int64Value(row[2]),
            attachmentsCount: intValue(row[13]) ?? 0,
            guid: stringValue(row[10]),
            replyToGUID: replyToGUID(
              associatedGuid: stringValue(row[11]),
              associatedType: intValue(row[12])
            )
          ))
      }
      return messages
    }
  }

  // MARK: - Attachments

  public func attachments(for messageID: Int64) throws -> [AttachmentMeta] {
    let sql = """
      SELECT a.filename, a.transfer_name, a.uti, a.mime_type, a.total_bytes, a.is_sticker
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = ?
      """
    return try withConnection { db in
      var metas: [AttachmentMeta] = []
      for row in try db.prepare(sql, messageID) {
        let filename = stringValue(row[0])
        let resolved = AttachmentResolver.resolve(filename)
        metas.append(
          AttachmentMeta(
            filename: filename,
            transferName: stringValue(row[1]),
            uti: stringValue(row[2]),
            mimeType: stringValue(row[3]),
            totalBytes: int64Value(row[4]) ?? 0,
            isSticker: boolValue(row[5]),
            originalPath: resolved.resolved,
            missing: resolved.missing
          ))
      }
      return metas
    }
  }

  func audioTranscription(for messageID: Int64) throws -> String? {
    guard hasAttachmentUserInfo else { return nil }
    let sql = """
      SELECT a.user_info
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = ?
      LIMIT 1
      """
    return try withConnection { db in
      for row in try db.prepare(sql, messageID) {
        let info = dataValue(row[0])
        guard !info.isEmpty,
          let plist = try? PropertyListSerialization.propertyList(from: info, options: [], format: nil)
            as? [String: Any],
          let transcription = plist["audio-transcription"] as? String,
          !transcription.isEmpty
        else { continue }
        return transcription
      }
      return nil
    }
  }

  public func maxRowID() throws -> Int64 {
    return try withConnection { db in
      let value = try db.scalar("SELECT MAX(ROWID) FROM message")
      return int64Value(value) ?? 0
    }
  }

  // MARK: - Connection Management

  func withConnection<T>(_ block: (Connection) throws -> T) throws -> T {
    if DispatchQueue.getSpecific(key: queueKey) != nil {
      return try block(connection)
    }
    return try queue.sync {
      try block(connection)
    }
  }

  // MARK: - Private Helpers

  private struct DynamicColumns {
    let body: String
    let guid: String
    let associatedGuid: String
    let associatedType: String
    let destinationCaller: String
    let audioMessage: String
    let reactionFilter: String
  }

  private func dynamicColumns() -> DynamicColumns {
    DynamicColumns(
      body: hasAttributedBody ? "m.attributedBody" : "NULL",
      guid: hasReactionColumns ? "m.guid" : "NULL",
      associatedGuid: hasReactionColumns ? "m.associated_message_guid" : "NULL",
      associatedType: hasReactionColumns ? "m.associated_message_type" : "NULL",
      destinationCaller: hasDestinationCallerID ? "m.destination_caller_id" : "NULL",
      audioMessage: hasAudioMessageColumn ? "m.is_audio_message" : "0",
      reactionFilter:
        hasReactionColumns
        ? " AND (m.associated_message_type IS NULL OR m.associated_message_type < 2000 OR m.associated_message_type > 3006)"
        : ""
    )
  }

  private func parseMessage(row: Statement.Element, chatID: Int64) throws -> Message {
    let rowID = int64Value(row[0]) ?? 0
    var sender = stringValue(row[2])
    let destinationCallerID = stringValue(row[8])
    if sender.isEmpty && !destinationCallerID.isEmpty { sender = destinationCallerID }
    let text = stringValue(row[3])
    let body = dataValue(row[13])
    var resolvedText = text.isEmpty ? TypedStreamParser.parseAttributedBody(body) : text
    if boolValue(row[7]), let transcription = try audioTranscription(for: rowID) {
      resolvedText = transcription
    }
    return Message(
      rowID: rowID,
      chatID: chatID,
      sender: sender,
      text: resolvedText,
      date: appleDate(from: int64Value(row[4])),
      isFromMe: boolValue(row[5]),
      service: stringValue(row[6]),
      handleID: int64Value(row[1]),
      attachmentsCount: intValue(row[12]) ?? 0,
      guid: stringValue(row[9]),
      replyToGUID: replyToGUID(
        associatedGuid: stringValue(row[10]),
        associatedType: intValue(row[11])
      )
    )
  }

  // MARK: - SQLite Binding Helpers

  func stringValue(_ binding: Binding?) -> String { binding as? String ?? "" }

  func int64Value(_ binding: Binding?) -> Int64? {
    if let value = binding as? Int64 { return value }
    if let value = binding as? Int { return Int64(value) }
    if let value = binding as? Double { return Int64(value) }
    return nil
  }

  func intValue(_ binding: Binding?) -> Int? {
    if let value = binding as? Int { return value }
    if let value = binding as? Int64 { return Int(value) }
    if let value = binding as? Double { return Int(value) }
    return nil
  }

  func boolValue(_ binding: Binding?) -> Bool {
    if let value = binding as? Bool { return value }
    if let value = intValue(binding) { return value != 0 }
    return false
  }

  func dataValue(_ binding: Binding?) -> Data {
    if let blob = binding as? Blob { return Data(blob.bytes) }
    return Data()
  }

  // MARK: - Associated GUID Helpers

  func normalizeAssociatedGUID(_ guid: String) -> String {
    guard !guid.isEmpty, let slash = guid.lastIndex(of: "/") else { return guid }
    let nextIndex = guid.index(after: slash)
    guard nextIndex < guid.endIndex else { return guid }
    return String(guid[nextIndex...])
  }

  func replyToGUID(associatedGuid: String, associatedType: Int?) -> String? {
    let normalized = normalizeAssociatedGUID(associatedGuid)
    guard !normalized.isEmpty else { return nil }
    if let type = associatedType, type >= 2000 && type <= 3006 { return nil }
    return normalized
  }

  // MARK: - Date Conversion

  static func appleEpoch(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 - appleEpochOffset) * 1_000_000_000)
  }

  func appleDate(from value: Int64?) -> Date {
    guard let value else { return Date(timeIntervalSince1970: Self.appleEpochOffset) }
    return Date(timeIntervalSince1970: (Double(value) / 1_000_000_000) + Self.appleEpochOffset)
  }

  // MARK: - Schema Detection

  private static func hasColumn(
    _ columnName: String, in table: String, connection: Connection
  ) -> Bool {
    do {
      for row in try connection.prepare("PRAGMA table_info(\(table))") {
        if let name = row[1] as? String,
          name.caseInsensitiveCompare(columnName) == .orderedSame
        { return true }
      }
    } catch {}
    return false
  }

  private static func detectReactionColumns(connection: Connection) -> Bool {
    do {
      let rows = try connection.prepare("PRAGMA table_info(message)")
      var columns = Set<String>()
      for row in rows {
        if let name = row[1] as? String { columns.insert(name.lowercased()) }
      }
      return columns.contains("guid")
        && columns.contains("associated_message_guid")
        && columns.contains("associated_message_type")
    } catch {
      return false
    }
  }

  static func enhance(error: Error, path: String) -> Error {
    let message = String(describing: error).lowercased()
    if message.contains("out of memory (14)") || message.contains("authorization denied")
      || message.contains("unable to open database") || message.contains("cannot open")
    {
      return IMsgError.permissionDenied(path: path, underlying: error)
    }
    return error
  }
}

// MARK: - Attachment Path Resolution

enum AttachmentResolver {
  static func resolve(_ path: String) -> (resolved: String, missing: Bool) {
    guard !path.isEmpty else { return ("", true) }
    let expanded = (path as NSString).expandingTildeInPath
    var isDir: ObjCBool = false
    let exists = FileManager.default.fileExists(atPath: expanded, isDirectory: &isDir)
    return (expanded, !(exists && !isDir.boolValue))
  }

  static func displayName(filename: String, transferName: String) -> String {
    if !transferName.isEmpty { return transferName }
    if !filename.isEmpty { return filename }
    return "(unknown)"
  }
}

// MARK: - Apple TypedStream Parser (attributedBody column)

enum TypedStreamParser {
  static func parseAttributedBody(_ data: Data) -> String {
    guard !data.isEmpty else { return "" }
    let bytes = [UInt8](data)
    let start = [UInt8(0x01), UInt8(0x2b)]
    let end = [UInt8(0x86), UInt8(0x84)]
    var best = ""

    var index = 0
    while index + 1 < bytes.count {
      if bytes[index] == start[0], bytes[index + 1] == start[1] {
        let sliceStart = index + 2
        if let sliceEnd = findSequence(end, in: bytes, from: sliceStart) {
          var segment = Array(bytes[sliceStart..<sliceEnd])
          if segment.count > 1, Int(segment[0]) == segment.count - 1 {
            segment.removeFirst()
          }
          let candidate = String(decoding: segment, as: UTF8.self)
            .trimmingLeadingControlCharacters()
          if candidate.count > best.count {
            best = candidate
          }
        }
      }
      index += 1
    }

    if !best.isEmpty { return best }
    return String(decoding: bytes, as: UTF8.self).trimmingLeadingControlCharacters()
  }

  private static func findSequence(_ needle: [UInt8], in haystack: [UInt8], from start: Int)
    -> Int?
  {
    guard !needle.isEmpty, start >= 0, start < haystack.count else { return nil }
    let limit = haystack.count - needle.count
    if limit < start { return nil }
    var index = start
    while index <= limit {
      var matched = true
      for offset in 0..<needle.count {
        if haystack[index + offset] != needle[offset] {
          matched = false
          break
        }
      }
      if matched { return index }
      index += 1
    }
    return nil
  }
}

extension String {
  fileprivate func trimmingLeadingControlCharacters() -> String {
    var scalars = unicodeScalars
    while let first = scalars.first,
      CharacterSet.controlCharacters.contains(first) || first == "\n" || first == "\r"
    {
      scalars.removeFirst()
    }
    return String(String.UnicodeScalarView(scalars))
  }
}
