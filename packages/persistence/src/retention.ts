/**
 * Artifact retention classes — blueprint §14.3, persistence SKILL ("Artifact retention classes").
 *
 * A class answers exactly one question: when does this artifact stop being worth keeping ON ITS
 * OWN? It never answers whether something still points at it — that is the reference guard in
 * `gc.ts`, and the two gates are deliberately independent. An artifact is collectable only when
 * BOTH agree, so a mistake in either one over-retains (disk) rather than deletes (evidence).
 *
 * The four classes restate the CHECK constraint frozen into `artifact.retention_class` in migration
 * v1. Duplicated on purpose, the way `packages/policy` duplicates `change_unit`: v1 cannot be
 * edited, so the two lists cannot drift without `gc.test.ts` noticing.
 */

export const RETENTION_CLASSES = [
  'transient',
  'task-evidence',
  'milestone',
  'build-cache',
] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/**
 * Narrow a value read back from the database.
 *
 * v1's CHECK makes this redundant against rows this build wrote, and not against rows a newer
 * build or `sqlite3` wrote. A class this code cannot name is not a class it may expire, so callers
 * treat `false` as "retain and report", never as "assume transient".
 */
export const isRetentionClass = (value: unknown): value is RetentionClass =>
  typeof value === 'string' && (RETENTION_CLASSES as readonly string[]).includes(value);

export type RetentionPolicy = {
  /** §14.3: "hours–days". PTY captures and debug streams. */
  readonly transient_ttl_ms: number;
  /** §14.3: "30 days default, or until task archive". */
  readonly task_evidence_ttl_ms: number;
  /** The age half of §14.3's "size/age" rule for `build-cache`. */
  readonly build_cache_ttl_ms: number;
  /** The size half. Total bytes of retained `build-cache` artifacts, oldest evicted first. */
  readonly build_cache_ceiling_bytes: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  transient_ttl_ms: 48 * HOUR_MS,
  task_evidence_ttl_ms: 30 * DAY_MS,
  build_cache_ttl_ms: 14 * DAY_MS,
  build_cache_ceiling_bytes: 2 * 1024 ** 3,
};

/**
 * The instant this artifact's class stops protecting it, or `null` for never.
 *
 * `milestone` is the `null`. §14.3 says manual retain, never auto-deleted, and "never" has to be a
 * value the arithmetic cannot reach — a very large number is a deadline, and a deadline arrives.
 *
 * The switch is exhaustive over the union with no `default`. A fifth class would fail to compile
 * here, which is the point: a class nobody wrote a lifetime for must not silently inherit one.
 */
export const classExpiryMs = (
  retention_class: RetentionClass,
  created_at_ms: number,
  policy: RetentionPolicy,
): number | null => {
  switch (retention_class) {
    case 'transient':
      return created_at_ms + policy.transient_ttl_ms;
    case 'task-evidence':
      return created_at_ms + policy.task_evidence_ttl_ms;
    case 'build-cache':
      return created_at_ms + policy.build_cache_ttl_ms;
    case 'milestone':
      return null;
  }
};
