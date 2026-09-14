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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '@internal/gateway';
import { openDatabase } from '@internal/persistence';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { PLACEHOLDER } from '../config/naming.js';
import { DEV_DB_PATH, seedDatabase } from '../scripts/seed.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const saved = new Map<string, string | undefined>();
let running: FastifyInstance | null = null;
let scratch: string | null = null;

const setEnv = (key: 'SEED_DB_PATH' | 'PORT', value: string | undefined): void => {
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
    // The old default opened a filename this process invented. Refusing, and naming the variable
    // to set, is the only honest answer: a package cannot know the repository root.
    await expect(start()).rejects.toThrow(/SEED_DB_PATH/);
  });

  it('refuses a relative path, because its own cwd is not the repository root', async () => {
    setEnv('SEED_DB_PATH', join('state', 'dev', PLACEHOLDER.dbFile));
    setEnv('PORT', '0');
    await expect(start()).rejects.toThrow(/absolute/);
  });

  it('refuses a database that does not exist rather than creating an empty one', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'office-'));
    const missing = join(scratch, PLACEHOLDER.dbFile);
    setEnv('SEED_DB_PATH', missing);
    setEnv('PORT', '0');
    // better-sqlite3 creates a database when the directory exists, so serving an unseeded path
    // would render an empty office — a claim durable truth never made.
    await expect(start()).rejects.toThrow(/pnpm seed/);
    expect(existsSync(missing)).toBe(false);
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
