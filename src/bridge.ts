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
  const dylibPath = customDylib
    ? (existsSync(customDylib) ? customDylib : null)
    : findDylib()
  let launching = false
  let requestId = 0

  return {
    available: dylibPath !== null,
    dylibPath,
    setTyping,
    markRead,
    sendContactCard,
    launch,
    kill,
  }

  // Bridge methods become no-ops when unavailable (no-throw, just return)

  async function setTyping(handle: string, typing: boolean): Promise<void> {
    if (!dylibPath) return
    await command("typing", { handle, typing })
  }

  async function markRead(handle: string): Promise<void> {
    if (!dylibPath) return
    await command("read", { handle })
  }

  // Throws when unavailable: contact-card rendering REQUIRES the dylib path,
  // and silently degrading would deliver an inline file pill — exactly the bug
  // this method exists to fix.
  async function sendContactCard(
    handle: string,
    vcardData: Buffer,
    filename: string
  ): Promise<void> {
    if (!dylibPath) {
      throw new Error(
        "contact-card send requires the IMCore dylib (SIP disabled + " +
        "imsg-plus-helper.dylib loaded). Run `imsg-plus status` for setup."
      )
    }
    await command("send_contact_card", {
      handle,
      vcard_b64: vcardData.toString("base64"),
      filename,
    })
  }

  async function launch(opts: { quiet?: boolean } = {}): Promise<void> {
    if (launching) return
    launching = true
    try {
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

      if (!opts.quiet) await waitForReady(15000)
    } finally {
      launching = false
    }
  }

  function kill(): void {
    try {
      execFileSync("/usr/bin/killall", ["Messages"], { stdio: "ignore" })
    } catch {
      // Not running
    }
  }

  async function command(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Hard cap: never block callers for more than 5s. The bridge is
    // best-effort — a stale bridge must not prevent message delivery.
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`bridge timeout (${action})`)), 5000)
    )
    return Promise.race([commandInner(action, params), deadline])
  }

  async function commandInner(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // If the lock file is missing, the dylib isn't loaded — launch first
    if (!existsSync(LOCK_FILE)) await launch()

    const response = await sendAndWait(action, params)
    if (response) return response

    // Timed out — maybe the dylib died. Relaunch once and retry.
    await launch()
    const retry = await sendAndWait(action, params)
    if (retry) return retry

    throw new Error("Timeout waiting for dylib response")
  }

  async function sendAndWait(action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = ++requestId
    writeFileSync(COMMAND_FILE, JSON.stringify({ id, action, params }))

    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await sleep(50)

      // Wait for dylib to write a response and clear the command file
      const cmd = safeRead(COMMAND_FILE)
      if (cmd) continue

      const data = safeRead(RESPONSE_FILE)
      if (!data) continue

      // Only accept responses whose id matches our request
      let response: any
      try {
        response = JSON.parse(data)
      } catch {
        continue
      }

      if (response.id !== undefined && response.id !== id) continue

      writeFileSync(RESPONSE_FILE, "")
      if (response.success) return response
      throw new Error(response.error ?? "Unknown dylib error")
    }

    return null
  }

  async function waitForReady(timeout: number): Promise<void> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (existsSync(LOCK_FILE)) {
        await sleep(500)
        return
      }
      await sleep(500)
    }
    throw new Error("Timeout waiting for Messages.app. Ensure SIP is disabled.")
  }
}

// "Has meaningful JSON content?" — empty string, whitespace, or "{}" don't count
export function safeRead(path: string): string | null {
  if (!existsSync(path)) return null
  const data = readFileSync(path, "utf8").trim()
  return data.length > 2 ? data : null
}

export function findDylib(): string | null {
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
