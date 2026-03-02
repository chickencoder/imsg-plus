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

  function launch(opts: { quiet?: boolean } = {}): void {
    kill()

    if (!dylibPath || !existsSync(dylibPath)) {
      throw new Error("imsg-plus-helper.dylib not found. Run: make build-dylib")
    }

    for (const f of [COMMAND_FILE, RESPONSE_FILE, LOCK_FILE]) {
      try { unlinkSync(f) } catch {}
    }

    const child = execFile(MESSAGES_BIN, [], {
      env: { ...process.env, DYLD_INSERT_LIBRARIES: resolve(dylibPath) },
    })
    child.unref()

    if (!opts.quiet) waitForReady(15000)
  }

  function kill(): void {
    try {
      execFileSync("/usr/bin/killall", ["Messages"], { stdio: "ignore" })
    } catch {
      // Not running
    }
  }

  async function command(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // If the lock file is missing, the dylib isn't loaded — launch first
    if (!existsSync(LOCK_FILE)) launch()

    const response = await sendAndWait(action, params)
    if (response) return response

    // Timed out — maybe the dylib died. Relaunch once and retry.
    launch()
    const retry = await sendAndWait(action, params)
    if (retry) return retry

    throw new Error("Timeout waiting for dylib response")
  }

  async function sendAndWait(action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    writeFileSync(COMMAND_FILE, JSON.stringify({ id: Date.now(), action, params }))

    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await sleep(50)

      // Wait for dylib to write a response and clear the command file
      const cmd = safeRead(COMMAND_FILE)
      if (cmd) continue

      const data = safeRead(RESPONSE_FILE)
      if (!data) continue

      writeFileSync(RESPONSE_FILE, "")
      const response = JSON.parse(data)
      if (response.success) return response
      throw new Error(response.error ?? "Unknown dylib error")
    }

    return null
  }

  function waitForReady(timeout: number): void {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (existsSync(LOCK_FILE)) { sleepSync(500); return }
      sleepSync(500)
    }
    throw new Error("Timeout waiting for Messages.app. Ensure SIP is disabled.")
  }
}

// "Has meaningful JSON content?" — empty string, whitespace, or "{}" don't count
function safeRead(path: string): string | null {
  if (!existsSync(path)) return null
  const data = readFileSync(path, "utf8").trim()
  return data.length > 2 ? data : null
}

function findDylib(): string | null {
  for (const p of DYLIB_SEARCH) {
    if (existsSync(p)) return p
  }
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
