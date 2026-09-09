---
name: issue-workflow
description: How work is claimed, sandboxed, evidenced, reviewed and offered for landing in this repo — labels, per-issue git worktrees, evidence comments, PR rules, parking rules for anything an agent may not do. Use at the start and end of every issue, and for unattended/overnight runs.
---

# Issue workflow

Work only ever comes from issues generated from `docs/backlog/backlog.yaml`. Inventing scope is a
defect.

## Labels

| Label | Meaning |
|---|---|
| `phase-0` … `phase-7` | phase membership |
| `agent:<role>` | intended specialist |
| `in-progress` | claimed; do not take |
| `blocked-dep` | dependency issue still open |
| `blocked-gate` | waits on an external Phase -1 gate — never start |
| `needs-owner` | requires a human decision or a forbidden action |
| `awaiting-owner-apply` | PR open, landing is the owner's call |
| `needs-repair` | ambiguous state; mutation frozen; owner exit required |

## Sequence

1. `python3 scripts/next-ready.py` — only take from this list.
2. Claim: `gh issue edit <n> --add-label in-progress` + a comment naming your agent role and start
   time.
3. `scripts/sandbox.sh open <ISSUE-ID>` — a per-issue git worktree under `.sandboxes/`.
   **Parallel agents never share a working tree.** Branch name: `<issue-id>-<slug>`.
4. Implement inside the change budget (250 lines for code tasks unless stated). Exceeding the
   budget means splitting the issue, not exceeding the budget.
5. `pnpm verify`. Green, or stop.
6. Evidence comment on the issue — this is task output, not a courtesy:
   - commands run and their key output
   - which acceptance checkbox each piece of evidence satisfies
   - skipped or flaky checks, named explicitly
   - **what I would verify manually** (required)
   - reversibility of the change: `revertible | compensable | irreversible`
7. `scripts/sandbox.sh inspect <ISSUE-ID>` before any teardown. Dirty sandbox is never destroyed.
8. `gh pr create` against `main`, linked to the issue. Then request the `fresh-reviewer`, and
   `security-reviewer` too if the change touches apply, approvals, credentials, auth or budgets.
9. Swap labels: remove `in-progress`, add `awaiting-owner-apply`. **Never merge. Never push to
   `main`.**

## Rejection is not a dead end

`request-changes` bundles the comments into a feedback unit, delivers it to the worker, and creates
a **new linked attempt** on the same issue. Two attempts maximum, then `needs-owner`.

## Parking rules (unattended runs)

Park — do not improvise — when the task needs any of: merging, pushing to `main`, a secret,
credential enrolment, a real hostname, an external account, a new runtime dependency without
justification, a change to `docs/blueprint/*`, or a decision the blueprint leaves to the owner.

To park: comment stating exactly what is blocked and what decision is needed, add `needs-owner`,
remove `in-progress`, move to the next ready issue. A parked issue with a crisp question is a
**good** overnight outcome. A completed issue built on a guess is not.

## Morning report

Every run appends to `docs/runs/<date>.md`, top-loaded for a 60-second read: what landed, what is
waiting for the owner, what is unknown, what the next ready issues are. No optimism, no padding.
