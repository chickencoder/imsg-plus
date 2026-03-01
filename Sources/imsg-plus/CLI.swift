import Commander
import Foundation
import IMsgCore

// MARK: - Command Specification

struct CommandSpec: @unchecked Sendable {
  let name: String
  let abstract: String
  let discussion: String?
  let signature: CommandSignature
  let usageExamples: [String]
  let run: (ParsedValues, RuntimeOptions) async throws -> Void

  var descriptor: CommandDescriptor {
    CommandDescriptor(
      name: name,
      abstract: abstract,
      discussion: discussion,
      signature: signature
    )
  }
}

// MARK: - Common Signatures

enum CommandSignatures {
  static func baseOptions() -> [OptionDefinition] {
    [
      .make(
        label: "db",
        names: [.long("db")],
        help: "Path to chat.db (defaults to ~/Library/Messages/chat.db)"
      )
    ]
  }

  static func withRuntimeFlags(_ signature: CommandSignature) -> CommandSignature {
    signature.withStandardRuntimeFlags()
  }
}

// MARK: - Parsed Values Helpers

enum ParsedValuesError: Error, CustomStringConvertible {
  case missingOption(String)
  case invalidOption(String)
  case missingArgument(String)

  var description: String {
    switch self {
    case .missingOption(let name):
      return "Missing required option: --\(name)"
    case .invalidOption(let name):
      return "Invalid value for option: --\(name)"
    case .missingArgument(let name):
      return "Missing required argument: \(name)"
    }
  }
}

extension ParsedValues {
  func flag(_ label: String) -> Bool { flags.contains(label) }
  func option(_ label: String) -> String? { options[label]?.last }
  func optionValues(_ label: String) -> [String] { options[label] ?? [] }

  func optionInt(_ label: String) -> Int? {
    guard let value = option(label) else { return nil }
    return Int(value)
  }

  func optionInt64(_ label: String) -> Int64? {
    guard let value = option(label) else { return nil }
    return Int64(value)
  }

  func optionRequired(_ label: String) throws -> String {
    guard let value = option(label), !value.isEmpty else {
      throw ParsedValuesError.missingOption(label)
    }
    return value
  }

  func argument(_ index: Int) -> String? {
    guard positional.indices.contains(index) else { return nil }
    return positional[index]
  }
}

// MARK: - Runtime Options

struct RuntimeOptions: Sendable {
  let jsonOutput: Bool
  let verbose: Bool
  let logLevel: String?

  init(parsedValues: ParsedValues) {
    self.jsonOutput = parsedValues.flags.contains("jsonOutput")
    self.verbose = parsedValues.flags.contains("verbose")
    self.logLevel = parsedValues.options["logLevel"]?.last
  }
}

// MARK: - Duration Parser

enum DurationParser {
  static func parse(_ value: String) -> TimeInterval? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let units: [(suffix: String, multiplier: Double)] = [
      ("ms", 0.001), ("s", 1), ("m", 60), ("h", 3600),
    ]
    for unit in units {
      if trimmed.hasSuffix(unit.suffix) {
        let number = String(trimmed.dropLast(unit.suffix.count))
        return Double(number).map { $0 * unit.multiplier }
      }
    }
    return Double(trimmed)
  }
}

// MARK: - Help Printer

struct HelpPrinter {
  static func printRoot(version: String, rootName: String, commands: [CommandSpec]) {
    for line in renderRoot(version: version, rootName: rootName, commands: commands) {
      Swift.print(line)
    }
  }

  static func printCommand(rootName: String, spec: CommandSpec) {
    for line in renderCommand(rootName: rootName, spec: spec) {
      Swift.print(line)
    }
  }

  static func renderRoot(version: String, rootName: String, commands: [CommandSpec]) -> [String] {
    var lines: [String] = []
    lines.append("\(rootName) \(version)")
    lines.append("Send and read iMessage / SMS from the terminal")
    lines.append("")
    lines.append("Usage:")
    lines.append("  \(rootName) <command> [options]")
    lines.append("")
    lines.append("Commands:")
    for command in commands {
      lines.append("  \(command.name)\t\(command.abstract)")
    }
    lines.append("")
    lines.append("Run '\(rootName) <command> --help' for details.")
    return lines
  }

  static func renderCommand(rootName: String, spec: CommandSpec) -> [String] {
    var lines: [String] = []
    lines.append("\(rootName) \(spec.name)")
    lines.append(spec.abstract)
    if let discussion = spec.discussion, !discussion.isEmpty {
      lines.append("\n\(discussion)")
    }
    lines.append("")
    lines.append("Usage:")
    lines.append("  \(rootName) \(spec.name) \(usageFragment(for: spec.signature))")
    lines.append("")
    if !spec.signature.arguments.isEmpty {
      lines.append("Arguments:")
      for arg in spec.signature.arguments {
        let optionalMark = arg.isOptional ? "?" : ""
        lines.append("  \(arg.label)\(optionalMark)\t\(arg.help ?? "")")
      }
      lines.append("")
    }
    let options = spec.signature.options
    let flags = spec.signature.flags
    if !options.isEmpty || !flags.isEmpty {
      lines.append("Options:")
      for option in options {
        let names = formatNames(option.names, expectsValue: true)
        lines.append("  \(names)\t\(option.help ?? "")")
      }
      for flag in flags {
        let names = formatNames(flag.names, expectsValue: false)
        lines.append("  \(names)\t\(flag.help ?? "")")
      }
      lines.append("")
    }
    if !spec.usageExamples.isEmpty {
      lines.append("Examples:")
      for example in spec.usageExamples {
        lines.append("  \(example)")
      }
    }
    return lines
  }

  private static func usageFragment(for signature: CommandSignature) -> String {
    var parts: [String] = []
    for argument in signature.arguments {
      let token = argument.isOptional ? "[\(argument.label)]" : "<\(argument.label)>"
      parts.append(token)
    }
    if !signature.options.isEmpty || !signature.flags.isEmpty {
      parts.append("[options]")
    }
    return parts.joined(separator: " ")
  }

  private static func formatNames(_ names: [CommanderName], expectsValue: Bool) -> String {
    let parts = names.map { name -> String in
      switch name {
      case .short(let char): return "-\(char)"
      case .long(let value): return "--\(value)"
      case .aliasShort(let char): return "-\(char)"
      case .aliasLong(let value): return "--\(value)"
      }
    }
    return parts.joined(separator: ", ") + (expectsValue ? " <value>" : "")
  }
}

// MARK: - Command Router

struct CommandRouter {
  let rootName = "imsg-plus"
  let version: String
  let specs: [CommandSpec]
  let program: Program

  init() {
    self.version = CommandRouter.resolveVersion()
    self.specs = [
      ChatsCommand.spec,
      HistoryCommand.spec,
      WatchCommand.spec,
      SendCommand.spec,
      RpcCommand.spec,
      TypingCommand.spec,
      ReadCommand.spec,
      StatusCommand.spec,
      LaunchCommand.spec,
    ]
    let descriptor = CommandDescriptor(
      name: rootName,
      abstract: "Send and read iMessage / SMS from the terminal",
      discussion: nil,
      signature: CommandSignature(),
      subcommands: specs.map { $0.descriptor }
    )
    self.program = Program(descriptors: [descriptor])
  }

  func run() async -> Int32 {
    return await run(argv: CommandLine.arguments)
  }

  func run(argv: [String]) async -> Int32 {
    let argv = normalizeArguments(argv)
    if argv.contains("--version") || argv.contains("-V") {
      Swift.print(version)
      return 0
    }
    if argv.count <= 1 || argv.contains("--help") || argv.contains("-h") {
      printHelp(for: argv)
      return 0
    }
    do {
      let invocation = try program.resolve(argv: argv)
      guard let commandName = invocation.path.last,
        let spec = specs.first(where: { $0.name == commandName })
      else {
        Swift.print("Unknown command")
        HelpPrinter.printRoot(version: version, rootName: rootName, commands: specs)
        return 1
      }
      let runtime = RuntimeOptions(parsedValues: invocation.parsedValues)
      do {
        try await spec.run(invocation.parsedValues, runtime)
        return 0
      } catch {
        Swift.print(error)
        return 1
      }
    } catch let error as CommanderProgramError {
      Swift.print(error.description)
      if case .missingSubcommand = error {
        HelpPrinter.printRoot(version: version, rootName: rootName, commands: specs)
      }
      return 1
    } catch {
      Swift.print(error)
      return 1
    }
  }

  private func normalizeArguments(_ argv: [String]) -> [String] {
    guard !argv.isEmpty else { return argv }
    var copy = argv
    copy[0] = URL(fileURLWithPath: argv[0]).lastPathComponent
    return copy
  }

  private func printHelp(for argv: [String]) {
    let path = helpPath(from: argv)
    if path.count <= 1 {
      HelpPrinter.printRoot(version: version, rootName: rootName, commands: specs)
      return
    }
    if let spec = specs.first(where: { $0.name == path[1] }) {
      HelpPrinter.printCommand(rootName: rootName, spec: spec)
    } else {
      HelpPrinter.printRoot(version: version, rootName: rootName, commands: specs)
    }
  }

  private func helpPath(from argv: [String]) -> [String] {
    var path: [String] = []
    for token in argv {
      if token == "--help" || token == "-h" { continue }
      if token.hasPrefix("-") { break }
      path.append(token)
    }
    return path
  }

  private static func resolveVersion() -> String {
    if let envVersion = ProcessInfo.processInfo.environment["IMSG_VERSION"],
      !envVersion.isEmpty
    {
      return envVersion
    }
    return IMsgVersion.current
  }
}
