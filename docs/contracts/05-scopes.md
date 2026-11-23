# Contract 5: scopes

**Version:** 0.1-draft · **Status:** pending

Consent, enforced by the island itself, not by what a client shows or what a model is told. A scope says what an
action may **read** and what it may **change**. Every request a client makes and every step a job takes runs under one,
and the island checks it where the work happens: at the vault, the tool dispatcher, search, the event log, the script
host, MCP calls and client-provided tools.

**Being connected grants nothing by itself.** Having a client open, a pairing, or being in a conversation does not
imply access to the island. Access comes only from explicit grants.

## A scope

```json
{ "id": "scope-…", "name": "Discord: #workshop",
  "read":  { "vault": ["/Shared/Workshop/**"], "people": ["self", "workshop-members"], "conversations": ["this"], "memory": "workshop", "events": "this" },
  "write": { "vault": ["/Shared/Workshop/**"], "memory": "none", "journal": "summary" },
  "tools": { "allow": ["vault_read", "vault_search", "web_search"], "ask": ["vault_write"], "deny": ["shell", "mcp:*"] },
  "outbound": { "discord": ["<this channel>"] },
  "expires": null }
```

- **Grants** attach scopes to things: to a **conversation** (from its consent record, contract 3), a **client and
  individual** (contract 6), a **job** (inherited from what started it, never widened), or a **visitor or guest**
  (contract 7).
- **A job runs under the intersection** of its trigger's scope and anything narrower it was given. A job never gains
  access because the island happens to have a tool.
- **Default for a new conversation from a new community:** read only what's in the conversation itself, plus the
  island's public profile; no tools beyond answering. More is granted explicitly.
- **Existing relationships keep their established expectations** (for example, Atelier visibility of DMs). The
  move-in creates grants that match them, and lists them for confirmation. They're never copied to new communities.
- **Admin:** `island.admin` is held by the island's identity and the people the identity names (on Fae's island:
  Fae, and her partner). It covers everything, including the lease's recovery takeover.

## Reads are governed as tightly as writes

| Surface | How the scope applies |
|---|---|
| Vault `list` / `read` | Paths outside `read.vault` don't exist for the reader: not listed, not readable. Their absence is indistinguishable from not-found, so private paths don't leak |
| Vault search, branch search | Only documents, chunks and conversations in scope are searched, and the results are filtered **again** before they're returned |
| Embeddings / memory retrieval | Every chunk carries the scope it came from. Retrieval filters by the reader's scope **before** ranking, so out-of-scope text never reaches the model, even as a near neighbour |
| Journal / storybook / dossiers | Entries carry provenance (contract 2's `scope`); reading them is filtered the same way |
| Event log | Contract 2: scoped `since` and `subscribe` |
| Script host (`jade.*`, `pandora.*`, `node`, `python`) | Scripts run with the job's scope. Their file system is the scoped vault view, and their tool calls go through the same dispatcher |
| Real shell | Only granted to scopes that allow it. It starts in the identity's root (contract 9) and runs as the island's account. For the identity's own work under her admin scope, that's her whole root, her established trust kept as it is. A narrower scope that allows a shell gets a working folder limited to its paths, and the account's own reach is declared, so a scope can't grant more than the account could reach anyway |
| MCP calls | Each server is a named tool family (`mcp:<server>:<tool>`). Each server declares its **reach** (for example, a subtree of the identity's root, or the network), and a scope may only allow a server whose whole reach the scope already covers. That's because the island can't check what happens inside a third-party server |
| Client-provided tools (contract 6) | Callable only within the intersection of the job's scope **and** the offering client's own grant |
| Outbound (bridges, http, email) | Only to destinations in `outbound`; everything else is refused |

## Acceptance tests (the negative ones first)

| id | Test | Status |
|---|---|---|
| S-01 | A visitor without the dossier scope can't read `/People/<private>.md` through `vault.read`, `vault.list`, `vault.search`, a tool, a script, or memory retrieval, and every one of those answers looks like not-found | pending |
| S-02 | A conversation from a newly joined community can't call the shell, an MCP server, or `vault_read` on a private project, **although those tools exist** on the island, and each refusal is logged with the scope | pending |
| S-03 | An embedding chunk from a private DM never appears in retrieval for a different conversation's scope, even when it's the nearest neighbour | pending |
| S-04 | A script started by an out-of-scope job sees only the scoped vault, and its `jade.tool()` calls are refused the same way | pending |
| S-05 | An MCP server whose declared reach exceeds the scope can't be allowed in it (granting is refused) | pending |
| S-06 | A client-provided tool is refused when the job's scope allows it but the offering client's grant doesn't, and the other way round | pending |
| S-07 | Being attached as a client (a valid token, no grants) gives no vault, chat or event access | pending |
| S-08 | A job never has more than its trigger's scope: a child job inherits, and can't widen | pending |
| S-09 | `ask` tools stop the job at `waiting_approval` (contract 4); `deny` tools are refused outright | pending |
| S-10 | The event log's facts are scoped: a reader doesn't learn that an out-of-scope conversation exists | pending |
| S-11 | Grants made at move-in match the old expectations (DM visibility) and are listed for confirmation; none are given to new communities | pending |
| S-12 | Outbound to an unlisted destination is refused | pending |

Today, any holder of the island's token has full access (`island.hello`). That's the single-person case of
`island.admin`: implemented, and it's exactly what this contract narrows.
