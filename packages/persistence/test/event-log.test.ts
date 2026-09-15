import { describe, expect, it } from 'vitest';
import {
  type AppendableEvent,
  appendEvent,
  eventLogIsWhole,
  latestSeq,
  openMemoryDatabase,
  readSince,
} from '../src/index.js';

const seed = (owner = 'o1') => {
  const db = openMemoryDatabase();
  db.prepare(`INSERT INTO owner (id, display, created_at) VALUES (?,?, 't')`).run(owner, owner);
  db.prepare(`INSERT INTO org_node (id, owner_id, name) VALUES (?,?, 'root')`).run(
    `n-${owner}`,
    owner,
  );
  return db;
};

const ev = (owner = 'o1', over: Partial<AppendableEvent> = {}): AppendableEvent => ({
  owner_id: owner,
  org_node_id: `n-${owner}`,
  ts: '2026-01-01T00:00:00.000Z',
  type: 'task.created',
  actor_member_id: 'm1',
  payload: { task_id: 't1' },
  ...over,
});

describe('seq is monotonic, per owner', () => {
  it('allocates 1, 2, 3 for one owner', () => {
    const db = seed();
    expect([appendEvent(db, ev()), appendEvent(db, ev()), appendEvent(db, ev())]).toEqual([
      1, 2, 3,
    ]);
    db.close();
  });

  it('gives each owner its own sequence, both starting at 1', () => {
    // The whole reason seq is not AUTOINCREMENT: a global counter would make these 1 and 2.
    const db = seed('o1');
    db.prepare(`INSERT INTO owner (id, display, created_at) VALUES ('o2','o2','t')`).run();
    db.prepare(`INSERT INTO org_node (id, owner_id, name) VALUES ('n-o2','o2','root')`).run();
    expect(appendEvent(db, ev('o1'))).toBe(1);
    expect(appendEvent(db, ev('o2'))).toBe(1);
    expect(appendEvent(db, ev('o1'))).toBe(2);
    db.close();
  });

  it('DOES reuse a sequence if the newest event is deleted — so nothing may delete', () => {
    // MAX(seq)+1 is not a high-water mark. Deleting the newest event makes the next append reuse
    // its number, and a client resumed from that point would miss one silently. Nothing in this
    // package deletes, and this test is here so a future retention pass cannot acquire the
    // behaviour without first confronting it: trimming the event log needs a stored high-water
    // mark, not MAX(seq). Recorded as a known limit rather than described as a guarantee.
    const db = seed();
    appendEvent(db, ev());
    appendEvent(db, ev());
    appendEvent(db, ev());
    db.prepare(`DELETE FROM event WHERE owner_id='o1' AND seq=3`).run();
    expect(appendEvent(db, ev())).toBe(3);
    db.close();
  });

  it('keeps the allocation and the insert in one transaction', () => {
    // A failure inside the transaction must leave no row and consume no sequence.
    const db = seed();
    appendEvent(db, ev());
    expect(() => appendEvent(db, ev('o1', { org_node_id: 'ghost' }))).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(latestSeq(db, 'o1')).toBe(1);
    expect(appendEvent(db, ev())).toBe(2);
    db.close();
  });
});

describe('replay resumes from a sequence, or refuses (§15.2)', () => {
  it('returns everything after the given point, in order', () => {
    const db = seed();
    for (let i = 0; i < 5; i += 1) appendEvent(db, ev());
    const got = readSince(db, 'o1', 2);
    expect(got?.map((e) => e.seq)).toEqual([3, 4, 5]);
    db.close();
  });

  it('round-trips the payload and artifact refs through JSON', () => {
    const db = seed();
    appendEvent(db, ev('o1', { payload: { a: [1, 2], b: null }, artifact_refs: ['sha256:x'] }));
    const [got] = readSince(db, 'o1', 0) ?? [];
    expect(got?.payload).toEqual({ a: [1, 2], b: null });
    expect(got?.artifact_refs).toEqual(['sha256:x']);
    db.close();
  });

  it('reports the sequence a snapshot would be taken at', () => {
    const db = seed();
    expect(latestSeq(db, 'o1')).toBe(0);
    appendEvent(db, ev());
    appendEvent(db, ev());
    expect(latestSeq(db, 'o1')).toBe(2);
    db.close();
  });

  it('returns empty, not null, when the caller is simply up to date', () => {
    const db = seed();
    appendEvent(db, ev());
    expect(readSince(db, 'o1', 1)).toEqual([]);
    db.close();
  });

  /**
   * §15.2: "If sequence recovery is incomplete, fetch a fresh snapshot." The server never
   * interpolates missing history — a caller resuming from a point the log no longer starts at must
   * be told so, not handed a plausible page that skips events. Invariant 1: unknown looks unknown.
   */
  it('refuses with null when the resume point is behind what the log holds', () => {
    const db = seed();
    for (let i = 0; i < 4; i += 1) appendEvent(db, ev());
    db.prepare(`DELETE FROM event WHERE owner_id='o1' AND seq <= 2`).run();
    expect(readSince(db, 'o1', 0)).toBeNull();
    expect(readSince(db, 'o1', 1)).toBeNull();
    expect(readSince(db, 'o1', 2)?.map((e) => e.seq)).toEqual([3, 4]);
    db.close();
  });

  it('refuses a page with a hole in the middle, not just a truncated start', () => {
    // The head-only check would have returned [1,2,4] here and called it contiguous.
    const db = seed();
    for (let i = 0; i < 4; i += 1) appendEvent(db, ev());
    db.prepare(`DELETE FROM event WHERE owner_id='o1' AND seq=3`).run();
    expect(readSince(db, 'o1', 0)).toBeNull();
    db.close();
  });

  it('refuses with null when the resume point is ahead of the log', () => {
    const db = seed();
    appendEvent(db, ev());
    expect(readSince(db, 'o1', 9)).toBeNull();
    db.close();
  });

  it('pages without hiding a gap', () => {
    const db = seed();
    for (let i = 0; i < 6; i += 1) appendEvent(db, ev());
    expect(readSince(db, 'o1', 0, 2)?.map((e) => e.seq)).toEqual([1, 2]);
    expect(readSince(db, 'o1', 2, 2)?.map((e) => e.seq)).toEqual([3, 4]);
    db.close();
  });

  it('does not leak another owner’s events into a replay', () => {
    const db = seed('o1');
    db.prepare(`INSERT INTO owner (id, display, created_at) VALUES ('o2','o2','t')`).run();
    db.prepare(`INSERT INTO org_node (id, owner_id, name) VALUES ('n-o2','o2','root')`).run();
    appendEvent(db, ev('o1'));
    appendEvent(db, ev('o2'));
    expect(readSince(db, 'o1', 0)?.map((e) => e.owner_id)).toEqual(['o1']);
    db.close();
  });
});

/**
 * `eventLogIsWhole` asked `COUNT(*) = MAX(seq)` and nothing else. "Allocated from 1" is a property
 * of `appendEvent`, not of the file, and v1 carries no `CHECK (seq >= 1)` — so one row at `seq <= 0`
 * restores the equality across a hole and the predicate answered `true` about a holed log. Executed
 * before the fix: with seq 5 deleted and a row at seq 0, `/api/office/state` answered 409 while
 * `?since=5` streamed seqs 6-20. The simple deleted-row case (below, and already covered) passes
 * either way, which is why it proved nothing here.
 */
describe('a log is whole only if it starts at 1 as well as having no interior hole', () => {
  const holed = (pad: number | null) => {
    const db = seed();
    for (let i = 0; i < 20; i += 1) appendEvent(db, ev());
    db.prepare(`DELETE FROM event WHERE owner_id='o1' AND seq=5`).run();
    if (pad !== null) {
      db.prepare(
        `INSERT INTO event (owner_id,seq,org_node_id,ts,type,actor_member_id,payload,artifact_refs)
         VALUES ('o1',?, 'n-o1','t','task.created','m1','{}','[]')`,
      ).run(pad);
    }
    return db;
  };

  it('calls a clean log whole, and an empty one too', () => {
    const clean = seed();
    for (let i = 0; i < 20; i += 1) appendEvent(clean, ev());
    expect(eventLogIsWhole(clean, 'o1')).toBe(true);
    clean.close();
    const empty = seed();
    expect(eventLogIsWhole(empty, 'o1')).toBe(true);
    empty.close();
  });

  it.each([
    ['no padding row', null],
    ['a padding row at seq 0', 0],
    ['a padding row at seq -1', -1],
  ])('refuses a log with a hole at seq 5 and %s', (_label, pad) => {
    const db = holed(pad);
    // The count is restored by the padding row; the minimum is what the hole cannot fake.
    expect(eventLogIsWhole(db, 'o1')).toBe(false);
    db.close();
  });
});

describe('the identity columns hold on the append path too', () => {
  it('refuses an event whose owner does not exist', () => {
    const db = seed();
    expect(() => appendEvent(db, ev('ghost'))).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });
});
