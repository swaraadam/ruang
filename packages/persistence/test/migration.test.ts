import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LATEST_VERSION,
  currentVersion,
  migrate,
  openDatabase,
  openMemoryDatabase,
  schemaFingerprint,
} from '../src/index.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'persist-'));
  dirs.push(d);
  return join(d, 'control.db');
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Every table except the two that *are* the identity. Enumerated so the exception is a decision. */
const IDENTITY_EXEMPT = ['owner', 'org_node'];

describe('migration v1 is locked', () => {
  /**
   * Migrations are forward-only. Editing v1 changes the schema of every database already created
   * from it and SQLite would never tell you — the file keeps `user_version = 1` either way.
   *
   * This pins the schema SQLite itself reports, not the migration text: a migration edited to
   * produce the *same* schema is harmless, and one edited to produce a different schema is the
   * failure worth catching. If this fails, the fix is a new migration file, never an edit to v1.
   */
  it('produces exactly this schema, and any edit to v1 fails here', () => {
    const db = openMemoryDatabase();
    // If this fails on CI but not locally, do NOT update the hash: better-sqlite3 bundles its own
    // SQLite, so both sides should normalise `sqlite_schema.sql` identically. A difference would
    // mean the two hosts disagree about the schema, which is worth stopping for.
    const hash = createHash('sha256').update(schemaFingerprint(db)).digest('hex');
    expect(hash).toBe('802d0eb1beb32dadba2400d61d08ae3e10b33ae61077ee2358e90afcad49dff6');
    db.close();
  });

  it('refuses a database from a newer build rather than guessing what it changed', () => {
    // Fail closed on an unknown schema, the same shape as invariant 4 on an unknown basis.
    const db = new Database(':memory:');
    db.pragma(`user_version = ${LATEST_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const path = tmp();
    const first = openDatabase(path);
    const before = schemaFingerprint(first);
    first.close();
    const second = openDatabase(path);
    expect(currentVersion(second)).toBe(LATEST_VERSION);
    expect(schemaFingerprint(second)).toBe(before);
    second.close();
  });
});

describe('the pragmas that are not defaults', () => {
  it('turns foreign keys on, which SQLite does not do per connection', () => {
    const db = openDatabase(tmp());
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('puts a real file in WAL mode', () => {
    const db = openDatabase(tmp());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });
});

describe('identity columns are mandatory from v1 (invariant 8, §14.2)', () => {
  const db = openMemoryDatabase();
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);

  it('covers every §14.1 entity plus the event log', () => {
    expect(tables.length).toBe(26);
    for (const t of ['owner', 'org_node', 'project', 'task', 'attempt', 'artifact', 'event']) {
      expect(tables).toContain(t);
    }
  });

  it('declares owner_id and org_node_id NOT NULL on every table that is not itself the identity', () => {
    const missing: string[] = [];
    for (const t of tables.filter((n) => !IDENTITY_EXEMPT.includes(n))) {
      const cols = db.pragma(`table_info(${t})`) as { name: string; notnull: number }[];
      for (const want of ['owner_id', 'org_node_id']) {
        const col = cols.find((c) => c.name === want);
        if (!col || col.notnull !== 1) missing.push(`${t}.${want}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('rejects an insert that omits them, rather than defaulting', () => {
    // The constraint, exercised — a NOT NULL that something silently defaults is not a constraint.
    db.prepare(`INSERT INTO owner (id, display, created_at) VALUES ('o1','O','t')`).run();
    db.prepare(`INSERT INTO org_node (id, owner_id, name) VALUES ('n1','o1','root')`).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO project (id, domain, adapter_binding, source_of_record, change_unit,
             change_budget, evidence_floor) VALUES ('p1','code','b','s','lines',250,'strong')`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed: project.owner_id/);
  });

  it('enforces the references it declares, because foreign keys are on', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO project (id, owner_id, org_node_id, domain, adapter_binding,
             source_of_record, change_unit, change_budget, evidence_floor)
           VALUES ('p2','ghost','n1','code','b','s','lines',250,'strong')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('the states the blueprint names are all representable', () => {
  /**
   * Both of these were wrong in the first version of v1 and caught in review. They are pinned
   * because v1 cannot be edited afterwards: a missing state here is not a bug to fix later, it is
   * a state that can never be stored without a v2.
   */
  it('keeps all five §15.3 steer delivery states, including attempted', () => {
    // §15.3: requested -> attempted -> acknowledged | failed | unresolved. `attempted` emits no
    // durable event (Appendix A.1 has four steer events), so the schema is its only home.
    const db = openMemoryDatabase();
    const sql = (
      db.prepare(`SELECT sql FROM sqlite_schema WHERE name='steer'`).get() as { sql: string }
    ).sql;
    for (const state of ['requested', 'attempted', 'acknowledged', 'failed', 'unresolved']) {
      expect(sql).toContain(`'${state}'`);
    }
    db.close();
  });

  it('lets one logical role hold several versions (§14.1 "versioned")', () => {
    const db = openMemoryDatabase();
    db.prepare(`INSERT INTO owner (id, display, created_at) VALUES ('o','O','t')`).run();
    db.prepare(`INSERT INTO org_node (id, owner_id, name) VALUES ('n','o','root')`).run();
    const ins = db.prepare(
      `INSERT INTO role (id, owner_id, org_node_id, name, version, charter, capabilities)
       VALUES (?,'o','n','reviewer',?,'c','[]')`,
    );
    ins.run('r1', 1);
    ins.run('r2', 2);
    expect(db.prepare(`SELECT count(*) c FROM role WHERE name='reviewer'`).get()).toEqual({ c: 2 });
    // ...and the same version twice is still refused.
    expect(() => ins.run('r3', 2)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});

describe('the schema refuses what must stay ephemeral (invariant 2)', () => {
  /**
   * §14.3: PTY bytes, token deltas and progress ticks never reach the database. There is no table
   * for them, and the check that matters is that nobody added one — a `pty`, `stream` or `tick`
   * table is how this invariant would be lost, one convenient column at a time.
   */
  it('has no table or column for a stream, a tick or a token delta', () => {
    const db = openMemoryDatabase();
    const rows = db
      .prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    const forbidden = /(pty|stdout|stderr|stream|tick|token_delta|keystroke|progress)/i;
    const offenders: string[] = [];
    for (const { name } of rows) {
      if (forbidden.test(name)) offenders.push(name);
      const cols = db.pragma(`table_info(${name})`) as { name: string }[];
      offenders.push(...cols.filter((c) => forbidden.test(c.name)).map((c) => `${name}.${c.name}`));
    }
    expect(offenders).toEqual([]);
    db.close();
  });

  it('stores large output by reference and hash, never inline', () => {
    const db = openMemoryDatabase();
    const cols = (db.pragma('table_info(artifact)') as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('sha256');
    expect(cols).toContain('path_ref');
    expect(cols).toContain('retention_class');
    expect(cols).not.toContain('body');
    expect(cols).not.toContain('content');
    db.close();
  });
});

describe('the event sequence is per owner, not global', () => {
  /**
   * §15.2 and the persistence SKILL: "monotonic seq per owner". With one owner that is
   * indistinguishable from global, which is exactly why `AUTOINCREMENT` is tempting — and why it is
   * wrong: it would need a migration the day a second owner exists, and §14.2 exists to avoid
   * precisely that migration.
   */
  it('keys the event log on (owner_id, seq), and uses no AUTOINCREMENT anywhere', () => {
    const db = openMemoryDatabase();
    const sql = (
      db.prepare(`SELECT sql FROM sqlite_schema WHERE name='event'`).get() as { sql: string }
    ).sql;
    expect(sql).toContain('PRIMARY KEY (owner_id, seq)');
    expect(schemaFingerprint(db)).not.toMatch(/AUTOINCREMENT/i);
    db.close();
  });

  it('lets two owners hold the same seq, which a global counter could not', () => {
    const db = openMemoryDatabase();
    for (const o of ['o1', 'o2']) {
      db.prepare(`INSERT INTO owner (id, display, created_at) VALUES (?,?,'t')`).run(o, o);
      db.prepare(`INSERT INTO org_node (id, owner_id, name) VALUES (?,?,'root')`).run(`n-${o}`, o);
      db.prepare(
        `INSERT INTO event (owner_id, seq, org_node_id, ts, type, actor_member_id, payload)
         VALUES (?,1,?, 't','task.created','m','{}')`,
      ).run(o, `n-${o}`);
    }
    expect(db.prepare(`SELECT count(*) c FROM event WHERE seq=1`).get()).toEqual({ c: 2 });
    db.close();
  });
});
