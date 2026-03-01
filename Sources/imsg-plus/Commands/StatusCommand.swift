import Commander
import Foundation
import IMsgCore

enum StatusCommand {
  static let spec = CommandSpec(
    name: "status",
    abstract: "Check availability of imsg-plus features",
    discussion: """
      Display the current status of imsg-plus features and permissions.
      Shows which advanced features are available and provides setup
      instructions if needed.
      """,
    signature: CommandSignatures.withRuntimeFlags(CommandSignature()),
    usageExamples: [
      "imsg-plus status"
    ]
  ) { values, runtime in
    try await run(values: values, runtime: runtime)
  }

  static func run(values: ParsedValues, runtime: RuntimeOptions) async throws {
    let bridge = IMCoreBridge.shared
    let availability = bridge.checkAvailability()

    if runtime.jsonOutput {
      let output: [String: Any] = [
        "basic_features": true,
        "advanced_features": availability.available,
        "typing_indicators": availability.available,
        "read_receipts": availability.available,
        "message": availability.message,
      ]
      print(JSONSerialization.string(from: output))
    } else {
      print("imsg-plus Status Report")
      print("========================")
      print()
      print("Basic features (send, receive, history):")
      print("  ✅ Available")
      print()
      print("Advanced features (typing indicators, read receipts):")
      if availability.available {
        print("  ✅ Available - IMCore framework loaded")
        print()
        print("Available commands:")
        print("  • imsg-plus typing <handle> <state>")
        print("  • imsg-plus read <handle>")
      } else {
        print("  ⚠️  Not available")
        print()
        print("To enable advanced features:")
        print("  1. Disable System Integrity Protection (SIP)")
        print("     - Restart Mac holding Cmd+R")
        print("     - Open Terminal from Utilities")
        print("     - Run: csrutil disable")
        print("     - Restart normally")
        print()
        print("  2. Grant Full Disk Access")
        print("     - System Settings → Privacy & Security → Full Disk Access")
        print("     - Add Terminal or your terminal app")
        print()
        print("  3. Restart imsg-plus")
        print()
        print("Note: Basic messaging features work without these steps.")
      }
    }
  }
}
