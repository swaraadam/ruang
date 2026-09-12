# ADR-0005: an independent CI reviewer, and unattended merge on its verdict

- **Date:** 2026-09-12
- **Status:** accepted
- **Phase:** 0
- **Blueprint sections affected:** §8.1, §8.2, §8.4 (away mode), §16.2
- **Supersedes part of:** ADR-0003 (condition 2 mechanism, and its deferred "second identity")

## Context

ADR-0003 gave `pr-landing-agent` merge authority and admitted the hole: **one GitHub account holds
every role.** Author, reviewer and merger are the same identity, so condition 2's approval could be
written by the agent it was meant to constrain. Real enforcement needed a second identity, which
§8 forbade creating, so it was deferred.

The owner now wants unattended operation — agents working through the backlog and landing their own
work overnight. That raises the cost of the hole from theoretical to operational: a fabricated
approval merged at 03:00 is discovered at 09:00, on `main`, with a night's work stacked on top.

The Claude GitHub App resolves the identity problem without creating an account. `claude-code-action`
runs in CI under the app's own identity, which is **not** the PR author. Its review is therefore
independent in the one way the local `fresh-reviewer` never could be.

Pattern adapted from an existing repo of the owner's (`claude_review.yaml` + `claude.yaml` +
a `review-pr` skill + exclusive verdict labels), with the changes below.

## Decision

### 1. A CI reviewer reviews every PR, on every push

`.github/workflows/claude-review.yml` runs on `opened`, `ready_for_review` and `synchronize`. It
reads `.claude/skills/review-pr/SKILL.md`, reviews against the CLAUDE.md §2 invariants and the
blueprint section the issue names, posts inline comments plus exactly one summary
`pull_request_review`, and applies one of two exclusive labels: `review-passed` / `changes-requested`.

`.github/workflows/claude.yml` handles `@claude` mentions for on-demand follow-up.

### 2. `synchronize` is NOT gated on a label — a deliberate divergence from the source pattern

The source repo re-reviews on push **only while `changes-requested` is present**, to bound Actions
spend. That is safe there because a human merges and sees the new commits.

Here the merge can be unattended. Under the source behaviour: PR is reviewed clean → `review-passed`
→ someone pushes → **no re-review fires, and the stale `review-passed` remains**. The landing gate
would then merge code no reviewer ever read. Reviewing every push is what closes that.

Cost is bounded by the §10 change budget: 250 lines per PR.

### 3. The verdict is carried by a SHA-bound marker, not by the label

The label is for humans. The gate reads:

```
claude-review: pass @ <40-character head SHA>
```

matched `grep -Fx` against `headRefOid`, exactly as ADR-0003 established for condition 2. **The SHA
binding is the staleness rule**: a push changes the head SHA, the marker stops matching, and the
pass expires by construction rather than by anyone remembering to revoke it.

A bare label cannot do this — a label has no commit identity, which is the same class of defect as
the `owner-approved` label the `guardrails` workflow reads from a stale event payload. The gate also
cross-checks the label against the marker and **refuses when they disagree**, since one of the two
is stale and it cannot tell which.

### 4. Unattended merge is bounded

The gate may merge while the owner is away, but never:

- a PR touching a guardrail path (`CLAUDE.md`, `.claude/settings.json`, `.github/workflows/**`,
  `scripts/audit-*.sh`) — those stay the owner's, and the CI reviewer is instructed never to emit a
  marker for one;
- a PR labelled `needs-owner`, `blocked-gate` or `changes-requested`;
- a PR over budget without an owner waiver on the issue, or with an acceptance box not tied to code.

And it **stops the run entirely** when one defect shape appears three times across different issues —
the condition that stopped the 2026-09-10 run, now binding on the merge path rather than only on the
work path.

### 5. `fresh-reviewer` is demoted to an author-side pre-check

Its marker runs as the PR author's own account. It is worth writing and worth reading; it is not
evidence, and it no longer satisfies condition 2 on its own.

## Consequences

**Easier:** the owner can sleep. Condition 2 becomes independent evidence for the first time, and a
stale approval becomes structurally impossible rather than procedurally discouraged.

**Harder:** every push costs a review run. The flow now depends on a credential
(`CLAUDE_CODE_OAUTH_TOKEN`) and an installed GitHub App, neither of which an agent may provision —
so a broken token means no marker, which means no merge. **That fails closed**, which is correct.

**Foreclosed:** nothing. Removing the two workflow files returns the repo to owner-merged operation.

## Known gaps — stated, not implied away

1. **The merge step is still the author's own account.** Nothing server-side checks that condition 2
   was honoured. Branch protection requires `verify` and `guardrails` and **zero approving reviews**.
   An agent can still add `review-passed`, or `owner-approved`, to a PR it wrote.
2. **The harness deny list does not cover sandboxes.** `.claude/settings.json` denies
   `Edit(./.github/workflows/**)`, but that path is relative to the repo root, and CLAUDE.md §7
   requires all work to happen in a git worktree under `.sandboxes/`. Writes to
   `.sandboxes/<ID>/.github/workflows/` are not matched by the deny and succeed. **Every guardrail
   `Edit(...)` deny in that file has the same hole.** Discovered while implementing this ADR.
3. Consequently the guardrail protection that actually binds today is the **`guardrails` CI check**,
   which requires the `owner-approved` label — and an agent can apply that label. The two gaps
   compose.

Closing 1 and 3 needs owner action in `.claude/settings.json` (a path agents may not edit):
denying `Bash(gh pr edit * --add-label owner-approved*)` removes the self-approval step, and
branch protection requiring an approving review would make condition 2 server-enforced. Closing 2
needs the deny patterns widened to match sandbox paths, or an equivalent hook.

Recorded here rather than fixed here: this ADR's own PR touches guardrail paths, so it is
owner-approved and owner-merged by construction.

## Reversibility

`revertible` — two workflow files, one skill, three documents, no schema, no durable row, no
external system beyond a GitHub App installation the owner controls and can uninstall.

## Deferred, and which seam carries it

- **Server-enforced condition 2** — branch protection requiring an approving review, with the CI
  reviewer switched from `--comment` to `--approve`. Deferred until the marker flow has run for a
  while and the failure modes are known; an `--approve`/`--request-changes` reviewer that misfires
  can deadlock a PR nobody is awake to dismiss. **Invariant held now:** the marker is SHA-bound, so
  a pass cannot be stale even though it can be forged.
- **Sandbox-aware guardrail denies** — Seam B carries it (the host adapter owns path policy).
  **Invariant held now:** the `guardrails` CI check still fails a guardrail-path PR that lacks the
  `owner-approved` label, and the gate refuses to merge one at all.
