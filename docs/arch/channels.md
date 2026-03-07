# Channel System

**Date:** 2026-02-27

## Overview

Channels are the I/O boundary between users and the agent. Each channel implements a transport (CLI, Telegram) and converts platform-specific events into `InboundMessage`s pushed onto the message bus. Outbound replies flow the other direction: the `ChannelManager` pulls `OutboundMessage`s from the bus and dispatches them to the correct channel's `send()` method.

The bus uses async queues with cancellation support so that both the inbound consumer (`src/index.ts` main loop) and the outbound consumer (dispatch loop) can shut down cleanly without dangling promises.

## Module Map

```
src/bus/
  types.ts          — ChannelName, InboundMessage, OutboundMessage, sessionKey()
  async-queue.ts    — generic async queue with close/cancellation
  message-bus.ts    — paired inbound + outbound queues, close()

src/channels/
  channel.ts        — Channel interface
  manager.ts        — channel registry, dispatch loop, config reload
  cli.ts            — CLI channel (readline)
  telegram.ts       — Telegram channel (grammy bot)
  dingtalk.ts       — DingTalk channel
  feishu.ts         — Feishu channel (experimental, webhook/websocket inbound + outbound text)
```

## Channel Interface

```typescript
type ChannelName = "cli" | "telegram" | "dingtalk" | "feishu" | "system";

interface Channel {
  readonly name: ChannelName;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  updateConfig?(config: unknown): void;   // optional, hot-reload
}
```

`ChannelName` is a union type used in both `InboundMessage.channel` and `OutboundMessage.channel`. The `"system"` variant is reserved for synthetic messages (e.g. cron jobs) that should not be dispatched to any channel.

`updateConfig` is optional. Channels that support hot-reload implement it. The manager calls it via the interface without type-checking the concrete class.

## Message Types

```typescript
interface InboundMessage {
  channel: ChannelName;
  senderId: string;          // "local" for CLI, "{telegramId}|{username}" for Telegram
  chatId: string;            // "cli" for CLI, Telegram chat ID as string
  content: string;
  timestamp: Date;
  media: string[];           // local file paths of downloaded attachments
  metadata: Record<string, unknown>;
}

interface OutboundMessage {
  channel: ChannelName;
  chatId: string;
  content: string;
  replyTo?: string;
  media: string[];           // local file paths or URLs to send
  metadata: Record<string, unknown>;  // { progress: boolean } controls typing indicator
}
```

`sessionKey(msg)` returns `"{channel}:{chatId}"` — the key used by `SessionManager` and the main loop's per-session serialization.

## AsyncQueue

Generic unbounded FIFO with blocking `pop()` and cooperative cancellation.

| Method | Behavior |
|--------|----------|
| `push(item)` | Resolves a waiting consumer immediately, or buffers |
| `pop()` | Returns next item, or blocks. Returns `undefined` when closed |
| `close()` | Resolves all pending waiters with `undefined`, rejects future pushes |

Consumers detect shutdown by checking `pop()` returning `undefined`. No exceptions are thrown — the caller decides how to exit.

## MessageBus

Thin wrapper around two `AsyncQueue` instances (inbound, outbound). Exposes `publishInbound`, `consumeInbound`, `publishOutbound`, `consumeOutbound`, and `close()`.

`close()` calls `close()` on both queues, unblocking both the main loop (`consumeInbound`) and the dispatch loop (`consumeOutbound`).

## ChannelManager

Owns the channel registry and the outbound dispatch loop.

### Construction

Reads `config.channels` and instantiates enabled channels:

```
constructor(config, bus)
  if config.channels.cli.enabled    → new CLIChannel(bus)
  if config.channels.telegram.enabled → new TelegramChannel(config, bus, workspace)
  if config.channels.dingtalk.enabled → new DingtalkChannel(config, bus)
  if config.channels.feishu.enabled → new FeishuChannel(config, bus)
```

### startAll()

Starts all channels and the dispatch loop concurrently via `Promise.all`. The dispatch loop runs until `stop()` is called.

### Dispatch Loop

```
while (running)
  msg = await bus.consumeOutbound()
  if (!msg) break                     ← queue closed, exit
  if (msg.channel === "system") continue
  channel = channels.get(msg.channel)
  if (channel) channel.send(msg)
```

Errors in `send()` are caught and logged, never propagated. A failing send to one chat does not block messages to other chats.

### stop()

```
stop()
  running = false
  bus.close()          ← unblocks dispatchLoop
  for each channel: channel.stop()
```

### updateConfig(config)

Applies dynamic channel changes on hot reload:

- `false -> true`: instantiate + `start()`
- `true -> false`: `stop()` + unregister
- `true -> true`: call `updateConfig?.(...)`

## CLI Channel

Minimal channel using Node's `readline` interface.

- **start()**: Creates a readline interface on `stdin`/`stdout`. Publishes each non-empty line as an `InboundMessage` with `senderId: "local"`, `chatId: "cli"`. The returned promise resolves when stdin closes.
- **stop()**: Closes the readline interface.
- **send()**: Writes content to `process.stdout.write()` (not `console.log`, to avoid bypassing structured logging).

## Telegram Channel

Single-file implementation (~450 lines) using the [grammY](https://grammy.dev/) bot framework.

### Inbound Processing

All inbound handlers follow the same pattern via two helpers:

**`senderIdFrom(ctx)`** — extracts `"{id}|{username}"` from a grammY context. Single source of truth for sender identity formatting.

**`guardInbound(ctx)`** — calls `senderIdFrom`, then `isAllowed`. Returns a discriminated union:
- `{ allowed: false }` — message should be silently dropped
- `{ allowed: true, senderId, chatId }` — safe to proceed

This eliminates the repeated `senderId` construction + `isAllowed` check that previously appeared in every handler.

### Supported Message Types

| grammY filter | Handler | Notes |
|---------------|---------|-------|
| `message:text` | Inline | Group-aware: requires @mention or reply-to-bot |
| `message:photo` | `handleInboundMedia` | Downloads largest photo size |
| `message:document` | `handleInboundMedia` | Preserves original filename |
| `message:video` | `handleInboundMedia` | Downloads as mp4 |
| `message:audio` | `handleInboundMedia` | Preserves original filename |
| `message:voice` | `handleInboundMedia` | Downloads as ogg |

### Group Chat Logic

For group/supergroup chats, messages are only processed when:
1. The message text/caption @mentions the bot, OR
2. The message is a reply to a bot message

When mentioned, the bot username is stripped from the content before publishing.

### handleInboundMedia

Shared method for all media types (photo, document, video, audio, voice). Handles the group-chat mention/reply check, starts the typing indicator, and publishes the inbound message. The `message:text` handler has its own inline logic because it needs to handle the mentioned-text-becomes-content case.

### Outbound Processing

**Deduplication**: A per-chat map tracks the last sent content (text + media paths concatenated) with a timestamp. Identical content within 5 seconds is suppressed. After the TTL window, the same content can be sent again.

**Typing indicator**: `startTyping(chatId)` sends `sendChatAction("typing")` immediately and repeats every 4 seconds via `setInterval`. `stopTyping(chatId)` clears the interval. Typing starts when an inbound message is received; stops when the final (non-progress) outbound message is sent.

**Text sending**: Content is converted from Markdown to Telegram HTML via `mdToTelegramHtml()`. On HTML parse failure, falls back to plain text.

**Media sending**: Single media items use type-specific API methods (`sendPhoto`, `sendVideo`, etc.). Multiple items use `sendMediaGroup`. Captions are attached to the first item if they fit within Telegram's 1024-character limit; otherwise, caption is sent as a separate text message after the media.

### Markdown to Telegram HTML

`mdToTelegramHtml()` converts a subset of Markdown to Telegram's supported HTML:

- Code blocks → `<pre><code>` (with language class)
- Inline code → `<code>`
- Bold (`**`, `__`) → `<b>`
- Italic (`*`, `_`) → `<i>`
- Strikethrough (`~~`) → `<s>`
- Links → `<a href>`
- List items (`-`) → bullet (`•`)
- Headings → stripped (no Telegram equivalent)
- Blockquotes → stripped

Code blocks and inline code are extracted before HTML-escaping the rest, then re-inserted. This prevents code content from being double-escaped.

### Dynamic Skill Commands

Telegram bot commands are synced from the `{workspace}/skills/` directory:

1. **`registerDynamicSkillHandler()`** — Middleware that intercepts `/command` messages. Checks if the command matches a skill directory name (with `-` replaced by `_`). If matched, publishes as `/{original-name} {args}`.
2. **`syncSkillCommands()`** — Calls `setMyCommands` with builtins (`/start`, `/new`, `/stop`, `/help`) plus discovered skills.
3. **`watchSkillsDir()`** — Watches the skills directory with `fs.watch` and re-syncs commands on changes (debounced 500ms).

### File Downloads

`downloadFile(fileId, fallbackExt, fileName?)` fetches files from Telegram's API, saves to `{tmpdir}/neoclaw/`, and returns the local path as a single-element array. Returns empty array on failure.

### Config Reload

`updateConfig(config)` replaces the stored `TelegramConfig` (notably `allowFrom`). The bot instance is not restarted — changes to `token` require a full restart.

## Data Flow

```
User input (keyboard / Telegram message)
     │
     ▼
  Channel.start()
     │  constructs InboundMessage
     ▼
  MessageBus.publishInbound()
     │
     ▼
  src/index.ts mainLoop
     │  await bus.consumeInbound()
     │  routes to NeovateAgent.processMessage()
     │
     ▼
  Agent yields OutboundMessage(s)
     │  bus.publishOutbound()
     ▼
  ChannelManager.dispatchLoop()
     │  await bus.consumeOutbound()
     │  routes by msg.channel
     ▼
  Channel.send()
     │  platform-specific delivery
     ▼
  User sees response
```

## Shutdown Sequence

```
1. ChannelManager.stop()
2.   → bus.close()               unblocks dispatchLoop and mainLoop
3.   → dispatchLoop exits        consumeOutbound() returns undefined
4.   → mainLoop exits            consumeInbound() returns undefined
5.   → channel.stop() for each   cleans up timers, watchers, bot polling
```

## Entry Points

| Layer | File | Notes |
|-------|------|-------|
| Types | `src/bus/types.ts` | `ChannelName`, `InboundMessage`, `OutboundMessage`, `sessionKey()` |
| Queue | `src/bus/async-queue.ts` | `AsyncQueue<T>` with `push`, `pop`, `close` |
| Bus | `src/bus/message-bus.ts` | `MessageBus` — paired queues with `close()` |
| Interface | `src/channels/channel.ts` | `Channel` interface |
| Manager | `src/channels/manager.ts` | `ChannelManager` — registry, dispatch, config reload |
| CLI | `src/channels/cli.ts` | `CLIChannel` — readline-based |
| Telegram | `src/channels/telegram.ts` | `TelegramChannel` — grammY bot, media handling, skills |
| Main loop | `src/index.ts` | Inbound consumer, per-session serialization |
