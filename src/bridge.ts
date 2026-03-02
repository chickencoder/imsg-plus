import { execFileSync, execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const CONTAINER = join(homedir(), "Library/Containers/com.apple.MobileSMS/Data")
const COMMAND_FILE = join(CONTAINER, ".imsg-plus-command.json")
const RESPONSE_FILE = join(CONTAINER, ".imsg-plus-response.json")
const LOCK_FILE = join(CONTAINER, ".imsg-plus-ready")
const MESSAGES_BIN = "/System/Applications/Messages.app/Contents/MacOS/Messages"

const DYLIB_SEARCH = [
  ".build/release/imsg-plus-helper.dylib",
  ".build/debug/imsg-plus-helper.dylib",
  "/usr/local/lib/imsg-plus-helper.dylib",
]

export type Bridge = ReturnType<typeof createBridge>

export function createBridge(customDylib?: string) {
  const dylibPath = customDylib ?? findDylib()

  return {
    available: dylibPath !== null,
    dylibPath,
    setTyping,
    markRead,
    status,
    launch,
    kill,
  }

  async function setTyping(handle: string, typing: boolean): Promise<void> {
    await command("typing", { handle, typing })
  }

  async function markRead(handle: string): Promise<void> {
    await command("read", { handle })
  }

  async function status(): Promise<Record<string, unknown>> {
    return await command("status", {})
  }

  function launch(opts: { killOnly?: boolean; quiet?: boolean } = {}): void {
    kill()
    if (opts.killOnly) return

    if (!dylibPath || !existsSync(dylibPath)) {
      throw new Error("imsg-plus-helper.dylib not found. Run: make build-dylib")
    }

    // Clean IPC files
    for (const f of [COMMAND_FILE, RESPONSE_FILE, LOCK_FILE]) {
      try { unlinkSync(f) } catch {}
    }

    // Launch Messages.app with dylib injection
    const abs = resolve(dylibPath)
    const child = execFile(MESSAGES_BIN, [], {
      env: { ...process.env, DYLD_INSERT_LIBRARIES: abs },
    })
    child.unref()

    // Wait for ready signal
    if (!opts.quiet) {
      waitForReady(15000)
    }
  }

  function kill(): void {
    try {
      execFileSync("/usr/bin/killall", ["Messages"], { stdio: "ignore" })
    } catch {
      // Not running — that's fine
    }
  }

  async function command(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    ensureRunning()

    const cmd = { id: Date.now(), action, params }
    writeFileSync(COMMAND_FILE, JSON.stringify(cmd))

    // Poll for response (dylib clears the command file when done)
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await sleep(50)

      if (!existsSync(RESPONSE_FILE)) continue
      const responseData = readFileSync(RESPONSE_FILE, "utf8").trim()
      if (responseData.length < 3) continue

      // Check that command file has been cleared (signals completion)
      const cmdData = existsSync(COMMAND_FILE)
        ? readFileSync(COMMAND_FILE, "utf8").trim()
        : ""
      if (cmdData.length > 2) continue

      writeFileSync(RESPONSE_FILE, "")
      const response = JSON.parse(responseData)

      if (response.success) return response
      const error = response.error ?? "Unknown dylib error"
      throw new Error(error)
    }

    throw new Error("Timeout waiting for dylib response")
  }

  function ensureRunning(): void {
    if (existsSync(LOCK_FILE)) {
      // Quick ping to verify
      try {
        const cmd = { id: Date.now(), action: "ping", params: {} }
        writeFileSync(COMMAND_FILE, JSON.stringify(cmd))
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          sleepSync(50)
          const responseData = existsSync(RESPONSE_FILE)
            ? readFileSync(RESPONSE_FILE, "utf8").trim()
            : ""
          if (responseData.length < 3) continue
          const cmdData = existsSync(COMMAND_FILE)
            ? readFileSync(COMMAND_FILE, "utf8").trim()
            : ""
          if (cmdData.length > 2) continue
          writeFileSync(RESPONSE_FILE, "")
          return // It's alive
        }
      } catch {}
    }

    // Not running — launch it
    launch()
  }

  function waitForReady(timeout: number): void {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (existsSync(LOCK_FILE)) {
        sleepSync(500)
        return
      }
      sleepSync(500)
    }
    throw new Error("Timeout waiting for Messages.app. Ensure SIP is disabled.")
  }
}

function findDylib(): string | null {
  for (const p of DYLIB_SEARCH) {
    if (existsSync(p)) return p
  }
  // Check next to the binary
  const sibling = join(process.argv[1] ?? "", "..", "imsg-plus-helper.dylib")
  if (existsSync(sibling)) return sibling
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
