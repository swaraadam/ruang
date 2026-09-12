---
name: review-pr
description: Review a pull request in this repo against the blueprint invariants. Auto-trigger when given a PR number and asked to review it, "review PR #123", "check this PR", or a PR URL for this repo. Also the process the claude-review.yml GitHub Action runs.
argument-hint: <PR number e.g. 45>
allowed-tools: Read, Glob, Grep, Bash(gh:*)
---

Review a pull request against this repo's documented standards.

Runs two ways:

- **Interactively** (`/review-pr <number>`) — the PR number is in `$ARGUMENTS`.
- **In CI** (`.github/workflows/claude-review.yml`) — the number and head SHA come from the
  workflow prompt.

In CI, run non-interactively: do not ask questions, produce the review and submit it.

## 1. Load the standards first

Read these before reviewing. Do **not** review from memory, and do not restate the rules back —
cite them.

- `CLAUDE.md` — §2 invariants (1–11), §3 core vocabulary, §4 seams, §8 what agents may not do,
  §10 style and the change budget.
- The blueprint section the issue names (`docs/blueprint/v0.7.md`). The issue body lists it under
  "Blueprint references".
- The skill for the area touched: `.claude/skills/seam-discipline`, `event-vocabulary`,
  `fail-closed-mechanics`, `sqlite-persistence`, `contract-testing`, `phase-gates`.

`docs/adr/` records deliberate choices that look like violations but are not. Check it before
flagging something as a divergence — ADR-0004, for example, records why the event envelope says
`project_id` where Appendix A.3 says `workspace_id`, and why `actor.runtime_id` is not `provider`.

## 2. Gather the change

1. `gh pr view <n>` — title, body, author, base, linked issue.
2. `gh pr diff <n>` — every changed file.
3. `gh issue view <issue>` — the acceptance criteria. **Review against the issue, not the PR
   description.** The PR description is the author's account of the work; the issue is the contract.

Read the surrounding file when the diff alone cannot tell you whether a rule is broken. A missing
`owner_id` on a durable row is only visible from the schema, not from the hunk.

## 3. Review every changed file, in priority order

### B1 — blocking: an invariant is violated

CLAUDE.md §2 says a violation here is a defect *even if tests pass and the feature works*.

1. A rendered state that does not reconstruct from snapshot + durable events, or unknown not
   looking unknown.
2. PTY bytes, token deltas or progress ticks treated as durable state or durable events.
3. Ambiguity resolved by guessing instead of `needs-repair`.
4. `unknown` staleness permitting dispatch or mutation.
5. AI judgment owning an irreversible consequence, or irreversible apply without fresh
   per-action verification bound to an action fingerprint.
6. Review-readiness asserted as a label rather than computed.
7. A fact with two authoritative homes.
8. `if (isOwner)` / `if (isMe)`, or a durable row or event missing `owner_id` / `org_node_id`.
9. git vocabulary in `packages/domain`, `packages/protocol` or the schema.
10. macOS vocabulary outside `adapters/host/darwin`.
11. Agent concurrency traded against attention cost.

Also B1: **a weakened guardrail.** A deleted assertion, a loosened audit pattern, a narrowed scan
set, a `skip`, `passWithNoTests`, a widened `.prettierignore`, a new audit exception. CLAUDE.md §8:
do not weaken a failing audit to pass.

And **evidence dishonesty** — the failure mode this repo has hit most. A claim that a check ran
when it did not; a criterion ticked whose stated mechanism does not exist; a citation to a section
that does not say what is claimed; a test that passes on broken code. Verify by grepping, not by
trusting the summary.

### B2 — blocking: the contract is not met

- An acceptance checkbox you cannot tie to a specific file and line.
- Change set over the budget — the issue's `change_budget`, else the 1250 default (CLAUDE.md §10) —
  with no owner waiver recorded **on the issue**. Count authored lines; a generated lockfile is not
  review burden. "The author said it was fine" is not a waiver; look for a `budget_waiver`.
- A `packages/protocol` union changed without a `PROTOCOL_VERSION` consideration, or a new shape
  with no renderer case.
- A seam crossed: substrate assumptions leaking into core, or a core workaround added because an
  adapter could not implement the contract.
- Work outside the issue's scope, or from a phase not yet open (`.claude/skills/phase-gates`).

### A3 — advisory: should fix

Naming against §3 vocabulary, a test that asserts an implementation detail of a seam, a comment
explaining *what* instead of *why*, a missing "what I would verify manually".

### A4 — advisory: nice to have

Formatting the tools do not catch, clarity, dead code.

For each finding: cite the exact **`file:line`**, name the **specific rule** ("invariant 8",
"§10 budget", "B1 evidence dishonesty"), and give a concrete fix.

Only flag violations of documented standards. If something looks wrong but no rule covers it, say
so plainly and label it **"not a documented rule"** rather than assigning it a tier.

**Never write `#` before a number** in anything posted to GitHub — GitHub auto-links `#4` to issue
4. Write "invariant 8" or "rule 4".

## 4. Per-line inline comments

One inline comment per specific finding, on the offending line, prefixed with its tier
(`[B1]` / `[B2]` / `[A3]` / `[A4]`), the rule, and the fix.

- **CI:** publish automatically if `mcp__github_inline_comment__create_inline_comment` is
  available; otherwise keep each finding in the summary with its `file:line`.
- **Interactive:** do not publish until the user approves in step 5.

## 5. Exactly one summary review per run

```
### 🔍 Automated review

**Verdict:** ✅ No blocking findings  |  ⚠️ Advisory only (A3/A4)  |  🚨 Blocked — B1/B2 found

**Findings:** 🔒 B1: N · 🏗️ B2: N · 📝 A3: N · ✨ A4: N

**Blocking (must fix):**
- `file:line` [B1] invariant N — what is wrong, and the fix

**Should fix:**
- `file:line` [A3] rule — the fix

**What I verified:**
- the specific things traced and confirmed, so a human knows what is already covered

**What I could not verify:**
- what needs a human or a real run — say this plainly rather than implying full coverage
```

Submit with:

```bash
gh pr review <n> --comment --body "<markdown>"
```

`gh pr review --comment`, **not** `gh pr comment` — only the former creates a `pull_request_review`.

Produce the summary even when clean. "What I verified" tells a reviewer what they can skip and
exposes a review that only skimmed. "What I could not verify" is required: a review that claims
more coverage than it had is the same defect as B1 evidence dishonesty, committed by the reviewer.

## 6. Verdict label, and the marker

The two labels are exclusive — adding one removes the other:

```bash
gh pr edit <n> --add-label review-passed     --remove-label changes-requested   # no B1/B2
gh pr edit <n> --add-label changes-requested --remove-label review-passed       # any B1/B2
```

**Then the marker.** Every run emits exactly one, as the last line of the summary review, with
nothing else on the line:

```
claude-review: pass @ <40-character head SHA>                 # no B1 and no B2
claude-review: changes-requested @ <40-character head SHA>    # any B1 or B2
```

Both are SHA-bound on purpose. A bare label cannot say *which* commit it judged, so a stale
`changes-requested` from an earlier push would otherwise read as a verdict on code that was never
reviewed. The CI step that proves a review ran accepts only these two, only from `claude[bot]`, and
only for the current head SHA.

### The marker is load-bearing

`pr-landing-agent` merges on it, unattended, while the owner is away. So:

- Emit `pass` **only** when there is no B1 and no B2 finding. Otherwise emit `changes-requested`.
  Never omit the marker entirely — a missing marker is indistinguishable from a review that
  crashed, and the CI step will fail the run rather than guess.
- Take the SHA from the workflow prompt (`HEAD SHA`), never from memory, never abbreviated. The
  gate matches the whole line with `grep -Fx`, so an abbreviated or annotated SHA simply fails.
- The SHA binding **is** the staleness rule: a push changes the head SHA, the marker stops
  matching, and the approval expires without anyone having to remember to revoke it.
- **Withhold the marker for the owner-only paths** — `.github/workflows/**`,
  `.claude/settings.json` and `scripts/audit-*.sh`. CI, the agent permission file and the scripts
  that enforce invariants 8/9/10 are the owner's to approve, and no review substitutes for that; a
  workflow change additionally cannot be reviewed at all, because `claude-code-action` skips itself
  on one. Say in the summary that the PR is owner-gated and why.
- **`CLAUDE.md` does get a marker.** It is instructions to agents, not a check that runs, so
  changing it weakens no audit and breaks no build. `guardrails.yml` gates it on that marker —
  never on the `review-passed` label, which carries no commit identity and would survive a push
  that changed the code it judged. If that workflow still requires `owner-approved` for `CLAUDE.md`
  when you read this, the paired config change has not been applied yet; emit the marker anyway,
  and the check will simply keep asking for the label until it is. It is still the file every other rule is read from, so apply the
  B1 "weakened guardrail" test with full force before emitting a pass for one.

## Rules

- **Advisory to GitHub, load-bearing to the gate.** Always `--comment`; never `--request-changes`,
  never `--approve`. The merge decision is the landing gate's, and it reads the marker.
- Be specific: exact `file:line`, the rule, the fix.
- Do not invent rules. Do not assign a tier to something no document covers.
- Prefer one accurate finding over five speculative ones. A reviewer who cries wolf gets muted.
- A previous review on this PR is not a reason to stay silent — later runs exist because the code
  changed. Only duplicate summaries *within one run* are forbidden.
