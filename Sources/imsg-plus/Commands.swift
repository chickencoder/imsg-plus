import Commander
import Foundation
import IMsgCore

// MARK: - Chats

enum ChatsCommand {
  static let spec = CommandSpec(
    name: "chats",
    abstract: "List recent conversations",
    discussion: nil,
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions() + [
          .make(label: "limit", names: [.long("limit")], help: "Number of chats to list")
        ]
      )
    ),
    usageExamples: ["imsg chats --limit 5", "imsg chats --limit 5 --json"]
  ) { values, runtime in
    let dbPath = values.option("db") ?? MessageStore.defaultPath
    let limit = values.optionInt("limit") ?? 20
    let store = try MessageStore(path: dbPath)
    let chats = try store.listChats(limit: limit)
    if runtime.jsonOutput {
      for chat in chats { try JSONLines.print(ChatPayload(chat: chat)) }
      return
    }
    for chat in chats {
      Swift.print("[\(chat.id)] \(chat.name) (\(chat.identifier)) last=\(CLIISO8601.format(chat.lastMessageAt))")
    }
  }
}

// MARK: - History

enum HistoryCommand {
  static let spec = CommandSpec(
    name: "history",
    abstract: "Show recent messages for a chat",
    discussion: nil,
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions() + [
          .make(label: "chatID", names: [.long("chat-id")], help: "chat rowid from 'imsg chats'"),
          .make(label: "limit", names: [.long("limit")], help: "Number of messages to show"),
          .make(
            label: "participants", names: [.long("participants")],
            help: "filter by participant handles", parsing: .upToNextOption),
          .make(label: "start", names: [.long("start")], help: "ISO8601 start (inclusive)"),
          .make(label: "end", names: [.long("end")], help: "ISO8601 end (exclusive)"),
        ],
        flags: [
          .make(label: "attachments", names: [.long("attachments")], help: "include attachment metadata")
        ]
      )
    ),
    usageExamples: [
      "imsg history --chat-id 1 --limit 10 --attachments",
      "imsg history --chat-id 1 --start 2025-01-01T00:00:00Z --json",
    ]
  ) { values, runtime in
    guard let chatID = values.optionInt64("chatID") else {
      throw ParsedValuesError.missingOption("chat-id")
    }
    let dbPath = values.option("db") ?? MessageStore.defaultPath
    let limit = values.optionInt("limit") ?? 50
    let showAttachments = values.flag("attachments")
    let participants = values.optionValues("participants")
      .flatMap { $0.split(separator: ",").map { String($0) } }
      .filter { !$0.isEmpty }
    let filter = try MessageFilter.fromISO(
      participants: participants,
      startISO: values.option("start"),
      endISO: values.option("end")
    )
    let store = try MessageStore(path: dbPath)
    let filtered = try store.messages(chatID: chatID, limit: limit, filter: filter)
    if runtime.jsonOutput {
      for message in filtered {
        let attachments = try store.attachments(for: message.rowID)
        try JSONLines.print(MessagePayload(message: message, attachments: attachments))
      }
      return
    }
    for message in filtered {
      let direction = message.isFromMe ? "sent" : "recv"
      Swift.print("\(CLIISO8601.format(message.date)) [\(direction)] \(message.sender): \(message.text)")
      if message.attachmentsCount > 0 {
        if showAttachments {
          for meta in try store.attachments(for: message.rowID) {
            Swift.print("  attachment: name=\(displayName(for: meta)) mime=\(meta.mimeType) missing=\(meta.missing) path=\(meta.originalPath)")
          }
        } else {
          Swift.print("  (\(message.attachmentsCount) attachment\(pluralSuffix(for: message.attachmentsCount)))")
        }
      }
    }
  }
}

// MARK: - Watch

enum WatchCommand {
  static let spec = CommandSpec(
    name: "watch",
    abstract: "Stream incoming messages",
    discussion: nil,
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions() + [
          .make(label: "chatID", names: [.long("chat-id")], help: "limit to chat rowid"),
          .make(label: "debounce", names: [.long("debounce")], help: "debounce interval (e.g. 250ms)"),
          .make(label: "sinceRowID", names: [.long("since-rowid")], help: "start watching after this rowid"),
          .make(label: "participants", names: [.long("participants")], help: "filter by participant handles", parsing: .upToNextOption),
          .make(label: "start", names: [.long("start")], help: "ISO8601 start (inclusive)"),
          .make(label: "end", names: [.long("end")], help: "ISO8601 end (exclusive)"),
        ],
        flags: [
          .make(label: "attachments", names: [.long("attachments")], help: "include attachment metadata")
        ]
      )
    ),
    usageExamples: [
      "imsg watch --chat-id 1 --attachments --debounce 250ms",
      "imsg watch --chat-id 1 --participants +15551234567",
    ]
  ) { values, runtime in
    try await run(values: values, runtime: runtime)
  }

  static func run(
    values: ParsedValues,
    runtime: RuntimeOptions,
    storeFactory: @escaping (String) throws -> MessageStore = { try MessageStore(path: $0) },
    streamProvider: @escaping (MessageWatcher, Int64?, Int64?, MessageWatcherConfiguration) -> AsyncThrowingStream<Message, Error> = {
      watcher, chatID, sinceRowID, config in
      watcher.stream(chatID: chatID, sinceRowID: sinceRowID, configuration: config)
    }
  ) async throws {
    let dbPath = values.option("db") ?? MessageStore.defaultPath
    let chatID = values.optionInt64("chatID")
    let debounceString = values.option("debounce") ?? "250ms"
    guard let debounceInterval = DurationParser.parse(debounceString) else {
      throw ParsedValuesError.invalidOption("debounce")
    }
    let sinceRowID = values.optionInt64("sinceRowID")
    let showAttachments = values.flag("attachments")
    let participants = values.optionValues("participants")
      .flatMap { $0.split(separator: ",").map { String($0) } }
      .filter { !$0.isEmpty }
    let filter = try MessageFilter.fromISO(
      participants: participants,
      startISO: values.option("start"),
      endISO: values.option("end")
    )
    let store = try storeFactory(dbPath)
    let watcher = MessageWatcher(store: store)
    let config = MessageWatcherConfiguration(debounceInterval: debounceInterval, batchLimit: 100)
    let stream = streamProvider(watcher, chatID, sinceRowID, config)
    for try await message in stream {
      guard filter.allows(message) else { continue }
      if runtime.jsonOutput {
        let attachments = try store.attachments(for: message.rowID)
        try JSONLines.print(MessagePayload(message: message, attachments: attachments))
        continue
      }
      let direction = message.isFromMe ? "sent" : "recv"
      Swift.print("\(CLIISO8601.format(message.date)) [\(direction)] \(message.sender): \(message.text)")
      if message.attachmentsCount > 0 {
        if showAttachments {
          for meta in try store.attachments(for: message.rowID) {
            Swift.print("  attachment: name=\(displayName(for: meta)) mime=\(meta.mimeType) missing=\(meta.missing) path=\(meta.originalPath)")
          }
        } else {
          Swift.print("  (\(message.attachmentsCount) attachment\(pluralSuffix(for: message.attachmentsCount)))")
        }
      }
    }
  }
}

// MARK: - Send

enum SendCommand {
  static let spec = CommandSpec(
    name: "send",
    abstract: "Send a message (text and/or attachment)",
    discussion: nil,
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions() + [
          .make(label: "to", names: [.long("to")], help: "phone number or email"),
          .make(label: "chatID", names: [.long("chat-id")], help: "chat rowid"),
          .make(label: "chatIdentifier", names: [.long("chat-identifier")], help: "chat identifier"),
          .make(label: "chatGUID", names: [.long("chat-guid")], help: "chat guid"),
          .make(label: "text", names: [.long("text")], help: "message body"),
          .make(label: "file", names: [.long("file")], help: "path to attachment"),
          .make(label: "service", names: [.long("service")], help: "imessage|sms|auto"),
          .make(label: "region", names: [.long("region")], help: "region for phone normalization"),
        ]
      )
    ),
    usageExamples: [
      "imsg send --to +14155551212 --text \"hi\"",
      "imsg send --to +14155551212 --file ~/Desktop/pic.jpg",
      "imsg send --chat-id 1 --text \"hi\"",
    ]
  ) { values, runtime in
    try await run(values: values, runtime: runtime)
  }

  static func run(
    values: ParsedValues,
    runtime: RuntimeOptions,
    sendMessage: @escaping (MessageSendOptions) throws -> Void = { try MessageSender().send($0) },
    storeFactory: @escaping (String) throws -> MessageStore = { try MessageStore(path: $0) }
  ) async throws {
    let dbPath = values.option("db") ?? MessageStore.defaultPath
    let recipient = values.option("to") ?? ""
    let chatID = values.optionInt64("chatID")
    let chatIdentifier = values.option("chatIdentifier") ?? ""
    let chatGUID = values.option("chatGUID") ?? ""
    let hasChatTarget = chatID != nil || !chatIdentifier.isEmpty || !chatGUID.isEmpty
    if hasChatTarget && !recipient.isEmpty { throw ParsedValuesError.invalidOption("to") }
    if !hasChatTarget && recipient.isEmpty { throw ParsedValuesError.missingOption("to") }
    let text = values.option("text") ?? ""
    let file = values.option("file") ?? ""
    if text.isEmpty && file.isEmpty { throw ParsedValuesError.missingOption("text or file") }
    let serviceRaw = values.option("service") ?? "auto"
    guard let service = MessageService(rawValue: serviceRaw) else {
      throw IMsgError.invalidService(serviceRaw)
    }
    let region = values.option("region") ?? "US"
    var resolvedChatIdentifier = chatIdentifier
    var resolvedChatGUID = chatGUID
    if let chatID {
      let store = try storeFactory(dbPath)
      guard let info = try store.chatInfo(chatID: chatID) else {
        throw IMsgError.invalidChatTarget("Unknown chat id \(chatID)")
      }
      resolvedChatIdentifier = info.identifier
      resolvedChatGUID = info.guid
    }
    if hasChatTarget && resolvedChatIdentifier.isEmpty && resolvedChatGUID.isEmpty {
      throw IMsgError.invalidChatTarget("Missing chat identifier or guid")
    }
    try sendMessage(MessageSendOptions(
      recipient: recipient, text: text, attachmentPath: file,
      service: service, region: region,
      chatIdentifier: resolvedChatIdentifier, chatGUID: resolvedChatGUID
    ))
    if runtime.jsonOutput {
      try JSONLines.print(["status": "sent"])
    } else {
      Swift.print("sent")
    }
  }
}

// MARK: - Typing

enum TypingCommand {
  static let spec = CommandSpec(
    name: "typing",
    abstract: "Control typing indicator for a conversation",
    discussion: "Set or clear the typing indicator (three dots) in a conversation.\nRequires advanced permissions (SIP disabled).",
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions() + [
          .make(label: "handle", names: [.long("handle")], help: "Phone number, email, or chat identifier"),
          .make(label: "state", names: [.long("state")], help: "on or off"),
        ]
      )
    ),
    usageExamples: [
      "imsg-plus typing --handle +14155551234 --state on",
      "imsg-plus typing --handle john@example.com --state off",
    ]
  ) { values, runtime in
    guard let handle = values.option("handle") else { throw IMsgError.invalidArgument("--handle is required") }
    guard let state = values.option("state"), state == "on" || state == "off" else {
      throw IMsgError.invalidArgument("--state must be 'on' or 'off'")
    }
    let bridge = IMCoreBridge.shared
    let availability = bridge.checkAvailability()
    guard availability.available else {
      print("⚠️  \(availability.message)")
      return
    }
    try await bridge.setTyping(for: handle, typing: state == "on")
    if runtime.jsonOutput {
      print(JSONSerialization.string(from: [
        "success": true, "handle": handle, "typing": state == "on",
      ] as [String: Any]))
    } else {
      print("\(state == "on" ? "💬" : "✓") Typing indicator \(state == "on" ? "enabled" : "disabled") for \(handle)")
    }
  }
}

// MARK: - Read

enum ReadCommand {
  static let spec = CommandSpec(
    name: "read",
    abstract: "Mark messages as read and send read receipts",
    discussion: "Clears unread badge and sends read receipts.\nRequires advanced permissions (SIP disabled).",
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions() + [
          .make(label: "handle", names: [.long("handle")], help: "Phone number, email, or chat identifier")
        ]
      )
    ),
    usageExamples: [
      "imsg-plus read --handle +14155551234",
      "imsg-plus read --handle john@example.com",
    ]
  ) { values, runtime in
    guard let handle = values.option("handle") else { throw IMsgError.invalidArgument("--handle is required") }
    let bridge = IMCoreBridge.shared
    let availability = bridge.checkAvailability()
    guard availability.available else {
      print("⚠️  \(availability.message)")
      return
    }
    try await bridge.markAsRead(handle: handle)
    if runtime.jsonOutput {
      print(JSONSerialization.string(from: [
        "success": true, "handle": handle, "marked_as_read": true,
      ] as [String: Any]))
    } else {
      print("✓ Marked messages as read for \(handle)")
    }
  }
}

// MARK: - Status

enum StatusCommand {
  static let spec = CommandSpec(
    name: "status",
    abstract: "Check availability of imsg-plus features",
    discussion: nil,
    signature: CommandSignatures.withRuntimeFlags(CommandSignature()),
    usageExamples: ["imsg-plus status"]
  ) { values, runtime in
    let availability = IMCoreBridge.shared.checkAvailability()
    if runtime.jsonOutput {
      print(JSONSerialization.string(from: [
        "basic_features": true, "advanced_features": availability.available,
        "typing_indicators": availability.available, "read_receipts": availability.available,
        "message": availability.message,
      ] as [String: Any]))
    } else {
      print("imsg-plus Status Report")
      print("========================")
      print("\nBasic features (send, receive, history):\n  ✅ Available")
      print("\nAdvanced features (typing indicators, read receipts):")
      if availability.available {
        print("  ✅ Available - IMCore framework loaded")
        print("\nAvailable commands:")
        print("  • imsg-plus typing <handle> <state>")
        print("  • imsg-plus read <handle>")
      } else {
        print("  ⚠️  Not available")
        print("\nTo enable: disable SIP, grant Full Disk Access, restart imsg-plus.")
      }
    }
  }
}

// MARK: - Launch

enum LaunchCommand {
  static let spec = CommandSpec(
    name: "launch",
    abstract: "Launch Messages.app with dylib injection",
    discussion: "Kills Messages.app and relaunches with DYLD_INSERT_LIBRARIES injection.",
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: [
          .make(label: "dylib", names: [.long("dylib")], help: "Custom path to dylib")
        ],
        flags: [
          .make(label: "killOnly", names: [.long("kill-only")], help: "Only kill, don't relaunch"),
          .make(label: "quiet", names: [.long("quiet"), .short("q")], help: "Suppress output"),
        ]
      )
    ),
    usageExamples: ["imsg-plus launch", "imsg-plus launch --kill-only"]
  ) { values, runtime in
    let killOnly = values.flag("killOnly")
    let quiet = values.flag("quiet")
    let bridge = IMCoreBridge.shared
    if !quiet && !runtime.jsonOutput { print("🔄 Killing Messages.app...") }
    bridge.killMessages()
    if killOnly {
      try await Task.sleep(nanoseconds: 1_000_000_000)
      if runtime.jsonOutput {
        print(JSONSerialization.string(from: ["success": true, "action": "kill"] as [String: Any]))
      } else if !quiet { print("✅ Messages.app terminated") }
      return
    }
    let searchPaths = ["/usr/local/lib/imsg-plus-helper.dylib", ".build/release/imsg-plus-helper.dylib"]
    let customDylib = values.option("dylib")
    let resolvedPath: String? = customDylib.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
      ?? searchPaths.first { FileManager.default.fileExists(atPath: $0) }
    guard let resolvedPath else {
      let error = "imsg-plus-helper.dylib not found. Run 'make build-dylib' or specify --dylib <path>"
      if runtime.jsonOutput {
        print(JSONSerialization.string(from: ["success": false, "error": error] as [String: Any]))
      } else { print("❌ \(error)") }
      throw IMsgError.invalidArgument("dylib not found")
    }
    bridge.dylibPath = resolvedPath
    if !quiet && !runtime.jsonOutput { print("📦 Using dylib: \(resolvedPath)") }
    try await Task.sleep(nanoseconds: 2_000_000_000)
    if !quiet && !runtime.jsonOutput { print("🚀 Launching Messages.app with injection...") }
    do {
      try bridge.ensureRunning()
      if runtime.jsonOutput {
        print(JSONSerialization.string(from: ["success": true, "action": "launch", "dylib": resolvedPath] as [String: Any]))
      } else if !quiet { print("✅ Messages.app launched with dylib injection") }
    } catch {
      if runtime.jsonOutput {
        print(JSONSerialization.string(from: ["success": false, "error": "\(error)"] as [String: Any]))
      } else if !quiet { print("❌ Failed to launch: \(error)") }
      throw error
    }
  }
}

// MARK: - RPC

enum RpcCommand {
  static let spec = CommandSpec(
    name: "rpc",
    abstract: "Run JSON-RPC over stdin/stdout",
    discussion: nil,
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: CommandSignatures.baseOptions(),
        flags: [
          .make(label: "noAutoRead", names: [.long("no-auto-read")], help: "Disable automatic read receipts"),
          .make(label: "noAutoTyping", names: [.long("no-auto-typing")], help: "Disable automatic typing indicators"),
        ]
      )
    ),
    usageExamples: ["imsg rpc", "imsg rpc --no-auto-read", "imsg rpc --no-auto-typing"]
  ) { values, runtime in
    let dbPath = values.option("db") ?? MessageStore.defaultPath
    let store = try MessageStore(path: dbPath)
    let server = RPCServer(
      store: store, verbose: runtime.verbose,
      autoRead: values.flag("noAutoRead") ? false : nil,
      autoTyping: values.flag("noAutoTyping") ? false : nil
    )
    try await server.run()
  }
}
