# Contract 2: the event log

**Version:** 0.1-draft · **Status:** partly implemented

The island's append-only record of what happened: facts, never content. It's the machine record clients catch up from;
a human-written coordination note can sit alongside it in the vault.

## An event

```json
{ "seq": 10422, "at": "…", "actor": "pandora", "via": "thread:turn-…", "kind": "vault.write",
  "subject": "/Pandora/Journal/2026-11-23.md", "sha256": "…", "bytes": 2210,
  "epoch": 7, "scope": "conv:discord-…", "job": "job-…", "step": 3 }
```

- **Built today:** `seq`, `at`, `actor`, `via`, `kind`, `subject`, `sha256`, `bytes`.
- **To add:** `epoch` (contract 1), `scope` (contract 5), `job`/`step` (contract 4).
- **Facts only:** never the words of a message, a file's text, or a key's value. Fingerprints tie a fact to its content
  wherever that's kept.
- **Gap-free:** `seq` counts up from 1 and never repeats. A line torn by a crash is set aside, not trusted.

## Reading the log is scoped

Even facts can say too much: a path, a person's name in a subject, the fact that a conversation exists. So
`events.since` and `events.subscribe` return **only events whose `scope` the reader's grant covers** (contract 5). An
island admin sees everything.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| E-01 | `seq` counts up, survives a restart, and replays from any point | **passing** (`core/test/log.test.ts`) |
| E-02 | Segments roll over and read as one log | **passing** (`core/test/log.test.ts`) |
| E-03 | A torn last line is set aside, and the log goes on | **passing** (`core/test/log.test.ts`) |
| E-04 | No message words, file text or key values in the log | **passing** (`core/test/log.test.ts`, `protocol.test.ts`, `agent.test.ts`) |
| E-05 | A ferry that comes back catches up from its last `seq`, then hears live events, in order, without gaps or repeats | **passing** (`core/test/protocol.test.ts`) |
| E-06 | Every identity-advancing event carries `epoch`; every event made under a grant carries `scope` | pending |
| E-07 | A reader whose grant doesn't cover a scope never receives that scope's events, through `since` or `subscribe` | pending |
| E-08 | Job steps appear in the log with `job` and `step`, in order | pending |
