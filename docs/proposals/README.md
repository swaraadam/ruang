# Proposed configuration

Files here are **not live**. They replace files under `.github/workflows/`, a path agents are
denied `Edit` on — a deny that held when these were written.

The deny was respected rather than worked around. A shell write would very likely have succeeded:
`Bash(python3 *)` is permitted and the deny is enforced per-tool, not on the resulting file. Doing
that would have made the permission file decorative, which is the same shape as an agent editing
its own permissions to obtain authority — the thing `docs/adr/0003-agent-landing-authority.md`
stopped and wrote down rather than doing. So the change is staged here for the owner to apply.

**That gap is real and is not filed anywhere yet.** M-10 covers new files escaping the deny; it
does not cover a shell write overwriting a guarded file. Worth its own entry.

**Nothing in this directory does anything until it is copied into place.** Landing it changes no
behaviour.

## What changes when you apply it

Two things, and only one of them is a loosening.

### 1. A label change re-evaluates the check — pure fix, no trade-off

`guardrails.yml` triggers on `labeled`/`unlabeled` and reads labels **live from the API** instead
of from the event payload. Today neither is true, which is why adding `owner-approved` does nothing
until you also close and reopen the PR, and why a re-run does not help — it replays the original
payload. Measured on PR 33: the re-run after the label change still expanded to
`echo "needs-owner" | grep -qw owner-approved`.

The live read also fixes the case that matters more: **removing** a label turns the check red again.
Today a green result persists, so the check records that approval *was once* given, not that it
*is* given at merge time.

### 2. `CLAUDE.md` stops needing the owner — the loosening, scoped deliberately

| Tier | Paths | Gate |
|---|---|---|
| **Owner-only** | `.github/workflows/**`, `.claude/settings.json`, `scripts/audit-*.sh` | `owner-approved` |
| **Delegated** | `CLAUDE.md` | `claude-review: pass @ <head sha>` from `claude[bot]` |

`CLAUDE.md` is instructions to agents, not a check that runs. Changing it weakens no audit and
breaks no build, a bad change is visible in the diff, and it is where nearly all the label friction
came from — so it is where loosening actually pays.

**The audit scripts are deliberately NOT delegated.** An earlier version of this file put them in
the delegated tier and `claude[bot]` blocked it as a weakened guardrail. It was right: those
scripts *are* the enforcement of invariants 8, 9 and 10, so handing them to the same agents they
constrain is a loosening with no floor under it.

The gate is the **SHA-bound marker**, never the `review-passed` label. The reviewer applies that
label on any clean verdict, and a label carries no commit identity — it survives a push that
changed the very code it judged.

## Applying it

The two files are a **matched pair and must land together**:

- `claude-review.yml` narrows marker-withholding, so `CLAUDE.md` starts receiving a marker.
- `guardrails.yml` gates `CLAUDE.md` on that marker.

Applying only the second refuses every `CLAUDE.md` change, because no marker would ever be emitted
for one. Applying only the first emits a marker nothing reads.

**Run these on this PR's own branch**, so the config and the documentation that describes it land
in one commit and cost one label:

```sh
cp docs/proposals/guardrails.yml    .github/workflows/guardrails.yml
cp docs/proposals/claude-review.yml .github/workflows/claude-review.yml
rm -r docs/proposals
git add -A && git commit -m "ci: apply the guardrails and reviewer changes" && git push
```

This PR already touches `CLAUDE.md` and so already needs `owner-approved`; adding the workflow
files costs no extra approval. Label it, close-and-reopen to re-trigger `guardrails` (the trigger
fix is not live until this very PR lands), and merge. **That is the last time that dance is
needed.**

The documentation in this PR describes a delegation that does not exist until these files are in
place. That is why they travel together: landing the docs alone would leave `CLAUDE.md` §8
claiming something CI does not do.

## What this does not change

Normal work is unaffected either way. `guardrails` only fires when a PR touches one of the four
paths above. A PR under `packages/`, `apps/` or `adapters/` never does, so it already merges with
no label and no owner involvement. This directory is an optimisation for infrastructure PRs, which
should be rare.
