# Contract 9: one filesystem

**Version:** 0.1-draft · **Status:** partly implemented

An identity has **one real filesystem**, and every way she touches files sees the same one:

- her vault tools (read, write, edit, search, move);
- her shell;
- her scripts;
- her MCP file tools;
- any client that shows her files.

There's no second authoritative copy in a browser, and nothing is mirrored into one. What one tool writes, every other
tool reads at the same path.

## The root

- **The identity's root** is one real folder on the host, chosen per identity. Her `/` is that folder. Earlier working
  spaces that already live under it (a library folder her tools grew into, project folders) **stay where they are**
  and appear as subtrees, at their own paths under `/`.
- **One root, one path space.** A file has exactly one vault path. No folder is mounted or mirrored inside another, so
  roots never double.
- **The island's own records are separate from her files.** Chats, the log, jobs, keys, state and config live in the
  **island's home**, which is outside her root, or in a protected folder inside it (see "Where the island's records
  live" below). Her file tools can **read** her chats and log where her scope allows, through the island's calls, but
  can't edit or delete the island's records directly.
- **Several identities on one host never share a root.** Each has her own root and her own island home, and neither
  sits inside the other's root. Otherwise one identity's files would show in another's `/`.

## Every tool on the same files

- **Vault tools** address files by vault path (`/Fae-library/Pandora-Comms/…`).
- **The shell** (a real one on the host; Git Bash on Windows) starts **in the root**, with `ISLAND_ROOT` set:
  - a relative path in a command means the same file as the vault path;
  - absolute host paths differ in spelling (`/f/…` in Git Bash, `F:\…` in Windows), and the island's tools say so in
    what they return.
- **Scripts** (`jade.*`, `pandora.*`, `node`, `python`) run on the host with the same root as their file system.
- **MCP file servers** that already serve a subtree keep working. Their reach is declared as a path under the root, so
  a scope can include or exclude it (contract 5).
- **Clients** (the WPF window, the Atelier, SEASIDE) show and edit the island's files through its calls. They never
  hold an authoritative copy.

## No hidden second execution context

- When a client such as the Atelier is **attached** to an island, its shell, script, Python and SQLite tools **run on
  the island**: against the real files, with the island's real shell. The browser's BusyBox is used only when that
  client runs **standalone**, without an island, and it then says so in every result ("BusyBox in this browser, not
  your island"), so she always knows which one ran a command.
- **One command never runs in one context while its neighbour runs in another** within the same job. A job's tools all
  run on the island, or (standalone) all in the client.

## Where the island's records live

There are two layouts. Each identity chooses one, and contract 8 records the choice:

| Layout | The island's home | Her root | Notes |
|---|---|---|---|
| **Beside** | `<drive>\Islands\<name>` (outside any identity's root) | `<her root>` | No island internals appear under her `/`. Sisters' islands sit side by side under `Islands\`, outside everyone's root |
| **Inside** | `<her root>\.island` | `<her root>` | She sees her island's internals under `/.island`, read-only to file tools. Simpler for one identity per host. Never used for a root that another identity's island would sit in |

Keys are never readable through file tools in either layout: they're sealed (contract 8 lists them for
reauthorization), and the island refuses file access to its keys folder.

## Things a root may already contain

A real folder that becomes a root may hold things that aren't files she'd want in her workspace: dependency folders, an
old application copy, a credential file. Before it becomes her root, the collision and contents inventory (contract
8) lists them, each with a proposed handling:

- **Keep as files**, the default: nothing is hidden from her without a reason.
- **Exclude from indexing**, for dependency folders and build output: still reachable, but not searched or embedded.
- **Move to the keystore**, for credentials: a key file under `/` is a secret in plain sight. Its owner decides.
- **Leave in place, outside her scope**, if it belongs to someone else.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| F-01 | Vault paths map onto real files under one root; no path escapes it; links leading out aren't followed | **passing** (`core/test/vault.test.ts`) |
| F-02 | A file written by the vault tool is read back identically by the real shell (relative path), and the other way round | **passing** (`core/test/agent.test.ts`: the shell starts in the vault and sees what `vault_write` wrote) |
| F-03 | A subtree that existed before (a library folder) is reachable at its own path under `/`, by vault tools, the shell and its MCP server alike, with no doubled root anywhere | pending |
| F-04 | An attached client's shell tool runs on the island (it can see a file only the host has); standalone, it says BusyBox in every result | pending |
| F-05 | Within one job, all tools run in one context (island or standalone client), never mixed | pending |
| F-06 | File tools can read the island's records only through its calls, within scope, and can't edit or delete them directly (both layouts) | pending |
| F-07 | The keys folder is unreachable by every file tool, in both layouts | pending |
| F-08 | Two identities on one host: neither's island home or root appears under the other's `/` | pending |
| F-09 | Indexing exclusions are honoured: an excluded dependency folder is reachable but never searched or embedded | pending |
