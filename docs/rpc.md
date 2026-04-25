# RPC

JSON-RPC 2.0 server over stdin/stdout. No daemon, no TCP port — the caller spawns `imsg-plus rpc` and communicates via stdio.

## Transport

- stdin/stdout, one JSON object per line
- JSON-RPC 2.0 framing (`jsonrpc`, `id`, `method`, `params`)
- Notifications (server → client) omit `id`

## Lifecycle

- Caller spawns `imsg-plus rpc [--no-auto-read] [--no-auto-typing] [--verbose]`
- Process stays alive for watch subscriptions + send queue
- Embedded queue worker runs automatically (no separate daemon)
- Closes when stdin closes

## Methods

### `chats.list`

Params:
- `limit` (int, default 20)

Result: `{ "chats": [Chat] }`

### `messages.history`

Params:
- `chat_id` (int, required)
- `limit` (int, default 50)
- `participants` (array, optional)
- `start` / `end` (ISO8601, optional)
- `attachments` (bool, default false)

Result: `{ "messages": [Message] }`

### `watch.subscribe`

Params:
- `chat_id` (int, optional)
- `since_rowid` (int, optional)
- `participants` (array, optional)
- `start` / `end` (ISO8601, optional)
- `attachments` (bool, default false)
- `stale_threshold` (int, seconds, default 30)

Result: `{ "subscription": 1 }`

Notifications:
- `message` — new message received
- `stale_send` — sent message not appearing in chat.db after threshold
- `heartbeat` — keep-alive every 15 minutes

### `watch.unsubscribe`

Params:
- `subscription` (int, required)

Result: `{ "ok": true }`

### `send`

Enqueues a message for delivery via the built-in queue worker. Returns immediately.

Params (direct):
- `to` (string) — phone number or email
- `text` (string, optional)
- `file` (string, optional)
- `service` ("imessage" | "sms" | "auto", default "auto")
- `region` (string, default "US")
- `idempotency_key` (string, optional — prevents duplicate sends)

Params (group/existing chat):
- `chat_id` or `chat_identifier` or `chat_guid` (one required; `chat_id` preferred)
- `text` / `file` / `service` / `region` as above

Result: `{ "ok": true, "queued": true, "id": 1, "duplicate": false }`

### `queue.status`

No params.

Result: `{ "pending": 0, "processing": 0, "sent": 5, "failed": 0 }`

### `send.voiceNote`

Sends an audio file as a native iMessage voice note (waveform balloon with a
play button on the receiver) instead of a generic file pill. Bypasses
AppleScript and constructs the IMMessage directly via the IMCore dylib so
`isAudioMessage` can be set on the message. The audio is transcoded to AAC
mono 24 kHz m4a (the format current Apple clients produce) via the
built-in `afconvert` before send. Hard-fails when the dylib path is
unavailable rather than degrading to a file pill, and is **not** queued —
the call returns when Messages.app has accepted the message.

Params (direct):
- `to` (string) — phone number or email
- `voice_note` (string, required) — path to an audio file (any format
  `afconvert` supports: `.m4a`, `.mp3`, `.wav`, `.caf`, …)
- `service` ("imessage", default "imessage") — SMS is rejected
- `region` (string, default "US")

Params (group/existing chat):
- `chat_id` or `chat_identifier` or `chat_guid` (one required; `chat_id` preferred)
- `voice_note` / `service` / `region` as above

Result: `{ "ok": true }`

Requires advanced features (SIP disabled + `imsg-plus-helper.dylib` injected
into Messages.app). Check `imsg-plus status --json`'s `voice_note_send`
field.

### `messages.react`

Params:
- `to` (string, required)
- `guid` (string, required — message GUID to react to)
- `type` (string, required — love, like, dislike, laugh, emphasis, question)
- `service` (string, optional)
- `region` (string, optional)

Result: `{ "ok": true }`

### `typing.set`

Requires bridge (dylib injected into Messages.app).

Params:
- `handle` (string, required — phone number or email)
- `state` ("on" | "off", required)

Result: `{ "ok": true }`

### `messages.markRead`

Requires bridge.

Params:
- `handle` (string, required)

Result: `{ "ok": true }`

## Notifications

Server-initiated notifications (no `id` field):

| Method | Params | Trigger |
|---|---|---|
| `message` | `{ subscription, message: Message }` | New message in watched chat |
| `queue.sent` | `{ job_id, idempotency_key, message_id?, guid? }` | Queued message delivered |
| `queue.failed` | `{ job_id, idempotency_key, error, status, attempts, max_attempts }` | Queued message failed |
| `stale_send` | `{ subscription, message }` | Sent message not in chat.db after threshold |
| `heartbeat` | `{ subscription }` | Keep-alive (every 15 min) |

## Objects

### Chat

```json
{
  "id": 1,
  "name": "John",
  "identifier": "+14155551212",
  "guid": "iMessage;-;+14155551212",
  "service": "iMessage",
  "is_group": false,
  "last_message_at": "2026-03-28T12:00:00.000Z",
  "participants": ["+14155551212"]
}
```

### Message

```json
{
  "id": 14245,
  "chat_id": 1,
  "guid": "ABC-123",
  "reply_to_guid": null,
  "sender": "+14155551212",
  "is_from_me": false,
  "text": "Hello",
  "created_at": "2026-03-28T12:00:00.000Z",
  "attachments": [],
  "reactions": [],
  "chat_identifier": "+14155551212",
  "chat_guid": "iMessage;-;+14155551212",
  "chat_name": "John",
  "participants": ["+14155551212"],
  "is_group": false
}
```

## Examples

```json
{"jsonrpc":"2.0","id":1,"method":"chats.list","params":{"limit":5}}
{"jsonrpc":"2.0","id":2,"method":"send","params":{"to":"+14155551212","text":"hello","idempotency_key":"abc-123"}}
{"jsonrpc":"2.0","id":3,"method":"watch.subscribe","params":{"attachments":true}}
{"jsonrpc":"2.0","id":4,"method":"typing.set","params":{"handle":"+14155551212","state":"on"}}
{"jsonrpc":"2.0","id":5,"method":"queue.status","params":{}}
```
