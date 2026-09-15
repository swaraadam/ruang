/**
 * Reference-guarded garbage collection — blueprint §14.3, persistence SKILL ("GC guard").
 *
 * The rule: "never delete an artifact referenced by an unresolved `RepairCase`, `Approval`,
 * `ReviewThread`, or a retained milestone."
 *
 * **The obvious implementation of that sentence is four queries, and it is the wrong one.** A guard
 * that enumerates what to check fails OPEN on whatever nobody named: add a table that points at
 * artifacts and the four queries still pass, still report a clean run, and start deleting evidence.
 * Silent, in the direction of data loss.
 *
 * So the enumeration is inverted. **Every table in the live schema pins by default**, and the
 * registry below lists only the EXCEPTIONS — two, each with a reason it had to state. A table added
 * by a future migration protects its artifacts without anyone remembering to protect them, and a
 * reference nobody thought about costs disk, never evidence. The enumeration that remains is the
 * one it is safe to enumerate: what does NOT protect. `gc.test.ts` pins that list so a third entry
 * cannot arrive quietly, and `protected_by_default` in the report names every table scanned under
 * the default, so the set is visible rather than implied.
 *
 * **References are found by value, not by column.** Each row is flattened to the set of strings it
 * contains — JSON walked, keys included — and intersected with the artifact ids. A new *column* is
 * covered for the same reason a new *table* is: nothing here names one.
 *
 * Two gates, both must permit deletion: the retention class (`retention.ts`) and this scan.
 */
import type { Db } from './db.js';
import {
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  classExpiryMs,
  isRetentionClass,
} from './retention.js';

/**
 * What a table is, as far as artifact references are concerned.
 *
 * `settled_when` is a SQL predicate that must evaluate TRUE to stop a row pinning. Everything else
 * — false, NULL, a state nobody anticipated — keeps the pin. §14.3 says "unresolved", so the
 * predicate spells what *settled* looks like and every other value fails closed into "still live".
 */
export type SourceDisposition =
  | { readonly kind: 'subject' }
  | { readonly kind: 'history'; readonly because: string }
  | { readonly kind: 'pins'; readonly settled_when: string | null };

export const REFERENCE_SOURCES: Readonly<Record<string, SourceDisposition>> = {
  // Every artifact row names its own id, so counting this would pin everything.
  artifact: { kind: 'subject' },

  // The one real exception. `artifact.created` carries the id of every artifact ever recorded, so a
  // log that pinned would make "transient" mean "forever". The log records that something HAPPENED;
  // §14.3's pinning sources are all LIVE CLAIMS. After collection it still holds the artifact's id,
  // kind, sha256, size and class — which is how evidence of an artifact outlives the artifact.
  event: {
    kind: 'history',
    because:
      'append-only record of what happened, not a live claim on a file; if it pinned, no ' +
      'retention class could ever expire',
  },

  // §14.3's named sources. Listed even though the default already pins them: without a
  // `settled_when` they would pin forever, and the word §14.3 uses is "unresolved".
  repair_case: { kind: 'pins', settled_when: 'resolution IS NOT NULL' },
  approval: { kind: 'pins', settled_when: 'decided_at IS NOT NULL AND decision IS NOT NULL' },
  review_thread: { kind: 'pins', settled_when: "status = 'resolved'" },
};

/** Anything the registry has not spoken about pins unconditionally. See the header. */
const UNCLASSIFIED: SourceDisposition = { kind: 'pins', settled_when: null };

/**
 * The pass refused to run. Nothing was deleted.
 *
 * Every throw site is a case where continuing would mean guessing at what protects an artifact.
 * Refusing is the only answer that cannot lose evidence (invariant 4's shape, applied to GC).
 */
export class GcRefusedError extends Error {
  public override readonly name = 'GcRefusedError';
}

/** Table names are interpolated into SQL, so they are proved to be identifiers first. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const liveTables = (db: Db): readonly string[] => {
  const names = (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  // A schema query that returns nothing is not a database with nothing to guard. Treating the two
  // alike is how a pass "scans" an unreadable file and reports a clean run.
  if (names.length === 0) {
    throw new GcRefusedError(
      'the schema reports no tables: refusing to read an empty answer as "nothing references ' +
        'anything". A scan that scanned nothing has not proved a thing is unreferenced.',
    );
  }
  for (const name of names) {
    if (!IDENTIFIER.test(name)) {
      throw new GcRefusedError(`table '${name}' is not an identifier this pass will interpolate`);
    }
  }
  // A classified source missing from the schema means its guard silently cannot run.
  const missing = Object.keys(REFERENCE_SOURCES).filter((t) => !names.includes(t));
  if (missing.length > 0) {
    throw new GcRefusedError(
      `classified reference sources are absent from the schema: ${missing.join(', ')}. ` +
        'A guard that cannot read its source is not a guard.',
    );
  }
  return names;
};

/**
 * Every string a row contains, flattened. JSON text columns are walked; object keys count too.
 *
 * Matching is whole-string, never substring, so an id that is a prefix of another cannot pin the
 * wrong artifact. The hole that opens is a column holding MALFORMED JSON, where a nested id is a
 * whole value of nothing: those strings go to `suspect`, and the caller falls back to containment
 * over them. False positives there over-retain, the direction this module may be wrong in.
 */
const harvest = (value: unknown, exact: Set<string>, suspect: string[]): void => {
  if (typeof value === 'string') {
    exact.add(value);
    const first = value[0];
    if (first === '{' || first === '[' || first === '"') {
      try {
        harvest(JSON.parse(value) as unknown, exact, suspect);
      } catch {
        // Not a "proceed anyway": the raw string is already in `exact`, and `suspect` keeps the
        // unparsed text searchable, so this loses no reference.
        suspect.push(value);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, exact, suspect);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      exact.add(key);
      harvest(item, exact, suspect);
    }
  }
};

type ScanResult = {
  readonly pins: ReadonlyMap<string, readonly string[]>;
  readonly scanned: readonly string[];
  readonly by_default: readonly string[];
};

const scanReferences = (
  db: Db,
  owner_id: string,
  artifact_ids: ReadonlySet<string>,
  tables: readonly string[],
): ScanResult => {
  const pins = new Map<string, string[]>();
  const scanned: string[] = [];
  const by_default: string[] = [];
  const pin = (id: string, source: string): void => {
    const sources = pins.get(id);
    if (sources === undefined) pins.set(id, [source]);
    else if (!sources.includes(source)) sources.push(source);
  };

  for (const table of tables) {
    const declared = REFERENCE_SOURCES[table];
    const disposition = declared ?? UNCLASSIFIED;
    if (declared === undefined) by_default.push(table);
    if (disposition.kind !== 'pins') continue;
    scanned.push(table);

    const columns = (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
    // Scoped to the owner where the column exists, whole-table where it does not. Cross-owner
    // over-scanning can only add pins, and adding a pin never deletes anything.
    const scoped = columns.includes('owner_id');
    const settled = disposition.settled_when === null ? '0' : `(${disposition.settled_when})`;
    const sql = `SELECT *, ${settled} AS __gc_settled FROM "${table}"${scoped ? ' WHERE owner_id = ?' : ''}`;

    let rows: Record<string, unknown>[];
    try {
      const statement = db.prepare(sql);
      rows = (scoped ? statement.all(owner_id) : statement.all()) as Record<string, unknown>[];
    } catch (cause) {
      // Never "no rows, carry on". An unreadable source is an unknown answer, and an unknown answer
      // about what protects an artifact is a refusal.
      throw new GcRefusedError(
        `cannot read reference source '${table}': ${(cause as Error).message}`,
        { cause },
      );
    }

    for (const row of rows) {
      if (row['__gc_settled'] === 1) continue;
      const exact = new Set<string>();
      const suspect: string[] = [];
      for (const [key, value] of Object.entries(row)) {
        if (key === '__gc_settled') continue;
        harvest(value, exact, suspect);
      }
      for (const value of exact) if (artifact_ids.has(value)) pin(value, table);
      if (suspect.length > 0) {
        for (const id of artifact_ids) {
          if (suspect.some((text) => text.includes(id))) pin(id, table);
        }
      }
    }
  }

  if (scanned.length === 0) {
    throw new GcRefusedError(
      'no reference source was scanned: every table classified itself out of the scan, so nothing ' +
        'could have been found to protect an artifact',
    );
  }
  return { pins, scanned, by_default };
};

export type ArtifactDisposition = 'due' | 'pinned' | 'not-due' | 'unreadable';

export type ArtifactDecision = {
  readonly artifact_id: string;
  readonly path_ref: string;
  readonly retention_class: string;
  readonly disposition: ArtifactDisposition;
  readonly reason: string;
  /** Which source tables hold a live reference. Empty unless `disposition` is `pinned`. */
  readonly pinned_by: readonly string[];
};

/**
 * `no-artifacts` is not `nothing-due`. A pass that found no rows has proved nothing about
 * retention; a pass that examined rows and found none due has. Collapsing them would let a query
 * that came back empty for the wrong reason report the same thing as a clean run.
 */
export type GcOutcome = 'no-artifacts' | 'nothing-due' | 'due';

export type GcPlan = {
  readonly owner_id: string;
  readonly outcome: GcOutcome;
  readonly examined: number;
  readonly sources_scanned: readonly string[];
  /** Tables scanned under the default disposition — protected without being named. */
  readonly protected_by_default: readonly string[];
  readonly decisions: readonly ArtifactDecision[];
};

export type PlanOptions = {
  readonly owner_id: string;
  /** Injected, never `Date.now()` in here: a deletion deadline must be reproducible. */
  readonly now_ms: number;
  readonly policy?: RetentionPolicy;
};

type ArtifactRow = {
  id: string;
  path_ref: string;
  retention_class: string;
  size_bytes: number;
  created_at: string;
};

/** Both gates, in order. Every arm that is not `due` is a reason to keep the artifact. */
const verdict = (
  row: ArtifactRow,
  pinned_by: readonly string[],
  now_ms: number,
  policy: RetentionPolicy,
): { disposition: ArtifactDisposition; reason: string } => {
  if (pinned_by.length > 0) {
    return { disposition: 'pinned', reason: `referenced by a live row in ${pinned_by.join(', ')}` };
  }
  if (!isRetentionClass(row.retention_class)) {
    return {
      disposition: 'unreadable',
      reason: `retention class '${row.retention_class}' has no defined lifetime`,
    };
  }
  const created = Date.parse(row.created_at);
  if (Number.isNaN(created)) {
    return {
      disposition: 'unreadable',
      reason: `created_at '${row.created_at}' is not a timestamp, so no deadline can be computed`,
    };
  }
  const expiry = classExpiryMs(row.retention_class, created, policy);
  if (expiry === null) {
    return {
      disposition: 'not-due',
      reason: 'milestone: manual retain, never auto-deleted (§14.3)',
    };
  }
  return now_ms < expiry
    ? { disposition: 'not-due', reason: `retained until ${new Date(expiry).toISOString()}` }
    : {
        disposition: 'due',
        reason: `${row.retention_class} expired at ${new Date(expiry).toISOString()}`,
      };
};

/**
 * Decide, without deleting anything. The dry run, and the half `collectArtifacts` reuses.
 *
 * Pins are computed first, so the build-cache size ceiling can only ever consider artifacts nothing
 * points at.
 */
export const planCollection = (db: Db, options: PlanOptions): GcPlan => {
  const policy = options.policy ?? DEFAULT_RETENTION_POLICY;
  const tables = liveTables(db);
  const rows = db
    .prepare(
      `SELECT id, path_ref, retention_class, size_bytes, created_at FROM artifact
        WHERE owner_id = ? ORDER BY created_at, id`,
    )
    .all(options.owner_id) as ArtifactRow[];

  const ids = new Set(rows.map((r) => r.id));
  const { pins, scanned, by_default } = scanReferences(db, options.owner_id, ids, tables);

  const decisions: ArtifactDecision[] = rows.map((row) => {
    const pinned_by = pins.get(row.id) ?? [];
    return {
      artifact_id: row.id,
      path_ref: row.path_ref,
      retention_class: row.retention_class,
      pinned_by,
      ...verdict(row, pinned_by, options.now_ms, policy),
    };
  });

  applySizeCeiling(decisions, rows, policy);

  return {
    owner_id: options.owner_id,
    outcome: rows.length === 0 ? 'no-artifacts' : decisions.some(isDue) ? 'due' : 'nothing-due',
    examined: rows.length,
    sources_scanned: scanned,
    protected_by_default: by_default,
    decisions,
  };
};

const isDue = (d: ArtifactDecision): boolean => d.disposition === 'due';

/**
 * The size half of §14.3's "size/age" rule for `build-cache`, oldest first.
 *
 * Only over `not-due` entries: `pinned` and `unreadable` are answers from the other two gates and a
 * byte ceiling does not overrule them. A cache entry something still points at is not cache
 * pressure, it is a reference.
 */
const applySizeCeiling = (
  decisions: ArtifactDecision[],
  rows: readonly ArtifactRow[],
  policy: RetentionPolicy,
): void => {
  const sizeOf = new Map(rows.map((r) => [r.id, r.size_bytes]));
  const candidates = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.retention_class === 'build-cache');

  let retained = candidates
    .filter(({ decision }) => decision.disposition !== 'due')
    .reduce((sum, { decision }) => sum + (sizeOf.get(decision.artifact_id) ?? 0), 0);

  // `rows` is ordered oldest first and `decisions` mirrors it, so index order is age order.
  for (const { decision, index } of candidates) {
    if (retained <= policy.build_cache_ceiling_bytes) return;
    if (decision.disposition !== 'not-due') continue;
    retained -= sizeOf.get(decision.artifact_id) ?? 0;
    decisions[index] = {
      ...decision,
      disposition: 'due',
      reason: `build-cache over the ${String(policy.build_cache_ceiling_bytes)}-byte ceiling; oldest evicted first`,
    };
  }
};

export type RemoveFailure = {
  readonly artifact_id: string;
  readonly path_ref: string;
  readonly reason: string;
};

export type GcReport = GcPlan & {
  readonly collected: readonly string[];
  readonly remove_failed: readonly RemoveFailure[];
};

export type CollectOptions = PlanOptions & {
  /**
   * Removes the file behind `path_ref`. Must be idempotent: an already-absent file is a success,
   * because an interrupted pass will ask again. Injected because this package owns rows, not a
   * filesystem — and it is the seam a caller uses to run the pass against a fake remover.
   */
  readonly remove: (artifact: { readonly artifact_id: string; readonly path_ref: string }) => void;
};

/**
 * Plan and collect in ONE immediate transaction.
 *
 * The write lock is taken before the scan reads, so no concurrent writer can insert the reference
 * that would have protected an artifact between the scan and the delete — the classic way a
 * reference guard is correct and still loses data.
 *
 * The file goes before its row, and a removal that throws leaves the row in place. That ordering
 * picks which residue is acceptable: a tracked file that still exists is a retry next pass, an
 * untracked file that still exists is litter nothing will ever find. Holding the write lock across
 * the removals is the price, and for a maintenance pass on one host it is the right way round.
 */
export const collectArtifacts = (db: Db, options: CollectOptions): GcReport =>
  db
    .transaction((): GcReport => {
      const plan = planCollection(db, options);
      const collected: string[] = [];
      const remove_failed: RemoveFailure[] = [];
      const drop = db.prepare(`DELETE FROM artifact WHERE owner_id = ? AND id = ?`);

      for (const decision of plan.decisions) {
        if (decision.disposition !== 'due') continue;
        try {
          options.remove({ artifact_id: decision.artifact_id, path_ref: decision.path_ref });
        } catch (cause) {
          // Continues in the RETAINING direction: the row stays, the artifact stays tracked, the
          // next pass retries. The one shape of `catch { continue }` that is not a default-allow.
          remove_failed.push({
            artifact_id: decision.artifact_id,
            path_ref: decision.path_ref,
            reason: (cause as Error).message,
          });
          continue;
        }
        drop.run(options.owner_id, decision.artifact_id);
        collected.push(decision.artifact_id);
      }

      return { ...plan, collected, remove_failed };
    })
    .immediate();
