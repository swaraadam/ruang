# Backup and restore

Blueprint §14.3 · persistence SKILL, last practical rule: *"Backups cover the DB **plus** referenced
artifacts **plus** configuration. A backup of only the DB is a broken backup."*

Three components. Skipping any one produces a restore that looks complete and is not — which is the
same failure shape as a garbage collector that deletes what it did not recognise, arriving from the
other side. The component list is code (`packages/persistence/src/backup.ts`, `BACKUP_SURFACE`) and
`backup.test.ts` fails if this document stops naming one of them, so a fourth durable location
cannot be added without the procedure being written.

## What a complete backup contains

### 1. `control-plane-database`

The SQLite file **and its `-wal` / `-shm` sidecars**, captured as one consistent copy.

The database runs in WAL mode, so committed transactions can live in the `-wal` file until a
checkpoint folds them in. Copying only the main file with `cp` while the gateway is running yields a
database that is internally valid and silently missing the most recent history — the worst possible
outcome, because nothing about it looks wrong.

Take the copy through SQLite itself, which reads a consistent snapshot without stopping the writer:

```sh
sqlite3 "$DB_PATH" ".backup '$DEST/control-plane.sqlite'"
# or, equivalently for this purpose:
sqlite3 "$DB_PATH" "VACUUM INTO '$DEST/control-plane.sqlite'"
```

This restores every durable row and the whole event log — which is the only authority on
`owner_id` / `org_node_id`, on basis history, and on what happened while nobody was watching.

### 2. `artifact-files`

The file behind every row in `artifact`, addressed by `path_ref` and verified by `sha256`.

The rows are in component 1; the bytes they point at are not. Restore only the database and the
references dangle: check logs, rendered changes and milestone captures are gone, and review-ready
becomes unprovable for every task whose evidence was on disk.

The authoritative list of what to copy is the database, not a directory listing:

```sh
sqlite3 -noheader "$DB_PATH" "SELECT path_ref FROM artifact ORDER BY created_at"
```

Copy by that list rather than by walking the artifacts directory. A file on disk with no row is
either litter or the residue of a failed collection; a row with no file is a defect. The list keeps
the two distinguishable.

### 3. `configuration`

The versioned role, org and context-pack data under `config/` that authorization resolves against
(Seam C).

Capability lookups resolve against roles and org nodes held as **data**, so a restore without them
can replay the history but cannot authorize the work that history describes. This component is
small, changes rarely, and is the one most often assumed to be "in the repository somewhere" — which
is only true until an owner edits a role on the host.

## What is deliberately not backed up

- **PTY bytes, token deltas, progress ticks.** Ephemeral by construction (invariant 2). They are
  never durable state, so there is nothing to restore.
- **`state/debug/`.** Short-retention debug captures, referenced by hash. Rotating and disposable.
- **`transient` artifacts, if space is tight.** See the retention table below: they are the one class
  a restore can reasonably be missing.

## Retention classes and what a restore owes each

Garbage collection (`packages/persistence/src/gc.ts`) may remove an artifact between two backups.
That is expected, and the classes say what the loss means:

| Retention class | Lifetime | What a backup owes it |
|---|---|---|
| `transient` | hours–days (PTY, debug) | nothing; expected to be absent |
| `task-evidence` | 30 days, or until task archive | restore it: this is what "review-ready" was computed from |
| `milestone` | manual retain, never auto-deleted | restore it; nothing else will ever regenerate it |
| `build-cache` | size/age eviction | nothing; regenerable by re-running checks |

An artifact referenced by an unresolved `RepairCase`, `Approval` or `ReviewThread` is never collected
regardless of class, so a backup taken while any of those is open carries the evidence attached to it.

## Verifying a restore

A restore that has not been verified is a belief. Two checks, in order:

1. **The database is this system's.** Open it through `openControlPlaneDatabase`, which refuses a
   file that is not the control plane rather than stamping the schema onto it.
2. **Every artifact row has its bytes, and they are the right bytes.** For each `path_ref`, hash the
   restored file and compare with the row's `sha256`. A missing file or a mismatched digest is a
   partial restore, and it is better to know that than to serve an office view built on it.

```sh
sqlite3 -noheader -separator '  ' "$DB_PATH" "SELECT sha256, path_ref FROM artifact" |
  while read -r want path; do
    got=$(shasum -a 256 "$path" 2>/dev/null | cut -d' ' -f1)
    [ "$got" = "$want" ] || echo "MISMATCH $path (row $want, file ${got:-absent})"
  done
```

Report the mismatches. Do not repair them by rewriting the row: the row is the record of what the
artifact was, and editing it to match a damaged file destroys the only evidence that anything is
wrong.

## Restore order

1. `configuration` — so authorization can resolve before anything reads history.
2. `control-plane-database` — the rows and the event log.
3. `artifact-files` — the bytes the rows reference.
4. Verify, as above, before starting the gateway.
