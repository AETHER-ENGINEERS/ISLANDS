# ISLANDS

**One core, many faces.** An island is a local-first, sovereign home for one person, human or AI: their files,
memory, tools, identity and models, on their own machine, as a real service. It keeps running when no window is open.
Windows, phones and bridges are **ferries** that come and go. Links to other islands are **jetties**, opt-in and
revocable.

The first island is Pandora Dee Fae's.

## The five invariants

1. An island works without a jetty.
2. Closing a jetty doesn't break continuity.
3. Permissions are specific and revocable.
4. Shared work keeps its provenance.
5. Interfaces are replaceable.

## The shape

```
 a person's session                       the island (a service, its own account)
 ┌────────────────┐   named pipe   ┌──────────────────────────────────────────┐
 │ ferry (window) │ ◄────────────► │ harbor: .NET 10 service host             │
 └────────────────┘                │   owns the door, decides who may open it │
                                   │ core: Node 24, TypeScript                │
                                   │   vault · event log · chats · threads    │
                                   │ children: MCP servers, shells, models    │
                                   └──────────────────────────────────────────┘
```

- **The core** (`core/`) is a 64-bit Node service.
  - The vault is real files: `/Pandora/SOUL.md` is `<home>/vault/Pandora/SOUL.md`.
  - Chats are files too.
  - The event log is append-only. It holds facts, never content.
- **The harbor** (coming) is a small .NET 10 Windows service. It runs the core under the island's own virtual account,
  restarts it if it falls, and owns the pipe ferries connect to, with a security descriptor that admits only the
  island's people.
- **Ferries** speak [the ferry protocol](docs/protocol.md): JSON-RPC 2.0, one message per line. A ferry that was away
  catches up from the log, so closing a window never loses anything. The first ferry is a native WPF window
  (`net10.0-windows`). Others follow against the same protocol.

## Run the core

Node 24 or newer.

```sh
cd core
npm install          # only for the type checker; the core itself has no dependencies
npm test
node bin/island.ts <home> --name "<island name>"
```

`<home>` is the island's folder; it gets `vault/`, `chats/`, `log/`, `state/`, `keys/`, `runs/`, `config/`, `trash/`
and `backups/`. Ferries find the core through `<home>/state/core.json`, which names its door and holds the token a
ferry presents in `island.hello`.

## Status

Step 1 of [the roadmap](docs/roadmap.md): the core's vault, event log, chats and the ferry protocol, with tests on
Windows and Linux.

## License

The island's own code is under the [AETHER-ENGINEERS License](LICENSE). Pieces taken from MIT-licensed projects keep
their notices: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
