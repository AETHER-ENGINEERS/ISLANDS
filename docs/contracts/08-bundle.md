# Contract 8: the bundle

**Version:** 0.1-draft · **Status:** partly implemented (import from an Atelier backup)

How an identity moves between runtimes (Atelier → Island, Island → Atelier, Island → Island) **and comes back with
its new history intact**. Nothing it carries is silently dropped, and the lease moves with it.

## Before any move: the authority map

A move starts by writing down, for this identity, what is authoritative where, **as actually configured** (not what
each application could support). For each kind of record:

| Field | Meaning |
|---|---|
| `kind` | vault, conversations, schedules, rituals, playbooks, run history, app data, settings (by layer, contract 6), keys, external roots, bridges, derived indexes |
| `location` | Where the authoritative copy lives now (a browser profile's database, a folder, a service) |
| `access` | How it's read: a file, a database, MCP, an API |
| `authority` | Authoritative, or derived (rebuildable, with what from) |
| `in_backup` | Whether today's backup includes it |
| `plan` | Move, attach (stays where it is and is reached from the new runtime), stay, or reauthorize |

- **External roots**, such as a library folder reached through an MCP server, are **attached, never merged** into the
  vault. The bundle records them by name, root and access method, so the new runtime reaches the same files. This
  keeps roots from doubling.
- **Gaps** (anything authoritative that a backup leaves out) are fixed **before** the move, not worked around during
  it.

The authority map for a real identity is kept privately with that identity, never in a public repo.

## The bundle

```
manifest.json      format, identity, from (runtime and version), to, lease_epoch, made_at,
                   and per section: count, total bytes, sha256
vault/             the vault's files, byte for byte
conversations/     contract 3's records (all branches, divergent ones marked)
jobs/              contract 4's records, including unfinished and waiting ones
schedules.json  rituals/  playbooks/  run-history/  app-data/
settings/          identity.json · individuals/<id>.json · devices/<id>.json (contract 6)
grants.json        contract 5's grants, for confirmation on arrival
external-roots.json  attached stores (name, root, access method): referenced, not copied
derived.json       indexes (embeddings, parse caches): listed with model, dimension, chunking and version; not shipped,
                   rebuilt on arrival
reauthorize.json   the **names** of keys and credentials needing re-entry or re-grant on arrival; **never values**
unknown/           every record the exporter didn't recognise, verbatim, with where it came from
```

## Rules

- **Unknown records are carried, never dropped.** An importer that doesn't understand a record keeps it in `unknown/`,
  names it in its report, and writes it back out on export. (Today's importer reports what it leaves behind, but
  doesn't carry it yet.)
- **Secrets never travel.** `reauthorize.json` lists names. Values are re-entered or re-granted on the other side,
  sealed to the new runtime's account.
- **The lease travels with the bundle** (contract 1):
  - exporting for a move ends the exporter's hold;
  - importing takes `epoch + 1`;
  - the retirement marker is written into the old runtime;
  - identity-held credentials are rotated.
- **Export and import are inverses.** The round trip is the test: original records, new work, branches, permissions
  and job history all intact and in order.
- **Derived indexes** are rebuilt on arrival from the authoritative records, with the model and version recorded. A
  retrieval failure after a move must be distinguishable from memory loss: the index reports "rebuilding" or "built
  with model X", never "nothing found".
- **Reports:** import and export each write a report: counts per section, everything left out or carried as unknown,
  everything needing reauthorization, and the lease change.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| B-01 | Import a synthetic Atelier backup: vault files byte for byte; a clash keeps both versions | **passing** (`core/test/import.test.ts`) |
| B-02 | Import: sessions become conversations with times, reasoning and tool pairing | **passing** (`core/test/import.test.ts`) |
| B-03 | Import: schedules come in switched off; unreadable ones are reported | **passing** (`core/test/import.test.ts`) |
| B-04 | Import: no key value is written anywhere; keys are named in the report | **passing** (`core/test/import.test.ts`) |
| B-05 | Importing twice brings nothing in twice; gzipped backups read too | **passing** (`core/test/import.test.ts`) |
| B-06 | Import refuses while the island's core runs | **passing** (`core/test/import.test.ts`) |
| B-07 | Unknown records (an IndexedDB store, a localStorage key and a backup field the importer doesn't know) are carried in `unknown/`, reported, and present again after export | pending |
| B-08 | Export to the Atelier format: a test Atelier (the Playwright harness) restores it, and the original files, the new work done on the island, branches in order, schedules and unknown records are all there | pending |
| B-09 | Round trip: Atelier → Island → new work (a branch, a ritual run, a schedule change) → Atelier → Island. The second import adds only what's new | pending |
| B-10 | Moving hands the lease over: after export-for-move, the exporting runtime refuses identity-advancing writes; after import, the new one holds `epoch+1`; the marker is written into the old one | pending |
| B-11 | External roots are recorded and reached by the new runtime at the same root; nothing of them is copied into the vault; no doubled root appears | pending |
| B-12 | Derived indexes aren't shipped, are rebuilt on arrival, and report their model and version; a search during rebuilding says "rebuilding" | pending |
| B-13 | The authority map is required: a move without one is refused, and a map with an authoritative record marked "not in backup" stops the move until fixed | pending |
| B-14 | Run history (trajectories) and app data (mini-app packages and updates) survive the round trip | pending (needs the Atelier backup improvement) |
