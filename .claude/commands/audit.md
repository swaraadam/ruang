---
description: Run the seam, identity and vocabulary audits and explain any failure
allowed-tools: Bash, Read, Grep, Glob
---

1. `./scripts/audit-seams.sh` — git vocabulary in `packages/domain`, `packages/protocol` or the
   schema; macOS vocabulary outside `adapters/host/darwin`.
2. `./scripts/audit-identity.sh` — `isMe`/`isOwner` authorization branches; durable tables and
   event types missing `owner_id`/`org_node_id`.
3. `pnpm verify` if both pass.

For each failure, report: file:line, the offending token, and which of the three legitimate fixes
applies (rename the concept · move the code behind the adapter · extend the contract with an ADR) —
per `.claude/skills/seam-discipline/SKILL.md`. Never propose an audit exception or a grep-dodging
rename.
