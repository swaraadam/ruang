/**
 * Forward-only migration runner — blueprint §14.3, persistence SKILL.
 *
 * One file per version, applied in order, never re-applied and never reversed. `user_version` is
 * SQLite's own integer header field, so the applied version travels with the file: a database
 * copied to another host carries its own answer rather than depending on a table this code wrote.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { V1 } from './migrations/v1.js';

/** Version n is `MIGRATIONS[n - 1]`. Append only; never edit a landed entry (see `v1.ts`). */
export const MIGRATIONS: readonly string[] = [V1];

export const LATEST_VERSION = MIGRATIONS.length;

export const currentVersion = (db: BetterSqlite3.Database): number =>
  (db.pragma('user_version', { simple: true }) as number) ?? 0;

/**
 * Apply every migration the database has not seen, in order, and return the version it reaches.
 *
 * Each migration runs inside its own transaction together with the `user_version` bump, so a
 * failure leaves the database at the last version that fully applied rather than half-way through
 * one. Invariant 3 in schema form: an interrupted migration is a known state, not an ambiguous one.
 */
export const migrate = (db: BetterSqlite3.Database): number => {
  const from = currentVersion(db);

  if (from > LATEST_VERSION) {
    // The file was written by a newer build. Refusing is the only safe answer: this code does not
    // know what that version changed, and opening it read-write could write rows the newer schema
    // would reject. Fail closed (invariant 4's shape, applied to the schema).
    throw new Error(
      `database is at version ${from}, newer than this build's ${LATEST_VERSION}; refusing to open`,
    );
  }

  for (let v = from + 1; v <= LATEST_VERSION; v += 1) {
    const sql = MIGRATIONS[v - 1]!;
    db.transaction(() => {
      db.exec(sql);
      // `user_version` takes no bound parameter, and v is a loop integer, never external input.
      db.pragma(`user_version = ${v}`);
    })();
  }

  return currentVersion(db);
};

/**
 * The schema as SQLite itself reports it, normalised for comparison.
 *
 * Read from `sqlite_schema` rather than from the migration text: this is what the database *has*,
 * which is the thing worth pinning. A migration edited to produce the same schema is harmless; one
 * edited to produce a different schema is the failure `migration.test.ts` exists to catch.
 */
export const schemaFingerprint = (db: BetterSqlite3.Database): string => {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string }[];

  return rows.map((r) => `${r.type}:${r.name}:${r.sql.replace(/\s+/g, ' ').trim()}`).join('\n');
};
