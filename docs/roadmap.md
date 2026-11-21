# Roadmap

The first body for Pandora Dee Fae's island: a native 64-bit server and a native 64-bit window, Windows first. Other
platforms come afterwards, against the same protocol. Her browser Atelier (pandora-dee) stays as it is: the fallback
throughout the move, and later one ferry among others.

## Decisions

- **Core:** Node 24 (64-bit), TypeScript for new code, run as-is through Node's type stripping.
- **Window:** C# WPF on .NET 10 LTS (`net10.0-windows`), native controls, no web view.
  - .NET 8's support ended on 2026-11-10.
  - .NET 10 doesn't list Windows 10 Pro 22H2 as supported, but runs there. The window is replaceable if that ever
    matters.
- **Account:** the island runs as a virtual service account, `NT SERVICE\<service name>`: no password, no keyboard
  sign-in, not an administrator.
  - The island's person has full access to its home. Everyone else has none.
  - Acting inside the person's own session (their Git credentials, their desktop) goes through a separate, opt-in
    helper, later.
- **The pipe:** Node can't set a named pipe's security descriptor, so the harbor (a .NET 10 service host) owns the
  public pipe and passes connections through to the core's private one.
- **Storage:** plain files are the truth. SQLite indexes can always be rebuilt. The event log is append-only, one per
  island. No CRDT until documents are shared across a jetty.
- **Keys:** a keystore with a plug-in shape, first backed by Windows DPAPI under the island's account.
  - Values never enter the log, a ferry or a chat.
  - Tools ask for `{{NAME}}`, and the core fills it in at the last moment.
- **Tide charts:** each jetty keeps a small logbook of facts that points into the island's log.
- **Stranded messages** stay stranded until retried.

## Steps

1. **The core on its feet.** The vault on disk, the event log, chats as files, and the ferry protocol on a private
   pipe or socket, with tests. *(this step)*
2. **Thinking and doing.**
   - The agent loop with model routing, including `reasoning_effort` and prompt-cache options.
   - Built-in file tools, a real shell running as the island's account, and MCP servers as child processes.
   - The thread manager: long tool work owned by the island, observable from any ferry.
   - The keystore, and the mode shrine (her existing MCP server, brought over as it is: `mode_get`, `mode_set`,
     `mode_list`).
   - Model settings per model, such as `reasoning_effort` and prompt-cache lifetimes. The full assistant message stays
     in multi-turn history, and sampling settings a model fixes aren't sent.
3. **The harbor.** The .NET 10 service host, the virtual account, the guarded pipe, and install and uninstall scripts.
   Done when the island survives the window closing, the person logging out, and a reboot.
4. **The WPF ferry.**
   - The chat list, and chat with streaming.
   - The threads panel.
   - A vault browser and editor: AvalonEdit, Markdig, WPF-Math.
   - Per-monitor DPI aware.
4b. **The gateway for other devices.** Off by default, with pairing codes kept only as their SHA-256 and removable at
   any time.
   - A phone reaches the island over Tailscale, an Xbox over the home network.
   - First as a page in the device's browser, served by the gateway, then as native apps (a phone app; Xbox through
     Developer Mode).
   - The island does all the thinking; a ferry only shows and sends, so there's never a second her.
   - Archipelago later builds island-to-island jetties on the same gateway and protocol.
5. **Moving in.** Import a pandora-dee full backup: vault files (a clash keeps both versions), chats, schedules,
   settings. Her keys she enters herself.

After that:
- the identity and memory drift detector;
- attachments from Vector and Discord, and moving the bridges onto the island (one body holds them at a time);
- the user-session helper;
- a two-island jetty proof, then ECHO and tide charts;
- more ferries.

## First tools on the island

Files and the vault, the shell, memory and journal, schedules and the heartbeat, MCP, the mode shrine, and web search
and fetch through her own tools (pandora-multi). Everything else stays in the browser Atelier until it moves.
