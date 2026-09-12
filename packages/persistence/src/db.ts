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
import { migrate } from './migrate.js';

export type Db = Database.Database;

/** Open (or create) the database, apply pending migrations, and return it ready to use. */
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
