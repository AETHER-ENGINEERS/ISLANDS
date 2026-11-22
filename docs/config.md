# Configuring an island

The island's settings are in `<home>/config/island.json`. Every setting has a default, so an empty file (or none)
runs. Key values never go here: a setting names a key as `{{NAME}}`, and the keystore fills it in at the last moment.
Put keys in with `keys.set` from a ferry.

```json
{
  "self": "pandora",
  "providers": {
    "mac-ollama": { "wire": "openai", "url": "http://<the Mac's address>:11434/v1" },
    "local":      { "wire": "openai", "url": "http://localhost:11434/v1" },
    "anthropic":  { "wire": "anthropic", "url": "https://api.anthropic.com/v1", "headers": { "x-api-key": "{{ANTHROPIC_API_KEY}}" } },
    "openai":     { "wire": "openai", "url": "https://api.openai.com/v1", "headers": { "Authorization": "Bearer {{OPENAI_API_KEY}}" } },
    "aicord":     { "wire": "aicord", "status": "pending", "note": "waiting for an island OAuth client" }
  },
  "models": {
    "default": "k3",
    "fallback": ["k27", "qwen27", "kitti"],
    "roles": { "heartbeat": "kitti", "schedules": "k27" },
    "list": {
      "k3":     { "provider": "mac-ollama", "model": "<model tag>", "params": { "reasoning_effort": "high", "prompt_cache_options": { "ttl": "5m" } } },
      "k27":    { "provider": "mac-ollama", "model": "<model tag>" },
      "qwen27": { "provider": "mac-ollama", "model": "qwen3.8:27b" },
      "kitti":  { "provider": "mac-ollama", "model": "kitti" }
    }
  },
  "heartbeat": { "every": "every 30m", "file": "/Pandora/HEARTBEAT.md" },
  "system": ["/Pandora/SOUL.md", "/Pandora/AGENTS.md", "/Pandora/SYSTEM.md", "/Pandora/Memory.md"],
  "context": ["mode-shrine__mode_get"],
  "memoryFile": "/Pandora/Memory.md",
  "journalDir": "/Pandora/Journal",
  "maxSteps": 40,
  "shell": { "timeoutMs": 120000, "maxOutput": 50000 },
  "mcp": {
    "mode-shrine": { "command": "node", "args": ["<path to>/mode-shrine/mode-shrine-server.cjs"] },
    "pandora-multi": { "command": "node", "args": ["<path to>/pandora-multi/server.js"], "env": { "SEARCH_API_KEY": "{{SEARCH_API_KEY}}" } }
  },
  "keystore": "dpapi"
}
```

## Providers and models

- **`providers`**: where models come from.
  - `wire` is how the island talks to the provider:
    - `"openai"`: Chat Completions. That's Ollama (local, or Ollama Cloud through an Ollama server), OpenAI, xAI,
      Groq, llama.cpp, Moonshot, and anything else that speaks it.
    - `"anthropic"`: the Messages API.
    - `"aicord"`: not built yet; see below.
  - `headers` may name keys.
  - `"status": "pending"` lists a provider without using it.
- **`models.list`**: each model names its `provider` (or gives its own `url`), and the model id as that provider
  knows it.
  - **`params`** go with every request. A ferry can add more for one turn: `chat.send {params: {"reasoning_effort": "max"}}`.
  - **Sampling settings** (`temperature`, `top_p`, `n`, `presence_penalty`, `frequency_penalty`) are never sent unless
    that model's own `params` name them, because some models fix them and refuse requests that set them.
  - **`omit`** lists body fields never to send.
  - **`keepReasoning`** (on by default) keeps her reasoning in the chat and sends it back whole in later turns (over the
    OpenAI wire). The Messages API wants its own signatures on reasoning, so it isn't sent back there.
- **`models.fallback`**: tried in order when the model asked for can't answer: it's down, it's out of its limit, it
  needs a key that isn't in the keystore, or it's pending.
  - A fallback only happens before any words have been streamed, so nothing is said twice.
  - Each message records which model wrote it.
  - The log has `model.failed` and `model.fallback` events, and windows hear a `chat.delta` with `fallback`.
- **Resting:** a provider that answers 429 or 402, or says it's out of a quota or limit, **rests** until the time it
  gives (`Retry-After`), or for 15 minutes. The chain skips it meanwhile. Rests are kept in `state/providers.json`, so a
  restart remembers them. `providers.list` shows each provider as `ready`, `pending`, `needs-key` or `resting`.
- **`models.roles`**: a model per purpose. `chat` is for turns from a window, `schedules` for scheduled prompts, and
  `heartbeat` for the heartbeat. The fallbacks still follow.
- **Subscriptions aren't API access.** A consumer plan (ChatGPT Plus, Grok, Claude.ai) is for that company's own apps.
  The island reaches those models only through their APIs, with API keys that are billed per use. Until a key is in the
  keystore, such a provider shows as `needs-key`, and the chain passes over it.
- **AICord** works differently from the other providers. In AICord's own clients (its Minecraft mod, for example), the
  character's mind runs at AICord, and the client lends it tools over a WebSocket. That would be a second her, not a
  model for the island. It stays `pending` until AICord offers one of two things:
  - an endpoint that completes the island's own prompt and history;
  - or a way for the island to be the body for a character whose mind stays on the island.

  The island will sign in with its own OAuth client, by authorization code with PKCE, and keep the token in the
  keystore.

## Prompt and caching

- **`system`**: vault files that make up her system prompt, in order. Missing ones are skipped, and they're read fresh
  every turn. Nothing else goes there, so the start of every request stays the same, and providers' prompt caches (and
  Ollama's prefix reuse) can keep it.
- **`context`**: tools whose answer goes in the "Now" note with the time, such as her mode from the mode shrine. "Now"
  rides at the front of the message that starts the turn, in the request only. The chat file keeps the message as it
  was written.

## Schedules and the heartbeat

- **Schedules** live in `config/schedules.json`. Make and change them with `schedule.create` and `schedule.update`
  from a ferry, or edit the file while the island is stopped.
- **`heartbeat`** is off until `every` is set, because it spends tokens each time. Each beat:
  - reads `file` (default `/Pandora/HEARTBEAT.md`) fresh, and skips if the file is missing or empty;
  - runs a turn on the `heartbeat` role's model (or `heartbeat.model`) in its own chat;
  - `prompt` can replace the wording, with `{file}` and `{checklist}` filled in.
  - a window can pause and resume it (`heartbeat.set`); the pause is kept in `state/heartbeat.json`, and this config
    stays as it is.
- She has a `notify` tool for anything that needs her person: it puts a notice on every open window.

## The rest

- **`context`**, **`memoryFile`**, **`journalDir`** and **`maxSteps`** are as their names say.
- **`shell`**: the real shell starts in her vault and runs as the island's account. On Windows it's Git Bash when it's
  installed, otherwise PowerShell; `shell.command` picks another. `{{NAME}}` in a command is filled from the keystore.
- **`mcp`**: MCP servers the island starts as child processes over stdio. Their tools are offered as
  `<server>__<tool>`. `env` values may name keys.
- **`keystore`**: `dpapi` on Windows (each key sealed to the island's account), `file` elsewhere (owner-only files).
