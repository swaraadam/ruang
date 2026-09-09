# ADR-0002: Phase 0 gate record — not met; two of four conditions were mis-reported by the script

- **Date:** 2026-09-10
- **Status:** accepted (record of an executed check, not a proposal)
- **Phase:** 0
- **Blueprint sections affected:** §03.3, §20, §22, §23

## Context

`./scripts/gate-check.sh 0` was run during an unattended overnight run, on branch `main` at commit
`c78cb52`. Raw output, verbatim:

```
Gate check: phase 0

0.1 vocabulary + identity audits
  PASS      audits green
0.2 verify gate
  FAIL      pnpm verify failing
0.3 gateway restart while live session survives
  UNPROVEN  restart survival -> no test found (P0-08)
0.4 Phase 0 contract tests
  UNPROVEN  contract suite -> not found (P0-13)

GATE 0: not met. UNPROVEN is not PASS.
exit=1
```

Each line was then checked by hand. **Two of the four are untrustworthy as printed.** The script's
verdict and the verified verdict are both recorded below; where they disagree, the verified column
is the one that counts.

| # | Exit condition | Script said | Verified | Evidence |
|---|---|---|---|---|
| 0.1 | vocabulary + identity audits pass | `PASS` | **UNPROVEN** | vacuously green — zero checks executed |
| 0.2 | verify gate | `FAIL` | **UNPROVEN** | broken invocation *and* a stub target |
| 0.3 | gateway restart while live session survives | `UNPROVEN` | **UNPROVEN** | accurate; no such test exists (P0-08) |
| 0.4 | Phase 0 contract tests green | `UNPROVEN` | **UNPROVEN** | accurate; no contract suite exists (P0-13) |

**0.1 — reported PASS, actually UNPROVEN.** Every check in `scripts/audit-seams.sh` and
`scripts/audit-identity.sh` is guarded by `[[ -d "$d" ]]` over `packages/`, `apps/`, `adapters/`,
`config/` (`audit-identity.sh:9`, `audit-seams.sh:22`, `audit-seams.sh:35`). On `main`,
`ls -d packages apps adapters` returns no such directory for all three. Zero checks execute and
both scripts print PASS having tested nothing. An audit that did not run is not a passing audit.

**0.2 — reported FAIL, actually UNPROVEN.** Two independent defects, either of which alone would
void the result:

1. `scripts/gate-check.sh:31` invokes `pnpm -s verify`. pnpm 12.3.4 rejects the flag outright —
   `error: unexpected argument '-s' found`, exit 2 — so the condition reports FAIL unconditionally,
   whatever the true state is. The correct form is `pnpm --silent run verify`.
2. With the correct invocation, `pnpm run verify` on `main` exits **0** — and still proves nothing,
   because main's `package.json` scripts are placeholders: `lint` is
   `echo 'lint not configured yet (P0-01)'`, `test` is `echo 'no tests yet (P0-01)'`, and
   `typecheck` is `tsc -b --pretty false || echo 'no project references yet (P0-01)'`, where the
   `|| echo` swallows any compiler failure.

Neither FAIL nor PASS is honest for 0.2. It is UNPROVEN, for both reasons.

**0.3 and 0.4** are accurate as printed. No session-restart-survival test exists (owned by P0-08,
not started); no contract suite exists (owned by P0-13, not started).

### Run context

- **P0-01 (toolchain)** was implemented and independently verified on local branch `p0-01`
  (commits `a0e1864`, `630152d`). On that branch `pnpm run verify` is real and green, and the
  audits stop being vacuous. **None of it counts toward this gate**: the branch is not landed, and
  the gate measures `main`.
- P0-01 is parked `needs-owner` for two reasons: (a) `.claude/settings.json` denies
  `Bash(git push*)` unconditionally, so no agent can push a branch or open a PR — the PR step of
  the definition of done (CLAUDE.md §7.5) is unreachable for all 28 issues; (b) no workspace
  package declares an entry point, so cross-package imports fail with `TS2307`; the fix is ~30
  lines against an already-exhausted 250-line budget, so the choice between a budget waiver and a
  new backlog entry is the owner's.
- `scripts/next-ready.py` reports `READY (0)`, 28 blocked. **Zero issues are startable.**
- The two `blocked-gate` issues (#20 canonical origin, #27 real cost ceilings) were correctly never
  started.
- All four external gates in `docs/gates/phase-minus-1.md` remain open and unchecked.

## Options

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Record the script's raw output only | none | high — leaves a false `PASS` on 0.1 and a false `FAIL` on 0.2 in the durable record | violates "never animate a lie" (CLAUDE.md §2.1) at the level of the record itself |
| Record raw output **and** the verified reality per condition | one ADR | none | chosen |
| Fix `gate-check.sh` during this run, then re-run | ~5 lines | inventing scope; changing a check to change its result | rejected — see Decision |
| Treat 0.1 PASS + landed P0-01 as "close enough" to advance | none | catastrophic — advances on an audit that executed nothing | rejected; `UNPROVEN` is never `PASS` |

## Decision

**Phase 0 gate: NOT MET. 0 of 4 exit conditions are genuinely proven. Do not advance.**

The recorded verdict for this run is `UNPROVEN × 4`, not the script's `PASS/FAIL/UNPROVEN/UNPROVEN`.
Advancing is not recommended, and no follow-on phase work may be opened on the strength of this
check.

`gate-check.sh` was **deliberately not fixed during this run.** It is a scaffold script that no
backlog issue owns; editing it would be inventing scope (CLAUDE.md §7.1), and editing a check
mid-run in order to change its own result is exactly what CLAUDE.md §8 forbids ("do not weaken a
failing audit to pass" — the symmetric case, strengthening one to produce a different verdict, is
the same defect). The defects are recorded here instead, for an owner-authorised issue.

## Consequences

**Every Phase 0 gate check run before `gate-check.sh` is repaired must be read as advisory only.**
Specifically: condition 0.2 is hard-wired to FAIL by the pnpm flag bug and cannot report anything
else; condition 0.1 reports PASS for an audit that executed nothing, and will keep doing so until
`packages/`, `apps/` and `adapters/` exist on the branch under test. Both must be fixed before the
next gate check is treated as meaningful.

Two prerequisites now block *all* forward motion, not just this gate:

1. The `git push*` deny rule makes the definition of done unreachable for all 28 issues. Work can
   be implemented and verified, but never landed by an agent — so `main` cannot change, so no gate
   condition measured on `main` can ever flip.
2. With `READY (0)`, there is no next issue to pick up. The run has no legal work remaining.

Both are owner decisions. Until at least the first is resolved, further unattended runs will
produce verified-but-unlanded branches and this same gate result.

What is *not* foreclosed: the P0-01 work on branch `p0-01` is intact and independently verified.
The sandbox must not be torn down (CLAUDE.md §7.6).

## Reversibility

`revertible`. This ADR records facts about one commit at one point in time; it is superseded by the
next dated gate record, not amended. No code, schema, identifier or configuration was changed by
the check or by this record. The verdict costs nothing to re-take once `main` moves.

## Deferred, and which seam carries it

- **`gate-check.sh` repair** (pnpm invocation on line 31; making 0.1 report UNPROVEN rather than
  PASS when the scan set is empty) — deferred to an owner-authorised backlog entry. **Invariant
  held now:** this record states the verified verdict, so no downstream reader inherits the
  script's two false lines. The next gate record must re-verify by hand until the script is fixed.
- **Landing P0-01** — deferred to the owner, blocked on the push/PR capability. **Invariant held
  now:** the gate is measured on `main` and reported as `not met`, so the unlanded branch cannot be
  mistaken for progress against the gate.
- **Workspace entry points / `TS2307`** — deferred pending the owner's budget-waiver-vs-new-issue
  call. **Seam that carries it:** none of the four seams; this is toolchain, inside the
  "not seams, deliberately" set (CLAUDE.md §4), so it is a migration cost, not a design commitment.
- **Phase -1 external gates 1–4** — remain open, unclosable by any agent. **Invariant held now:**
  placeholder identifiers only (ADR-0000), no hostname registered, no passkey enrolled, automation
  disabled for want of real cost ceilings.
