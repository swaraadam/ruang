/**
 * Opening the control-plane database — blueprint §14.3, §19.1 ("SQLite + WAL").
 *
 * Three pragmas are not defaults and all three are load-bearing:
 *
 * - **WAL.** A reader never blocks the writer, which is what lets the office view read a snapshot
 *   while a task is mid-write. It is also per-database and persists, so setting it once is enough.
 * - **foreign_keys.** OFF by default in SQLite, per-connection, and not persisted. Every open must
 *   set it or the schema's references become documentation (persistence SKILL: "Foreign keys ON").
 * - **busy_timeout.** WAL still serialises writers; without a timeout a concurrent write fails
 *   immediately with SQLITE_BUSY rather than waiting the moment the gateway has two writers.
 */
import Database from 'better-sqlite3';
import { LATEST_VERSION, currentVersion, migrate, schemaFingerprint } from './migrate.js';

export type Db = Database.Database;

/**
 * Open (or CREATE) the database, apply pending migrations, and return it ready to use.
 *
 * This is the writer's path — the seed, and anything else whose job is to bring a database into
 * existence. A reader must not use it: it will happily create an empty database, or stamp this
 * schema into an unrelated file. Readers call `openControlPlaneDatabase`, which proves identity
 * first.
 */
export const openDatabase = (path: string): Db => {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
};

/** An in-memory database at the latest version. For tests; WAL is meaningless without a file. */
export const openMemoryDatabase = (): Db => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
};

/**
 * Thrown when the file at a path is not this system's control-plane database.
 *
 * Separate from a generic open failure on purpose: a caller wants to say something different about
 * "there is no file" (run the seed) and "there is a file and it belongs to something else"
 * (do not touch it).
 */
export class ForeignDatabaseError extends Error {
  public override readonly name = 'ForeignDatabaseError';
}

/**
 * The schema this build expects, as SQLite reports it, computed from the migrations themselves.
 *
 * Derived rather than pinned: a hard-coded fingerprint here would be a second spelling of the
 * migrations and would drift from them the day v2 lands. `migration.test.ts` pins the hash; this
 * only needs to know what THIS build would produce.
 */
let expected: string | null = null;
const expectedFingerprint = (): string => {
  if (expected === null) {
    const reference = openMemoryDatabase();
    expected = schemaFingerprint(reference);
    reference.close();
  }
  return expected;
};

const tableNames = (fingerprint: string): readonly string[] =>
  fingerprint
    .split('\n')
    .filter((line) => line.startsWith('table:'))
    .map((line) => line.split(':')[1] ?? '');

const tableCount = (names: readonly string[]): string =>
  `${String(names.length)} table${names.length === 1 ? '' : 's'}`;

/**
 * Open a database THIS PROCESS DID NOT CREATE, having first proved it is the control plane.
 *
 * `openDatabase` is the create-or-open path the seed needs. It is the wrong path for a reader,
 * because better-sqlite3 opens any file at all and `migrate()` then writes 26 tables into whatever
 * it found — a foreign database gets this schema stamped into it and is served back as an office
 * with no projects. Existence was never identity, and an empty office is a claim durable truth
 * never made (invariant 1).
 *
 * So identity is proved first, and proved through a READ-ONLY handle: SQLite will not write through
 * one, so a file that fails the proof is byte-for-byte unchanged when this throws. The proof is the
 * schema itself — every table, column and constraint the migrations produce, plus `user_version`.
 * That is a stronger marker than a marker table would be (a table named by this code proves only
 * that something created a table by that name) and it needs no migration to introduce.
 *
 * The re-open afterwards is a read-write handle on a path that has just been proved, and `migrate`
 * is then a no-op because the version already matches. A file swapped between the two opens would
 * defeat that; on a single-owner local machine the swapper would already own the process.
 */
export const openControlPlaneDatabase = (path: string): Db => {
  let probe: Db | null = null;
  let version: number;
  let fingerprint: string;
  try {
    probe = new Database(path, { readonly: true, fileMustExist: true });
    // Inside the same `try` as the open, because better-sqlite3 opens lazily: a file that is not a
    // database at all constructs without complaint and fails on the first read. Catching only the
    // constructor let `SqliteError: file is not a database` escape as an unhandled startup crash.
    version = currentVersion(probe);
    fingerprint = schemaFingerprint(probe);
  } catch (cause) {
    throw new ForeignDatabaseError(
      `${path} could not be read as a control-plane database: ${(cause as Error).message}`,
      { cause },
    );
  } finally {
    probe?.close();
  }

  const want = expectedFingerprint();
  if (version !== LATEST_VERSION || fingerprint !== want) {
    const found = tableNames(fingerprint);
    throw new ForeignDatabaseError(
      `${path} is not this system's control-plane database.\n` +
        `  expected: schema version ${String(LATEST_VERSION)}, ${tableCount(tableNames(want))}\n` +
        `  found:    schema version ${String(version)}, ${tableCount(found)}` +
        (found.length === 0
          ? ''
          : ` (${found.slice(0, 4).join(', ')}${found.length > 4 ? ', …' : ''})`) +
        '\n  Nothing was written to it: the check reads through a read-only handle precisely so that\n' +
        '  a file which turns out to belong to something else is left exactly as it was found.',
    );
  }

  return openDatabase(path);
};
