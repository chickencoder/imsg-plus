import Commander
import Foundation
import IMsgCore

enum LaunchCommand {
  static let spec = CommandSpec(
    name: "launch",
    abstract: "Launch Messages.app with dylib injection",
    discussion: """
      Kills any running Messages.app instance, then relaunches it with
      DYLD_INSERT_LIBRARIES set to inject the imsg-plus helper dylib.
      Waits for the lock file to confirm successful injection.

      The dylib is searched in order:
        1. /usr/local/lib/imsg-plus-helper.dylib
        2. .build/release/imsg-plus-helper.dylib (relative to cwd)
        3. Custom path via --dylib flag
      """,
    signature: CommandSignatures.withRuntimeFlags(
      CommandSignature(
        options: [
          .make(
            label: "dylib", names: [.long("dylib")],
            help: "Custom path to imsg-plus-helper.dylib")
        ],
        flags: [
          .make(
            label: "killOnly", names: [.long("kill-only")],
            help: "Only kill Messages.app, don't relaunch"),
          .make(
            label: "quiet", names: [.long("quiet"), .short("q")],
            help: "Suppress non-essential output"),
        ]
      )
    ),
    usageExamples: [
      "imsg-plus launch",
      "imsg-plus launch --kill-only",
      "imsg-plus launch --dylib /path/to/dylib",
      "imsg-plus launch --json",
      "imsg-plus launch --quiet",
    ]
  ) { values, runtime in
    try await run(values: values, runtime: runtime)
  }

  static func run(values: ParsedValues, runtime: RuntimeOptions) async throws {
    let killOnly = values.flags.contains("killOnly")
    let quiet = values.flags.contains("quiet")
    let customDylib = values.option("dylib")

    let bridge = IMCoreBridge.shared

    // Kill Messages.app
    if !quiet && !runtime.jsonOutput {
      print("🔄 Killing Messages.app...")
    }
    bridge.killMessages()

    if killOnly {
      // Wait briefly for termination
      try await Task.sleep(nanoseconds: 1_000_000_000)

      if runtime.jsonOutput {
        let output: [String: Any] = [
          "success": true,
          "action": "kill",
          "message": "Messages.app terminated",
        ]
        print(JSONSerialization.string(from: output))
      } else if !quiet {
        print("✅ Messages.app terminated")
      }
      return
    }

    // Resolve dylib path
    let dylibPath = resolveDylibPath(custom: customDylib)

    guard let resolvedPath = dylibPath else {
      let error =
        "imsg-plus-helper.dylib not found. Searched:\n"
        + "  - /usr/local/lib/imsg-plus-helper.dylib\n"
        + "  - .build/release/imsg-plus-helper.dylib\n"
        + "Run 'make build-dylib' or specify --dylib <path>"

      if runtime.jsonOutput {
        let output: [String: Any] = [
          "success": false,
          "error": "dylib_not_found",
          "message": error,
        ]
        print(JSONSerialization.string(from: output))
      } else {
        print("❌ \(error)")
      }
      throw IMsgError.invalidArgument("dylib not found")
    }

    // Set the dylib path on the bridge
    bridge.dylibPath = resolvedPath

    if !quiet && !runtime.jsonOutput {
      print("📦 Using dylib: \(resolvedPath)")
      print("⏳ Waiting for Messages.app to terminate...")
    }

    // Wait for Messages to fully terminate
    try await Task.sleep(nanoseconds: 2_000_000_000)

    if !quiet && !runtime.jsonOutput {
      print("🚀 Launching Messages.app with injection...")
    }

    // Use ensureRunning which handles the full lifecycle
    do {
      try bridge.ensureRunning()

      if runtime.jsonOutput {
        let output: [String: Any] = [
          "success": true,
          "action": "launch",
          "dylib": resolvedPath,
          "message": "Messages.app launched with dylib injection",
        ]
        print(JSONSerialization.string(from: output))
      } else if !quiet {
        print("✅ Messages.app launched with dylib injection")
      }
    } catch {
      if runtime.jsonOutput {
        let output: [String: Any] = [
          "success": false,
          "action": "launch",
          "dylib": resolvedPath,
          "error": "\(error)",
        ]
        print(JSONSerialization.string(from: output))
      } else if !quiet {
        print("❌ Failed to launch: \(error)")
      }
      throw error
    }
  }

  /// Resolve dylib path in priority order
  private static func resolveDylibPath(custom: String?) -> String? {
    // Custom path takes highest priority if provided
    if let custom = custom {
      if FileManager.default.fileExists(atPath: custom) {
        return custom
      }
      return nil
    }

    let searchPaths = [
      "/usr/local/lib/imsg-plus-helper.dylib",
      ".build/release/imsg-plus-helper.dylib",
    ]

    for path in searchPaths {
      if FileManager.default.fileExists(atPath: path) {
        return path
      }
    }

    return nil
  }
}
