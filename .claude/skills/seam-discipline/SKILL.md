---
name: seam-discipline
description: How to keep the four seams (domain, host, owner/org, provider) clean in this repo — what vocabulary may appear where, how to run and read the seam audits, and how to add a capability without leaking substrate assumptions. Use this whenever writing or reviewing code in packages/, adapters/ or the DB schema, whenever an audit fails, and whenever tempted to "just check if it's git" in the core.
---

# Seam discipline

Portability here is not a feature. It is the absence of a specific failure: freezing a contract
on code, then discovering at adapter three that it was git-shaped all along.

## The test

Not "does this support future X?" but: **when X becomes real, do we add a module plus config, or
edit thirty files?** If the answer is thirty files, you are at a seam and it needs a type boundary.

## The four seams

| Seam | Question | Lives in | Concrete today |
|---|---|---|---|
| A Domain | what work *is* | `adapters/domain/*` | code (git); assets (Unity) at Phase 4 |
| B Host | where work *runs* | `adapters/host/darwin` + test double | macOS / Mac Mini |
| C Owner & org | who *may* do what | `config/roles`, `config/org`, `packages/policy` | one human owner, as data |
| D Provider | which runtime *executes* | `adapters/provider/*` | Codex, Claude — substitution only |

Seam D is deliberately **not** generalized. Two real integrations first, then extract.

## Vocabulary rules (mechanically enforced)

Forbidden in `packages/domain`, `packages/protocol`, and the SQL schema:
`git, commit, branch, merge, worktree, diff, hunk`.
Allowed in `adapters/domain/code`, where they are accurate.

Forbidden anywhere except `adapters/host/darwin`:
`launchd, LaunchAgent, pmset, tmux, TCC, FileVault, ~/Library`.

Forbidden everywhere: `isMe`, `isOwner` as authorization branches.

Run: `./scripts/audit-seams.sh` and `./scripts/audit-identity.sh` (both inside `pnpm verify`,
and the seam audit also runs as a post-edit hook).

## Reading a failure

The audit prints file, line and the offending token. Three legitimate fixes, in order of
preference:

1. **Rename the concept.** You meant `basis.ref`, not `commit`. Most failures are this.
2. **Move the code.** Substrate detail belongs behind the adapter, not in the spine.
3. **Extend the contract.** The core genuinely needs a capability it cannot express — add an SPI
   method or a protocol shape, in a versioned way, with an ADR line.

Never: add an audit exception, rename a variable to dodge the grep, or put the word in a comment
instead of the identifier while keeping the assumption.

## Adding capability without leaking

- Core asks the adapter a *question* (`is_basis_stale`), it does not perform an *operation*
  (`git status`).
- Core receives *data* (`SandboxInspection`, `RenderableChange`), not handles or command strings.
- Adapters receive policy-scoped inputs, never credential-broker handles.
- Host specifics arrive as `capabilities()` data — e.g. `egress_enforcement: advisory` — so the
  policy layer reads a value instead of hard-coding a guarantee. A future Linux runner reporting
  `enforced` must require zero protocol change.
- Every new SPI method must be answerable by both a text domain and a binary-asset domain. Write
  the one-line asset answer in the PR description. If you cannot, the method is git-shaped.

## Cross-check when reviewing

- Would a Unity asset workflow implement this method honestly, or return a lie?
- Would a Linux host break this, and would the break be visible or silent?
- Does this row/event carry `owner_id` and `org_node_id`?
- Does authorization go through a capability lookup, with no special case for the one owner?
