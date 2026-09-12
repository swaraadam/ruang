# Personal Agent Workspace — Project Instructions

Implementation of `docs/blueprint/v0.7.md` (Technical Blueprint v0.7, "Execution Baseline").
Read this file fully before touching anything. It overrides habit, convention and taste.

## 0. What this is

A single-owner, local-first control plane for a development machine that keeps working when the
owner is away from the keyboard. One owner, one Mac Mini, one canonical browser origin.
The office view is a visualization of durable truth, never a simulation.

**The one rule:** build for one owner, one host, one domain today. Pay only for deliberate seams.
A seam costs a type boundary and a naming discipline — not two implementations on day one.

## 1. Naming is not cleared yet (hard constraint)

Product / repo / CLI / hostname / WebAuthn RP ID naming clearance is an unfinished Phase -1 gate
(`docs/gates/phase-minus-1.md`). Until an ADR clears it:

- Use the placeholder identifiers in `config/naming.ts` (single source, one-file rename later).
- Do **not** bake a product name into package names, DB rows, hostnames or WebAuthn RP IDs.
- Do **not** register a real hostname or enrol a real passkey. Throwaway hostname only.
- `Project` is the core entity name. Avoid "workspace" as a type name; it is UI copy only.

## 2. Non-negotiable invariants

Violating one of these is a defect even if tests pass and the feature works.

1. **Never animate a lie.** Every rendered state reconstructs from snapshot + durable events.
   Unknown must look unknown.
2. **Durable vs ephemeral split.** PTY bytes, token deltas and progress ticks are never durable
   state and never durable events. See `.claude/skills/event-vocabulary/SKILL.md`.
3. **`needs-repair` is a real state.** Ambiguity freezes mutation instead of guessing.
4. **Fail closed on basis.** `unknown` staleness refuses dispatch and refuses mutation.
5. **Apply authority fails closed.** AI judgment never owns irreversible consequences.
   Irreversible apply requires fresh per-action verification bound to an action fingerprint.
6. **Evidence is task output**, not a byproduct. Review-ready is computed, never a visual label.
7. **One authoritative home per fact.** SQLite owns control-plane history; the session backend
   owns live streams; the domain adapter owns workspace contents.
8. **No `if (isOwner)` / `if (isMe)`.** Authorization is always a capability lookup.
   `owner_id` and `org_node_id` are mandatory on every durable row and durable event from
   migration v1.
9. **No git vocabulary in the core.** `git|commit|branch|merge|worktree|diff|hunk` must not appear
   in `packages/domain`, `packages/protocol` or the DB schema. Allowed inside
   `adapters/domain/code`.
10. **No macOS vocabulary outside the host adapter.** `launchd|LaunchAgent|pmset|tmux|TCC|FileVault|~/Library`
    only inside `adapters/host/darwin`.
11. **Attention cost beats agent concurrency.** Waiting is tokenless and event-driven.

`pnpm verify` runs the audits for 8/9/10. Run it before every commit. A hook also runs the seam
audit after edits — do not disable it.

## 3. Core vocabulary (use these words, in this order of authority)

| Core term | Never write instead | Code-adapter mapping |
|---|---|---|
| `basis.ref` | `planned_against_commit` | commit SHA |
| `basis.inputs[resource_id, version]` | `context_inputs[path, sha]` | file path + hash |
| `Sandbox` | worktree | git worktree |
| `ChangeSet` / `ChangeAnchor` | diff / hunk | file + text range |
| `change_budget` + `change_unit` | `diff_budget_lines` | lines or files |
| `Apply` | merge / push / land | patch/merge via broker ("Land" is UI copy only) |
| `Source of record` | repo / project root | git repository |
| `Checks` | tests / lint / typecheck | those, declared per project |
| `Exclusive resource lock` | build lock | `unity-editor`, `unity-build` |

## 4. Seams (the only axes of variation)

- **Seam A — Domain adapter** (`adapters/domain/*`): what work is. Basis, sandbox, change set,
  checks, apply planning, reversal. SPI is **provisional** until code *and* a real binary-asset
  workflow both pass the contract tests. If the asset adapter cannot implement a method, revise
  the contract — never add a core workaround.
- **Seam B — Host adapter** (`adapters/host/darwin`): where work runs. Sessions, autostart, paths,
  local notifications, capabilities. macOS-only implementation plus a test double; the core suite
  must pass against the double.
- **Seam C — Owner / roles / org** (`config/roles`, `config/org`, `packages/policy`): who may do
  what. Roles and org nodes are versioned data, not code.
- **Seam D — Provider runtime** (`adapters/provider/*`): substitution boundary, deliberately *not*
  generalized. Keep `start/cancel/send/status` minimal until both Codex and Claude are real.

Not seams, deliberately: React, TypeScript, SQLite, the office renderer. Changing them later is an
acceptable migration.

## 5. Stack

React + Vite + Tailwind (static bundle served by gateway) · TypeScript + Fastify + WebSocket
gateway · SQLite + WAL via `better-sqlite3`, migrations from v1 · xterm.js attaching to tmux ·
Tailscale primary network path, Cloudflare fallback, one canonical origin · LaunchAgent autostart ·
PixiJS/Phaser for the office (Phase 6 only) · pnpm workspaces · vitest.

## 6. Repository layout

```
apps/web  apps/gateway
packages/domain  packages/protocol  packages/policy  packages/persistence  packages/attention
adapters/domain/code  adapters/domain/assets(Phase 4)  adapters/host/darwin  adapters/provider/{codex,claude}
config/{roles,org,context-packs}  state/{artifacts,debug}  docs/  scripts/
```

## 7. How you pick up work

1. Work comes from GitHub issues generated from `docs/backlog/backlog.yaml`. Never invent scope.
2. `scripts/next-ready.py` lists issues whose dependencies are closed. Take from that list only.
3. Claim by adding label `in-progress` and a comment naming your agent role.
4. Work in a per-issue sandbox: `scripts/sandbox.sh open <ISSUE-ID>` (a git worktree under
   `.sandboxes/`). Parallel agents must never share one working tree.
5. Definition of done, every issue:
   - acceptance checkboxes in the issue all satisfied
   - `pnpm verify` green (typecheck, lint, tests, seam audit, identity audit)
   - evidence recorded in the issue comment: commands run, output, what you would verify manually
   - a PR opened against `main`, linked to the issue, with the reversibility of the change stated
6. Then `scripts/sandbox.sh inspect <ISSUE-ID>` before any teardown. Never delete a dirty sandbox.

## 8. What agents may not do

Mirror the Director capability table from the blueprint — it applies to you, in this repo:

- **No direct pushes to `main`, ever.** Push feature branches and open PRs. `main` changes only
  through a merged PR, and that is enforced server-side by branch protection requiring the `verify`
  check — not by convention.
- **Merging is allowed only through the landing gate.** `pr-landing-agent` is the sole agent that
  may merge, and only when every condition in `.claude/agents/pr-landing-agent.md` holds: CI
  `verify` and `guardrails` green on the exact head SHA, a `claude-review: pass` marker carrying
  that same head SHA from the CI reviewer (`.github/workflows/claude-review.yml`, which runs as the
  Claude GitHub App — a **different identity** from the PR author, which is what makes it evidence),
  `security-reviewer` approved for apply/approval/credential/auth/budget changes, change set within
  budget or under a recorded owner waiver, every acceptance box tied to actual code, and no
  owner-only file touched (`.github/workflows/**`, `.claude/settings.json`,
  `scripts/audit-*.sh`). Otherwise it requests
  changes. No other agent merges anything.
- **Unattended merge is allowed. Two paths are never delegated.** The gate may merge while the
  owner is away, but never a PR touching **`.github/workflows/**`, `.claude/settings.json` or
  `scripts/audit-*.sh`** — CI, the agent permission file, and the scripts that enforce invariants
  8, 9 and 10. An agent must not weaken the build, widen its own capability, or loosen the checks
  that constrain it, and then merge that with nobody awake — however good the review was. A
  workflow change additionally cannot be reviewed at all, because `claude-code-action` skips itself
  on one. Those need `owner-approved`.
  **`CLAUDE.md` alone is delegated**: it is instructions to agents, not a check that runs, so
  changing it weakens no audit and breaks no build. It merges on a `claude-review: pass` marker for
  the exact head SHA, never on the `review-passed` label, which carries no commit identity and
  would survive a push that changed the code it judged.
  Never merge a PR labelled `needs-owner`, `blocked-gate` or `changes-requested`, and stop the run
  entirely when one defect shape appears three times across different issues. A local
  `fresh-reviewer` marker is an author-side pre-check, never sufficient alone — it runs as the same
  account that wrote the PR. The merge step remains discipline, not
  enforcement: ADR-0003 and ADR-0005 say so plainly rather than implying a boundary that is not
  there.
- **Never edit the guardrails to get green.** `scripts/audit-seams.sh`,
  `scripts/audit-identity.sh`, `.claude/settings.json` and `.github/workflows/**` are denied to
  agents. Weakening an audit, a CI workflow or the permission file is not a shortcut to a passing
  build — it is the failure the build exists to catch. Escalate instead.
- No `git push --force`, no history rewrite, no branch/tag deletion, no `rm -rf` outside
  `.sandboxes/` and `state/debug/`.
- No secrets in files, env or logs. No credential enrolment, no passkey registration, no real
  hostname/DNS registration, no third-party account creation.
- No `npm publish`, no deployment, no outbound writes to any external system.
- No new runtime dependency without an ADR line in the issue explaining why nothing in the stack
  covers it.
- No editing another agent's open sandbox, and no editing `docs/blueprint/*` (it is the input).
- Do not weaken a failing audit to pass. Fix the code or escalate on the issue.

If a task requires something on this list, stop, comment on the issue with label `needs-owner`,
and move to the next ready issue. Parking work is correct behaviour, not failure.

## 9. Phase discipline

Phases are evidence gates, not dates. Current position: **Phase 0** (spine + code adapter), with
three Phase -1 items still open externally (naming clearance, canonical-origin proof, real cost
ceilings) — see `docs/gates/phase-minus-1.md`. Anything gated on those is labelled `blocked-gate`
and must not be started.

Phase 1 ends in a **mandatory two-week stop-and-use period**. Do not open Phase 2 work.

## 10. Style

- Small, reviewable change sets. Code change budget: 250 lines per task unless the issue says
  otherwise. If a task exceeds it, split the issue instead of exceeding the budget.
- Types before implementation. `packages/protocol` unions are closed and versioned; adding a shape
  bumps `PROTOCOL_VERSION` and requires a renderer case.
- Tests are contract tests where a seam exists, unit tests otherwise. No mock that asserts an
  implementation detail of a seam.
- Comments explain why, not what. Reference the blueprint section for any non-obvious rule.
- Contract tests live in `tests/contract/` and are named `*.contract.test.ts`. Gate condition 0.4
  selects that directory; a contract test anywhere else is invisible to the gate, which is the
  point (no adapter-private contract test). `vitest.config.ts` sets no global `retry`.
- Commit messages: `<area>: <imperative summary>` + `Refs #<issue>`.
