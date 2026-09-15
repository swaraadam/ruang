/**
 * The GC guard — blueprint §14.3, and issue P0-17's first two acceptance boxes.
 *
 * Two kinds of test live here and they defend different things:
 *
 * 1. The stated rule: an artifact referenced by an unresolved RepairCase, Approval or ReviewThread,
 *    or held as a milestone, survives. Each is paired with its CONTRAST — settle the claim, or
 *    change the class, and the same artifact is collected. Without the contrast the guard could be
 *    "never delete anything" and still pass.
 * 2. The shape of the guard: protection is the DEFAULT, not a list. The tests that matter most are
 *    the ones about a reference the registry never named.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  type ArtifactDecision,
  type Db,
  type GcReport,
  type NewArtifact,
  GcRefusedError,
  REFERENCE_SOURCES,
  collectArtifacts,
  listArtifacts,
  readSince,
  recordArtifact,
} from '../src/index.js';
import { ATTEMPT, ORG, OWNER, TASK, seedControlPlane } from './fixture.js';

const HASH = 'b'.repeat(64);
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (ms: number): string => new Date(ms).toISOString();

const put = (db: Db, over: Partial<NewArtifact> & { id: string }): string => {
  recordArtifact(db, {
    owner_id: OWNER,
    org_node_id: ORG,
    task_id: TASK,
    attempt_id: ATTEMPT,
    kind: 'check-log',
    path_ref: `artifacts/${over.id}`,
    sha256: HASH,
    size_bytes: 10,
    retention_class: 'transient',
    created_at: at(T0),
    actor_member_id: 'm1',
    ...over,
  });
  return over.id;
};

/** Collect with a remover that records rather than touching a filesystem. */
const collect = (db: Db, now_ms: number): GcReport & { removed: readonly string[] } => {
  const removed: string[] = [];
  const report = collectArtifacts(db, {
    owner_id: OWNER,
    now_ms,
    remove: ({ path_ref }) => removed.push(path_ref),
  });
  return { ...report, removed };
};

const decisionFor = (report: GcReport, id: string): ArtifactDecision => {
  const found = report.decisions.find((d) => d.artifact_id === id);
  if (found === undefined) throw new Error(`no decision for ${id}; GC never examined it`);
  return found;
};

const ids = (db: Db): readonly string[] => listArtifacts(db, OWNER).map((a) => a.id);

const openRepairCase = (db: Db, affected: string): void => {
  db.prepare(
    `INSERT INTO repair_case (id, owner_id, org_node_id, task_id, affected_resources, opened_at)
     VALUES ('r-1', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(OWNER, ORG, TASK, affected);
};

const undecidedApproval = (db: Db, planRef: string): void => {
  db.prepare(
    `INSERT INTO approval
       (id, owner_id, org_node_id, task_id, risk, reversibility, reversal_plan_ref,
        action_fingerprint, target_ref, apply_plan_hash)
     VALUES ('ap-1', ?, ?, ?, 'high', 'irreversible', ?, 'fp', 'target', 'hash')`,
  ).run(OWNER, ORG, TASK, planRef);
};

const openReviewThread = (db: Db, locator: string): void => {
  db.prepare(
    `INSERT INTO review_thread
       (id, owner_id, org_node_id, task_id, anchor_kind, anchor_locator, status)
     VALUES ('rt-1', ?, ?, ?, 'text_range', ?, 'open')`,
  ).run(OWNER, ORG, TASK, locator);
};

/**
 * ACCEPTANCE 1 — "GC never deletes an artifact referenced by an unresolved RepairCase, Approval,
 * ReviewThread or retained milestone."
 */
describe('a live claim on an artifact outranks its expiry', () => {
  it('keeps an expired artifact an unresolved RepairCase still points at', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-1' });
    openRepairCase(db, JSON.stringify(['a-1']));

    const report = collect(db, T0 + 365 * DAY);

    expect(decisionFor(report, 'a-1')).toMatchObject({
      disposition: 'pinned',
      pinned_by: ['repair_case'],
    });
    expect(report.collected).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(ids(db)).toEqual(['a-1']);
  });

  it('releases it once the RepairCase is resolved — so the pin is real, not a blanket refusal', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-1' });
    openRepairCase(db, JSON.stringify(['a-1']));
    db.prepare(`UPDATE repair_case SET resolution = 'adopt' WHERE id = 'r-1'`).run();

    const report = collect(db, T0 + 365 * DAY);

    expect(report.collected).toEqual(['a-1']);
    expect(report.removed).toEqual(['artifacts/a-1']);
    expect(ids(db)).toEqual([]);
  });

  it('keeps an artifact an undecided Approval names as its reversal plan', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-2' });
    undecidedApproval(db, 'a-2');

    expect(decisionFor(collect(db, T0 + 365 * DAY), 'a-2')).toMatchObject({
      disposition: 'pinned',
      pinned_by: ['approval'],
    });
    expect(ids(db)).toEqual(['a-2']);
  });

  it('keeps an artifact an open ReviewThread anchors on', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-3' });
    openReviewThread(db, 'a-3');

    expect(decisionFor(collect(db, T0 + 365 * DAY), 'a-3')).toMatchObject({
      disposition: 'pinned',
      pinned_by: ['review_thread'],
    });
    expect(ids(db)).toEqual(['a-3']);
  });

  it('keeps a retained milestone with no reference at all', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-4', retention_class: 'milestone' });

    expect(decisionFor(collect(db, T0 + 3650 * DAY), 'a-4').disposition).toBe('not-due');
    expect(ids(db)).toEqual(['a-4']);
  });

  /**
   * A half-decided approval is not a decided one. §14.3 says "unresolved", and the predicate spells
   * what settled looks like so that everything else — NULL, a value nobody anticipated, half a
   * decision — keeps the pin rather than losing it.
   */
  it('treats a half-written decision as still unresolved', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-5' });
    undecidedApproval(db, 'a-5');
    db.prepare(
      `UPDATE approval SET decided_at = '2026-01-02T00:00:00.000Z' WHERE id = 'ap-1'`,
    ).run();

    expect(decisionFor(collect(db, T0 + 365 * DAY), 'a-5').disposition).toBe('pinned');
    expect(ids(db)).toEqual(['a-5']);
  });
});

/**
 * The guard's SHAPE. An enumeration of reference sources fails open on whatever nobody named, and
 * these are the tests that say this one does not.
 */
describe('a reference the registry never named still protects', () => {
  it('protects through a table nobody classified, and says which one', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-6' });
    // `check_result.artifact_ref` is a real v1 reference that §14.3's four-source sentence does not
    // mention. Nothing in gc.ts names this table; it is protected because protection is the default.
    db.prepare(
      `INSERT INTO check_spec (id, owner_id, org_node_id, project_id, required, timeout_s, flake_policy)
       VALUES ('cs-1', ?, ?, 'p-1', 1, 60, 'fail')`,
    ).run(OWNER, ORG);
    db.prepare(
      `INSERT INTO check_result
         (id, owner_id, org_node_id, attempt_id, check_spec_id, result, artifact_ref)
       VALUES ('cr-1', ?, ?, ?, 'cs-1', 'passed', 'a-6')`,
    ).run(OWNER, ORG, ATTEMPT);

    const report = collect(db, T0 + 365 * DAY);

    expect(decisionFor(report, 'a-6')).toMatchObject({
      disposition: 'pinned',
      pinned_by: ['check_result'],
    });
    expect(report.protected_by_default).toContain('check_result');
    expect(ids(db)).toEqual(['a-6']);
  });

  it('protects through a reference buried in a JSON column it was never told about', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-7' });
    db.prepare(
      `INSERT INTO evidence (id, owner_id, org_node_id, attempt_id, profile, confidence_lane, artifact_refs)
       VALUES ('e-1', ?, ?, ?, 'strong', 'lane', ?)`,
    ).run(OWNER, ORG, ATTEMPT, JSON.stringify({ logs: [{ ref: 'a-7' }] }));

    expect(decisionFor(collect(db, T0 + 365 * DAY), 'a-7')).toMatchObject({
      disposition: 'pinned',
      pinned_by: ['evidence'],
    });
  });

  it('protects through malformed JSON rather than reading a parse failure as "no reference"', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-8' });
    // Looks structured, is not. The value-equality scan would miss the id nested in it; the
    // substring fallback catches it, because over-retaining is the direction this may be wrong in.
    openRepairCase(db, '["a-8", truncated');

    expect(decisionFor(collect(db, T0 + 365 * DAY), 'a-8').disposition).toBe('pinned');
    expect(ids(db)).toEqual(['a-8']);
  });

  /**
   * The list it is safe to enumerate is what does NOT protect. Pinning it here means removing
   * protection from a table has to be written down twice — in the registry and here.
   */
  it('has exactly two non-pinning sources, each with a stated reason', () => {
    const exceptions = Object.entries(REFERENCE_SOURCES)
      .filter(([, disposition]) => disposition.kind !== 'pins')
      .map(([table, disposition]) => [table, disposition.kind]);

    expect(exceptions).toEqual([
      ['artifact', 'subject'],
      ['event', 'history'],
    ]);
    const history = REFERENCE_SOURCES['event'];
    expect(history?.kind === 'history' && history.because.length > 0).toBe(true);
  });
});

/** ACCEPTANCE 2 — "transient artifacts expire; milestone artifacts never expire." */
describe('retention classes decide when a thing stops being worth keeping', () => {
  it('collects an unreferenced transient artifact once its hours have passed', () => {
    const db = seedControlPlane();
    put(db, { id: 'tr-1', retention_class: 'transient' });

    const report = collect(db, T0 + 3 * DAY);

    expect(report.outcome).toBe('due');
    expect(report.collected).toEqual(['tr-1']);
    expect(report.removed).toEqual(['artifacts/tr-1']);
    expect(ids(db)).toEqual([]);
  });

  it('keeps the same transient artifact before its deadline', () => {
    const db = seedControlPlane();
    put(db, { id: 'tr-2', retention_class: 'transient' });

    const report = collect(db, T0 + 3600_000);

    expect(report.outcome).toBe('nothing-due');
    expect(decisionFor(report, 'tr-2').disposition).toBe('not-due');
    expect(ids(db)).toEqual(['tr-2']);
  });

  it('never expires a milestone, at any age, with the class named as the reason', () => {
    const db = seedControlPlane();
    put(db, { id: 'ms-1', retention_class: 'milestone' });

    const report = collect(db, T0 + 36_500 * DAY);

    expect(decisionFor(report, 'ms-1').disposition).toBe('not-due');
    expect(decisionFor(report, 'ms-1').reason).toContain('milestone');
    expect(report.collected).toEqual([]);
    expect(ids(db)).toEqual(['ms-1']);
  });

  it('holds task-evidence for 30 days, then lets it go', () => {
    const db = seedControlPlane();
    put(db, { id: 'te-1', retention_class: 'task-evidence' });

    expect(collect(db, T0 + 29 * DAY).collected).toEqual([]);
    expect(collect(db, T0 + 31 * DAY).collected).toEqual(['te-1']);
  });

  it('evicts build-cache oldest first when the size ceiling is exceeded', () => {
    const db = seedControlPlane();
    put(db, { id: 'bc-old', retention_class: 'build-cache', size_bytes: 600, created_at: at(T0) });
    put(db, {
      id: 'bc-new',
      retention_class: 'build-cache',
      size_bytes: 600,
      created_at: at(T0 + DAY),
    });

    const removed: string[] = [];
    const report = collectArtifacts(db, {
      owner_id: OWNER,
      now_ms: T0 + 2 * DAY,
      policy: {
        transient_ttl_ms: 48 * 3600_000,
        task_evidence_ttl_ms: 30 * DAY,
        build_cache_ttl_ms: 14 * DAY,
        build_cache_ceiling_bytes: 1000,
      },
      remove: ({ path_ref }) => removed.push(path_ref),
    });

    expect(report.collected).toEqual(['bc-old']);
    expect(decisionFor(report, 'bc-old').reason).toContain('ceiling');
    expect(ids(db)).toEqual(['bc-new']);
  });

  it('leaves a pinned build-cache entry alone however far over the ceiling it is', () => {
    const db = seedControlPlane();
    put(db, { id: 'bc-held', retention_class: 'build-cache', size_bytes: 5000 });
    openRepairCase(db, JSON.stringify(['bc-held']));

    const report = collectArtifacts(db, {
      owner_id: OWNER,
      now_ms: T0 + 365 * DAY,
      policy: {
        transient_ttl_ms: 1,
        task_evidence_ttl_ms: 1,
        build_cache_ttl_ms: 1,
        build_cache_ceiling_bytes: 1,
      },
      remove: () => {
        throw new Error('nothing should have been removed');
      },
    });

    expect(report.collected).toEqual([]);
    expect(decisionFor(report, 'bc-held').disposition).toBe('pinned');
  });
});

/** "Evidence outlives the run" — the artifact goes, the durable fact of it does not. */
describe('what survives collection', () => {
  it('leaves artifact.created in the log after the row and file are gone', () => {
    const db = seedControlPlane();
    put(db, { id: 'tr-3', retention_class: 'transient' });

    collect(db, T0 + 3 * DAY);

    const events = readSince(db, OWNER, 0) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'artifact.created',
      payload: { artifact_id: 'tr-3', sha256: HASH, retention_class: 'transient' },
    });
    expect(listArtifacts(db, OWNER)).toEqual([]);
  });
});

/**
 * A pass that scanned nothing must not look like a clean one, and a pass that cannot read what
 * protects an artifact must not delete it.
 */
describe('refusing beats guessing', () => {
  it('distinguishes "no artifacts at all" from "nothing was due"', () => {
    const db = seedControlPlane();
    expect(collect(db, T0).outcome).toBe('no-artifacts');

    put(db, { id: 'a-9', retention_class: 'milestone' });
    expect(collect(db, T0).outcome).toBe('nothing-due');
  });

  it('refuses a database whose schema reports no tables', () => {
    const empty = new Database(':memory:');
    expect(() => collect(empty as Db, T0)).toThrow(GcRefusedError);
  });

  it('refuses when a classified reference source is absent from the schema', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-10' });
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE review_thread');

    // A guard whose source table is missing reads as "no references found", which is exactly the
    // silent fail-open this module exists to prevent.
    expect(() => collect(db, T0 + 365 * DAY)).toThrow(GcRefusedError);
    expect(ids(db)).toEqual(['a-10']);
  });

  it('retains an artifact whose created_at is not a timestamp', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-11', created_at: 'some time last week' });

    const report = collect(db, T0 + 365 * DAY);

    expect(decisionFor(report, 'a-11').disposition).toBe('unreadable');
    expect(report.collected).toEqual([]);
    expect(ids(db)).toEqual(['a-11']);
  });

  it('keeps the row when removing the file fails, and names the failure', () => {
    const db = seedControlPlane();
    put(db, { id: 'a-12', retention_class: 'transient' });

    const report = collectArtifacts(db, {
      owner_id: OWNER,
      now_ms: T0 + 3 * DAY,
      remove: () => {
        throw new Error('permission denied');
      },
    });

    expect(report.collected).toEqual([]);
    expect(report.remove_failed).toEqual([
      { artifact_id: 'a-12', path_ref: 'artifacts/a-12', reason: 'permission denied' },
    ]);
    // Still tracked, so the next pass retries it. An untracked file nothing points at is litter.
    expect(ids(db)).toEqual(['a-12']);
  });
});
