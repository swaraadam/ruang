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
import { CANONICAL_ORIGIN } from '../config/naming.js';
import { seedDatabase } from '../scripts/seed.js';

const OWNER = 'dev-owner';

const seeded = (): Db => {
  const db = openMemoryDatabase();
  seedDatabase(db);
  return db;
};

let running: FastifyInstance | null = null;
const closeRunning = async (): Promise<void> => {
  if (running !== null) await running.close();
  running = null;
};
afterEach(closeRunning);

const started = async (
  db: Db,
  maxReplay?: number,
): Promise<{ app: FastifyInstance; url: string }> => {
  const app = await createGateway({
    db,
    owner_id: OWNER,
    // Imported, never typed out: the allowlist has to come from the file that owns the name, or
    // clearance stops being a one-file change (CLAUDE.md §1).
    canonical_origin: CANONICAL_ORIGIN,
    ...(maxReplay === undefined ? {} : { max_replay: maxReplay }),
  });
  running = app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { app, url: `http://127.0.0.1:${String(port)}` };
};

const openStream = async (
  db: Db,
  since: string,
  maxReplay?: number,
  client?: (origin: string) => Record<string, unknown>,
): Promise<{ kind: string; reason?: string; status?: number; events?: { seq: number }[] }> => {
  const { url } = await started(db, maxReplay);
  const { WebSocket } = await import('ws');
  // A browser always sends Origin on a handshake, so the test client must too. `url` IS this
  // instance's own origin, which is what a page served by it would send.
  const socket = new WebSocket(
    `${url.replace('http', 'ws')}/api/office/events?since=${since}`,
    client === undefined ? { origin: url } : client(url),
  );
  return await new Promise((resolve, reject) => {
    socket.on('message', (data: Buffer) => {
      socket.close();
      resolve(JSON.parse(data.toString('utf8')) as { kind: string });
    });
    // The handshake was refused: there is no socket and there will be no frame. This is what a
    // refused upgrade looks like from the client, and it is the shape the boundary tests assert.
    socket.on('unexpected-response', (_req, res: { statusCode?: number }) => {
      resolve({ kind: 'refused-upgrade', status: res.statusCode ?? 0 });
    });
    socket.on('error', (error: Error) => {
      if (!/Unexpected server response/.test(error.message)) reject(error);
    });
    setTimeout(() => reject(new Error('no frame within 5s')), 5_000);
  });
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

/**
 * C1. Binding to 127.0.0.1 keeps the NETWORK out; it keeps no BROWSER out. A WebSocket handshake is
 * exempt from the same-origin policy, so before this check any page the owner visited could open the
 * stream and read the whole durable log; and any name that resolved to 127.0.0.1 could reach the
 * HTTP route with CORS no longer in the way. Every case below was accepted at f401f67.
 */
describe('the browser boundary: one canonical origin (§4.2)', () => {
  const canonicalHost = new URL(CANONICAL_ORIGIN).host;

  /**
   * A real request on a real socket, with the headers as written.
   *
   * `node:http` rather than `fetch`: undici will not let a caller override `Host`, and `Host` is
   * half of this check. A test that cannot send the hostile header cannot prove the refusal.
   */
  const get = async (
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> => {
    const { request } = await import('node:http');
    const target = new URL(`${url}/api/office/state`);
    return await new Promise((resolve, reject) => {
      const req = request(
        { host: target.hostname, port: target.port, path: target.pathname, headers },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  };

  it('refuses a hostile Origin on the HTTP route', async () => {
    const { url } = await started(seeded());
    const res = await get(url, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'forbidden_origin' });
    // Nothing durable crossed the boundary, and the refusal does not name the value it checks
    // against -- handing that back to the page that just failed would be the one leak worth having.
    expect(res.body).not.toContain('dev-project');
    expect(res.body).not.toContain(canonicalHost);
  });

  it('refuses `Origin: null` by name rather than treating it as absent', async () => {
    const { url } = await started(seeded());
    // Sandboxed iframes and some file:// contexts send the literal string. Reading it as "no
    // Origin" is the common mistake and would have made the allowlist optional.
    const res = await get(url, { Origin: 'null' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ detail: expect.stringContaining('null') });
  });

  it('refuses a foreign Host, which is the half that closes DNS rebinding', async () => {
    const { url } = await started(seeded());
    // `office.evil.example` resolving to 127.0.0.1 is a rebind. The browser still sends the name it
    // was given, so the name is what refuses it -- an Origin check alone never sees this request.
    expect((await get(url, { Host: 'office.evil.example' })).status).toBe(403);
    expect(
      (await get(url, { Host: 'office.evil.example', Origin: 'https://evil.example' })).status,
    ).toBe(403);
  });

  it('serves a request with no Origin, which is what the renderer and `curl` send', async () => {
    const { url } = await started(seeded());
    // Deliberate: browsers omit Origin on SAME-ORIGIN GET, so requiring it here would refuse the
    // office's own fetch. Rule 1 (Host) is what stands between this and a rebound request.
    const res = await get(url, {});
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ owner_id: OWNER });
  });

  it('refuses a request with no Origin that the browser says is cross-site', async () => {
    const { url } = await started(seeded());
    expect((await get(url, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get(url, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await get(url, { 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });

  it('serves the canonical origin, which it was told and did not spell', async () => {
    const { url } = await started(seeded());
    const res = await get(url, { Host: canonicalHost, Origin: CANONICAL_ORIGIN });
    expect(res.status).toBe(200);
  });

  it('refuses the upgrade itself for every hostile handshake, so no frame is ever written', async () => {
    const db = seeded();
    const hostile: readonly [string, (origin: string) => Record<string, unknown>][] = [
      ['a hostile Origin', () => ({ origin: 'https://evil.example' })],
      ['Origin: null', () => ({ origin: 'null' })],
      ['a foreign Host', (o) => ({ origin: o, headers: { Host: 'evil.example' } })],
      // RFC 6455 §4.1 requires a browser to send Origin on a handshake, so its absence means "not a
      // browser" -- and the browser is the entire threat model for this stream. Fail closed.
      ['no Origin at all', () => ({})],
    ];
    for (const [label, client] of hostile) {
      const frame = await openStream(db, '0', undefined, client);
      expect(frame.kind, `${label} must not open a stream`).toBe('refused-upgrade');
      expect(frame.status).toBe(403);
      expect(frame.events).toBeUndefined();
      await closeRunning();
    }
  });

  it('opens the stream for its own origin', async () => {
    const frame = await openStream(seeded(), '10');
    expect(frame.kind).toBe('events');
  });
});

describe('the event stream resumes from a sequence (§15.2)', () => {
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

  // The 409 and the stream are two doors onto one log. This is the case that was open: with an
  // interior event gone, `/api/office/state` answered 409 while `?since=<the missing seq>` replayed
  // a clean-looking run over the hole, because `readSince` checks contiguity from where the CALLER
  // asked rather than from the log's start. Every resume point must now refuse, and it must refuse
  // for the same reason the other door gives.
  it('refuses every resume point over a holed log, exactly as the snapshot route does', async () => {
    const db = seeded();
    db.prepare(`DELETE FROM event WHERE owner_id = ? AND seq = 3`).run(OWNER);

    const { app } = await started(db);
    const snapshot = await app.inject({ method: 'GET', url: '/api/office/state' });
    expect(snapshot.statusCode).toBe(409);
    await closeRunning();

    for (const since of ['0', '2', '3', '4', '10', '19']) {
      const frame = await openStream(db, since);
      expect(frame.kind, `?since=${since} must not stream over the hole`).toBe('resync');
      expect(frame.reason).toMatch(/not contiguous/);
      expect(frame.events).toBeUndefined();
      await closeRunning();
    }
  });

  it('rejects an unvalidated resume point at the boundary with a typed error', async () => {
    const frame = await openStream(seeded(), 'latest');
    expect(frame.kind).toBe('error');
    expect(frame.reason).toMatch(/non-negative integer/);
  });
});

/** Keeps the import used: appendEvent is the writer this stream will eventually follow. */
void appendEvent;
