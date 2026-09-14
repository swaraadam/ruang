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
 *
 * (One exception to the first, stated rather than left implied: the optional static branch at the
 * bottom maps request paths to files. It has no caller in this repo and is not hardened — issue #87.)
 *
 * One thing it does have, because its absence was a hole: A BROWSER ORIGIN CHECK ON EVERY REQUEST.
 * Binding to loopback is a boundary against the network and not against the browser — a WebSocket
 * handshake is exempt from the same-origin policy, so any page the owner visits could open this
 * stream and read the whole durable log, and any name that resolves to 127.0.0.1 could reach the
 * HTTP route with the browser's CORS backstop removed. Both halves are checked below, on one hook,
 * so that every route added to this instance later inherits the check rather than the hole (§4.2).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Db, StoredEvent } from '@internal/persistence';
import { eventLogIsWhole, readSince } from '@internal/persistence';
import type { DurableEvent } from '@internal/protocol';
import { isDurableEvent } from '@internal/protocol';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { IncompleteHistoryError, officeSnapshot } from './snapshot.js';

export type GatewayOptions = {
  readonly db: Db;
  readonly owner_id: string;
  /**
   * The one canonical browser origin, e.g. `https://<hostname>`. REQUIRED: a gateway that does not
   * know which origin is canonical cannot enforce it, and defaulting would be inventing one.
   *
   * The caller supplies it for the same reason it supplies the database path — this process must
   * not spell product identifiers while naming clearance is an open Phase -1 gate (CLAUDE.md §1).
   * `config/naming.ts` is the single source; `scripts/dev.sh` reads it from there and exports it.
   */
  readonly canonical_origin: string;
  /** Built web assets. Omitted in tests and whenever the bundle has not been built. */
  readonly web_root?: string;
  /** Largest gap this will replay in one go before telling the client to re-snapshot instead. */
  readonly max_replay?: number;
};

/** What the stream sends. A closed set: a renderer with no case for a frame must fail to compile. */
export type StreamFrame =
  | { readonly kind: 'events'; readonly events: readonly DurableEvent[] }
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

/**
 * Loopback names. Not a policy choice: these are the only authorities that reach this process
 * without passing through a resolver an attacker can answer for. A hostile domain rebound to
 * 127.0.0.1 still travels with ITS OWN name in the Host header, which is the half of the check that
 * closes DNS rebinding. The port is deliberately not pinned — the port is not what a rebind forges,
 * and tests, `pnpm dev` and a launch agent all bind different ones.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The canonical origin, parsed once. `host` carries its port when the origin names one. */
type CanonicalOrigin = { readonly origin: string; readonly host: string };

const parseCanonicalOrigin = (raw: string): CanonicalOrigin => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayStartupRefusal(
      `refusing to start: canonical_origin is not a URL: ${raw}\n` +
        '  expected an origin such as https://<hostname>, from config/naming.ts.',
    );
  }
  const bare =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  if (!bare) {
    throw new GatewayStartupRefusal(
      `refusing to start: canonical_origin must be a bare http(s) origin, got ${raw}\n` +
        '  an origin is scheme + host + port and nothing else; a path or a credential here would\n' +
        '  mean the value being compared against is not the value a browser sends.',
    );
  }
  return { origin: url.origin.toLowerCase(), host: url.host.toLowerCase() };
};

/** The hostname half of an authority, keeping an IPv6 literal's brackets. */
const hostnameOf = (authority: string): string => {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  const colon = authority.indexOf(':');
  return colon === -1 ? authority : authority.slice(0, colon);
};

const firstValue = (raw: string | readonly string[] | undefined): string | undefined =>
  Array.isArray(raw) ? raw[0] : (raw as string | undefined);

export type BoundaryRequest = {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly sec_fetch_site: string | undefined;
  /** `http` or `https`, as this process itself received it. */
  readonly scheme: string;
  /** A WebSocket handshake. Browsers ALWAYS send `Origin` on one; other clients need not. */
  readonly upgrade: boolean;
};

/**
 * Whether a request may cross the browser boundary. `null` means yes; a string says why not.
 *
 * Three rules, and the order matters because each one narrows what the next can assume.
 *
 * 1. **Host must name this gateway.** Loopback (any port) or the canonical origin's host. This is
 *    the anti-rebinding half: `evil.test` may resolve to 127.0.0.1, but the browser still sends
 *    `Host: evil.test`, and a gateway that answers to any name answers to that one.
 * 2. **A present Origin must be the canonical origin or this request's own.** `Origin: null` is a
 *    string, not an absence — sandboxed iframes, some `file://` contexts and redirected requests
 *    send it — so it is refused by name rather than falling through a `!== undefined` test.
 * 3. **A missing Origin is treated differently on the two doors, deliberately.**
 *    - On a WebSocket handshake it is REFUSED. RFC 6455 §4.1 requires a browser client to send
 *      `Origin`; absence therefore means "not a browser", and the browser is the entire threat
 *      model for this stream. Refusing costs a browser nothing and removes the oldest bypass
 *      there is, which is to omit the header being checked.
 *    - On the HTTP route it is ACCEPTED, provided rule 1 passed and `Sec-Fetch-Site` does not say
 *      otherwise. This is not laxity, it is the only way to serve the renderer: browsers omit
 *      `Origin` on SAME-ORIGIN GET and HEAD, so the office's own `fetch` carries none, and neither
 *      does `curl`. Nothing is opened by allowing it — a cross-origin browser READ always carries
 *      `Origin`, and a cross-origin load that does not (an `<img>`, a `<script>`) cannot read the
 *      body it triggers. The one real no-Origin read is DNS rebinding, and rule 1 refused it.
 *      `Sec-Fetch-Site` is then checked for what it is worth: when a browser does send it, only
 *      `same-origin` and `none` (a typed URL, a bookmark) get through, which makes the argument
 *      above enforced rather than merely reasoned.
 */
export const boundaryRefusal = (
  request: BoundaryRequest,
  canonical: CanonicalOrigin,
): string | null => {
  const host = request.host?.trim().toLowerCase();
  if (host === undefined || host === '' || /[\s,]/.test(host)) {
    return 'a request must carry exactly one Host header naming this gateway';
  }
  if (host !== canonical.host && !LOOPBACK.has(hostnameOf(host))) {
    return 'the Host header does not name this gateway';
  }

  const origin = request.origin?.trim().toLowerCase();
  if (origin !== undefined && origin !== '') {
    if (origin === 'null') return 'Origin: null is not an origin this gateway serves';
    const own = `${request.scheme.toLowerCase()}://${host}`;
    if (origin !== canonical.origin && origin !== own) {
      return 'Origin is not the canonical origin of this gateway';
    }
    return null;
  }

  if (request.upgrade) {
    return 'a WebSocket handshake must carry an Origin header';
  }
  const site = request.sec_fetch_site?.trim().toLowerCase();
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return `a request with no Origin and Sec-Fetch-Site: ${site} is not same-origin`;
  }
  return null;
};

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
  const canonical = parseCanonicalOrigin(options.canonical_origin);
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // ONE hook, before routing, so the boundary is a property of the instance and not of a route.
  // @fastify/websocket runs upgrades through this same lifecycle, so replying here refuses the
  // handshake itself: the socket never opens and no frame is ever written to it. A per-route check
  // would have to be remembered on every route added after this one, and the POST verbs (§15.1)
  // land on this instance.
  app.addHook('onRequest', (request, reply, done) => {
    const refusal = boundaryRefusal(
      {
        host: request.headers.host,
        origin: request.headers.origin,
        sec_fetch_site: firstValue(request.headers['sec-fetch-site']),
        scheme: request.protocol,
        upgrade: firstValue(request.headers.upgrade)?.toLowerCase() === 'websocket',
      },
      canonical,
    );
    if (refusal === null) {
      done();
      return;
    }
    // Deliberately terse. The caller that needs the detail is the owner reading their own console,
    // not the page that just tried; naming the canonical origin in a body a rebound request could
    // read would hand back the one value the check is about.
    void reply.code(403).send({ error: 'forbidden_origin', detail: refusal });
  });

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

    // FIRST, the same question `/api/office/state` asks, of the same log, through the same
    // predicate: is this history whole? `readSince` alone cannot answer it, because it checks
    // contiguity from the CALLER'S resume point -- so a client told "409, the log has a hole" could
    // ask this door for the missing sequence and receive a clean run over the top of it. The 409 and
    // this refusal are now one rule with two shapes, not two implementations that agreed by luck.
    if (!eventLogIsWhole(db, owner_id)) {
      send({
        kind: 'resync',
        reason: 'history is not contiguous; fetch /api/office/state',
        seq: since,
      });
      socket.close();
      return;
    }

    // THEN the caller's own range. `readSince` answers null rather than a partial page, which here
    // means a resume point past the end of the log -- refusing to stream it is cheaper than a client
    // that believes it caught up. Same for a gap larger than one replay.
    //
    // It asks for one row MORE than it will ever send. Reading exactly `maxReplay` cannot tell a
    // full page from a page that happens to end the log, so the old check called a complete replay
    // an overflow and told the client so. Refusing is safe; a reason that is false is not.
    const events = readSince(db, owner_id, since, maxReplay + 1);
    if (events === null) {
      send({
        kind: 'resync',
        reason: `history cannot be resumed from ${String(since)}; fetch /api/office/state`,
        seq: since,
      });
      socket.close();
      return;
    }
    if (events.length > maxReplay) {
      send({
        kind: 'resync',
        reason: `the gap from ${String(since)} exceeds one replay; fetch /api/office/state`,
        seq: since,
      });
      socket.close();
      return;
    }

    // Validate outbound at the boundary too, and SEND THE VALUE THAT PASSED. Checking one shape and
    // transmitting another proves nothing about what the renderer receives, so each envelope is
    // built once, validated, and kept; the row itself never reaches the wire. An event this gateway
    // cannot prove is well-formed is one it must not assert to a renderer -- the validator is the
    // same one the writer used, so a failure here means the row is wrong, not the wire.
    const envelopes: DurableEvent[] = [];
    for (const e of events) {
      const envelope = toEnvelope(e);
      if (!isDurableEvent(envelope)) {
        send({
          kind: 'error',
          reason: `stored event at seq ${String(e.seq)} is not a durable event`,
        });
        socket.close();
        return;
      }
      envelopes.push(envelope);
    }

    send({ kind: 'events', events: envelopes });

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

/**
 * A startup condition this process can name, as opposed to a stack trace from three layers down.
 * `name` is stable so the `start` script can print the message alone and keep stacks for the
 * failures it did not anticipate.
 */
export class GatewayStartupRefusal extends Error {
  public override readonly name = 'GatewayStartupRefusal';
}

/**
 * Which database to open. The answer is always the caller's, never this process's.
 *
 * The gateway used to default to a repo-root-relative literal, and that single line was wrong twice:
 * it spelled the filename itself (a second spelling of `config/naming.ts`'s `dbFile`, which CLAUDE.md
 * §1 forbids while naming clearance is open) and it assumed a working directory this process does
 * not have — `pnpm --filter @internal/gateway start` runs with cwd `apps/gateway/`, so the literal
 * resolved to `apps/gateway/state/dev/...`. Guessing produced a path that existed nowhere.
 *
 * So it does not guess. A package deep in the tree cannot know the repo root and must not know the
 * product's filenames; whoever knows both — `scripts/dev.sh`, a launch agent, a test — passes an
 * absolute path. Refusing is invariant 4 applied to startup: an unknown basis for the whole
 * snapshot refuses to serve rather than open some file and render whatever is in it.
 */
export const resolveDatabasePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const raw = env['SEED_DB_PATH'];
  if (raw === undefined || raw.trim() === '') {
    throw new GatewayStartupRefusal(
      'refusing to start: no database was named.\n' +
        '  set SEED_DB_PATH to the absolute path of the control-plane database.\n' +
        '  `pnpm dev` does this for you from the one source (config/naming.ts via scripts/seed.ts);\n' +
        '  this process does not name database files and does not know the repository root.',
    );
  }
  const path = raw.trim();
  if (!isAbsolute(path)) {
    // A relative path here is resolved against `apps/gateway/`, which is never what the caller
    // meant. Saying so beats opening the wrong file, or creating one.
    throw new GatewayStartupRefusal(
      `refusing to start: SEED_DB_PATH must be absolute, got ${path}\n` +
        `  this process runs with cwd ${process.cwd()}, not the repository root.`,
    );
  }
  if (!existsSync(path)) {
    // better-sqlite3 would CREATE an empty database here, and an empty office is a claim: "the
    // owner has no projects". Nothing durable ever said that. Invariant 1.
    //
    // **This is the first of two refusals and the weaker one.** Existence is not identity: a file
    // being present says nothing about whose it is, and this check passed for a symlink to an
    // unrelated database, into which the migration then wrote all 26 control-plane tables before
    // the gateway served `{"projects":[]}` — the very claim the paragraph above says it refuses to
    // make. `openControlPlaneDatabase` proves identity; this one survives only because "there is
    // no database yet, run the seed" is a more useful thing to say than "that file is not ours".
    throw new GatewayStartupRefusal(
      `refusing to start: no database at ${path}\n` +
        '  run `pnpm seed` first — serving an empty database would render an office durable truth never said.',
    );
  }
  return path;
};

/**
 * Which origin is canonical. The answer is always the caller's, never this process's.
 *
 * Same rule as the database path and for the same reason: `config/naming.ts` is the single source
 * of every product identifier while naming clearance is an open Phase -1 gate, and a package deep
 * in the tree must not carry a second spelling of one (CLAUDE.md §1). `scripts/dev.sh` reads it
 * from there and exports it, exactly as it does `SEED_DB_PATH`.
 *
 * Refusing when it is unset is invariant 4 applied to a boundary: a gateway that does not know
 * which origin is canonical cannot enforce one, and the failure mode of guessing is a control plane
 * readable by any page the owner visits.
 */
export const resolveCanonicalOrigin = (env: NodeJS.ProcessEnv = process.env): string => {
  const raw = env['CANONICAL_ORIGIN'];
  if (raw === undefined || raw.trim() === '') {
    throw new GatewayStartupRefusal(
      'refusing to start: no canonical origin was named.\n' +
        '  set CANONICAL_ORIGIN to the one origin a browser may reach this gateway from.\n' +
        '  `pnpm dev` does this for you from the one source (config/naming.ts);\n' +
        '  this process does not name hostnames and must not, while naming clearance is open.',
    );
  }
  return raw.trim();
};

/**
 * Present so `pnpm dev` has something to exec. Nothing here runs at import.
 *
 * Returns the instance so a caller (a test, a supervisor) can close it. A server nobody can stop is
 * a server nobody can test.
 */
export const start = async (): Promise<FastifyInstance> => {
  const { ForeignDatabaseError, openControlPlaneDatabase } = await import('@internal/persistence');
  const dbPath = resolveDatabasePath();
  const canonicalOrigin = resolveCanonicalOrigin();
  // Identity before the handle: `openControlPlaneDatabase` proves the file IS this system's control
  // plane through a read-only probe, so a path that names something else is refused without a table
  // being created in it. `openDatabase` here would create or convert whatever it was pointed at.
  let db;
  try {
    db = openControlPlaneDatabase(dbPath);
  } catch (error) {
    if (error instanceof ForeignDatabaseError) {
      throw new GatewayStartupRefusal(
        `refusing to start: ${error.message}\n` +
          '  Serving it would answer with an office assembled from a database nobody here wrote.',
      );
    }
    throw error;
  }
  const app = await createGateway({
    db,
    owner_id: readOwnerFromEnv(),
    canonical_origin: canonicalOrigin,
  });
  const port = Number(process.env.PORT ?? 4319);
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`gateway listening on http://127.0.0.1:${String(bound)}  database: ${dbPath}`);
  return app;
};
