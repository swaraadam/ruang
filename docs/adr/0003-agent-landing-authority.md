# ADR-0003: Agents may land their own PRs through a landing gate

- **Date:** 2026-09-10
- **Status:** accepted, **partially implemented** — see "Known gap" before relying on this
- **Phase:** 0
- **Blueprint sections affected:** §08.2 (Director capabilities), §12.4 (reversibility on approval), §20

## Context

Until now agents could implement and verify work but could not deliver it. ADR-0002 recorded the
consequence: `.claude/settings.json` denied `Bash(git push*)` unconditionally, so no branch reached
the remote, `gh pr create` failed, and the PR step of the definition of done (CLAUDE.md §7.5) was
unreachable for all 28 issues. An overnight run could only ever produce local branches.

The deny rule's *intent* was right — never write to `main`. It was written wider than its intent,
and it enforced that intent by an honour system inside the agent harness rather than at the server.

The owner has now put a real boundary in place:

- `.github/workflows/verify.yml` runs `pnpm install --frozen-lockfile && pnpm run verify` on every
  pull request.
- Branch protection on `main` requires the `verify` check, with `strict: true` (a branch must be up
  to date before merging). Confirmed via
  `gh api repos/swaraadam/ruang/branches/main/protection`.

That changes what "let an agent merge" means. The guarantee stops being "the agent promised not to"
and becomes "the server will not accept it".

## Options

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Keep the blanket push deny; owner lands everything | none | every unattended run ends in unlanded branches; the backlog advances one wave per owner-apply cycle | measured in ADR-0002: 11 waves for Phase 0 + 1 |
| Let any agent merge once CI is green | none | high — CI green proves the suite passed, not that the suite is meaningful; an agent that weakens a check gets a green build | rejected |
| **Narrow the deny to `main` and force-pushes; merging only through a dedicated gate agent** | one agent definition, one settings change | low — bounded by branch protection, by a denied-files list, and by the gate's own conditions | **chosen** |
| Allow merging but require an owner ack per PR | none | collapses to option 1 in practice | rejected |

## Decision

**Agents may push feature branches and merge PRs, but only through `pr-landing-agent`. Direct
pushes to `main` remain forbidden. The irreversible list is unchanged.**

Three parts:

1. **Permission model** (`.claude/settings.json`). The blanket `Bash(git push*)` deny is replaced
   by targeted denies: `git push origin main`, any `--force`/`-f` push. Allowed:
   `git push -u origin <branch>`, `gh pr merge --squash --delete-branch`, `gh pr review`,
   `gh pr checks`, `gh run view`. Newly denied to agents: `Edit` on `.github/workflows/**`,
   `.claude/settings.json`, `scripts/audit-seams.sh`, `scripts/audit-identity.sh` — the guardrails
   an agent must not be able to file down from the inside.
2. **The gate** (`.claude/agents/pr-landing-agent.md`). It never writes source. It merges only when
   all of: CI `verify` green on the exact head SHA; `fresh-reviewer` approved *this* change set;
   `security-reviewer` approved if the change touches apply/approvals/credentials/auth/budget; the
   change set is within budget or under an owner waiver recorded on the issue; every acceptance box
   is tied to a file and line rather than to the author's summary; no denied file is touched; the
   branch is up to date and `MERGEABLE`. Otherwise it requests changes.
3. **CLAUDE.md §8** now states the push/merge rules and names the guardrail files explicitly.

**The irreversible list is untouched:** no secrets, no credential enrolment, no passkey
registration, no real hostname or DNS registration, no third-party accounts, no publishing, no
deployment, no outbound writes to external systems, no force pushes, no history rewrites.

### Why merging is revertible, and irreversible apply still is not

This does not breach invariant 5 ("apply authority fails closed; AI judgment never owns
irreversible consequences"), because a squash merge to `main` is `revertible` in the blueprint §5.5
sense, not `irreversible`:

- Every landing is **one squash commit**. `git revert <sha>` restores `main` exactly, with no
  compensating action and no external state to unwind.
- Nothing leaves the machine. A merge writes to a private repository; it publishes nothing, deploys
  nothing, sends nothing, and enrols no credential.
- The reversal is cheap and complete, so the reversal plan is knowable in advance — which is what
  §12.4 asks approval to display.

Landing a *code change* and performing an *irreversible apply* are different operations with
different reversibility classes, and only the second requires fresh per-action owner verification.
Conflating them is what kept the backlog frozen. Keeping them separate is the point of this ADR.

## Consequences

- Unattended runs can now deliver landed work, so the backlog advances without an owner in the
  loop. The gate, not the owner, becomes the thing standing between an agent and `main`.
- The blast radius of a bad merge is one `git revert`. The blast radius of a *bad gate* is larger,
  which is why the gate cannot write code and cannot merge anything that edits its own guardrails.
- CI is now load-bearing. `pnpm run verify` must stay honest; a weakened check is now a weakened
  merge condition, not just a weakened local signal. Hence the new `Edit` denies.
- `enforce_admins` is `false` on the protection rule, so the owner can still merge past a red check
  deliberately. Agents cannot — `--admin` is not available to them and is explicitly forbidden.
- **CI cannot pass on any branch based on a `main` that has no `pnpm-lock.yaml`**, because the
  workflow runs `pnpm install --frozen-lockfile`. Until P0-01 lands, every main-based PR is red for
  that reason alone. This inverts the intended order: P0-01 must land first.

## Known gap — this ADR is not fully implemented

Part 1 above is **incomplete in a way that blocks the whole mechanism.** The working copy of
`.claude/settings.json` still contains `Bash(gh pr merge*)` in its deny list alongside the new
narrower allow. Deny takes precedence over allow in Claude Code, so `gh pr merge` is refused —
verified empirically: even `gh pr merge --help` is denied.

The agent that would have fixed it cannot: `Edit(./.claude/settings.json)` is itself denied, and
routing around an enforced deny with a shell write is exactly the self-granting behaviour the deny
exists to prevent. An agent must not be able to edit its own permission file to obtain merge
authority, so the correct outcome is that it stopped and wrote this down.

**Required owner action:** delete the line `"Bash(gh pr merge*)"` from the `deny` array in
`.claude/settings.json`. The narrower `"Bash(gh pr merge * --squash --delete-branch*)"` allow is
already present. Until then, `pr-landing-agent` can evaluate every landing condition but cannot
execute the merge.

## Reversibility

`revertible`. Reverting this ADR's commit restores the previous `CLAUDE.md` §8 and removes the
landing-gate agent definition. Restoring the old permission model is a one-line edit to
`.claude/settings.json`. Nothing here is baked into a durable identifier, a credential, a schema or
an external system. Branch protection is owner-controlled and unaffected either way.

## Deferred, and which seam carries it

- **Requiring a `security-reviewer` approval mechanically** rather than by the gate's own judgement
  — deferred until there is an apply/credential surface to protect (Phase 3). **Invariant held
  now:** the gate's conditions name the trigger explicitly, and Phase 0 has no such surface.
- **A CODEOWNERS or required-review rule on the guardrail files** — deferred; today they are
  protected by the harness deny list, which binds agents but not a human with push access.
  **Invariant held now:** the gate rejects any PR whose diff touches them, so a guardrail change
  cannot ride in on an unrelated PR.
