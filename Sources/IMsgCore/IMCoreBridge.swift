import Foundation

public enum IMCoreBridgeError: Error, CustomStringConvertible {
  case dylibNotFound
  case connectionFailed(String)
  case chatNotFound(String)
  case operationFailed(String)

  public var description: String {
    switch self {
    case .dylibNotFound:
      return "imsg-plus-helper.dylib not found. Build with: make build-dylib"
    case .connectionFailed(let error):
      return "Connection to Messages.app failed: \(error)"
    case .chatNotFound(let id):
      return "Chat not found: \(id)"
    case .operationFailed(let reason):
      return "Operation failed: \(reason)"
    }
  }
}

/// Bridge to IMCore via DYLD injection into Messages.app.
///
/// Manages the full lifecycle: finding the dylib, launching Messages.app
/// with injection, and communicating via file-based IPC. The dylib runs
/// inside Messages.app's process where it has access to the private
/// IMCore framework for typing indicators and read receipts.
///
/// IPC protocol:
///   CLI writes JSON to ~/.imsg-plus-command.json (in Messages container)
///   Dylib reads it, processes it, writes response to ~/.imsg-plus-response.json
///   Dylib clears the command file to signal completion
///   Lock file ~/.imsg-plus-ready contains Messages.app PID when ready
public final class IMCoreBridge: @unchecked Sendable {
  public static let shared = IMCoreBridge()

  // MARK: - IPC file paths (inside Messages.app container)

  private var containerPath: String {
    NSHomeDirectory() + "/Library/Containers/com.apple.MobileSMS/Data"
  }
  private var commandFile: String { containerPath + "/.imsg-plus-command.json" }
  private var responseFile: String { containerPath + "/.imsg-plus-response.json" }
  private var lockFile: String { containerPath + "/.imsg-plus-ready" }

  private let messagesAppPath = "/System/Applications/Messages.app/Contents/MacOS/Messages"
  private let queue = DispatchQueue(label: "imsg.bridge")
  private let lock = NSLock()

  private static let dylibSearchPaths = [
    ".build/release/imsg-plus-helper.dylib",
    ".build/debug/imsg-plus-helper.dylib",
    "/usr/local/lib/imsg-plus-helper.dylib",
  ]

  /// Resolved path to the dylib, or nil if not found
  public var dylibPath: String?

  public var isAvailable: Bool { dylibPath != nil }

  private init() {
    self.dylibPath =
      Self.dylibSearchPaths.first { FileManager.default.fileExists(atPath: $0) }
      ?? {
        let bundleSibling = Bundle.main.bundlePath + "/../imsg-plus-helper.dylib"
        return FileManager.default.fileExists(atPath: bundleSibling) ? bundleSibling : nil
      }()
  }

  // MARK: - Public API

  public func setTyping(for handle: String, typing: Bool) async throws {
    _ = try await sendCommand(action: "typing", params: ["handle": handle, "typing": typing])
  }

  public func markAsRead(handle: String) async throws {
    _ = try await sendCommand(action: "read", params: ["handle": handle])
  }

  public func getStatus() async throws -> [String: Any] {
    return try await sendCommand(action: "status", params: [:])
  }

  public func checkAvailability() -> (available: Bool, message: String) {
    guard dylibPath != nil else {
      return (
        false,
        """
        imsg-plus-helper.dylib not found. To enable:
        1. make build-dylib
        2. Disable SIP (csrutil disable from Recovery Mode)
        3. Grant Full Disk Access to Terminal
        """
      )
    }
    if isInjectedAndReady() {
      return (true, "Connected to Messages.app. IMCore features available.")
    }
    do {
      try ensureRunning()
      return (true, "Messages.app launched with injection. IMCore features available.")
    } catch {
      return (false, String(describing: error))
    }
  }

  // MARK: - Messages.app Lifecycle

  public func isInjectedAndReady() -> Bool {
    guard FileManager.default.fileExists(atPath: lockFile) else { return false }
    do {
      let response = try sendCommandSync(action: "ping", params: [:])
      return response["success"] as? Bool == true
    } catch {
      return false
    }
  }

  public func ensureRunning() throws {
    if isInjectedAndReady() { return }

    guard let path = dylibPath, FileManager.default.fileExists(atPath: path) else {
      throw IMCoreBridgeError.dylibNotFound
    }

    killMessages()
    Thread.sleep(forTimeInterval: 1.0)

    for file in [commandFile, responseFile, lockFile] {
      try? FileManager.default.removeItem(atPath: file)
    }

    try launchWithInjection(dylibPath: path)
    try waitForReady(timeout: 15.0)
  }

  public func killMessages() {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
    task.arguments = ["Messages"]
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    try? task.run()
    task.waitUntilExit()
  }

  // MARK: - IPC

  private func sendCommand(action: String, params: [String: Any]) async throws -> [String: Any] {
    try ensureRunning()

    let paramsCopy = params
    let response = try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<[String: Any], Error>) in
      queue.async {
        do {
          let response = try self.sendCommandSync(action: action, params: paramsCopy)
          continuation.resume(returning: response)
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }

    if response["success"] as? Bool == true {
      return response
    }

    let error = response["error"] as? String ?? "Unknown error"
    if error.contains("Chat not found") {
      throw IMCoreBridgeError.chatNotFound(params["handle"] as? String ?? "unknown")
    }
    throw IMCoreBridgeError.operationFailed(error)
  }

  private func sendCommandSync(action: String, params: [String: Any]) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }

    let command: [String: Any] = [
      "id": Int(Date().timeIntervalSince1970 * 1000),
      "action": action,
      "params": params,
    ]

    let jsonData = try JSONSerialization.data(withJSONObject: command, options: [])
    try jsonData.write(to: URL(fileURLWithPath: commandFile))

    let deadline = Date().addingTimeInterval(10.0)
    while Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)

      guard let responseData = try? Data(contentsOf: URL(fileURLWithPath: responseFile)),
        responseData.count > 2
      else { continue }

      if let cmdData = try? Data(contentsOf: URL(fileURLWithPath: commandFile)),
        cmdData.count <= 2
      {
        guard
          let response = try? JSONSerialization.jsonObject(with: responseData, options: [])
            as? [String: Any]
        else {
          throw IMCoreBridgeError.operationFailed("Invalid response from dylib")
        }
        try? "".write(toFile: responseFile, atomically: true, encoding: .utf8)
        return response
      }
    }

    throw IMCoreBridgeError.operationFailed("Timeout waiting for dylib response")
  }

  // MARK: - Private Helpers

  private func launchWithInjection(dylibPath: String) throws {
    let absolutePath =
      dylibPath.hasPrefix("/")
      ? dylibPath
      : FileManager.default.currentDirectoryPath + "/" + dylibPath

    guard FileManager.default.fileExists(atPath: absolutePath) else {
      throw IMCoreBridgeError.dylibNotFound
    }

    let task = Process()
    task.executableURL = URL(fileURLWithPath: messagesAppPath)
    var environment = ProcessInfo.processInfo.environment
    environment["DYLD_INSERT_LIBRARIES"] = absolutePath
    task.environment = environment
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice

    do {
      try task.run()
    } catch {
      throw IMCoreBridgeError.connectionFailed("Failed to launch Messages.app: \(error)")
    }
  }

  private func waitForReady(timeout: TimeInterval) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if FileManager.default.fileExists(atPath: lockFile) {
        Thread.sleep(forTimeInterval: 0.5)
        return
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    throw IMCoreBridgeError.connectionFailed(
      "Timeout waiting for Messages.app. Ensure SIP is disabled.")
  }
}
