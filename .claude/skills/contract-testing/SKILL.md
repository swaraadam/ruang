---
name: contract-testing
description: How to write and run the adapter contract suite, host test double runs, provider golden replays and the verify gate in this repo. Use when adding tests, when a seam needs proving, when an adapter is added or changed, and before claiming any issue is done.
---

# Contract testing

The contract suite is written **once against the SPI** and run against **every** adapter. An
adapter with its own private version of a contract test is a hole in the seam.

## `pnpm verify`

```
typecheck → lint → unit → contract → scripts/audit-seams.sh → scripts/audit-identity.sh
```

Must be fast enough to run per commit. Every issue's definition of done includes a green run
pasted as evidence.

## Where contract tests live

`tests/contract/`, named `*.contract.test.ts`. Both halves are load-bearing:

- The **directory** is what gate condition 0.4 selects. A contract test outside it is invisible
  to the gate, so "no adapter-private contract test" stops being a rule someone has to remember
  and becomes a structural fact.
- The **name** is how a reader tells a contract test from a unit test once both sit in `tests/`.

A suite is written once against the SPI and parameterized by adapter. If an adapter needs its own
version of an assertion, the contract is wrong — revise it (ADR), do not fork the test.

## Domain adapter contract (blueprint §20.1)

For each registered adapter, assert:

1. Basis: `fresh`, `stale(reason)` and `unknown` are all producible; `unknown` refuses dispatch.
2. Sandbox close never destroys dirty work without a `SafetyRecord` and a recorded policy outcome.
3. `inspect_sandbox` is non-mutating and callable at any lifecycle point.
4. Change-set hash is stable across repeated computation on an unchanged sandbox.
5. Every produced `RenderableChange` matches a closed protocol shape with a renderer case.
6. Declared checks execute; skips carry an explicit `skipped_reason`; retries are bounded and
   recorded separately; a flaky pass is distinguishable from a clean pass.
7. `apply_plan` returns per-operation reversibility and never returns broker handles.
8. `confirm_applied` reconciles; `revert_or_compensate` returns a plan or an explicit
   `not_reversible`.
9. `needs-repair` is reachable **and** recoverable through each allowed exit.

## Two-adapter proof

The SPI stays provisional until the code adapter and a **real** binary-asset workflow both pass.
If the asset adapter cannot implement a method, revise the contract in writing (ADR) — no core
workaround. Phase 7 adds a minimal text/docs fixture adapter that must compile and pass in under a
day with zero core edits; it is a regression fixture, not a product feature.

## Host double

One real Darwin implementation, one test double. The **entire core suite** must pass against the
double on any platform. That run is the proof that launchd/tmux/TCC assumptions did not leak.

## Provider replay

Record sanitized provider event fixtures; replay against normalizers. A provider SDK change must
fail a test rather than silently corrupt office state. Sanitization is a script, never manual.

## Anti-patterns

- Mocking across a seam in a way that asserts the *implementation* rather than the contract.
- Tests that pass because the code and the test share a wrong assumption — always assert against
  the blueprint rule, quoting the section in the test name.
- Relaxing an audit or deleting an assertion to get green. Escalate on the issue instead.
- Snapshot tests over event streams without asserting `seq` monotonicity and replayability.
- A global `retry` in `vitest.config.ts`. Condition 0.4 reads the runner's pass/fail counters, so
  a test that fails then passes is reported as passed — the gate would print PASS over a flake.
  Retries belong to a declared check, bounded and recorded, per item 6 above.
