/**
 * The append-only event log — blueprint §15.2, §14.2, persistence SKILL.
 *
 * PR 2 of P0-05; v1 (PR 1) owns the table. This owns the two operations that make it a log rather
 * than a table: allocating the sequence, and reading a contiguous range back.
 *
 * **Nothing here can store an ephemeral message** (invariant 2), and that is enforced by the type
 * rather than by care: `type` is `DurableEventType`, the closed union from `@internal/protocol`.
 * `'process.output'` or `'pty.binary'` will not compile. The ephemeral channels live in a subpath
 * this package does not import, so they cannot even be named here.
 */
import type { DurableEventType } from '@internal/protocol';
import type { Db } from './db.js';

/** What the caller supplies. `seq` is not among the fields: the log allocates it. */
export type AppendableEvent = {
  readonly owner_id: string;
  readonly org_node_id: string;
  readonly ts: string;
  readonly type: DurableEventType;
  readonly project_id?: string | null;
  readonly task_id?: string | null;
  readonly attempt_id?: string | null;
  readonly actor_member_id: string;
  readonly actor_role_id?: string | null;
  readonly actor_runtime_id?: string | null;
  readonly payload: unknown;
  readonly artifact_refs?: readonly string[];
};

/**
 * What comes back. **`type` is deliberately wider than on the way in.**
 *
 * The write path is constrained to `DurableEventType`, so this package cannot append an ephemeral
 * name. The read path cannot make the same promise: v1 has no CHECK on `event.type`, so a row is
 * whatever is in the file — written by an older build, a newer one, or `sqlite3` by hand. Narrowing
 * it here with a cast would be asserting a constraint the database does not hold. A caller that
 * needs the union should narrow with `isDurableEvent` from `@internal/protocol`.
 */
export type StoredEvent = Omit<AppendableEvent, 'payload' | 'artifact_refs' | 'type'> & {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly artifact_refs: readonly string[];
};

const INSERT = `INSERT INTO event
  (owner_id, seq, org_node_id, ts, type, project_id, task_id, attempt_id,
   actor_member_id, actor_role_id, actor_runtime_id, payload, artifact_refs)
  VALUES (@owner_id, @seq, @org_node_id, @ts, @type, @project_id, @task_id, @attempt_id,
          @actor_member_id, @actor_role_id, @actor_runtime_id, @payload, @artifact_refs)`;

const NEXT_SEQ = `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM event WHERE owner_id = ?`;

/**
 * Append one event and return the sequence it was given.
 *
 * **The read of `MAX(seq)` and the insert are one immediate transaction.** `.immediate()` matters:
 * `db.transaction(fn)` issues a deferred `BEGIN`, which takes no write lock until the first write —
 * so two processes could both complete the `MAX(seq)` read before either upgraded, and the loser
 * would fail on the primary key instead of serialising behind the winner. `BEGIN IMMEDIATE` takes
 * the write lock before the read, so the second writer waits (up to `busy_timeout`) and then reads
 * a maximum that already includes the first.
 *
 * Per owner, never global (§14.2, and the v1 schema's `PRIMARY KEY (owner_id, seq)`).
 */
export const appendEvent = (db: Db, event: AppendableEvent): number =>
  db
    .transaction((e: AppendableEvent): number => {
      const { next } = db.prepare(NEXT_SEQ).get(e.owner_id) as { next: number };
      db.prepare(INSERT).run({
        owner_id: e.owner_id,
        seq: next,
        org_node_id: e.org_node_id,
        ts: e.ts,
        type: e.type,
        project_id: e.project_id ?? null,
        task_id: e.task_id ?? null,
        attempt_id: e.attempt_id ?? null,
        actor_member_id: e.actor_member_id,
        actor_role_id: e.actor_role_id ?? null,
        actor_runtime_id: e.actor_runtime_id ?? null,
        payload: JSON.stringify(e.payload),
        artifact_refs: JSON.stringify(e.artifact_refs ?? []),
      });
      return next;
    })
    .immediate(event);

type Row = {
  owner_id: string;
  seq: number;
  org_node_id: string;
  ts: string;
  type: string;
  project_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  actor_member_id: string;
  actor_role_id: string | null;
  actor_runtime_id: string | null;
  payload: string;
  artifact_refs: string;
};

const hydrate = (r: Row): StoredEvent => ({
  ...r,
  payload: JSON.parse(r.payload) as unknown,
  artifact_refs: JSON.parse(r.artifact_refs) as readonly string[],
});

/** The sequence a snapshot is taken at. Clients resume from here (§15.2). */
export const latestSeq = (db: Db, ownerId: string): number =>
  (
    db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM event WHERE owner_id = ?`).get(ownerId) as {
      s: number;
    }
  ).s;

/**
 * Events after `afterSeq`, in order, up to `limit`.
 *
 * **Returns a contiguous run or nothing.** §15.2: "If sequence recovery is incomplete, fetch a
 * fresh snapshot" — the server never interpolates missing history, so a caller resuming from a
 * sequence the log no longer starts at gets `null` and knows to re-snapshot, rather than a plausible
 * page that silently skips events. `null` is the "unknown must look unknown" answer (invariant 1).
 */
export const readSince = (
  db: Db,
  ownerId: string,
  afterSeq: number,
  limit = 500,
): readonly StoredEvent[] | null => {
  const rows = db
    .prepare(`SELECT * FROM event WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(ownerId, afterSeq, limit) as Row[];

  if (rows.length === 0) {
    // Nothing after that point is only honest if that point exists, or is the very start.
    return afterSeq === 0 || afterSeq <= latestSeq(db, ownerId) ? [] : null;
  }
  // Every row must follow its predecessor, not just the first. Checking only the head catches a
  // truncated start and misses a hole in the middle -- which cannot happen while nothing deletes,
  // but "cannot happen today" is not "cannot be returned", and this is the one function a caller
  // trusts to say the history is whole.
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.seq !== afterSeq + 1 + i) return null;
  }
  return rows.map(hydrate);
};
