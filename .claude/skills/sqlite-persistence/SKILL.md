---
name: sqlite-persistence
description: Persistence rules for this repo — SQLite+WAL as the single authoritative control plane, migrations from v1, mandatory owner_id/org_node_id, the entity set, artifact retention classes and GC guards. Use for any schema change, migration, query, artifact write, retention or garbage-collection work.
---

# Persistence

SQLite + WAL is the authoritative control-plane history. One host, one file, inspectable with
`sqlite3`. That is a feature.

## Migrations

- Start at version 1. Append-only, forward-only, one file per version, checked into git.
- Every migration has a test asserting the resulting schema constraints, not just that it ran.
- No destructive migration without an ADR and an owner decision.

## Mandatory identity columns

Every durable row and every durable event: `owner_id NOT NULL`, `org_node_id NOT NULL`, from v1.
Authorization queries the capability table even though there is exactly one human owner. This is a
cheap seam now and an expensive migration later.

## Entity set (blueprint §14.1)

`Owner · Member · Role · OrgNode · Project · Task · Attempt · Sandbox · ChangeSet · Artifact ·
CheckSpec · CheckResult · Evidence · Steer · ReviewThread · ReviewComment · Approval · Preview ·
Notification · RepairCase · Lock · BudgetReservation · BudgetLedger · HostRunner · ContextPack`

Notable required fields: `Attempt` carries `session_capture_method` and `session_last_verified_at`;
`Approval` carries `reversal_plan_ref`, `action_fingerprint`, `target_ref`, `apply_plan_hash`;
`Lock` carries `disposition` (`active | held-by-frozen-task`); `Steer` carries `delivery_state` and
`attempts`; `CheckResult` carries `exit_code` and `skipped_reason`.

## What never goes in the database

PTY bytes · token deltas · high-frequency progress ticks · raw provider debug streams.
Large outputs (screenshots, rendered changes, check logs) are files with sha256 + a reference row.

## Artifact retention classes

| Class | Lifetime |
|---|---|
| `transient` | hours–days (PTY, debug) |
| `task-evidence` | 30 days default, or until task archive |
| `milestone` | manual retain, never auto-deleted |
| `build-cache` | size/age LRU |

**GC guard:** never delete an artifact referenced by an unresolved `RepairCase`, `Approval`,
`ReviewThread`, or a retained milestone. Write that as a test, not a comment.

## Event log

Monotonic `seq` per owner. Snapshot endpoint returns the sequence it was taken at; clients resume
from there. If sequence recovery is incomplete, the client fetches a fresh snapshot — the server
never interpolates missing history.

## Practical rules

- `better-sqlite3`, synchronous, prepared statements, explicit transactions around multi-row
  invariants.
- Foreign keys ON. Check constraints for enum-ish columns — the schema is documentation.
- No ORM. Hand-written SQL in `packages/persistence`, typed at the boundary.
- Backups cover the DB *plus* referenced artifacts *plus* configuration. A backup of only the DB is
  a broken backup.
