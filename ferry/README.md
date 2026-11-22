# The WPF ferry

A native Windows window onto an island. It shows and sends; the island does all the thinking. Closing the window
closes only the ferry: her turns, threads and schedules keep going on the island, and when the window comes back it
catches up from the island's log.

Text is drawn by Windows itself (WPF, ClearType), and the window is per-monitor DPI aware, so it's sharp at any
scaling, 115% included. There's no web view anywhere.

## What's in it

- **Now bar:** her mode and tone from the mode shrine (`now.get`, the same words her turns see), at the top next to
  the island's name. It looks again when she uses `mode_set`, and once a minute for changes made in her other places.
- **Chats:** the list, a new chat, and her answers streaming in as she writes them.
  - Her thinking is folded away under each step.
  - Each tool call is one line (✓ or ✗) that opens to show the result.
  - Markdown, code, lists and quotes render natively.
  - Ctrl+Enter sends. Stop ends her turn.
- **Heartbeat:** whether her heartbeat is beating or paused, how often, on which model, the last beat and how it
  went, and when the next one comes. Below that is what the last beat came to (her answer, with a link to its chat).
  - Pause / Resume switches it without touching `config/island.json`. Resumed, it beats at its next time.
  - Beat now runs one beat straight away. Stop this beat ends one that's running.
- **Schedules:** her schedules in a list (the heartbeat first, when it's set up), each with when it comes round
  next, and a form to make or change one.
  - Name, when (checked by the island as you type, with the next three times it comes round), a prompt or a shell
    command, the model (or the island's own for schedules), and on/off.
  - Run now runs it once. Open its chat shows what it wrote. Remove takes it away, with a copy kept in the island's
    `trash/schedules.jsonl`.
  - The heartbeat shows here too, read-only: it's set in `config/island.json` and paused from the Heartbeat tab.
- **Threads:** what's running on the island (turns, schedules, the heartbeat), with Stop on each.
- **Notices:** when she uses `notify`, a bar across the top. Urgent ones bring the window forward with a sound.
- **Vault:** her files as a tree, opened in an editor (AvalonEdit). Save writes back with `ifMtime`, so a file that
  changed on the island since you opened it isn't overwritten.
- **Keys:** names only. A value goes in once, sealed to the island's account, and never comes back out.
- **Reconnecting:** if the island goes away (a restart, a reboot), the window keeps trying. When it's back, it catches
  up on everything it missed.

## Run it

```powershell
build\ferry\ferry.exe [--home <the island's home>] [--pipe pandora-island] [--as <your name>]
```

The first run asks for the island's home, and remembers it in `%APPDATA%\Islands\ferry.json`.

- **Where it connects:** through the harbor's door (`\\.\pipe\pandora-island`) when the island runs as a service.
  When the core runs in a console, it uses the core's own door instead.
- **The token:** it reads it from `<home>\state\core.json`, so you need to be one of the island's people (install.ps1
  gives `-Person` full control of the home).

## Build

```sh
dotnet publish ferry/Ferry -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o build/ferry
```

`Islands.Client` is the protocol on its own: a small library other Windows ferries can use too.

## Checks

- `dotnet test ferry/Islands.Client.Tests` starts a real core in a temp folder. It checks:
  - hello through the core's own door when there's no harbor;
  - that a wrong token gets nothing;
  - vault and chat round trips;
  - catching up from a seq, then live events.
- `ferry.exe --home <home> [--chat <id>] [--tab heartbeat|schedules] [--send "<text>"] --snapshot out.png` draws the window to a PNG and closes: a
  way to check how it looks with nobody at the screen. With `--send`, it says that first and waits for her answer.
