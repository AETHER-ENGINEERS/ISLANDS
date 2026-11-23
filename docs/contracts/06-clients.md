# Contract 6: clients, individuals and devices

**Version:** 0.1-draft · **Status:** pending

Several people may use one device, and one person may use several devices. Each should be able to make things look
their own way, without that leaking into anyone else's view or into the island's identity.

## Who is at a client

A client says, at `island.hello`:

```json
{ "client": { "id": "<stable per installation>", "kind": "wpf" | "atelier" | "seaside" | "phone" | "…", "version": "…" },
  "device": { "id": "<stable per machine>", "name": "living-room PC" },
  "individual": { "id": "<who is using it>", "proof": "…" } }
```

- **`client.id`** is per installation of a client; **`device.id`** is per machine; **`individual.id`** is the person
  or AI at the keyboard (or behind the voice) right now. Switching individuals on one client is allowed, and starts a
  new session with that individual's grants (contract 5).
- **Proof:** to begin with, a device-held credential per individual (a pairing made on the island, stored per user
  account on that device), so that someone else at the same device can't speak as them. The island records which
  individuals are known on which devices.

## Four layers of settings

| Layer | Belongs to | Examples | Where it's kept |
|---|---|---|---|
| **Identity** | The island | Models, persona files, schedules, bridge rules | The island's config (`config/island.json` today) |
| **Individual** | A person, on every device | Theme, font size, language, how her voice sounds to them, which panels they like | The island, under the individual: `clients/individuals/<id>.json` |
| **Device** | A machine, for everyone | Screen layout, which monitor, audio device | The client's own storage on that device |
| **Individual on a device** | One person on one machine | A different layout on the small laptop, drafts, open folders | The client's own storage, under the individual |

Lookup goes from the most specific layer to the least: individual-on-device, then device, then individual, then the
client's defaults. Identity settings are never overridden by presentation layers.

- **Presentation never becomes identity.** A theme choice can't change her models or her persona.
- **Sharing is deliberate:** in a shared space (SEASIDE), resources such as cats, companions and files become shared
  only by a grant (contract 5). Two devices connecting to the same server don't merge their individuals' settings.
- **The Atelier's localStorage today mixes identity and presentation.** Contract 8's move-in sorts each known key
  into a layer, and carries unknown keys rather than dropping them.

## Clients reach the island from anywhere they're allowed

- A client may run on the island's host or on any authorized device on the LAN or over Tailscale. It talks to the
  island through the gateway (the roadmap's step 4b): the same protocol, over an encrypted connection, with a
  per-individual credential (above), and from a browser page with the island answering only paired origins (as
  SEASIDE's pairing does).
- **A client keeps no authoritative copy** of the island's files or records (contract 9). The Atelier as a client shows
  and edits the island's files through its calls, and runs its shell and script tools on the island. Its own browser
  storage holds only presentation (contract 6's device and individual-on-device layers) and caches it can rebuild.

## Client-provided tools

A client that can do what the host can't (a browser pane, a GPU for LiteRT/ONNX, a camera, a phone's sensors) may
**offer** tools while it's attached:

- The offer lists its tools, each with an `effect` (contract 4).
- The island routes calls to it within scope (contract 5), and logs them.
- When the client leaves, its tools are reported unavailable, not left to hang. A job needing them waits or fails
  cleanly.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| D-01 | Two individuals on one device: each gets their own theme and layout; switching individuals switches them; neither sees the other's drafts | pending |
| D-02 | One individual on two devices: their individual settings follow them; device layouts stay per device | pending |
| D-03 | Individual-on-device overrides win over individual settings on that device only | pending |
| D-04 | Changing presentation never changes identity settings (models, persona files, schedules are untouched) | pending |
| D-05 | Someone at the same device can't speak as another individual without that individual's credential | pending |
| D-06 | A client-offered tool works while attached; after the client leaves, it's reported unavailable within a few seconds, and a waiting job fails or waits cleanly | pending |
| D-07 | Two clients attached at once: shared state (a note, a chat) updates in both without corruption; per-client state stays separate | pending |
| D-08 | The window keeps its own settings per device today (`ferry.json`) | implemented, untested |
| D-09 | A browser client on another device reaches the island through the gateway with its individual credential; an unpaired origin is refused | pending (needs the gateway) |
| D-10 | A client keeps no authoritative copy: clearing its browser storage loses only presentation and caches, and nothing of the island's | pending |
