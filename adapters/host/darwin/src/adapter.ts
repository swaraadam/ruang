/**
 * Seam B, Darwin. The only file that composes macOS behaviour into a `HostAdapter`; everything
 * above it sees the six facets of blueprint §6.1 and nothing else.
 */
import { createPathPolicy } from '@internal/host-contract';
import type { HostAdapter, HostCapabilities } from '@internal/host-contract';
import { createAutostartContract } from './autostart.js';
import { defaultDarwinEnv } from './env.js';
import type { DarwinEnv } from './env.js';
import { runHealthProbes } from './probes.js';
import { createSessionManager } from './sessions.js';

/**
 * Blueprint §6.3 and Appendix B.3. `advisory` is reported, never asserted anywhere else: macOS has
 * no per-process egress enforcement this adapter can stand behind, and saying so as data is what
 * lets `packages/policy` decide instead of assume. A Linux runner answering `enforced` changes
 * nothing above this line.
 */
export const DARWIN_CAPABILITIES: HostCapabilities = {
  adapter_id: 'darwin',
  session_backend_id: 'tmux',
  egress_enforcement: 'advisory',
  persistent_sessions: true,
  local_notifications: true,
  biometric_step_up_via_webauthn: true,
};

const quote = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export const createDarwinHostAdapter = (env: DarwinEnv = defaultDarwinEnv()): HostAdapter => {
  // Darwin volumes are case-insensitive by default, so `/Users/x` and `/users/x` are one root.
  const paths = createPathPolicy({
    roots: env.allow_roots,
    realpath: env.realpath,
    caseInsensitive: true,
  });
  const sessions = createSessionManager(env, paths);
  const autostart = createAutostartContract(env);

  return {
    capabilities: () => Promise.resolve(DARWIN_CAPABILITIES),
    session_manager: () => sessions,
    autostart_contract: () => autostart,
    path_policy: () => paths,
    notify_local: (notification) => {
      const body = quote(notification.body);
      const out = env.run([
        'osascript',
        '-e',
        `display notification "${body}" with title "${quote(notification.title)}"`,
      ]);
      const failed = out.error !== null || out.code !== 0;
      return Promise.resolve({
        notification_id: notification.notification_id,
        channel_id: notification.channel_id,
        outcome: failed ? ('failed' as const) : ('handed_off' as const),
        handed_off_at: failed ? null : env.now().toISOString(),
        // The notification centre returns no read receipt, so this is structurally null:
        // `notification.delivered` needs a `confirmed_at` and must come from somewhere else.
        confirmed_at: null,
        reason: failed ? (out.error ?? (out.stderr.trim() || `exit ${String(out.code)}`)) : null,
      });
    },
    health_probes: () => Promise.resolve(runHealthProbes(env)),
  };
};
