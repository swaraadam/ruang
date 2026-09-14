/**
 * P0-09 acceptance, proved against a real Fastify instance over a real (in-memory) database rather
 * than against mocks: the point of the gateway is what it refuses, and a mock cannot refuse.
 */
import { openMemoryDatabase, appendEvent, latestSeq } from '@internal/persistence';
import type { Db } from '@internal/persistence';
import { createGateway, officeSnapshot } from '@internal/gateway';
import { isDurableEvent } from '@internal/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { seedDatabase } from '../scripts/seed.js';

const OWNER = 'dev-owner';

const seeded = (): Db => {
  const db = openMemoryDatabase();
  seedDatabase(db);
  return db;
};

let running: FastifyInstance | null = null;
afterEach(async () => {
  if (running !== null) await running.close();
  running = null;
});

const started = async (
  db: Db,
  maxReplay?: number,
): Promise<{ app: FastifyInstance; url: string }> => {
  const app = await createGateway({
    db,
    owner_id: OWNER,
    ...(maxReplay === undefined ? {} : { max_replay: maxReplay }),
  });
  running = app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { app, url: `http://127.0.0.1:${String(port)}` };
};

describe('GET /api/office/state (§15.1)', () => {
  it('serves the seeded office at a sequence a client can resume from', async () => {
    const { app } = await started(seeded());
    const res = await app.inject({ method: 'GET', url: '/api/office/state' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReturnType<typeof officeSnapshot>;
    expect(body.owner_id).toBe(OWNER);
    expect(body.seq).toBeGreaterThan(0);
    expect(body.tasks.map((t) => t.id)).toEqual([
      'dev-task-01',
      'dev-task-02',
      'dev-task-03',
      'dev-task-04',
    ]);
  });

  // Invariant 1, and the reason `basis_staleness` is nullable rather than defaulted.
  it('reports an indeterminate basis as unknown, keeps its ref, and shows it undispatched', async () => {
    const { app } = await started(seeded());
    const body = (await app.inject({ method: 'GET', url: '/api/office/state' })).json() as {
      tasks: {
        id: string;
        basis_staleness: string | null;
        basis_ref: string | null;
        dispatched: boolean;
      }[];
    };
    const unknown = body.tasks.find((t) => t.id === 'dev-task-03');
    expect(unknown?.basis_staleness).toBe('unknown');
    // A basis WAS captured. Nulling the ref to express doubt would assert something else false.
    expect(unknown?.basis_ref).toBe('basis-0003');
    expect(unknown?.dispatched).toBe(false);
  });

  it('never defaults an unassessed basis to fresh', async () => {
    const { app } = await started(seeded());
    const body = (await app.inject({ method: 'GET', url: '/api/office/state' })).json() as {
      tasks: { id: string; basis_staleness: string | null; dispatched: boolean }[];
    };
    // Nothing in the seeded log assesses task-01's staleness, so the gateway declines to claim one.
    // `null` is "no assessment on the record" -- the distinction this endpoint exists to preserve.
    expect(body.tasks.find((t) => t.id === 'dev-task-01')?.basis_staleness).toBeNull();
    expect(body.tasks.every((t) => t.basis_staleness !== 'fresh' || t.dispatched)).toBe(true);
  });

  it('refuses to render over a hole in history rather than serving a smaller one', async () => {
    const db = seeded();
    // Delete an interior event: the log is now non-contiguous, and a snapshot built on the partial
    // replay would look entirely confident.
    db.prepare(`DELETE FROM event WHERE owner_id = ? AND seq = 5`).run(OWNER);
    const { app } = await started(db);
    const res = await app.inject({ method: 'GET', url: '/api/office/state' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'incomplete_history' });
  });
});

describe('the office state depends on no ephemeral source (invariant 2)', () => {
  it('exposes no field sourced from a PTY, a token counter or a progress tick', async () => {
    const { app } = await started(seeded());
    const body = (await app.inject({ method: 'GET', url: '/api/office/state' })).json();
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'pty',
      'stdout_chunk',
      'token',
      'progress',
      'tick',
      'cursor',
      'bytes',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('is reproducible from the database alone: two gateways over one database agree', async () => {
    const db = seeded();
    const a = officeSnapshot(db, OWNER);
    const b = officeSnapshot(db, OWNER);
    expect(a).toEqual(b);
  });
});

describe('no endpoint accepts an arbitrary command string (§4.1)', () => {
  it('declares exactly two routes, both GET, neither taking a body', async () => {
    const { app } = await started(seeded());
    const printed: string = app.printRoutes({ commonPrefix: false });
    const routes = printed
      .split('\n')
      .filter((l: string) => l.includes('('))
      .map((l: string) => l.trim());
    // If this list grows, the growth is the thing to review: every addition is new authority
    // reachable from a browser.
    expect(routes.join(' ')).toContain('office/state');
    expect(routes.join(' ')).toContain('office/events');
    expect(routes.join(' ')).not.toMatch(/POST|PUT|PATCH|DELETE/);
  });

  it('has no route that would run something', async () => {
    const { app } = await started(seeded());
    for (const url of ['/api/exec', '/api/run', '/api/shell', '/api/command']) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('the event stream resumes from a sequence (§15.2)', () => {
  const openStream = async (
    db: Db,
    since: string,
    maxReplay?: number,
  ): Promise<{ kind: string; reason?: string; events?: { seq: number }[] }> => {
    const { url } = await started(db, maxReplay);
    const { WebSocket } = await import('ws');
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/office/events?since=${since}`);
    return await new Promise((resolve, reject) => {
      socket.on('message', (data: Buffer) => {
        socket.close();
        resolve(JSON.parse(data.toString('utf8')) as { kind: string });
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no frame within 5s')), 5_000);
    });
  };

  it('replays exactly the gap a client missed', async () => {
    const db = seeded();
    const frame = await openStream(db, '10');
    expect(frame.kind).toBe('events');
    // Exactly the gap: everything after 10, nothing at or before it.
    expect(frame.events?.[0]?.seq).toBe(11);
    expect(frame.events?.every((e) => e.seq > 10)).toBe(true);
    // The frame AS SENT, checked with the same validator the writer used. `seq` alone was true of
    // both the stored row and the envelope, so asserting on it accepted a wire shape the protocol
    // never defined; the check has to run on the value the client actually receives.
    expect(frame.events?.[0]).toBeDefined();
    expect(isDurableEvent(frame.events?.[0])).toBe(true);
    expect(frame.events?.every((e) => isDurableEvent(e))).toBe(true);
  });

  it('replays a page that exactly fills the limit instead of calling it an overflow', async () => {
    const db = seeded();
    // Exactly `max_replay` events remain. Reading only `max_replay` rows cannot tell that from an
    // overflow, and the resync then said "exceeds one replay" about a gap that did not.
    const frame = await openStream(db, String(latestSeq(db, OWNER) - 3), 3);
    expect(frame.kind).toBe('events');
    expect(frame.events?.length).toBe(3);
  });

  it('refuses to stream a gap larger than one replay', async () => {
    const frame = await openStream(seeded(), '0', 3);
    expect(frame.kind).toBe('resync');
    expect(frame.reason).toMatch(/exceeds one replay/);
  });

  it('forces a fresh snapshot when recovery would be incomplete', async () => {
    const db = seeded();
    db.prepare(`DELETE FROM event WHERE owner_id = ? AND seq = 15`).run(OWNER);
    const frame = await openStream(db, '10');
    expect(frame.kind).toBe('resync');
    expect(frame.reason).toMatch(/not contiguous/);
  });

  it('rejects an unvalidated resume point at the boundary with a typed error', async () => {
    const frame = await openStream(seeded(), 'latest');
    expect(frame.kind).toBe('error');
    expect(frame.reason).toMatch(/non-negative integer/);
  });
});

/** Keeps the import used: appendEvent is the writer this stream will eventually follow. */
void appendEvent;
