/**
 * DEVELOPMENT SEED DATA — `pnpm seed`. Not a migration, and not production data.
 *
 * Writes **rows**, never DDL. It does not live in `packages/persistence/src/migrations/`, it is not
 * registered with `migrate()`, and nothing in `packages/*` imports it. Rows go into the ordinary
 * tables and events through `appendEvent`, so seeded history replays through `readSince` exactly
 * like history a real run produced. Nothing downstream needs an "is this seeded?" branch — which is
 * the point: a renderer that had to know would be rendering a fixture, not durable truth.
 *
 * PART 1 writes the machinery and the rows everything else hangs off: org, people, role, project,
 * and the one `project.registered` event. It seeds no tasks. The four `dev-task-*` fixtures — which
 * cover the whole `fresh | stale | unknown` basis union plus the state that freezes mutation — are
 * part 2, because a seed of happy paths would teach the office to render only happy paths and that
 * is the half worth reviewing on its own.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Db, appendEvent, latestSeq, openDatabase, readSince } from '@internal/persistence';
import { PAYLOAD_VALIDATORS } from '@internal/protocol';
import type { DurableEventType, PayloadOf } from '@internal/protocol';

import { PLACEHOLDER } from '../config/naming.js';

/**
 * Relative to the working directory, which `pnpm seed` sets to the repo root. Under `state/`,
 * gitignored, and named from `config/naming.ts` so clearance stays a one-file change (CLAUDE.md §1).
 */
/**
 * Overridable so the CLI's own refusal branch can be tested without writing to `state/`. The
 * acceptance line "re-running without --reset refuses" is about `main()`, and proving it at the
 * `occupiedTables` level only proves the predicate the branch happens to call.
 */
export const DEV_DB_PATH = process.env.SEED_DB_PATH ?? join('state', 'dev', PLACEHOLDER.dbFile);

const OWNER = 'dev-owner';
const ORG = 'dev-org-root';
const ROLE = 'dev-role-implementer';
const PROJECT = 'dev-project-01';
const HUMAN = 'dev-member-owner';
const AGENT = 'dev-member-agent';
const RUNTIME = 'dev-runtime-a';
const LOCK = 'bundle-build';
/** Fixed clock, so reseeding twice produces comparable databases rather than noise. */
const T0 = Date.parse('2026-09-13T09:00:00.000Z');

/** Every table the schema defines, so "non-empty" means non-empty and not "empty where I looked". */
const tableNames = (db: Db): readonly string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);

/** Tables holding rows, with counts. Empty means the database is safe to seed. */
export const occupiedTables = (db: Db): readonly { table: string; rows: number }[] =>
  tableNames(db)
    .map((table) => ({
      table,
      rows: (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
    }))
    .filter((t) => t.rows > 0);

/**
 * `--reset` clears rows; it never drops or recreates anything. Foreign keys stay ON (db.ts sets
 * them) and are deferred only to the end of this transaction, so order does not matter here but a
 * dangling reference still fails the whole thing at COMMIT rather than passing quietly.
 */
export const resetRows = (db: Db): void => {
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const t of tableNames(db)) db.prepare(`DELETE FROM "${t}"`).run();
  })();
};

export type SeedSummary = {
  readonly ownerId: string;
  readonly lastSeq: number;
};

type Row = Readonly<Record<string, string | number | null>>;
const writeSeedRows = (db: Db): SeedSummary => {
  let tick = 0;
  const at = (): string => new Date(T0 + tick++ * 60_000).toISOString();

  // Invariant 8 is enforced here rather than trusted to twenty call sites: identity is supplied by
  // the writer, not remembered by the author. Which columns exist is asked of the schema rather than
  // kept in a list here, so the exception v1.ts documents — `owner` and `org_node`, where the
  // primary key *is* that identity — needs no second copy that could drift from it.
  const insert = (table: string, row: Row): void => {
    const has = (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
    const full = {
      ...(has.includes('owner_id') ? { owner_id: OWNER } : {}),
      ...(has.includes('org_node_id') ? { org_node_id: ORG } : {}),
      ...row,
    };
    const names = Object.keys(full);
    // Table and column names are literals in this file, never input; values are always bound.
    const cols = names.join(', ');
    db.prepare(
      `INSERT INTO "${table}" (${cols}) VALUES (${names.map((c) => `@${c}`).join(', ')})`,
    ).run(full);
  };

  const ACTORS = {
    owner: { actor_member_id: HUMAN, actor_role_id: null, actor_runtime_id: null },
    agent: { actor_member_id: AGENT, actor_role_id: ROLE, actor_runtime_id: RUNTIME },
  } as const;

  /**
   * Events for one task (and optionally one attempt), so call sites carry the payload and not the
   * routing. Each append is checked against the validator `@internal/protocol` publishes for that
   * exact type: a seed that wrote a payload the gateway's own boundary validator would reject is a
   * seed that teaches the renderer to expect the wrong shape.
   */
  const on =
    (task: string | null, attempt: string | null = null) =>
    <T extends DurableEventType>(
      type: T,
      payload: PayloadOf<T>,
      who: keyof typeof ACTORS = 'agent',
    ) => {
      if (!PAYLOAD_VALIDATORS[type](payload)) {
        throw new Error(`seed built a payload that fails PAYLOAD_VALIDATORS['${type}']`);
      }
      const scope = { project_id: PROJECT, task_id: task, attempt_id: attempt };
      appendEvent(db, {
        owner_id: OWNER,
        org_node_id: ORG,
        ts: at(),
        type,
        ...scope,
        ...ACTORS[who],
        payload,
        artifact_refs: [],
      });
    };

  // --- org, people, project -------------------------------------------------------------------
  // monthly_ceiling_cents stays 0: real cost ceilings are an OPEN Phase -1 gate
  // (docs/gates/phase-minus-1.md). Inventing one here would be a number nobody decided.
  const display = 'Development owner (seed)';
  insert('owner', {
    id: OWNER,
    display,
    monthly_ceiling_cents: 0,
    credential_ref: null,
    created_at: at(),
  });
  insert('org_node', { id: ORG, parent_id: null, name: 'Root', policy_overrides: null });
  insert('role', {
    id: ROLE,
    name: 'implementer',
    version: 1,
    charter: 'Implements a scoped task inside a sandbox and produces evidence.',
    capabilities: JSON.stringify(['task.dispatch', 'sandbox.open', 'checks.run']),
    context_refs: null,
    output_contract: null,
    // A Role may tighten a Project's budget and never loosen it (§7.2): 120 <= the project's 250.
    limits: JSON.stringify({ change_budget: 120, change_unit: 'lines' }),
    delegation: null,
  });
  insert('member', { id: HUMAN, kind: 'human', role_ref: null, display });
  insert('member', {
    id: AGENT,
    kind: 'agent',
    role_ref: ROLE,
    display: 'Implementer agent (seed)',
  });

  const project = {
    domain: 'code',
    adapter_binding: 'code@v0',
    source_of_record: 'local:dev-seed/project-01',
    change_unit: 'lines',
    change_budget: 250,
    evidence_floor: 'strong',
  } as const;
  insert('project', { id: PROJECT, ...project, exclusive_locks: JSON.stringify([LOCK]) });
  on(null)('project.registered', { project_id: PROJECT, ...project }, 'owner');

  return { ownerId: OWNER, lastSeq: latestSeq(db, OWNER) };
};

/**
 * Write the development set — all of it or none of it. Takes an already-migrated `Db` so a test can
 * run it against an in-memory database without touching the filesystem.
 *
 * One transaction, because a half-written seed leaves a database that is neither empty nor
 * complete: the next run would refuse it as non-empty and the office would render a project whose
 * tasks stop mid-sentence. Partial truth is the state this repo refuses to have (invariant 3).
 */
export const seedDatabase = (db: Db): SeedSummary => db.transaction(writeSeedRows).immediate(db);

const BANNER = 'DEVELOPMENT SEED DATA — not a migration, not production data.';

const main = (): void => {
  const path = resolve(DEV_DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  console.log(`${BANNER}\ndatabase: ${path}`);

  const db = openDatabase(path);
  if (process.argv.slice(2).includes('--reset')) resetRows(db);

  const occupied = occupiedTables(db);
  if (occupied.length > 0) {
    // Fail closed. Upserting would merge two versions of "the truth" into one database, and there
    // is no honest way to render that. Refusing is the cheap, reversible answer.
    console.error('\nREFUSED: the database already holds rows and --reset was not passed.');
    for (const t of occupied) console.error(`  ${t.table.padEnd(16)} ${t.rows}`);
    console.error('\nRe-run as `pnpm seed --reset` to clear these rows and seed again.');
    console.error('The seed never upserts: merging seeded rows into existing ones is not truth.');
    db.close();
    process.exitCode = 2;
    return;
  }

  const summary = seedDatabase(db);
  console.log('\nrows written');
  for (const t of occupiedTables(db)) console.log(`  ${t.table.padEnd(16)} ${t.rows}`);

  const replay = readSince(db, summary.ownerId, 0, 1000);
  if (replay === null) {
    // `readSince` answers null rather than a partial page when history has a hole. Print that as
    // itself; an empty list here would be a claim the log is whole.
    console.error('\nhistory is not contiguous — refusing to claim the seeded log replays');
    db.close();
    process.exitCode = 3;
    return;
  }
  console.log(`\nevent log replayed from seq 0 (${replay.length} events)`);
  for (const e of replay) console.log(`  ${String(e.seq).padStart(3)}  ${e.type}`);

  console.log(`\nsnapshot sequence: ${summary.lastSeq}\n${BANNER}\n`);
  db.close();
};

// Only when run as a program. The test imports `seedDatabase` directly and must not touch state/.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
