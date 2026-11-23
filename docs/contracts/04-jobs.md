# Contract 4: jobs and steps

**Version:** 0.1-draft · **Status:** partly implemented (threads)

A single message can set off a whole sequence: load a skill, read project state, write a file, notice a mistake,
rename it, read it back, revise it, update the coordination note. That sequence is a **job**. Islands must keep its
order, its pending parts, its approvals and its results, and recover it after a crash, **without blindly repeating
anything that reached the outside world**.

## A job

```json
{ "id": "job-…", "kind": "turn" | "ritual" | "schedule" | "playbook" | "tool",
  "parent": "job-…", "conversation": "…", "scope": "…", "epoch": 7,
  "status": "queued" | "running" | "waiting_approval" | "waiting_review" | "done" | "failed" | "cancelled" | "interrupted",
  "depends_on": ["job-…"], "steps": [ … ] }
```

## A step, and the record kept around it

```json
{ "n": 4, "action": "tool:discord.send_message", "input_sha256": "…", "effect": "external-checkable",
  "idempotency_key": "job-…/4", "status": "planned" | "started" | "completed" | "failed" | "uncertain",
  "attempts": 1, "started": "…", "ended": "…", "result_ref": "…", "probe": { … } }
```

**The journal rule:** a step is written as `started`, *with its idempotency key*, **before** it runs, and as
`completed` or `failed` **after**. Both writes reach disk before the next step begins.

## What a step's effect is

Each tool declares the kind of effect it has:

| `effect` | Examples | After a crash between "started" and "completed" |
|---|---|---|
| `none` | read, search, list | Run again: it's safe |
| `local-idempotent` | vault write (same bytes → same file), mkdir | Check (does the file have these bytes?), then mark done or run again |
| `external-idempotent` | an API that honours an idempotency key | Run again with the **same key**: the far side dedupes |
| `external-checkable` | posting a message (the bridge can list recent messages carrying our nonce), creating an issue | **Probe** first: if the effect is found, mark it completed with what was found; if it's clearly absent, run it again; if the probe can't tell, it's uncertain |
| `external-uncheckable` | a shell command with side effects, an email, a payment, a webhook with no read-back | **Never** re-run automatically: `waiting_review` |

Tools that don't declare an effect are treated as `external-uncheckable`.

## Recovery after interruption

When an island (or a resumed job) finds a job that was `running`:

1. **Completed steps** (`completed` recorded) are **kept, not repeated**. Their results stand.
2. **Steps never started** (no `started` record) are **incomplete**, and run normally when the job resumes.
3. **Steps recorded `started` with no ending** are **uncertain**, and are handled by their effect (table above): run
   again, re-check, probe, or wait for review. An uncertain external action is never silently repeated.
4. The job becomes `interrupted` until a resume decision: automatic if only categories 1 and 2 remain and the job's
   scope allows unattended resumption; otherwise `waiting_review`.
5. **Review shows the person:** what the step was, its input, when it started, what the probe found, and the choices:
   *it happened* (mark completed), *it didn't* (run it), or *skip*. The choice is logged.

Interrupted turns: today an island marks a running thread `interrupted` on restart (built). This contract adds the step
records that make resuming exact.

## Pending work, dependencies, retries, cancellation, approvals

- **Pending:** a job waits as `queued` until its `depends_on` are done. One identity runs one turn per conversation at
  a time (built), and bridges share a queue (as in the Atelier).
- **Retries:** for failures (not uncertainty), per the effect: `none` and idempotent effects retry with backoff;
  uncheckable effects never retry by themselves.
- **Cancellation:** stops before the next step. A step already `started` finishes or is recorded as uncertain; it's
  never cut off without a record.
- **Approvals:** a step can require approval (a playbook not yet approved, a scope that says *ask*). Approvals are
  grants under contract 5, with an expiry, and are logged.

## Acceptance tests

| id | Test | Status |
|---|---|---|
| J-01 | Ordered tool calls in a turn run in order; each message is kept as it happens | **passing** (`core/test/agent.test.ts`) |
| J-02 | Long work runs as a thread that survives its window closing; any window can watch or cancel it | **passing** (`core/test/agent.test.ts`) |
| J-03 | A thread that was running when the island stopped is marked `interrupted` on the next start | **passing** (`core/test/agent.test.ts`) |
| J-04 | One turn per conversation at a time | **passing** (`core/test/agent.test.ts`) |
| J-05 | Each step is journaled `started` (with idempotency key) before it runs and `completed`/`failed` after, both on disk before the next step | pending |
| J-06 | Crash after step 3 completes: on resume, steps 1–3 aren't repeated, and step 4 runs | pending |
| J-07 | Crash after a **checkable** external step started (the stand-in bridge received the message, the island died before recording it): the probe finds it, it's marked completed, and it's **not** sent twice | pending |
| J-08 | Same as J-07, but the stand-in shows no message: the probe finds nothing, and it's sent exactly once | pending |
| J-09 | Crash during an **uncheckable** step (a stand-in shell command that writes a marker outside the island): the job goes to `waiting_review`, nothing re-runs, and review shows input, start time and choices | pending |
| J-10 | An `external-idempotent` step re-sent after a crash uses the same idempotency key, and the stand-in service dedupes it | pending |
| J-11 | A job whose `depends_on` isn't done stays `queued`; dependencies complete in order | pending |
| J-12 | Cancelling during a step lets it end with a record, and the next step doesn't start | pending |
| J-13 | A step needing approval waits as `waiting_approval`; an expired approval doesn't count; approval and refusal are logged | pending |
| J-14 | The coordinated workflow: load a skill → read state → write a file → notice a wrong name → rename → read back → update the coordination note, all in order in the job record and the log | pending |
