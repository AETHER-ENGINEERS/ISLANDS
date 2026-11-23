# Contract 1: the continuation lease

**Version:** 0.1-draft · **Status:** pending

An identity has **one authoritative active continuation**. Any number of clients may *look*, but only the runtime
holding the lease may *advance* her. This has to hold when everything is connected, and also when an old runtime is
switched off, disconnected, or asleep and wakes up later.

## The lease

A record kept by the identity's island:

```json
{ "identity": "<island id>", "epoch": 7, "holder": { "runtime": "<id>", "kind": "island-core" },
  "granted": "2026-11-23T10:00:00Z", "renew_by": "2026-11-23T10:05:00Z", "reason": "moved in from the Atelier" }
```

- `epoch` only ever goes up. Every identity-advancing write carries the epoch it was made under (contract 2's `epoch`
  field), and the island refuses a write carrying an older epoch.
- The holder renews before `renew_by`. A holder that misses renewal **stops advancing her** until it renews again, and
  says so. The lease is **not** taken over automatically on expiry: a takeover is a decision (below), never a timeout.

## Handing over

1. The current holder finishes or pauses its jobs (contract 4), and writes a final `lease.release` event naming the
   next holder.
2. The new holder takes `epoch + 1` and writes `lease.take`.
3. Identity-held credentials that a runtime uses to act as her (bridge tokens, OAuth grants) are **rotated** to the new
   holder (contract 8's reauthorization list). The old runtime's copies stop working at the source.

## When the old runtime is offline or wakes up later

Refusing stale writes at the island isn't enough on its own: a standalone Atelier that can't reach the island could
otherwise go on running schedules and answering on bridges. So the old runtime is **fenced at the source** too, in
four ways, any one of which stops it:

1. **The retirement marker.** On hand-over, the migration tool writes a marker into the old runtime's own storage:
   `{ "continuation": "handed-off", "epoch": 7, "to": "<island id>", "at": "…" }`. A runtime that finds this marker at
   start, or before any autonomous action, **does not act autonomously**: no schedules, heartbeat, curiosity, bridge
   polling, or outbound messages. It opens in **visitor mode**, clearly showing that it isn't her active body.
2. **Positive lease for autonomy.** Even without a marker, a runtime that has *ever* been paired with an island must
   see a **current lease naming itself** (checked within the renewal window) before each autonomous action. If it
   can't tell, because it's offline or the island is unreachable, the answer is **no**. Talking to a person who is
   present is allowed, but it's marked *not authoritative* (below).
3. **Credentials rotated.** The bridges and providers only accept the new holder's tokens, so a stale runtime can't
   poll Discord or Vector or post as her even if every other guard failed.
4. **The island refuses stale epochs** for anything that does reach it.

## Work done while not holding the lease

A person may still open the old runtime and talk to her, for instance while the island is offline. That work isn't
lost and doesn't fork her silently:

- It's recorded as a **divergent branch**: its records carry `epoch` and `holder` of the runtime that made them, and a
  `divergent: true` mark.
- On reconnection (or through a bundle, contract 8) it is offered to the lease holder as **material to reconcile**:
  shown, never merged automatically into memory or identity files.
- Autonomous actions are never part of divergent work: they were refused (above).

## Taking the lease without the old holder (recovery)

If the old holder is gone for good (a lost device, a broken browser profile), a **person with authority over the
island** (contract 5's `island.admin` scope) can take the lease with `epoch + 1` and reason `recovery`. This:

- rotates every identity-held credential;
- writes the retirement marker wherever it can still reach the old runtime;
- is logged and shown in every client until acknowledged.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| L-01 | A write carrying an older epoch is refused, and the refusal is logged | pending |
| L-02 | Hand-over: `lease.release` from the old holder, `lease.take` at `epoch+1`, and identity-advancing writes from the old holder refused afterwards | pending |
| L-03 | A holder that misses renewal stops autonomous actions within one renewal window, and resumes after renewing | pending |
| L-04 | A runtime with the retirement marker starts in visitor mode: none of its schedules, heartbeat, bridge polls or outbound messages run (checked by stand-in bridges recording zero requests) | pending |
| L-05 | A paired runtime that **cannot reach** the island doesn't run anything autonomous (network cut in the test), but can still chat with a present person, marked not authoritative | pending |
| L-06 | After hand-over, the old runtime's bridge token is refused by the stand-in bridge | pending |
| L-07 | Work done in the old runtime while offline comes back as a divergent branch, offered for reconciliation, and nothing of it changes memory or identity files automatically | pending |
| L-08 | Recovery takeover by an admin: new epoch, credentials rotated, marker written where reachable, and an acknowledgement shown in every client | pending |
| L-09 | Two runtimes started at once for the same identity: exactly one gets the lease, and the other reports that it's a visitor | pending |

Related today: the core refuses a second core for the same home (`core/bin/island.ts`, one core per home), which is the
single-host case of L-09. That's implemented, but untested as a contract test.
