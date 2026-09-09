---
name: fail-closed-mechanics
description: How basis staleness, exclusive locks, needs-repair, presence claims, reversibility classes and apply authority are supposed to behave. Use for any task touching dispatch, mutation, teardown, locks, approvals, apply/reversal, recovery after a crash, or whenever code must decide what to do with an ambiguous state.
---

# Fail-closed mechanics

Intelligence is not the security boundary. The planner may be an LLM; consequences pass through
deterministic gates.

## Basis staleness

`fresh | stale(reason) | unknown`. Checked immediately before dispatch **and again** after any long
queue wait, immediately before mutation.

- `stale` → refuse dispatch, raise attention, re-brief.
- `unknown` → **fails closed.** Never guess, never proceed, never "probably fine". Task requeues as
  `blocked_basis_unknown` and raises attention.
- Fingerprint only resources actually consulted. Editing an unread file must not stale the task;
  changing a consulted architecture resource must.

## Exclusive locks

- Named, machine-wide (`unity-editor`, `unity-build`).
- Queue wait → basis re-check before acquisition and again before mutation.
- Basis `unknown` after a wait → do not acquire or retain the lock.
- If reconciliation becomes `unknown` while the lock is held → task enters `needs-repair` and the
  lock becomes `held-by-frozen-task`, visibly separate from ordinary work. Releasing it is an
  explicit audited repair operation that does **not** resolve the RepairCase.

## needs-repair

Read-only with respect to affected resources. Allowed exits, owner-chosen only:
`Reprobe · Adopt · Reset/abandon · Release frozen lock · adapter-specific repair`.
The Director may never clear `needs-repair`. Every exit is audited. All must be reachable from the
phone.

## Presence and teardown

- Presence is an explicit claim/lease (`claim`, `heartbeat`, `release`), never inferred from file
  mtimes.
- Dirty state blocks destructive cleanup whether or not a claim is active.
- Before teardown, compute a `SafetyRecord`: dirtiness, retained artifacts, reversal options. No
  sandbox with unapplied work is destroyed without a recorded policy outcome.
- Cannot prove ownership or safety → `needs-repair`.

## Reversibility

| Class | Meaning | Examples |
|---|---|---|
| `revertible` | clean automated reversal exists | local change, generated artifact |
| `compensable` | undo needs a new forward action | deployment rollback, republish |
| `irreversible` | no reliable reversal | store submission, release, sent message, destructive delete |

Reversibility is **orthogonal to risk tier**. A one-line change can be irreversible; a large change
can be safely revertible. Show both, separately, before the decision. Irreversible apply requires
fresh per-action verification regardless of risk tier. A reversal is itself an ApplyPlan: validated,
budgeted, authorized, and `apply.reversed`/`apply.compensated` only after confirmed completion.

## Apply authority

1. Adapter returns a declarative `ApplyPlan` — ordered operations with `target_ref`, required
   capability, risk, reversibility class. No broker handles.
2. Spine validates against role capability, current basis, approval fingerprint, budget.
3. Spine invokes the credential broker. The worker never holds the secret.
4. `confirm_applied` lets the adapter reconcile after execution.

`action_fingerprint = hash({operation, project_id, task_id, basis_ref, change_set_hash, target_ref,
apply_plan_hash, reversibility_class})`. Verification binds to that fingerprint; a reusable or
stale assertion is a critical defect.

## Away mode

Irreversible or step-up-gated work parks **indefinitely**. Durable state is
`awaiting_user_verification`, distinct from generic pending approval. No timeout may convert absence
into authorization. Deterministic watchers keep running while the Director sleeps; escalate stuck
notification *delivery* separately from ordinary owner delay.

## Smell test when reviewing

Any default-allow branch, any timeout that approves, any `catch { proceed }`, any "assume fresh if
we cannot tell", any state that cannot be reconstructed from durable events — each is a defect in
this repo, regardless of how convenient it is.
