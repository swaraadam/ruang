/**
 * The host test double — blueprint §20.5. One real Darwin implementation, one double; the core
 * suite runs against the double on any platform, and that run is the proof the seam held.
 *
 * It touches no filesystem, spawns no process and reads no clock it was not given, so every answer
 * is one a test asked for. Where a real host is uncertain it is uncertain too — `registration:
 * 'unknown'`, `confirmed_at: null` — because a double more confident than the thing it stands in
 * for tests the wrong contract.
 */
import { createManifestAutostart, createPathPolicy } from './shared.js';
import type {
  HealthProbe,
  HostAdapter,
  HostCapabilities,
  HostSession,
  NotificationOutcome,
  OwnerProcedure,
  ProbeKind,
} from './spi.js';
import { summarizeProbes } from './spi.js';

/** Sessions live in a store the caller owns. Handing the same store to a second adapter is what
 * "the gateway restarted" means to a test — the sessions are below it (§6.2). */
export type SessionStore = Map<string, HostSession>;
export const createSessionStore = (): SessionStore => new Map();

export type HostDoubleOptions = {
  readonly now?: () => Date;
  readonly capabilities?: Partial<HostCapabilities>;
  readonly allow_roots?: readonly string[];
  /** Prefix rewrites for the double's `realpath`, so a symlink escape is testable anywhere. */
  readonly symlinks?: Readonly<Record<string, string>>;
  /** Paths that resolve. Defaults to the roots, the symlink names and `/`. */
  readonly existing_paths?: readonly string[];
  readonly case_insensitive?: boolean;
  readonly sessions?: SessionStore;
  readonly manifests?: Map<string, string>;
  readonly probe_overrides?: Partial<Record<ProbeKind, Partial<HealthProbe>>>;
  readonly notify_outcome?: NotificationOutcome;
  /** False makes the backend unreachable, so the live set becomes unknown rather than empty. */
  readonly backend_available?: boolean;
};

export type HostDouble = HostAdapter & {
  readonly sessions: SessionStore;
  readonly manifests: Map<string, string>;
  /** Simulate the process inside a session exiting. */
  endSession(session_id: string): void;
};

export const createHostDouble = (options: HostDoubleOptions = {}): HostDouble => {
  const now = options.now ?? (() => new Date(0));
  const stamp = (): string => now().toISOString();
  const roots = options.allow_roots ?? ['/allowed'];
  const symlinks = options.symlinks ?? {};
  const existing = new Set(options.existing_paths ?? ['/', ...roots, ...Object.keys(symlinks)]);
  const sessions = options.sessions ?? createSessionStore();
  const manifests = options.manifests ?? new Map<string, string>();
  const up = options.backend_available !== false;

  const realpath = (path: string): string => {
    const link = Object.keys(symlinks).find((k) => path === k || path.startsWith(`${k}/`));
    const resolved =
      link === undefined ? path : `${symlinks[link] ?? ''}${path.slice(link.length)}`;
    if (!existing.has(path)) throw new Error(`ENOENT: ${path}`);
    return resolved;
  };

  const paths = createPathPolicy({
    roots,
    realpath,
    caseInsensitive: options.case_insensitive ?? false,
  });

  const procedureFor = (unit_id: string): OwnerProcedure => ({
    title: `Register autostart unit ${unit_id}`,
    why_owner_runs_it:
      'This adapter writes the manifest and stops. Registering it is an owner act so that nothing ' +
      'in an unattended run can grant itself a start-up foothold.',
    steps: [
      { instruction: `register ${unit_id} with the host service manager`, is_command: false },
    ],
  });

  const refused = (reason: string) =>
    Promise.resolve({ outcome: 'refused' as const, session: null, refused_reason: reason });

  const probe = (kind: ProbeKind, probe_id: string): HealthProbe => ({
    probe_id,
    kind,
    state: 'ok',
    observed: 'double',
    detail: 'the double reports what the test asked it to report',
    checked_at: stamp(),
    procedure: null,
    ...(options.probe_overrides?.[kind] ?? {}),
  });

  return {
    sessions,
    manifests,
    endSession: (session_id) => {
      const found = sessions.get(session_id);
      if (found !== undefined) sessions.set(session_id, { ...found, status: 'exited' });
    },

    capabilities: () =>
      Promise.resolve({
        adapter_id: 'double',
        session_backend_id: 'in-memory',
        egress_enforcement: 'advisory',
        persistent_sessions: true,
        local_notifications: true,
        biometric_step_up_via_webauthn: false,
        ...options.capabilities,
      }),

    session_manager: () => ({
      attach: (spec) => {
        if (!up) return refused('session backend unreachable');
        const found = sessions.get(spec.session_id);
        if (found?.status === 'live') {
          const session = { ...found, last_verified_at: stamp() };
          sessions.set(spec.session_id, session);
          return Promise.resolve({ outcome: 'reattached' as const, session, refused_reason: null });
        }
        if (found?.status === 'unknown') return refused(`session ${spec.session_id} is unknown`);
        const decision = paths.canonicalize(spec.working_directory);
        if (!decision.allowed) return refused(`working directory refused: ${decision.reason}`);
        const session: HostSession = {
          session_id: spec.session_id,
          host_session_ref: `double:${spec.session_id}`,
          status: 'live',
          created_at: stamp(),
          last_verified_at: stamp(),
        };
        sessions.set(spec.session_id, session);
        return Promise.resolve({ outcome: 'created' as const, session, refused_reason: null });
      },
      reattach: (session_id) => {
        if (!up) return refused('session backend unreachable');
        const found = sessions.get(session_id);
        if (found === undefined) return refused(`no session ${session_id}`);
        if (found.status !== 'live') return refused(`session is ${found.status}`);
        const session = { ...found, last_verified_at: stamp() };
        sessions.set(session_id, session);
        return Promise.resolve({ outcome: 'reattached' as const, session, refused_reason: null });
      },
      list: () =>
        up
          ? Promise.resolve([...sessions.values()])
          : Promise.reject(new Error('session backend unreachable')),
    }),

    autostart_contract: () =>
      createManifestAutostart({
        pathFor: (unit_id) => `/double/autostart/${unit_id}`,
        render: (plan) => JSON.stringify(plan),
        procedureFor,
        read: (path) => manifests.get(path) ?? null,
        write: (path, body) => void manifests.set(path, body),
      }),

    path_policy: () => paths,

    notify_local: (notification) => {
      const outcome = options.notify_outcome ?? 'handed_off';
      const ok = outcome === 'handed_off';
      return Promise.resolve({
        notification_id: notification.notification_id,
        channel_id: notification.channel_id,
        outcome,
        handed_off_at: ok ? stamp() : null,
        confirmed_at: null,
        reason: ok ? null : `double configured to answer ${outcome}`,
      });
    },

    health_probes: () =>
      Promise.resolve(
        summarizeProbes(stamp(), [
          probe('permissions', 'filesystem_access'),
          probe('power', 'sleep_policy'),
          probe('disk', 'disk_headroom'),
          probe('unlock', 'volume_unlock'),
        ]),
      ),
  };
};
