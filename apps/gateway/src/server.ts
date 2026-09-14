/**
 * The one local gateway (§4.1, §15.1, §15.2): one authority, typed operations only.
 *
 * Two things this deliberately does not have, because their absence is the security property:
 *
 *  - NO ENDPOINT TAKES A COMMAND STRING. Every route below is a fixed shape over durable state.
 *    A browser reaching this process cannot ask it to run anything, which is why terminal access is
 *    a separate attach token against the session backend and not a verb here.
 *  - NO EPHEMERAL SOURCE. The snapshot is built from rows and durable events only. PTY bytes, token
 *    deltas and progress ticks are not in the database at all (invariant 2), so there is nothing for
 *    a view to accidentally read.
 */
import { readFileSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Db, StoredEvent } from '@internal/persistence';
import { readSince } from '@internal/persistence';
import { isDurableEvent } from '@internal/protocol';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { IncompleteHistoryError, officeSnapshot } from './snapshot.js';

export type GatewayOptions = {
  readonly db: Db;
  readonly owner_id: string;
  /** Built web assets. Omitted in tests and whenever the bundle has not been built. */
  readonly web_root?: string;
  /** Largest gap this will replay in one go before telling the client to re-snapshot instead. */
  readonly max_replay?: number;
};

/** What the stream sends. A closed set: a renderer with no case for a frame must fail to compile. */
export type StreamFrame =
  | { readonly kind: 'events'; readonly events: readonly StoredEvent[] }
  | { readonly kind: 'resync'; readonly reason: string; readonly seq: number }
  | { readonly kind: 'error'; readonly reason: string };

const DEFAULT_MAX_REPLAY = 5_000;

/**
 * The wire shape a StoredEvent becomes.
 *
 * The columns are nullable and `EventEnvelope` makes the same fields OPTIONAL and not nullable, so a
 * row spread straight onto the wire produces an envelope this repo's own validator rejects. Omitting
 * rather than nulling is the contract, written where it is used.
 */
export const toEnvelope = (e: StoredEvent): unknown => ({
  seq: e.seq,
  ts: e.ts,
  type: e.type,
  owner_id: e.owner_id,
  org_node_id: e.org_node_id,
  ...(typeof e.project_id === 'string' ? { project_id: e.project_id } : {}),
  ...(typeof e.task_id === 'string' ? { task_id: e.task_id } : {}),
  ...(typeof e.attempt_id === 'string' ? { attempt_id: e.attempt_id } : {}),
  actor: {
    member_id: e.actor_member_id,
    role_id: e.actor_role_id ?? null,
    runtime_id: e.actor_runtime_id ?? null,
  },
  payload: e.payload,
  artifact_refs: e.artifact_refs,
});

const parseSince = (raw: unknown): number | null => {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string') return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

export const createGateway = async (options: GatewayOptions): Promise<FastifyInstance> => {
  const { db, owner_id } = options;
  const maxReplay = options.max_replay ?? DEFAULT_MAX_REPLAY;
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  app.get('/api/office/state', async (_request, reply) => {
    try {
      return officeSnapshot(db, owner_id);
    } catch (error) {
      if (error instanceof IncompleteHistoryError) {
        // 409, not 500: nothing broke. The log has a hole and this refuses to render over it
        // (invariant 1). A 500 would read as "try again", and trying again will not help.
        return reply.code(409).send({ error: 'incomplete_history', detail: error.message });
      }
      throw error;
    }
  });

  app.get('/api/office/events', { websocket: true }, (socket, request) => {
    const send = (frame: StreamFrame): void => void socket.send(JSON.stringify(frame));

    const since = parseSince((request.query as Record<string, unknown>)['since']);
    if (since === null) {
      send({ kind: 'error', reason: 'since must be a non-negative integer sequence' });
      socket.close();
      return;
    }

    // `readSince` answers null rather than a partial page when history has a hole, and that is the
    // whole mechanism: an incomplete recovery must force a fresh snapshot rather than hand the
    // client a gap it cannot see. Same for a gap larger than one replay -- refusing to stream it is
    // cheaper than a client that believes it caught up.
    const events = readSince(db, owner_id, since, maxReplay);
    if (events === null) {
      send({
        kind: 'resync',
        reason: `history is not contiguous from ${String(since)}; fetch /api/office/state`,
        seq: since,
      });
      socket.close();
      return;
    }
    if (events.length === maxReplay) {
      send({
        kind: 'resync',
        reason: `the gap from ${String(since)} exceeds one replay; fetch /api/office/state`,
        seq: since,
      });
      socket.close();
      return;
    }

    // Validate outbound at the boundary too. An event this gateway cannot prove is well-formed is
    // one it must not assert to a renderer -- the validator is the same one the writer used, so a
    // failure here means the row is wrong, not the wire.
    const bad = events.find((e) => !isDurableEvent(toEnvelope(e)));
    if (bad !== undefined) {
      send({
        kind: 'error',
        reason: `stored event at seq ${String(bad.seq)} is not a durable event`,
      });
      socket.close();
      return;
    }

    send({ kind: 'events', events });

    // Inbound is validated and then refused: there is no operation to perform here yet, and a
    // silently ignored message teaches a client that it was accepted.
    socket.on('message', () => {
      send({ kind: 'error', reason: 'this stream is read-only; it accepts no operations' });
    });
  });

  if (options.web_root !== undefined) {
    await app.register(fastifyStatic, { root: options.web_root, prefix: '/' });
  }

  return app;
};

export const readOwnerFromEnv = (): string => process.env.OWNER_ID ?? 'dev-owner';

/** Present so `pnpm dev` has something to exec. Nothing here runs at import. */
export const start = async (): Promise<void> => {
  const { openDatabase } = await import('@internal/persistence');
  const dbPath = process.env.SEED_DB_PATH ?? 'state/dev/control-plane.sqlite3';
  const db = openDatabase(dbPath);
  const app = await createGateway({ db, owner_id: readOwnerFromEnv() });
  const port = Number(process.env.PORT ?? 4319);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`gateway listening on http://127.0.0.1:${String(port)}  database: ${dbPath}`);
  void readFileSync;
};
