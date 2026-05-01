# Changelog

## 2.3.0 - 2026-05-01

- feat: `send` RPC now accepts `reply_to` (target message GUID); jobs with it set dispatch through the dylib bridge as threaded replies. AppleScript can't thread, so this requires the IMCore dylib (and a `send_reply` handler in the dylib — see IMsgHelper/IMsgInjected.m for the existing pattern used by `react`/`send_voice_note`).
- feat: `imsg-plus send --reply-to <guid> --to <handle> --text <text>` for one-shot threaded replies via CLI.
- feat: `bridge.sendReply(handle, text, replyToGuid, service?)` and corresponding `worker` integration; reply jobs without an available bridge fail with a clear error rather than silently ignoring threading.
- chore: queue.db jobs table gains a `reply_to_guid` column; older queues are migrated in-place via `ALTER TABLE`.

## 2.2.0 - 2026-05-01

- feat: `--include-reactions` flag on `watch` and `messages` to surface tapback rows (filtered out by default to preserve existing CLI behavior)
- feat: surface `is_audio_message`, `associated_message_type`, `associated_message_guid` on `Message` and the JSON output
- feat: emit `rowid` alongside `id` in JSON output as a chat.db-aligned alias
- fix: `associated_message_guid` is normalized to the bare iMessage GUID (chat.db's `p:N/` part-index prefix is stripped)

## 2.1.1 - 2026-03-28

- fix: remove redundant worker typing that blocked sends for up to 50s when bridge was stale
- fix: add 5s timeout cap to bridge commands so bridge calls never block indefinitely
- cleanup: remove dead `autoType`/`autoTypeOff` functions

## 2.1.0 - 2026-03-04

- feat: FIFO send queue with idempotency keys and stale job reaper
- feat: `enqueue` command for background message delivery
- feat: `worker` command to process message queue
- feat: `queue` command to list/purge/count jobs
- feat: `queue.status` RPC method
- feat: `queue.sent` and `queue.failed` RPC notifications
- feat: `stale_send` notifications when sent messages don't appear in chat.db
- feat: heartbeat notifications every 15 minutes (keep-alive)
- feat: auto-recovery for watch subscriptions on transient DB errors
- feat: `messages.react` RPC method
- feat: TTL cache for chat/participant data
- fix: FIFO queue race condition and message ordering
- fix: fail zombie jobs that exceeded max_attempts instead of endlessly reclaiming

## 2.0.0 - 2026-02-01

Complete rewrite from Swift to TypeScript/Node.js.

- **Breaking**: Requires Node.js 20+ instead of Swift runtime
- **Breaking**: Build with `npm run build` / `make build` instead of SwiftPM
- rewrite: all CLI commands ported to TypeScript (~2100 LOC vs ~8800 LOC)
- feat: `cleanup` command to remove old staged attachments
- feat: better-sqlite3 for database access (faster, simpler than SQLite.swift)
- feat: `arg` for CLI flag parsing (replaces Commander)
- improvement: ~2-3s builds vs ~30s (no SwiftPM overhead)
- improvement: symlink install (instant updates after rebuild)
- same CLI surface area and RPC protocol as v1

## 0.4.1 - Unreleased (v1 branch)

- fix: prefer handle sends when chat identifier is a direct handle
- fix: apply history filters before limit (#20, thanks @tommybananas)

## 0.4.0 - 2026-01-07
- feat: surface audio message transcriptions (thanks @antons)
- fix: stage message attachments in Messages attachments directory (thanks @antons)
- fix: prefer chat GUID for `chat_id` sends to avoid 1:1 AppleScript errors (thanks @mshuffett)
- fix: detect python3 in patch-deps script (thanks @visionik)
- build: add universal binary build helper
- ci: switch to make-based lint/test/build
- docs: update build/test/release instructions
- chore: replace pnpm scripts with make targets

## 0.3.0 - 2026-01-02
- feat: JSON-RPC server over stdin/stdout (`imsg rpc`) with chats, history, watch, and send
- feat: group chat metadata in JSON/RPC output (participants, chat identifiers, is_group)
- feat: tapback + emoji reaction support in JSON output (#8) — thanks @tylerwince
- enhancement: custom emoji reactions and tapback removal handling
- feat: include `guid` and `reply_to_guid` metadata in JSON output
- fix: hide reaction rows from history/watch output and improve reaction matching
- fix: fill missing sender handles from `destination_caller_id` for outgoing/group messages
- fix: harden reaction detection
- docs: add RPC + group chat notes
- test: expand RPC/command coverage, add reaction fixtures, drop unused stdout helper
- test: add coverage for sender fallback
- chore: update copyright year to 2026

## 0.2.1 - 2025-12-30
- fix: avoid crash parsing long attributed bodies (>256 bytes) (thanks @tommybananas)

## 0.2.0 - 2025-12-28
- feat: Swift 6 rewrite with reusable IMsgCore library target
- feat: Commander-based CLI with SwiftPM build/test workflow
- feat: event-driven watch using filesystem events (no polling)
- feat: SQLite.swift + PhoneNumberKit + NSAppleScript integration
- fix: ship PhoneNumberKit resource bundle for CLI installs
- fix: embed Info.plist + AppleEvents entitlement for automation prompts
- fix: fall back to osascript when AppleEvents permission is missing
- fix: decode length-prefixed attributed bodies for sent messages
- chore: SwiftLint + swift-format linting
- change: JSON attachment keys now snake_case
- deprecation note: `--interval` replaced by `--debounce` (no compatibility)
- chore: version.env + generated version source for `--version`

## 0.1.1 - 2025-12-27
- feat: `imsg chats --json`
- fix: drop sqlite `immutable` flag so new messages/replies show up (thanks @zleman1593)
- chore: update go dependencies

## 0.1.0 - 2025-12-20
- feat: `imsg chats` list recent conversations
- feat: `imsg history` with filters (`--participants`, `--start`, `--end`) + `--json`
- feat: `imsg watch` polling stream (`--interval`, `--since-rowid`) + filters + `--json`
- feat: `imsg send` text and/or one attachment (`--service imessage|sms|auto`, `--region`)
- feat: attachment metadata output (`--attachments`) incl. resolved path + missing flag
- fix: clearer Full Disk Access error for `~/Library/Messages/chat.db`
