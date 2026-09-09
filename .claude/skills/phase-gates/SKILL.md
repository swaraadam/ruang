---
name: phase-gates
description: The phase order, exit conditions, external Phase -1 gates and the mandatory stop-and-use period. Use before starting any issue, when deciding whether work is in scope right now, when running a gate check, and whenever asked "are we ready for the next phase".
---

# Phase gates

Phases are **evidence gates, not dates**. There is no calendar in this project; a phase ends when
its exit condition is demonstrable, and not before.

| Phase | Deliverable | Exit condition |
|---|---|---|
| -1 Trial + probe | orchestrator trial, instrumented asset task, canonical-origin proof, naming clearance | ADR fixes spine scope/delegation/asset shape; cleared repo/CLI/RP-ID names; check/render/apply-plan decisions recorded |
| 0 Spine + code adapter | protocol/domain packages, closed render union, code adapter, Darwin host adapter, persistent session manager, owner/org rows, migrations | gateway restart while live session survives; vocabulary + identity audits pass; Phase-0 contract tests green |
| 1 Remote Desk | canonical origin, mobile terminal attach, bell→needs_input, read-only change sets, preview, notifications, claim/lease | useful from phone on real work |
| **STOP & USE** | two weeks of daily use + friction log | Phase 2 scope justified by observed friction, not blueprint momentum |
| 2 Control loops + asset read-only | basis staleness, session resume, steer/repair exits, asset snapshot/inspect/render | real asset change renders reviewably on phone; anchors work; unknown fails closed and recovers |
| 3 Trust loop | review threads, review-readiness, evidence, broker, mobile apply, WebAuthn, reversibility | request-changes → new attempt → apply from phone with target-bound fingerprint and reversal plan |
| 4 Asset apply + heavy-native | asset apply/confirm, exclusive locks, import/build checks, manual-required evidence | one real asset task lands honestly; frozen-lock repair works; SPI revised in writing if needed |
| 5 Roles & org as data | role templates, org tree, delegation invariants, budget sub-allocation | add role + sub-department with no code change; no privilege/budget escalation |
| 6 Office | org-derived scene, attention badges, frozen/unknown distinct | only if Phases 1–3 are useful daily; passes the three-second glance test |
| 7 Portability audit | minimal third adapter as test fixture | written in under a day, core untouched |

## Open external Phase -1 gates

These are **not** document decisions and no agent can close them. Issues depending on them carry
label `blocked-gate`. See `docs/gates/phase-minus-1.md`.

1. **Naming clearance** — product/repo/CLI/hostname/WebAuthn RP ID. Blocks persistent identifiers.
2. **Canonical-origin proof** — one origin over both private (Tailscale) and fallback (Cloudflare)
   paths, proven on a throwaway hostname *before* any passkey enrolment.
3. **Real cost ceilings** — monthly/hourly/task/run values set by the owner. Placeholders are not
   executable configuration; automation stays disabled until they exist.

Also open: whether the code adapter delegates lifecycle to an external orchestrator (Phase -1 ADR).
Until decided, build the adapter directly and keep the projection/`adapter.divergence` path
possible.

## Running a gate check

`./scripts/gate-check.sh <phase>` — prints each exit condition with the command that proves it and
`PASS/FAIL/UNPROVEN`. `UNPROVEN` is not `PASS`. The result goes in `docs/adr/` as a dated gate
record via the `adr-scribe` agent.

## Stop branch

If daily use shows an existing orchestrator plus a thin mobile/review layer already solves the
workflow — and the asset requirement turns out not to be real — **stop before generalizing**. The
seams prevent lock-in; they do not obligate scope. Recommending the stop branch is a legitimate,
valuable outcome, not a failure.
