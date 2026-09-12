/**
 * DEVELOPMENT SEED DATA — `pnpm seed`. Not a migration, and not production data.
 *
 * Writes **rows**, never DDL. It does not live in `packages/persistence/src/migrations/`, it is not
 * registered with `migrate()`, and nothing in `packages/*` imports it. Rows go into the ordinary
 * tables and events through `appendEvent`, so seeded history replays through `readSince` exactly
 * like history a real run produced. Nothing downstream needs an "is this seeded?" branch — which is
 * the point: a renderer that had to know would be rendering a fixture, not durable truth.
 *
 * The four tasks cover the whole `fresh | stale | unknown` basis union plus the state that freezes
 * mutation, because a seed of happy paths teaches the office to render only happy paths: `unknown`
 * basis and therefore never dispatched (invariants 1 and 4); `stale` basis, also not dispatched but
 * for a reason the system can name; and `needs-repair` holding a lock whose disposition is
 * `held-by-frozen-task` (invariant 3).
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
export const DEV_DB_PATH = join('state', 'dev', PLACEHOLDER.dbFile);

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
  readonly tasks: readonly { id: string; state: string; basis: string }[];
};

type Row = Readonly<Record<string, string | number | null>>;
type Capture = 'reported' | 'probed' | 'unknown';
type TaskSeed = {
  id: string;
  title: string;
  execution_class: 'mechanical' | 'standard' | 'deep';
  expected_reversibility: 'revertible' | 'compensable' | 'irreversible';
  state: string;
  basis_ref: string;
  inputs: readonly { resource_id: string; version: string }[];
};

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

  // --- tasks ----------------------------------------------------------------------------------
  // v1 puts no CHECK on task.state, so these strings are the vocabulary the canon uses verbatim:
  // `needs-repair` (CLAUDE.md invariant 3) and `blocked_basis_unknown` (fail-closed SKILL).
  const declare = (t: TaskSeed): void => {
    const { id, title, execution_class, expected_reversibility, basis_ref, inputs } = t;
    insert('task', {
      id,
      project_id: PROJECT,
      role_id: ROLE,
      title,
      basis_ref,
      basis_inputs: JSON.stringify(inputs),
      execution_class,
      expected_reversibility,
      acceptance_criteria: JSON.stringify([`${title} is demonstrable from durable state`]),
      state: t.state,
      created_at: at(),
    });
    const e = on(id);
    const created = { task_id: id, project_id: PROJECT, role_id: ROLE, title };
    e('task.created', { ...created, execution_class, expected_reversibility }, 'owner');
    e('task.basis.captured', { task_id: id, basis_ref, inputs, captured_at: at() });
  };

  const dispatch = (
    task: string,
    attempt: string,
    basis_ref: string,
    o: { sandbox?: string; session?: string; capture: Capture; lifecycle: string },
  ): void => {
    const sandbox_id = o.sandbox ?? null;
    const e = on(task, attempt);
    e(
      'task.dispatched',
      { task_id: task, attempt_id: attempt, runtime_id: RUNTIME, basis_ref },
      'owner',
    );
    if (sandbox_id !== null) {
      const kind = 'isolated-copy';
      const opened = { sandbox_id, task_id: task, attempt_id: attempt, adapter_id: 'code', kind };
      insert('sandbox', {
        id: sandbox_id,
        project_id: PROJECT,
        adapter: 'code',
        kind,
        safety_record_ref: null,
        opened_at: at(),
      });
      e('sandbox.opened', opened);
    }
    insert('attempt', {
      id: attempt,
      task_id: task,
      sandbox_id,
      runtime_id: RUNTIME,
      session_id: o.session ?? null,
      session_capture_method: o.capture,
      // An unverifiable session says so. A timestamp here would assert a check that never happened.
      session_last_verified_at: o.capture === 'unknown' ? null : at(),
      lifecycle: o.lifecycle,
      started_at: at(),
    });
    e('attempt.started', { attempt_id: attempt, task_id: task, runtime_id: RUNTIME, sandbox_id });
  };

  // T1 — dispatched and running against a fresh basis.
  declare({
    id: 'dev-task-01',
    title: 'Add a liveness probe to the session watcher',
    execution_class: 'standard',
    expected_reversibility: 'revertible',
    state: 'running',
    basis_ref: 'basis-0001',
    inputs: [{ resource_id: 'resource/session-watcher', version: 'v-4c11' }],
  });
  dispatch('dev-task-01', 'dev-attempt-01', 'basis-0001', {
    sandbox: 'dev-sandbox-01',
    session: 'dev-session-01',
    capture: 'reported',
    lifecycle: 'running',
  });

  // T2 — a named stale reason. Stale refuses dispatch and asks for a re-brief; it does not guess.
  declare({
    id: 'dev-task-02',
    title: 'Reconcile the notification channel list',
    execution_class: 'deep',
    expected_reversibility: 'revertible',
    state: 'blocked_basis_stale',
    basis_ref: 'basis-0002',
    inputs: [{ resource_id: 'resource/notification-channels', version: 'v-77b2' }],
  });
  on('dev-task-02')('task.stale', {
    task_id: 'dev-task-02',
    basis_ref: 'basis-0002',
    staleness: 'stale',
    reason: 'resource/notification-channels moved from v-77b2 to v-91d0 after basis capture',
    stale_inputs: ['resource/notification-channels'],
  });

  // T3 — THE HONEST UNKNOWN (invariants 1 and 4).
  //
  // A basis was captured, so `basis_ref` is set: claiming none exists would be its own lie. What is
  // unknown is whether that basis still holds — one consulted resource could not be re-probed, so
  // the answer is neither `fresh` nor `stale`. `stale_inputs` is empty **not because nothing
  // changed** but because nothing is *known* to have changed; the field a renderer must read is
  // `staleness`. Fail closed: no `task.dispatched` follows and no attempt exists. Rendering this as
  // fresh, or hiding it because it has no attempt to draw, is the lie this task exists to catch.
  declare({
    id: 'dev-task-03',
    title: 'Retire the legacy preview route',
    execution_class: 'standard',
    expected_reversibility: 'revertible',
    state: 'blocked_basis_unknown',
    basis_ref: 'basis-0003',
    inputs: [
      { resource_id: 'resource/preview-routes', version: 'v-8f2c' },
      { resource_id: 'resource/gateway-contract', version: 'v-31ab' },
    ],
  });
  on('dev-task-03')('task.stale', {
    task_id: 'dev-task-03',
    basis_ref: 'basis-0003',
    staleness: 'unknown',
    reason: 're-probe of resource/gateway-contract did not complete; staleness is indeterminate',
    stale_inputs: [],
  });

  // T4 — reconciliation went unknown while an exclusive lock was held.
  declare({
    id: 'dev-task-04',
    title: 'Rebuild the asset bundle',
    execution_class: 'mechanical',
    expected_reversibility: 'compensable',
    state: 'needs-repair',
    basis_ref: 'basis-0004',
    inputs: [{ resource_id: 'resource/bundle-manifest', version: 'v-02da' }],
  });
  dispatch('dev-task-04', 'dev-attempt-04', 'basis-0004', {
    capture: 'unknown',
    lifecycle: 'frozen',
  });
  const e4 = on('dev-task-04', 'dev-attempt-04');
  // v1 identifies a lock by (owner_id, name) and gives it no id column, so `lock_id` is the name.
  // Minting a separate identifier the schema has nowhere to store would make the event unjoinable.
  insert('lock', {
    name: LOCK,
    holder_task_id: 'dev-task-04',
    holder_attempt_id: 'dev-attempt-04',
    disposition: 'held-by-frozen-task',
    acquired_at: at(),
  });
  e4('lock.acquired', {
    lock_id: LOCK,
    lock_name: LOCK,
    holder_task_id: 'dev-task-04',
    acquired_at: at(),
  });
  e4('adapter.divergence', {
    adapter_id: 'code',
    project_id: PROJECT,
    expected: 'bundle manifest at v-02da',
    observed: 'manifest unreadable',
    reconciliation: 'needs_repair',
  });
  const subject = { subject_kind: 'task', subject_id: 'dev-task-04' } as const;
  const allowed_operations = ['reprobe', 'adopt', 'reset', 'release-frozen-lock'];
  const probes = ['read bundle manifest', 'verify runtime session'];
  e4('state.needs_repair', {
    ...subject,
    reason: 'reconciliation became unknown while the exclusive lock was held',
    frozen_lock_ids: [LOCK],
    allowed_operations,
  });
  insert('repair_case', {
    id: 'dev-repair-04',
    task_id: 'dev-task-04',
    probes: JSON.stringify(probes),
    affected_resources: JSON.stringify(['resource/bundle-manifest']),
    frozen_locks: JSON.stringify([LOCK]),
    allowed_ops: JSON.stringify(allowed_operations),
    // Unresolved, and only an owner may resolve it. The Director never clears `needs-repair`.
    resolution: null,
    opened_at: at(),
  });
  e4('repair.requested', { repair_id: 'dev-repair-04', ...subject, probes });

  return {
    ownerId: OWNER,
    lastSeq: latestSeq(db, OWNER),
    tasks: [
      { id: 'dev-task-01', state: 'running', basis: 'fresh' },
      { id: 'dev-task-02', state: 'blocked_basis_stale', basis: 'stale (named reason)' },
      {
        id: 'dev-task-03',
        state: 'blocked_basis_unknown',
        basis: 'UNKNOWN — never render as fresh',
      },
      { id: 'dev-task-04', state: 'needs-repair', basis: 'fresh, lock held-by-frozen-task' },
    ],
  };
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

  console.log('\ntasks');
  for (const t of summary.tasks) console.log(`  ${t.id}  ${t.state.padEnd(22)} basis ${t.basis}`);
  console.log(`\nsnapshot sequence: ${summary.lastSeq}\n${BANNER}\n`);
  db.close();
};

// Only when run as a program. The test imports `seedDatabase` directly and must not touch state/.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
