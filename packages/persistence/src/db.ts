/**
 * Opening the control-plane database — blueprint §14.3, §19.1 ("SQLite + WAL").
 *
 * Three pragmas are not defaults and all three are load-bearing. They are spelled once, in
 * `applyPragmas` below, and every file-backed open goes through it:
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
 * The three non-default pragmas from the note above, applied to every file-backed handle.
 *
 * One definition, not one per open path. The list is short enough to copy, which is exactly the
 * hazard: a second copy is a second thing to remember when one of the three changes, and the header
 * comment above would then describe neither. `openMemoryDatabase` is the stated exception and sets
 * only `foreign_keys` — see the note there for why the other two say nothing in memory.
 */
const applyPragmas = (db: Db): void => {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
};

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
  applyPragmas(db);
  migrate(db);
  return db;
};

/**
 * An in-memory database at the latest version. For tests.
 *
 * `foreign_keys` only, and deliberately not `applyPragmas`: a journal mode is meaningless without a
 * file and `busy_timeout` cannot fire on a handle no other connection can reach. Setting them here
 * would suggest this path had the same reasons behind it as the file paths, and it does not.
 */
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
 * So identity is proved first. The proof is the schema itself — every table, column and constraint
 * the migrations produce, plus `user_version`. That is a stronger marker than a marker table would
 * be (a table named by this code proves only that something created a table by that name) and it
 * needs no migration to introduce.
 *
 * **It is proved on the handle that is then used, and there is exactly one.** Proving through a
 * read-only probe and re-opening read-write afterwards resolved `path` twice, and a symlink flipped
 * between the two opens turned the refusal into `migrate()` writing 26 tables into the file that
 * had just failed — a plain flip loop won that race in seconds, and the attacker needs write access
 * to the directory, not to this process. One handle removes the window: the descriptor the
 * verification read is the descriptor `migrate` writes through, so no rename can come between them.
 * Opening read-write writes nothing by itself; the pragmas and `migrate` are this path's only
 * writes and both are past the refusal. `migrate` is then provably a no-op — same inode, version
 * already `LATEST_VERSION`.
 *
 * The one residue, stated because the previous version of this comment claimed the opposite: when
 * the refused file is a WAL database whose writer crashed, SQLite folds the orphaned `-wal` into it
 * as this handle closes. That is recovery of already-committed frames — bytes move, no row does —
 * and it is what that file's own next reader would have done. The earlier read-only probe avoided
 * it and instead left `-shm`/`-wal` sidecars behind, so "byte-for-byte as it was found" was never
 * true either; it was untrue in a quieter way.
 */
export const openControlPlaneDatabase = (path: string): Db => {
  let db: Db | null = null;
  let version: number;
  let fingerprint: string;
  try {
    db = new Database(path, { fileMustExist: true });
    // Inside the same `try` as the open, because better-sqlite3 opens lazily: a file that is not a
    // database at all constructs without complaint and fails on the first read. Catching only the
    // constructor let `SqliteError: file is not a database` escape as an unhandled startup crash.
    version = currentVersion(db);
    fingerprint = schemaFingerprint(db);
  } catch (cause) {
    db?.close();
    throw new ForeignDatabaseError(
      `${path} could not be read as a control-plane database: ${(cause as Error).message}`,
      { cause },
    );
  }

  const want = expectedFingerprint();
  if (version !== LATEST_VERSION || fingerprint !== want) {
    const found = tableNames(fingerprint);
    db.close();
    throw new ForeignDatabaseError(
      `${path} is not this system's control-plane database.\n` +
        `  expected: schema version ${String(LATEST_VERSION)}, ${tableCount(tableNames(want))}\n` +
        `  found:    schema version ${String(version)}, ${tableCount(found)}` +
        (found.length === 0
          ? ''
          : ` (${found.slice(0, 4).join(', ')}${found.length > 4 ? ', …' : ''})`) +
        '\n  Nothing here wrote to it: the refusal is before the pragmas and the migration, which are\n' +
        '  the only writes this path makes, so no row is added, changed or removed. SQLite itself may\n' +
        '  still fold an orphaned -wal back into the file as the handle closes — bytes, never data.',
    );
  }

  // Past the refusal, so these are writes to a proved control-plane database. Same handle
  // throughout: see the note above on why the second open was the hole.
  applyPragmas(db);
  migrate(db);
  return db;
};
