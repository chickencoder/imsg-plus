import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pickRecipient, normalize, looksLikeHandle, sendVoiceNote } from "../send.js"

function makeBridge(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    dylibPath: "/fake/path.dylib",
    setTyping: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    sendVoiceNote: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    ...overrides,
  } as any
}

describe("pickRecipient", () => {
  it("sends directly to a phone number", () => {
    const result = pickRecipient({ to: "+15551234567", text: "hi" })
    expect(result.recipient).toBe("+15551234567")
    expect(result.chatTarget).toBe("")
    expect(result.service).toBe("imessage")
  })

  it("sends directly to an email", () => {
    const result = pickRecipient({ to: "user@example.com", text: "hi" })
    expect(result.recipient).toBe("user@example.com")
    expect(result.chatTarget).toBe("")
  })

  it("throws when both --to and --chat-id are provided", () => {
    expect(() => pickRecipient({ to: "x", chatId: 1, text: "hi" })).toThrow("not both")
  })

  it("throws when neither --to nor --chat-* is provided", () => {
    expect(() => pickRecipient({ text: "hi" })).toThrow("required")
  })

  it("looks up chat by chatId using db", () => {
    const fakeDb = {
      chat: (id: number) =>
        id === 42
          ? { id: 42, identifier: "chat;+;group", guid: "iMessage;+;chat123", name: "Group", service: "iMessage", isGroup: true }
          : null,
    } as any

    const result = pickRecipient({ chatId: 42, text: "hi" }, fakeDb)
    expect(result.chatTarget).toBe("iMessage;+;chat123")
    expect(result.recipient).toBe("")
  })

  it("throws for unknown chat id", () => {
    const fakeDb = { chat: () => null } as any
    expect(() => pickRecipient({ chatId: 999, text: "hi" }, fakeDb)).toThrow("Unknown chat id")
  })

  it("sends directly when identifier looks like a handle", () => {
    const fakeDb = {
      chat: () => ({ id: 1, identifier: "+15559876543", guid: "iMessage;-;+15559876543", name: "", service: "iMessage", isGroup: false }),
    } as any

    const result = pickRecipient({ chatId: 1, text: "hi" }, fakeDb)
    expect(result.recipient).toBe("+15559876543")
    expect(result.chatTarget).toBe("")
  })

  it("uses specified service instead of auto", () => {
    const result = pickRecipient({ to: "+15551234567", text: "hi", service: "sms" })
    expect(result.service).toBe("sms")
  })

  it("uses chatGuid directly", () => {
    const result = pickRecipient({ chatGuid: "iMessage;+;chat999", text: "hi" })
    expect(result.chatTarget).toBe("iMessage;+;chat999")
  })

  it("uses chatIdentifier directly", () => {
    const result = pickRecipient({ chatIdentifier: "chat;+;group123", text: "hi" })
    expect(result.chatTarget).toBe("chat;+;group123")
  })
})

describe("normalize", () => {
  it("formats US phone numbers to E.164", () => {
    expect(normalize("(555) 123-4567", "US")).toBe("+15551234567")
  })

  it("returns emails unchanged", () => {
    expect(normalize("user@example.com", "US")).toBe("user@example.com")
  })

  it("returns already E.164 numbers unchanged", () => {
    expect(normalize("+15551234567", "US")).toBe("+15551234567")
  })

  it("returns invalid input unchanged", () => {
    expect(normalize("not-a-number", "US")).toBe("not-a-number")
  })
})

describe("looksLikeHandle", () => {
  it("returns true for email addresses", () => {
    expect(looksLikeHandle("user@example.com")).toBe(true)
  })

  it("returns true for phone numbers", () => {
    expect(looksLikeHandle("+15551234567")).toBe(true)
    expect(looksLikeHandle("(555) 123-4567")).toBe(true)
    expect(looksLikeHandle("555 123 4567")).toBe(true)
  })

  it("returns false for chat identifiers", () => {
    expect(looksLikeHandle("chat123;+;group")).toBe(false)
    expect(looksLikeHandle("iMessage;+;chat")).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(looksLikeHandle("")).toBe(false)
  })
})

describe("sendVoiceNote", () => {
  it("rejects --service sms (audio messages don't render over SMS)", async () => {
    await expect(
      sendVoiceNote({ to: "+15551234567", voiceNote: "/tmp/clip.m4a", service: "sms" }, makeBridge())
    ).rejects.toThrow(/SMS/)
  })

  it("throws when the audio file is missing", async () => {
    await expect(
      sendVoiceNote({ to: "+15551234567", voiceNote: "/no/such/audio.m4a" }, makeBridge())
    ).rejects.toThrow(/audio not found/)
  })

  it("throws when the bridge dylib is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imsg-audio-"))
    const srcPath = join(dir, "clip.m4a")
    writeFileSync(srcPath, Buffer.from("fake-audio"))

    const runAfconvert = vi.fn((args: string[]) => {
      writeFileSync(args[args.length - 1], Buffer.from("transcoded"))
    })

    const bridge = makeBridge({
      available: false,
      dylibPath: null,
      sendVoiceNote: vi.fn().mockRejectedValue(new Error("dylib unavailable")),
    })

    try {
      await expect(
        sendVoiceNote({ to: "+15551234567", voiceNote: srcPath, runAfconvert }, bridge)
      ).rejects.toThrow(/dylib/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("transcodes via afconvert and dispatches to bridge.sendVoiceNote with the staged path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imsg-audio-"))
    const srcPath = join(dir, "clip.m4a")
    writeFileSync(srcPath, Buffer.from("fake-audio"))

    const runAfconvert = vi.fn((args: string[]) => {
      writeFileSync(args[args.length - 1], Buffer.from("transcoded"))
    })

    try {
      const bridge = makeBridge()
      await sendVoiceNote({ to: "+15551234567", voiceNote: srcPath, runAfconvert }, bridge)

      expect(runAfconvert).toHaveBeenCalledTimes(2)
      // Step 1: source → mono PCM CAF (lets afconvert downmix cleanly)
      const step1 = runAfconvert.mock.calls[0][0]
      expect(step1).toEqual(expect.arrayContaining(["-f", "caff", "-d", "LEI16", "-c", "1"]))
      // Step 2: mono PCM CAF → mono Opus CAF — Apple's own voice-note codec
      const step2 = runAfconvert.mock.calls[1][0]
      expect(step2).toEqual(expect.arrayContaining(["-f", "caff", "-d", "opus"]))

      expect(bridge.sendVoiceNote).toHaveBeenCalledTimes(1)
      const [target, stagedPath] = bridge.sendVoiceNote.mock.calls[0]
      expect(target).toBe("+15551234567")
      // Staged with the canonical Apple filename for voice notes
      expect(stagedPath).toMatch(/Audio Message\.caf$/)
    } finally {
      vi.restoreAllMocks()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
