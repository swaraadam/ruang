/**
 * The office state, reconstructed from durable truth only (§15.1, §15.2).
 *
 * Every field here comes from a row or a durable event. Nothing is derived from a live process, a
 * PTY, a token counter or a progress tick — invariant 2 keeps those out of the database entirely, and
 * this module is where that pays: there is no ephemeral source available to leak into a view even by
 * accident.
 *
 * The rule that shapes the types: UNKNOWN MUST LOOK UNKNOWN (invariant 1). A task whose basis was
 * assessed and found indeterminate is not the same as a task whose basis was never assessed, and
 * neither is `fresh`. Both are representable, and `fresh` is never a default.
 */
import type { Db, StoredEvent } from '@internal/persistence';
import { latestSeq, readSince } from '@internal/persistence';

/** Never `fresh` by omission: `null` means no assessment is on the record at all. */
export type BasisStaleness = 'fresh' | 'stale' | 'unknown' | null;

export type TaskView = {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly state: string;
  readonly execution_class: string;
  readonly expected_reversibility: string;
  /** The captured reference. Present even when staleness is `unknown` — see the note below. */
  readonly basis_ref: string | null;
  readonly basis_staleness: BasisStaleness;
  /** Why, when the system could name a reason. Absent is absent, not "no reason". */
  readonly basis_reason: string | null;
  readonly dispatched: boolean;
};

export type LockView = {
  /** The exclusive resource. v1 keys locks by (owner, name), so the name IS the identity. */
  readonly name: string;
  readonly disposition: string;
  readonly holder_task_id: string | null;
  readonly acquired_at: string;
};

export type RepairView = {
  readonly id: string;
  readonly task_id: string | null;
  /** Null while open. Only an owner writes it, so null here is "still frozen", never "fine now". */
  readonly resolution: string | null;
  readonly opened_at: string;
};

export type ProjectView = {
  readonly id: string;
  readonly domain: string;
  readonly change_unit: string;
  readonly change_budget: number;
  readonly evidence_floor: string;
};

export type OfficeSnapshot = {
  /** The sequence this snapshot is true as of. A client resumes the stream from exactly here. */
  readonly seq: number;
  readonly owner_id: string;
  readonly projects: readonly ProjectView[];
  readonly tasks: readonly TaskView[];
  readonly locks: readonly LockView[];
  readonly repairs: readonly RepairView[];
};

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const all = (db: Db, sql: string, ...params: readonly string[]): readonly Row[] =>
  db.prepare(sql).all(...params) as Row[];

/**
 * The basis facts live in the event log, not in a column, so they are read from it.
 *
 * `task.stale` carries the staleness the adapter actually determined. Reading the LAST one per task
 * is the reconstruction: an earlier assessment is history, not current truth. A task with no such
 * event has `null` — never assessed — which a renderer must not draw as fresh.
 */
const basisFromEvents = (
  events: readonly StoredEvent[],
): ReadonlyMap<string, { staleness: BasisStaleness; reason: string | null }> => {
  const byTask = new Map<string, { staleness: BasisStaleness; reason: string | null }>();
  for (const event of events) {
    if (event.type !== 'task.stale' || typeof event.task_id !== 'string') continue;
    const payload = event.payload as { staleness?: unknown; reason?: unknown };
    const staleness = payload.staleness;
    byTask.set(event.task_id, {
      staleness:
        staleness === 'fresh' || staleness === 'stale' || staleness === 'unknown'
          ? staleness
          : null,
      reason: strOrNull(payload.reason),
    });
  }
  return byTask;
};

const dispatchedTasks = (events: readonly StoredEvent[]): ReadonlySet<string> => {
  const dispatched = new Set<string>();
  for (const event of events) {
    if (event.type === 'task.dispatched' && typeof event.task_id === 'string') {
      dispatched.add(event.task_id);
    }
  }
  return dispatched;
};

/**
 * Read the whole office at one sequence.
 *
 * `seq` is taken FIRST and the history is read up to it, so the snapshot and the resume point
 * describe the same instant. Taking it afterwards would hand a client a sequence it had already been
 * shown events past, and the gap it then asked for would silently be empty.
 */
export const officeSnapshot = (db: Db, owner_id: string): OfficeSnapshot => {
  const seq = latestSeq(db, owner_id);
  // A hole in history is not a smaller history. `readSince` answers null rather than a partial page,
  // and a snapshot built on a partial replay would be a confident-looking lie.
  const history = readSince(db, owner_id, 0, seq);
  if (history === null) {
    throw new IncompleteHistoryError(
      `refusing to build a snapshot for '${owner_id}': the event log is not contiguous up to ${String(seq)}`,
    );
  }
  const basis = basisFromEvents(history);
  const dispatched = dispatchedTasks(history);

  return {
    seq,
    owner_id,
    projects: all(
      db,
      `SELECT id, domain, change_unit, change_budget, evidence_floor FROM project
        WHERE owner_id = ? ORDER BY id`,
      owner_id,
    ).map((r) => ({
      id: str(r['id']),
      domain: str(r['domain']),
      change_unit: str(r['change_unit']),
      change_budget: num(r['change_budget']),
      evidence_floor: str(r['evidence_floor']),
    })),
    tasks: all(
      db,
      `SELECT id, project_id, title, state, execution_class, expected_reversibility, basis_ref
         FROM task WHERE owner_id = ? ORDER BY id`,
      owner_id,
    ).map((r) => {
      const id = str(r['id']);
      const assessed = basis.get(id);
      return {
        id,
        project_id: str(r['project_id']),
        title: str(r['title']),
        state: str(r['state']),
        execution_class: str(r['execution_class']),
        expected_reversibility: str(r['expected_reversibility']),
        // Kept even when staleness is `unknown`. Nulling it would assert a different and equally
        // false thing: that no basis was ever captured.
        basis_ref: strOrNull(r['basis_ref']),
        basis_staleness: assessed?.staleness ?? null,
        basis_reason: assessed?.reason ?? null,
        dispatched: dispatched.has(id),
      };
    }),
    locks: all(
      db,
      `SELECT name, disposition, holder_task_id, acquired_at FROM lock
        WHERE owner_id = ? ORDER BY name`,
      owner_id,
    ).map((r) => ({
      name: str(r['name']),
      disposition: str(r['disposition']),
      holder_task_id: strOrNull(r['holder_task_id']),
      acquired_at: str(r['acquired_at']),
    })),
    repairs: all(
      db,
      `SELECT id, task_id, resolution, opened_at FROM repair_case WHERE owner_id = ? ORDER BY id`,
      owner_id,
    ).map((r) => ({
      id: str(r['id']),
      task_id: strOrNull(r['task_id']),
      resolution: strOrNull(r['resolution']),
      opened_at: str(r['opened_at']),
    })),
  };
};

export class IncompleteHistoryError extends Error {}
