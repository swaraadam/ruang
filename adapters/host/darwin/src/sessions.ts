/**
 * Blueprint §6.2: persistent terminals are owned by tmux, below the gateway. The gateway attaches
 * and renders; killing the gateway must not kill the work, so nothing here is a child of this
 * process.
 *
 * Reattaching one of these is a *terminal* fact and can only become `session.reattached`. Whether
 * the provider conversation inside it resumed is Seam D's answer and a different durable event;
 * this module has no way to claim it, which is the intended shape.
 */
import type {
  HostSession,
  PathPolicy,
  SessionAttachment,
  SessionManager,
} from '@internal/host-contract';
import type { DarwinEnv } from './env.js';

/** tmux reads `.` and `:` as address syntax; anything outside this set is refused, not escaped. */
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const FORMAT = '#{session_name}\t#{session_created}';

export class SessionBackendUnavailable extends Error {}

const refuse = (reason: string): SessionAttachment => ({
  outcome: 'refused',
  session: null,
  refused_reason: reason,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createSessionManager = (env: DarwinEnv, paths: PathPolicy): SessionManager => {
  const stamp = (): string => env.now().toISOString();

  const listRaw = (): readonly HostSession[] => {
    const out = env.run(['tmux', 'list-sessions', '-F', FORMAT]);
    // Backend unreachable means the set of live sessions is *unknown*. Returning `[]` would render
    // "no sessions" over "we cannot tell", which is exactly what invariant 1 forbids.
    if (out.error !== null)
      throw new SessionBackendUnavailable(`backend unreachable: ${out.error}`);
    if (out.code !== 0) {
      // A stopped server is a known-empty set, not an unknown one.
      if (/no server running|no sessions/i.test(`${out.stderr}${out.stdout}`)) return [];
      throw new SessionBackendUnavailable(out.stderr.trim() || `exit ${String(out.code)}`);
    }
    const verified = stamp();
    return out.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [name = '', created] = line.split('\t');
        const seconds = Number(created);
        return {
          session_id: name,
          host_session_ref: `tmux:${name}`,
          status: 'live' as const,
          // An unparsable timestamp is null, never `now`: a guessed creation time is a lie.
          created_at:
            Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
          last_verified_at: verified,
        };
      });
  };

  /** Either the session, or `undefined`, or a refusal because the backend could not be asked. */
  const find = (id: string): HostSession | undefined | SessionAttachment => {
    try {
      return listRaw().find((s) => s.session_id === id);
    } catch (error) {
      return refuse(message(error));
    }
  };
  const isRefusal = (v: HostSession | undefined | SessionAttachment): v is SessionAttachment =>
    v !== undefined && 'outcome' in v;

  const reattached = (session: HostSession): SessionAttachment => ({
    outcome: 'reattached',
    session: { ...session, last_verified_at: stamp() },
    refused_reason: null,
  });

  return {
    attach: (spec) => {
      if (!SESSION_NAME.test(spec.session_id)) {
        return Promise.resolve(refuse(`session id ${spec.session_id} is not addressable`));
      }
      const decision = paths.canonicalize(spec.working_directory);
      if (!decision.allowed) {
        return Promise.resolve(refuse(`working directory refused: ${decision.reason}`));
      }
      const found = find(spec.session_id);
      if (isRefusal(found)) return Promise.resolve(found);
      if (found !== undefined) return Promise.resolve(reattached(found));

      const created = env.run([
        'tmux',
        'new-session',
        '-d',
        '-s',
        spec.session_id,
        '-c',
        decision.canonical,
        ...(spec.command ?? []),
      ]);
      if (created.error !== null || created.code !== 0) {
        return Promise.resolve(
          refuse(created.error ?? (created.stderr.trim() || `exit ${String(created.code)}`)),
        );
      }
      // Verify rather than assume: a zero exit that produced no session is still no session.
      const confirmed = find(spec.session_id);
      if (isRefusal(confirmed)) return Promise.resolve(confirmed);
      return Promise.resolve(
        confirmed === undefined
          ? refuse('session did not appear after creation')
          : { outcome: 'created', session: confirmed, refused_reason: null },
      );
    },

    reattach: (session_id) => {
      if (!SESSION_NAME.test(session_id)) {
        return Promise.resolve(refuse(`session id ${session_id} is not addressable`));
      }
      const found = find(session_id);
      if (isRefusal(found)) return Promise.resolve(found);
      // Never creates: `session.reattached` must not be emittable for a session nobody kept.
      return Promise.resolve(
        found === undefined ? refuse(`no live session ${session_id}`) : reattached(found),
      );
    },

    list: () => {
      try {
        return Promise.resolve(listRaw());
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(message(error)));
      }
    },
  };
};
