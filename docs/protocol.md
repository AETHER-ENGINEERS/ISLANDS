# The ferry protocol

How a ferry (a window, a phone, a bridge) talks to an island. One language everywhere: **JSON-RPC 2.0, one message
per line** (UTF-8, `\n`-terminated), the same framing MCP's stdio transport uses.

Version: **`islands/0.1`**. A ferry says which version it speaks in `island.hello`; the island answers with its own.
Calls and fields are only ever added within a version; removing or changing one is a new version.

## Transport

- **On Windows**, the harbor (the island's .NET service host) owns the public pipe, `\\.\pipe\pandora-island`. Its
  security descriptor admits only the island's account and the accounts the island's person names. The harbor passes
  each connection through to the core's private pipe.
- **The core** listens on its own endpoint: a named pipe on Windows, a Unix socket elsewhere (tests, CI, other
  systems). The endpoint is named in `state/core.json` with a random token. That file lives in the island's home,
  where only the island's account and its people can read it.
- **Before anything else**, a connection must send `island.hello` with that token. Until it has, the core answers
  nothing else and closes the connection after 10 seconds or on a wrong token. No data flows to a stranger, even one
  that managed to open the pipe.
- Lines are capped at 64 MiB. A longer line closes the connection with an error.

## Messages

Requests carry an `id` and get exactly one response. Notifications from the island carry no `id`.

```json
→ {"jsonrpc":"2.0","id":1,"method":"vault.read","params":{"path":"/Pandora/SOUL.md"}}
← {"jsonrpc":"2.0","id":1,"result":{"path":"/Pandora/SOUL.md","text":"# Pandora Dee Fae\n…","size":2210,"mtime":1795275160191}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":10422,"at":"…","actor":"pandora","kind":"vault.write",…}}
```

Errors use JSON-RPC's codes, plus the island's own:

| code | meaning |
|---|---|
| -32700 | the line isn't JSON |
| -32600 | not a JSON-RPC request |
| -32601 | no such method |
| -32602 | wrong or missing parameters |
| -32603 | something broke inside the island (the message says what) |
| -32000 | not said hello yet, or the hello was refused |
| -32001 | not found (a path, a chat, a thread) |
| -32002 | refused by the island's rules (a path outside the vault, a name Windows can't hold) |
| -32003 | conflict (it exists already, or it changed since you read it) |

## Calls

### island

| method | params | result |
|---|---|---|
| `island.hello` | `{token, ferry: {name, version}, protocol: "islands/0.1", as?}` | `{island: {name, version, protocol}, seq, as}`. `seq` is the last event's number, for catching up |
| `island.status` | none | `{name, version, startedAt, seq, vault: {files, dirs}, chats, ferries, models: {default, names}, mcp: [{name, running, tools, error?}], threads}` |

`as` names who is at this ferry: a person's name, or `"pandora"` for the island's own voice. Every change a ferry
makes is logged with that actor and with `via: "ferry:<name>"`.

### vault

Paths are vault paths: they start with `/`, use `/`, and never contain `.` or `..` parts. `/Pandora/SOUL.md` is the
file `vault/Pandora/SOUL.md` in the island's home.

| method | params | result |
|---|---|---|
| `vault.list` | `{path?: "/", recursive?: true}` | `{entries: [{path, dir, size, mtime}]}` |
| `vault.read` | `{path, encoding?: "utf8"\|"base64"}` | `{path, text?\|base64?, size, mtime}` |
| `vault.write` | `{path, text?\|base64?, ifMtime?}` | `{path, size, mtime}`. Parent folders are made. With `ifMtime`, a file changed since then is a conflict (-32003) |
| `vault.mkdir` | `{path}` | `{path}` |
| `vault.move` | `{from, to}` | `{from, to}`. Whatever was at `to` goes to the trash first |
| `vault.delete` | `{path}` | `{path, trash}`: it moves to the island's trash, never removed outright |

### chats

A chat is a file, `chats/<id>.jsonl`: a first line with the chat's details, then one line per message. The log
records that a message was added, with its fingerprint, not its words.

| method | params | result |
|---|---|---|
| `chat.list` | none | `{chats: [{id, title, created, updated, messages}]}` |
| `chat.create` | `{title?}` | `{chat: {id, title, created}}` |
| `chat.open` | `{id}` | `{chat: {id, title, created}, messages: [{n, role, content, at, by}]}` |
| `chat.post` | `{id, role?: "user", content}` | `{n, at}`. Adds a message as the ferry's person |
| `chat.rename` | `{id, title}` | `{chat}` |

| `chat.send` | `{id, content, model?, params?, purpose?}` | `{n, thread}`: posts the message, then her turn runs as an island thread. `model` picks one; otherwise the model for `purpose` (default `chat`) or the default, then the fallbacks. `params` adds model settings for this turn, such as `{"reasoning_effort": "max"}`. A chat that already has a turn running answers -32003 |

While she answers, every ferry hears:

- `chat.delta` `{chat, thread, content?, reasoning?}` as her words and reasoning stream;
  `{chat, thread, message: n, done}` when a message of hers is kept; `{chat, thread, tool, ok}` after each tool call.
- `chat.delta` `{chat, thread, fallback: {from, reason}}` when a model couldn't answer and the next one is asked.
- `chat.done` `{chat, thread, n?, finish, usage?, model}` when the turn ends.

The chat file keeps each message whole: an assistant message's `tool_calls`, `reasoning_content` and `model`, a tool
result's `tool_call_id` and `name`. That's what goes back to the model in later turns.

### threads

Long work belongs to the island, not to the window that asked: closing a ferry doesn't stop it.

| method | params | result |
|---|---|---|
| `threads.list` | `{limit?: 50}` | `{threads: [{id, kind, title, chat?, by, via, status, started, ended?, error?, progress?}]}` |
| `thread.get` | `{id}` | `{thread}` |
| `thread.cancel` | `{id}` | `{thread}`: it stops, and ends as `cancelled` |

Every ferry hears a `thread` notification (the thread's record) when one starts, makes progress and ends. `status` is
`running`, `done`, `failed`, `cancelled`, or `interrupted` (it was running when the island stopped).

### keys

A key's value goes in once and never comes back out: not to a ferry, a chat, the log or a tool's output. Settings
and tools name it as `{{NAME}}`. On Windows each key is sealed with DPAPI to the island's own account.

| method | params | result |
|---|---|---|
| `keys.list` | none | `{keys: [{name, backend}]}` (names only) |
| `keys.set` | `{name, value}` | `{name, backend}` |
| `keys.delete` | `{name}` | `{name}`: the sealed file goes to the trash |

### tools and models

| method | params | result |
|---|---|---|
| `now.get` | none | `{time, context: [{tool, text}]}`: what each tool in `context` says right now (her mode, from the mode shrine), the same words her turns see in the "Now" note. Only those tools run; the ferry's Now bar reads it |
| `tools.list` | none | `{tools: [{name, description}]}`: built-in ones, then each MCP server's as `<server>__<tool>` |
| `models.list` | none | `{default, fallback, roles, models: [{name, model, provider, host, ready, why?}]}` |
| `providers.list` | none | `{providers: [{name, wire, status, until?, reason?, note?}], chain}`. `status` is `ready`, `pending`, `needs-key` or `resting` (out of its limit until `until`) |

### schedules and the heartbeat

Schedules run as island threads, with no window open. `when` is `every 30m`, `every 2h`, `daily 08:30`,
`weekdays 09:00`, `weekends 10:00` or 5-field cron, in the island's local time.

| method | params | result |
|---|---|---|
| `schedule.list` | none | `{schedules: [{id, name, when, prompt?, command?, model?, chat?, enabled, lastRun?, lastStatus?, next?, running?}]}`. The heartbeat is listed first when it's set up (`enabled: false` while it's paused) |
| `schedule.create` | `{name, when, prompt\|command, model?, enabled?}` | `{schedule}` |
| `schedule.update` | `{id, name?, when?, prompt?, command?, model?, enabled?}` | `{schedule}`. For the heartbeat, only `enabled` (pause or resume) |
| `schedule.delete` | `{id}` | `{id}` |
| `schedule.run` | `{id}` | `{thread}`: runs it now. -32003 if it's still running, or had nothing to do |
| `heartbeat.status` | none | `{enabled, configured, paused?, every?, model?, lastRun?, lastStatus?, next?, running?, chat?, result?}`. `result` is `{text, at, model?}`: her last answer in the heartbeat's chat |
| `heartbeat.set` | `{on}` | the same as `heartbeat.status`. Pauses (`false`) or resumes (`true`) it without changing `config/island.json`; resumed, it beats next at its next time, not at once for the beats it missed |

A schedule's prompt becomes a turn of hers in the schedule's own chat ("⏰ name"). A command's output is kept there
too. Every ferry hears a `notice` notification `{text, urgent, from, at}` when she uses her `notify` tool.

### events

| method | params | result |
|---|---|---|
| `events.subscribe` | `{fromSeq?: 0, kinds?: ["vault.", "chat."]}` | `{seq}`, the last event at the moment of subscribing |
| `events.unsubscribe` | none | `{}` |
| `events.since` | `{fromSeq, limit?: 1000, kinds?}` | `{events: [...], more: bool}` |

After `events.subscribe`, the island sends every event after `fromSeq` that matches `kinds` (prefixes), in order, as
`event` notifications, then every new one as it happens. A ferry that comes back after a while subscribes from the
last `seq` it saw and misses nothing.

## Events

Each line of the island's log is one event:

```json
{"seq":10422,"at":"2026-11-21T09:14:03.120Z","actor":"pandora","via":"ferry:wpf","kind":"vault.write",
 "subject":"/Pandora/Journal/2026-11-21.md","sha256":"…","bytes":2210}
```

- `seq` counts up from 1 and never repeats or goes back. `at` is the island's clock, in UTC.
- `actor` is who did it. `via` is how it reached the island: a ferry, a tool, the scheduler, a jetty.
- Events hold facts, never content: a message's words, a file's text and a key's value are never in the log. The
  fingerprint (`sha256`) ties the fact to the content wherever that is kept.

Kinds so far: `island.start`, `island.stop`, `ferry.hello`, `ferry.bye`, `vault.write`, `vault.mkdir`,
`vault.move`, `vault.delete`, `chat.create`, `chat.rename`, `chat.message` (with `tool` for a tool result),
`thread.start`, `thread.end` (`status`, `ms`), `thread.cancel`, `tool.call` (`tool`, `subject`, `ok`, `ms`),
`key.set`, `key.delete` (the name only), `model.failed` (`model`, `provider`, `status`, `limited`, `restUntil?`),
`model.fallback` (`to`, `passed`), `schedule.create`, `schedule.update`, `schedule.delete`, `schedule.skip`,
`notice` (`urgent`, `bytes`).

The vault folder is the truth, so a file someone changes there directly (Mrrowr-murrr, an editor, another program)
is what `vault.read` returns next. Noticing such changes as events (`vault.outside`) comes with the file watcher in a
later step.
