---
name: event-vocabulary
description: The durable vs ephemeral event split, the event envelope, the complete durable event list, and how to add a new event type. Use whenever emitting, persisting, replaying or rendering an event, whenever deciding if something belongs in SQLite, and whenever the office or a UI view needs to show activity.
---

# Event vocabulary

Two channels. Confusing them is how a system starts animating lies.

## Durable — persisted, sequenced, replayable

Control-plane facts. Written to SQLite with a monotonic `seq`. Any view must be reconstructable
from a snapshot plus these.

```
project.registered  task.created  task.basis.captured  task.stale  task.dispatched
attempt.started  attempt.completed  attempt.failed
sandbox.opened  sandbox.closed  lock.acquired  lock.released
agent.needs_input  steer.requested  steer.acknowledged  steer.failed  steer.unresolved
review.thread.created  review.comment.added  review.feedback.delivered  review.waiver_recorded
evidence.ready  approval.requested  approval.decided
apply.started  apply.completed  apply.failed  apply.reversed  apply.compensated
repair.requested  repair.resolved  repair.lock_released  state.needs_repair
task.completed  task.cancelled
agent.session.id_captured  session.reattached  session.resumed
notification.queued  notification.delivered  notification.delivery_failed  notification.opened
budget.threshold  budget.pause
preview.started  preview.healthy  preview.failed  preview.stopped
project.claimed  project.claim_released  project.claim_expired
artifact.created  adapter.divergence
```

## Ephemeral — memory / session channel only

```
agent.message.delta  process.output  pty.binary  progress.tick
cursor/terminal paint state  high-frequency tool progress
```

These must be **impossible to persist by type**: separate module, separate transport type, no
shared base that a persistence call would accept. Raw provider payloads are never durable events;
opt-in debug captures are short-retention files under `state/debug/`, referenced by hash.

## Envelope

```json
{ "seq": 0, "ts": "", "type": "", "owner_id": "", "org_node_id": "",
  "workspace_id": null, "task_id": null, "attempt_id": null,
  "actor": { "member_id": "", "role_id": null, "provider": null },
  "payload": {}, "artifact_refs": [] }
```

`owner_id` and `org_node_id` are mandatory from migration v1 — including for one-owner
deployments. Retrofitting them later is an expensive migration.

## Adding an event type

1. Is it a fact you would need to *re-derive a view* after a restart? If not, it is ephemeral.
2. Is there already a durable event for it? Prefer payload detail over a near-duplicate type.
3. Add to the closed union in `packages/protocol`, bump `PROTOCOL_VERSION`, add the validator.
4. Add persistence + replay coverage. An event nobody replays is a log line, not an event.
5. If a UI shows it, add the renderer case. Exhaustive switch; no default box.

## Delivery is state, not a claim

`notification.*` and `steer.*` model reality honestly:

- steer: `requested → attempted → acknowledged | failed | unresolved`. An unresolved steer blocks
  further steering until the owner marks it lost, confirms observation, or retries.
- notification: `requested → queued → delivered → opened → decided` where the channel supports it.
  A delivery watchdog distinguishes "waiting for you" from "you may never have received it".

Never emit `delivered` because you called a send function. That is the lie this section exists to
prevent.
