import { type StoredEvent, openMemoryDatabase, readSince } from '@internal/persistence';
import { isDurableEvent } from '@internal/protocol';
import { describe, expect, it } from 'vitest';

import { occupiedTables, resetRows, seedDatabase } from '../scripts/seed.js';

// D-01 acceptance, proved mechanically rather than by reading the script. In-memory on purpose:
// the seed writes ordinary rows through the ordinary append path, so it needs no file to show
// that, and the test must never touch the dev database under state/.
const seeded = () => {
  const db = openMemoryDatabase();
  return { db, summary: seedDatabase(db) };
};

// `event.project_id/task_id/attempt_id` are nullable columns, while Appendix A.3 and
// `EventEnvelope` make those fields optional and NOT nullable — `isDurableEvent` rejects an
// explicit null. A gateway that spread a StoredEvent straight onto the wire would emit envelopes
// its own validator refuses, so the omission below is the contract, written where it can be seen.
const toEnvelope = (e: StoredEvent): unknown => ({
  seq: e.seq,
  ts: e.ts,
  type: e.type,
  owner_id: e.owner_id,
  org_node_id: e.org_node_id,
  ...(typeof e.project_id === 'string' ? { project_id: e.project_id } : {}),
  ...(typeof e.task_id === 'string' ? { task_id: e.task_id } : {}),
  ...(typeof e.attempt_id === 'string' ? { attempt_id: e.attempt_id } : {}),
  actor: {
    member_id: e.actor_member_id,
    role_id: e.actor_role_id ?? null,
    runtime_id: e.actor_runtime_id ?? null,
  },
  payload: e.payload,
  artifact_refs: e.artifact_refs,
});

describe('development seed data', () => {
  it('replays contiguously from seq 0, and every event passes isDurableEvent', () => {
    const { db, summary } = seeded();
    const replay = readSince(db, summary.ownerId, 0, 1000);
    expect(replay).not.toBeNull();
    expect(replay?.map((e) => e.seq)).toEqual(replay?.map((_, i) => i + 1));
    expect(summary.lastSeq).toBe(replay?.length);
    expect((replay ?? []).filter((e) => !isDurableEvent(toEnvelope(e))).map((e) => e.type)).toEqual(
      [],
    );
  });

  // Invariant 1. The unknown task is unknown in durable truth, not labelled unknown in a view:
  // `task.stale` carries `staleness: 'unknown'` and, because unknown fails closed, no dispatch and
  // no attempt follow it.
  it('seeds a task whose basis staleness is genuinely unknown and which was never dispatched', () => {
    const { db, summary } = seeded();
    const replay = readSince(db, summary.ownerId, 0, 1000) ?? [];
    const unknown = replay.filter(
      (e) =>
        e.type === 'task.stale' && (e.payload as { staleness: string }).staleness === 'unknown',
    );
    expect(unknown.map((e) => e.task_id)).toEqual(['dev-task-03']);
    expect(
      replay.filter((e) => e.type === 'task.dispatched' && e.task_id === 'dev-task-03'),
    ).toEqual([]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM attempt WHERE task_id = ?`).get('dev-task-03'),
    ).toEqual({ n: 0 });
    // The basis ref is known; it is its *staleness* that is not. Nulling it would be a different
    // lie — "no basis was ever captured".
    expect(db.prepare(`SELECT state, basis_ref FROM task WHERE id = ?`).get('dev-task-03')).toEqual(
      {
        state: 'blocked_basis_unknown',
        basis_ref: 'basis-0003',
      },
    );
  });

  // Invariant 8: not "the rows I remembered to check", every row of every table that was written.
  it('writes owner_id and org_node_id on every seeded row, with only the v1 exception', () => {
    const { db } = seeded();
    const lacking: Record<string, string[]> = { owner_id: [], org_node_id: [] };
    for (const { table } of occupiedTables(db)) {
      const cols = (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
      for (const col of ['owner_id', 'org_node_id']) {
        if (!cols.includes(col)) {
          lacking[col]?.push(table);
          continue;
        }
        const bad = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${col}" IS NULL`).get();
        expect({ table, col, bad }).toEqual({ table, col, bad: { n: 0 } });
      }
    }
    // The only tables without the columns are the ones whose primary key *is* that identity —
    // exactly the exception the v1.ts header enumerates, and nothing else.
    expect(lacking).toEqual({ owner_id: ['owner'], org_node_id: ['owner', 'org_node'] });
  });

  it('leaves rows behind that a second seed must refuse, and --reset clears them', () => {
    const { db } = seeded();
    // This is what the CLI branches on: occupied means refuse, never upsert.
    expect(occupiedTables(db).length).toBeGreaterThan(0);
    resetRows(db);
    expect(occupiedTables(db)).toEqual([]);
    expect(() => seedDatabase(db)).not.toThrow();
  });
});
