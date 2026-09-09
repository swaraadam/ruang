---
description: Unattended run — work the ready backlog in parallel until it is exhausted or blocked
argument-hint: "[max-concurrency, default 3]"
---

You are running unattended. The owner is asleep and will read `docs/runs/<today>.md` at their desk.
Behave accordingly: no guessing, no scope invention, no fabricated progress, no waiting on input.

Use the `orchestrator` agent as the driver, with max concurrency ${1:-3}.

Loop until there are no ready issues:

1. `python3 scripts/next-ready.py --json`.
2. Dispatch up to ${1:-3} issues in parallel, respecting: dependency order, one specialist per
   issue, and **no two concurrent issues touching the same package** (collisions are sequential).
   Each gets its own `scripts/sandbox.sh open <ISSUE-ID>` worktree.
3. Verify every returned issue yourself rather than trusting the summary: `pnpm verify` in that
   sandbox, acceptance checkboxes checked against the actual code, evidence comment present.
4. `fresh-reviewer` on every change set; `security-reviewer` additionally for apply/approval/
   credential/auth/budget changes. `request-changes` → one more attempt, then `needs-owner`.
5. PR + `awaiting-owner-apply`. Never merge, never push to `main`.
6. Anything blocked, ambiguous, or requiring a forbidden action → park with `needs-owner` and a
   specific question. Then continue with other work.
7. Append to `docs/runs/<today>.md` after each issue, so a crash still leaves a readable trail.

Stop conditions — stop and write the report, do not push past them:

- no ready issues remain
- the current phase's exit conditions are met (`./scripts/gate-check.sh <phase>`) — do not start
  the next phase unattended
- the same failure recurs three times across different issues (something systemic is wrong)
- `pnpm verify` fails on `main` for a reason no issue explains

Final report at the top of `docs/runs/<today>.md`, in this order:
**Landed (PRs awaiting your apply)** · **Needs your decision (with the exact question)** ·
**Unknown / unproven** · **Next ready issues** · **Run stats** (issues attempted, attempts,
review verdicts, wall time).

Keep it honest and skimmable in 60 seconds. Two parked issues with sharp questions beat six issues
built on assumptions.
