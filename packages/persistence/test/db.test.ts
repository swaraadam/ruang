/**
 * `openControlPlaneDatabase` must prove identity ON THE HANDLE IT THEN USES.
 *
 * It used to prove it on a read-only probe, close that, and open the path a second time
 * read-write. Two resolutions of one path is a TOCTOU window, and it is not a narrow one: a plain
 * symlink-flip loop in another process took a foreign database from 1 table to 27 within ~30 calls,
 * every run, because `migrate()` then wrote the whole control-plane schema into the file the probe
 * had just refused. The attacker needs write access to the DIRECTORY, not to this process — which
 * on this host is every sandbox and every postinstall running as the owner.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ForeignDatabaseError, openControlPlaneDatabase, openDatabase } from '../src/index.js';

let scratch: string | null = null;
afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** Flips a symlink between two targets as fast as it can, until `until`. */
const FLIPPER = `
const { symlinkSync, unlinkSync, renameSync } = require('node:fs');
const [link, a, b, until] = process.argv.slice(1);
const tmp = link + '.flip';
const point = (t) => { try { unlinkSync(tmp); } catch {} try { symlinkSync(t, tmp); renameSync(tmp, link); } catch {} };
while (Date.now() < Number(until)) { point(a); point(b); }
`;

const inspect = (path: string): { tables: number; version: number; secret: string | null } => {
  const db = new Database(path, { readonly: true });
  const tables = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as { c: number }
  ).c;
  const version = db.pragma('user_version', { simple: true }) as number;
  let secret: string | null;
  try {
    secret = (db.prepare(`SELECT secret FROM vault LIMIT 1`).get() as { secret: string }).secret;
  } catch {
    secret = null;
  }
  db.close();
  return { tables, version, secret };
};

/**
 * The refusal printed "Nothing was written to it: the check reads through a read-only handle" and
 * `TRY-THIS.md` promised the file was "byte-for-byte as it was found". Both were false for a
 * WAL-mode foreign database: the read-only probe could not clean up after itself, so it left `-shm`
 * and `-wal` beside the file it had just declined to touch. The transcript's own example was not
 * WAL, which is how a claim that is literally true stays generally false.
 */
describe('refusing a foreign WAL database leaves it as it found it', () => {
  it('creates no sidecar it does not remove, and changes no row', () => {
    scratch = mkdtempSync(join(tmpdir(), 'wal-'));
    const foreign = join(scratch, 'someone-elses.sqlite');
    const d = new Database(foreign);
    d.pragma('journal_mode = WAL');
    d.exec(`CREATE TABLE vault (id INTEGER PRIMARY KEY, secret TEXT);`);
    d.prepare(`INSERT INTO vault (secret) VALUES ('mine')`).run();
    d.close();

    const listing = (): string[] => readdirSync(scratch as string).sort();
    const digest = (): string => createHash('sha256').update(readFileSync(foreign)).digest('hex');
    const before = { files: listing(), sha: digest() };
    expect(before.files).toEqual(['someone-elses.sqlite']);

    expect(() => openControlPlaneDatabase(foreign)).toThrow(ForeignDatabaseError);

    // Pre-fix this was ['someone-elses.sqlite', '...-shm', '...-wal'].
    expect(listing()).toEqual(before.files);
    expect(digest()).toBe(before.sha);
    expect(inspect(foreign)).toEqual({ tables: 1, version: 0, secret: 'mine' });
  });
});

describe('the database identity proof cannot be raced', () => {
  it('writes no schema into a foreign file swapped in under the path', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'race-'));
    const real = join(scratch, 'real-control-plane.sqlite');
    const victim = join(scratch, 'someone-elses.sqlite');
    const link = join(scratch, 'control-plane.sqlite');
    openDatabase(real).close();
    const v = new Database(victim);
    v.exec(`CREATE TABLE vault (id INTEGER PRIMARY KEY, secret TEXT);`);
    v.prepare(`INSERT INTO vault (secret) VALUES ('mine')`).run();
    v.close();
    const before = inspect(victim);
    expect(before).toEqual({ tables: 1, version: 0, secret: 'mine' });

    symlinkSync(real, link);
    const until = Date.now() + 3000;
    const flipper = spawn(process.execPath, ['-e', FLIPPER, link, real, victim, String(until)], {
      stdio: 'ignore',
    });
    let refused = 0;
    let opened = 0;
    const untyped: string[] = [];
    try {
      while (Date.now() < until) {
        try {
          openControlPlaneDatabase(link).close();
          opened += 1;
        } catch (error) {
          if (error instanceof ForeignDatabaseError) refused += 1;
          else untyped.push((error as Error).message);
        }
      }
    } finally {
      flipper.kill('SIGKILL');
    }

    // The point: not one of those calls leaked into a write. Pre-fix this read `tables: 27`,
    // `version: 1`, because `migrate()` ran on a second open of a path the probe had refused.
    expect(inspect(victim)).toEqual(before);
    // Both halves must have happened, or the attacker never got a turn and the line above would
    // pass for the wrong reason.
    expect(opened, 'the real database must have been opened at least once').toBeGreaterThan(0);
    expect(refused, 'the victim must have been seen and refused at least once').toBeGreaterThan(0);
    // A path that resolves to nothing mid-rename is still a refusal to open a control-plane
    // database, so it must arrive as one. Pre-fix the second open's `SqliteError` escaped untyped.
    expect(untyped, 'every failure must be the named refusal').toEqual([]);
  }, 30_000);
});
