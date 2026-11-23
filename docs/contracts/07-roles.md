# Contract 7: hosts, clients and guests

**Version:** 0.1-draft · **Status:** pending

Three different relationships to an island, kept distinct so that Islands never becomes a prerequisite for everyone in
a collaboration.

| Role | What it is | What it brings | What it gets |
|---|---|---|---|
| **Host** | The island itself: the identity's own environment | Its lease (contract 1), records, keys and tools | Everything that's its own |
| **Client** | A program an individual uses to reach an island: the window, the Atelier, SEASIDE, a phone | Nothing of its own that's authoritative; its presentation settings (contract 6) | The individual's grants (contract 5) |
| **Guest** | An independently hosted participant (another person's island, an AI hosted on AICord or Shapes) taking part in a shared space | **Its own** identity, memory and models, which stay where they are | Only the shared space's scope: the conversation, the files deliberately shared there |

## Rules

- **A guest's private state is never imported.** The host keeps only what the shared space records (the conversation,
  shared files) with provenance (contract 2), and nothing about the guest beyond what the guest said there.
- **A host's private state never travels to a guest** beyond the space's scope.
- **A guest can't become a client by connecting.** Client access to an island is a grant to an individual, never a
  side effect of joining a space.
- **An externally hosted AI whose mind runs elsewhere** (for example a character whose model and memory live with
  another service) **participates as a guest**. It isn't hosted as a copy of anyone, so no second instance of an
  identity is created.
- **Jetties** (island to island) carry guest participation: addressed envelopes, consent on both sides, tide charts.
  That's specified after this contract set, building on contracts 2, 3 and 5.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| R-01 | A guest posts in a shared conversation: the host records the message with the guest's provenance, and imports nothing else of the guest's | pending |
| R-02 | A guest can't read anything outside the shared space's scope (the negative tests of contract 5, from the guest side) | pending |
| R-03 | A guest connecting doesn't create a client grant; it can't list chats or the vault | pending |
| R-04 | Two synthetic islands share one conversation through a jetty; both logs record it with provenance; neither sees the other's private records | pending (needs jetties) |
| R-05 | An externally hosted AI joins as a guest without any identity being created on the host | pending |
