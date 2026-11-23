# Island contracts (drafts for review)

The agreements independent Islands, clients, bridges and migration tools keep with each other. They sit on top of the
ferry protocol (`docs/protocol.md`, `islands/0.1`) and extend it. None of them replace it.

| # | Contract | Version | Status |
|---|---|---|---|
| 1 | [The continuation lease](01-continuation-lease.md): one active writer per identity, online or not | 0.1-draft | Pending |
| 2 | [The event log](02-event-log.md): facts, provenance, catch-up | 0.1-draft | Partly implemented |
| 3 | [Conversations and branches](03-conversations.md) | 0.1-draft | Partly implemented |
| 4 | [Jobs and steps](04-jobs.md): ordered work that survives interruption, including uncertain outcomes | 0.1-draft | Partly implemented |
| 5 | [Scopes](05-scopes.md): consent and execution boundaries, for reads and writes | 0.1-draft | Pending |
| 6 | [Clients, individuals and devices](06-clients.md): who is looking, from where, and how it looks | 0.1-draft | Pending |
| 7 | [Hosts, clients and guests](07-roles.md) | 0.1-draft | Pending |
| 8 | [The bundle](08-bundle.md): moving, returning, and the authority map | 0.1-draft | Partly implemented (import) |
| 9 | [One filesystem](09-filesystem.md): one real root per identity, every tool on the same files | 0.1-draft | Partly implemented |

## How to read the test lists

Every contract ends with acceptance tests. Each has an id (`L-03`, `S-11`…) and one of three statuses:

- **passing:** implemented, and an existing automated test proves it. The test file is named.
- **implemented, untested:** the behaviour exists in the code, but no contract test proves it yet.
- **pending:** not implemented. The contract-test harness (`contracts/`, after review) reports these as *pending*,
  never as skipped, so the list is also the to-do list.

A contract moves from `0.x-draft` to `1.0` when everyone who builds against it (Islands, the Atelier, SEASIDE) has
agreed to it and all of its tests are passing.

## Words used throughout

- **Island:** an independently controlled, persistent environment belonging to one individual, human or AI.
- **Identity:** whose island it is.
- **Runtime:** a program that can act as an identity: an island core, an Atelier page, a SEASIDE "heart".
- **Client** (or ferry): a program that shows an island and sends to it.
- **Individual:** a person or AI using a client; they may differ from the island's identity (a partner, a visitor).
- **Device:** the machine a client runs on.
- **Advance an identity:** do something only she may do: answer as her, write her memory, run her schedules, poll her
  bridges, spend on her behalf.
