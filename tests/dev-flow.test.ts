/**
 * The seam nothing tested: `pnpm seed` writes a database and `pnpm dev` opens it.
 *
 * `tests/gateway.test.ts` proves the routes against an in-memory database it builds itself, so every
 * assertion there passed while the documented three-command flow crashed on command two. The gateway
 * used to carry a database path of its own, and it was wrong twice over: the filename was a second,
 * differently spelled copy of `config/naming.ts`'s `dbFile` (CLAUDE.md §1 forbids copying those
 * strings at all while naming clearance is open), and the path was relative, while
 * `pnpm --filter @internal/gateway start` runs with cwd `apps/gateway/`. Two independent defects in
 * one line, zero failing tests — because no test went through the wiring.
 *
 * These do. Nothing below imports a symbol the broken version lacked: each one runs the real script
 * or the real `start()` and asserts on behaviour, so it fails against the old code by doing the
 * wrong thing rather than by failing to load.
 */
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '@internal/gateway';
import { openDatabase } from '@internal/persistence';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { CANONICAL_ORIGIN, PLACEHOLDER } from '../config/naming.js';
import { DEV_DB_PATH, seedDatabase } from '../scripts/seed.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const saved = new Map<string, string | undefined>();
let running: FastifyInstance | null = null;
let scratch: string | null = null;

const setEnv = (
  key: 'SEED_DB_PATH' | 'PORT' | 'CANONICAL_ORIGIN',
  value: string | undefined,
): void => {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(async () => {
  if (running !== null) await running.close();
  running = null;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A real file database, at the one filename, seeded through the ordinary append path. */
const seedTempDatabase = (): string => {
  scratch = mkdtempSync(join(tmpdir(), 'office-'));
  const path = join(scratch, PLACEHOLDER.dbFile);
  const db = openDatabase(path);
  seedDatabase(db);
  db.close();
  return path;
};

describe('the gateway serves the database the seed wrote', () => {
  it('answers /api/office/state over a socket from a seeded file database', async () => {
    setEnv('SEED_DB_PATH', seedTempDatabase());
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);

    running = await start();
    const { port } = running.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/office/state`);
    const body = (await response.json()) as {
      seq: number;
      owner_id: string;
      tasks: { id: string; basis_staleness: string | null; dispatched: boolean }[];
      locks: { disposition: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.owner_id).toBe('dev-owner');
    expect(body.seq).toBe(20);
    expect(body.tasks.map((t) => t.id)).toEqual([
      'dev-task-01',
      'dev-task-02',
      'dev-task-03',
      'dev-task-04',
    ]);
    // Not merely that bytes moved: the unknown basis survived a file, a process and HTTP without
    // being rounded to fresh, and is still undispatched (invariants 1 and 4).
    const unknown = body.tasks.find((t) => t.id === 'dev-task-03');
    expect(unknown?.basis_staleness).toBe('unknown');
    expect(unknown?.dispatched).toBe(false);
    expect(body.locks[0]?.disposition).toBe('held-by-frozen-task');
  });
});

describe('the gateway names no database of its own (invariants 1 and 4)', () => {
  it('refuses to start when nothing told it which database', async () => {
    setEnv('SEED_DB_PATH', undefined);
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);
    // The old default opened a filename this process invented. Refusing, and naming the variable
    // to set, is the only honest answer: a package cannot know the repository root.
    await expect(start()).rejects.toThrow(/SEED_DB_PATH/);
  });

  it('refuses a relative path, because its own cwd is not the repository root', async () => {
    setEnv('SEED_DB_PATH', join('state', 'dev', PLACEHOLDER.dbFile));
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);
    await expect(start()).rejects.toThrow(/absolute/);
  });

  it('refuses a database that does not exist rather than creating an empty one', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'office-'));
    const missing = join(scratch, PLACEHOLDER.dbFile);
    setEnv('SEED_DB_PATH', missing);
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);
    // better-sqlite3 creates a database when the directory exists, so serving an unseeded path
    // would render an empty office — a claim durable truth never made.
    await expect(start()).rejects.toThrow(/pnpm seed/);
    expect(existsSync(missing)).toBe(false);
  });
});

/**
 * M1. The refusal this PR added checked that SOMETHING EXISTED at the path and called that knowing
 * what it was. `existsSync` follows symlinks; `openDatabase` then opens read-write and migrates. At
 * f401f67 this test's victim went from one table to twenty-seven, `user_version` 0 to 1, and the
 * gateway served `{"seq":0,"projects":[]}` from it — the exact empty-office claim the refusal was
 * written to prevent.
 */
describe('the gateway proves the database is its own before opening it (invariant 1)', () => {
  it('refuses a symlink to an unrelated database without writing a table into it', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'foreign-'));
    const victim = join(scratch, 'someone-elses.db');
    const link = join(scratch, PLACEHOLDER.dbFile);
    const unrelated = new Database(victim);
    unrelated.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);`);
    unrelated.close();
    symlinkSync(victim, link);

    const inspect = (): { tables: string[]; version: number } => {
      const db = new Database(victim, { readonly: true });
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      const version = db.pragma('user_version', { simple: true }) as number;
      db.close();
      return { tables, version };
    };
    const before = inspect();

    setEnv('SEED_DB_PATH', link);
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);
    await expect(start()).rejects.toThrow(/not this system's control-plane database/);

    // The point is not only that it refused. A read-only probe cannot write, so the file it
    // declined to serve is exactly as it was found.
    const after = inspect();
    expect(after.tables).toEqual(before.tables);
    expect(after.tables).toEqual(['notes']);
    expect(after.version).toBe(0);
  });

  it('refuses a file that is not a database at all', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'foreign-'));
    const notADatabase = join(scratch, PLACEHOLDER.dbFile);
    writeFileSync(notADatabase, 'this is a text file\n');
    setEnv('SEED_DB_PATH', notADatabase);
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);
    await expect(start()).rejects.toThrow(/GatewayStartupRefusal|control-plane/);
  });
});

/**
 * C1, through the real `start()` rather than through a hand-built instance: the boundary is only
 * real if the process `pnpm dev` launches has it.
 */
describe('the gateway is told its canonical origin and enforces it (§4.2)', () => {
  it('refuses to start when nothing named the canonical origin', async () => {
    setEnv('SEED_DB_PATH', seedTempDatabase());
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', undefined);
    // A gateway that does not know which origin is canonical cannot enforce one, and the failure
    // mode of guessing is a control plane readable by any page the owner visits.
    await expect(start()).rejects.toThrow(/CANONICAL_ORIGIN/);
  });

  it('hands no durable event to a hostile origin over a real socket', async () => {
    setEnv('SEED_DB_PATH', seedTempDatabase());
    setEnv('PORT', '0');
    setEnv('CANONICAL_ORIGIN', CANONICAL_ORIGIN);
    running = await start();
    const { port } = running.server.address() as AddressInfo;

    const refused = await fetch(`http://127.0.0.1:${String(port)}/api/office/state`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(refused.status).toBe(403);

    const { WebSocket } = await import('ws');
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/office/events?since=0`, {
        origin: 'https://evil.example',
      });
      socket.on('message', (d: Buffer) => resolve(`FRAME ${d.toString('utf8').slice(0, 40)}`));
      socket.on('unexpected-response', (_r, res: { statusCode?: number }) =>
        resolve(`refused ${String(res.statusCode)}`),
      );
      socket.on('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused 403');
  });
});

describe('`pnpm dev` resolves the path from the one source', () => {
  const devSh = (env: Record<string, string>, ...args: string[]) =>
    spawnSync('./scripts/dev.sh', args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...env },
    });

  it('opens exactly the path `pnpm seed` writes, spelled only in config/naming.ts', () => {
    const run = devSh({}, '--print-db-path');
    expect(run.status).toBe(0);
    const printed = run.stdout.trim();
    // `DEV_DB_PATH` is the seed's own export and takes its filename from `PLACEHOLDER.dbFile`.
    // Agreement here is the whole defect: the two used to differ by one character.
    expect(printed).toBe(resolve(ROOT, DEV_DB_PATH));
    expect(basename(printed)).toBe(PLACEHOLDER.dbFile);
    expect(printed.startsWith('/')).toBe(true);
  }, 180_000);

  it('says the database is missing instead of letting a dependency throw', () => {
    scratch = mkdtempSync(join(tmpdir(), 'office-'));
    const missing = join(scratch, PLACEHOLDER.dbFile);
    const run = devSh({ SEED_DB_PATH: missing });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(missing);
    expect(run.stderr).toMatch(/pnpm seed/);
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/Cannot open database/);
  }, 180_000);
});
