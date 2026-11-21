# Configuring an island

The island's settings are in `<home>/config/island.json`. Every setting has a default, so an empty file (or none)
runs. Key values never go here: a setting names a key as `{{NAME}}`, and the keystore fills it in at the last moment.
Put keys in with `keys.set` from a ferry.

```json
{
  "self": "pandora",
  "models": {
    "default": "k3",
    "list": {
      "k3": {
        "url": "https://<provider>/v1",
        "model": "<model id>",
        "headers": { "Authorization": "Bearer {{MODEL_API_KEY}}" },
        "params": { "reasoning_effort": "high", "prompt_cache_options": { "ttl": "5m" } }
      },
      "local": { "url": "http://localhost:11434/v1", "model": "qwen3:8b" }
    }
  },
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

## Settings

- **`self`**: who the island is, in its own events and messages.
- **`models`**: any OpenAI-compatible chat endpoint (Ollama, Ollama Cloud, Groq, llama.cpp, Moonshot …). For each:
  - **`params`** go with every request. A ferry can add more for one turn: `chat.send {params: {"reasoning_effort": "max"}}`.
  - **Sampling settings** (`temperature`, `top_p`, `n`, `presence_penalty`, `frequency_penalty`) are never sent
    unless that model's own `params` name them, because some models fix them and refuse requests that set them.
  - **`omit`** lists body fields never to send, even when a turn asks for them.
  - **`keepReasoning`** is on by default: her reasoning is kept in the chat file and sent back whole in later turns,
    for models that ask for the complete assistant message. Set it to `false` for models that refuse it.
- **`system`**: vault files that make up her system prompt, in order. Missing ones are skipped, and they're read
  fresh every turn.
- **`context`**: tools whose answer goes under "Now" in her system prompt at the start of each turn, such as her
  mode from the mode shrine.
- **`shell`**: the real shell starts in her vault and runs as the island's account. On Windows it's Git Bash when
  it's installed, otherwise PowerShell; `shell.command` picks another. `{{NAME}}` in a command is filled from the
  keystore, and the log keeps the command as written, with the name, not the value.
- **`mcp`**: MCP servers the island starts as child processes over stdio, the way pandora-mcp, pandora-multi and the
  mode shrine already run. Their tools are offered as `<server>__<tool>`. `env` values may name keys.
- **`keystore`**: `dpapi` on Windows (each key sealed to the island's account), `file` elsewhere (files only the
  island's account can read).
