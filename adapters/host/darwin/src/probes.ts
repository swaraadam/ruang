/**
 * Blueprint §6.4 as data: Full Disk Access / TCC, power and sleep configuration, the FileVault
 * power-loss availability gap, disk thresholds, and whether a login session exists at all for a
 * LaunchAgent to run in.
 *
 * Every probe may answer `unknown`, and several routinely do — the dashboard has to be able to
 * show "we could not tell" (invariant 1), and `summarizeProbes` turns any `unknown` or `blocked`
 * into a refusal to dispatch (invariant 4). Nothing here grants a permission or changes a setting;
 * a failing probe produces a procedure for the owner.
 */
import { summarizeProbes } from '@internal/host-contract';
import type { HealthProbe, HealthReport, OwnerProcedure, ProbeKind } from '@internal/host-contract';
import type { DarwinEnv } from './env.js';

type Draft = Omit<HealthProbe, 'checked_at'>;

/** Steps are `[text, is_command]` — stated per step rather than guessed from the text. */
const fix = (
  title: string,
  why: string,
  steps: readonly (readonly [string, boolean])[],
): OwnerProcedure => ({
  title,
  why_owner_runs_it: why,
  steps: steps.map(([instruction, is_command]) => ({ instruction, is_command })),
});

const d = (
  probe_id: string,
  kind: ProbeKind,
  state: HealthProbe['state'],
  observed: string | null,
  detail: string,
  procedure: OwnerProcedure | null = null,
): Draft => ({ probe_id, kind, state, observed, detail, procedure });

const errno = (error: unknown): string | null => (error as NodeJS.ErrnoException).code ?? null;

/** Reading the permission database is the cheapest honest test of Full Disk Access. */
const filesystemAccess = (env: DarwinEnv): Draft => {
  const grant = fix(
    'Grant Full Disk Access to the gateway binary',
    'A TCC grant requires a user-present System Settings interaction by design. Nothing may ' +
      'script it, and this adapter does not try.',
    [
      ['System Settings > Privacy & Security > Full Disk Access', false],
      ['Add the binary that runs the gateway, then restart it', false],
    ],
  );
  try {
    env.readFile(`${env.home}/Library/Application Support/com.apple.TCC/TCC.db`);
    return d('full_filesystem_access', 'permissions', 'ok', 'readable', 'permission granted');
  } catch (error) {
    const code = errno(error);
    return code === 'EPERM' || code === 'EACCES'
      ? d('full_filesystem_access', 'permissions', 'blocked', code, 'access denied', grant)
      : // ENOENT and anything else: the probe failed, so the permission state was never read.
        d('full_filesystem_access', 'permissions', 'unknown', code, 'probe unreadable', grant);
  }
};

const sleepPolicy = (env: DarwinEnv): Draft => {
  const stayAwake = fix(
    'Keep the host awake for unattended work',
    'Power configuration is machine-wide and an owner should choose it deliberately.',
    [['sudo pmset -a sleep 0 womp 1', true]],
  );
  const out = env.run(['pmset', '-g', 'custom']);
  if (out.error !== null || out.code !== 0) {
    return d('sleep_policy', 'power', 'unknown', null, 'power settings unreadable', stayAwake);
  }
  const minutes = Number(/^\s*sleep\s+(\d+)/m.exec(out.stdout)?.[1] ?? NaN);
  if (!Number.isFinite(minutes)) {
    return d('sleep_policy', 'power', 'unknown', null, 'no sleep value in the output', stayAwake);
  }
  return minutes === 0
    ? d('sleep_policy', 'power', 'ok', 'sleep=0', 'the host does not idle-sleep')
    : d(
        'sleep_policy',
        'power',
        'degraded',
        `sleep=${String(minutes)}`,
        `idle-sleeps after ${String(minutes)} minutes; a remote attach will drop`,
        stayAwake,
      );
};

const diskHeadroom = (env: DarwinEnv): Draft => {
  const free = fix(
    'Free space on the work volume',
    'Deleting files is not something an unattended agent should decide.',
    [['Review artifacts under state/artifacts and remove what is no longer evidence', false]],
  );
  try {
    const { available, total } = env.diskFree(env.home);
    const gib = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GiB`;
    const observed = `${gib(available)} free of ${gib(total)}`;
    if (available < env.min_free_bytes) {
      return d('disk_headroom', 'disk', 'blocked', observed, 'below the floor', free);
    }
    return available < env.min_free_bytes * 2
      ? d('disk_headroom', 'disk', 'degraded', observed, 'approaching the floor', free)
      : d('disk_headroom', 'disk', 'ok', observed, 'headroom above the floor');
  } catch (error) {
    return d('disk_headroom', 'disk', 'unknown', errno(error), 'free space unreadable', free);
  }
};

/** §6.4's availability gap. FileVault on is the *correct* security posture and is still an
 * availability limit: after power loss the volume needs a physical unlock before anything
 * autostarts. `degraded` reports the trade-off; it is not advice to turn it off. */
const volumeUnlock = (env: DarwinEnv): Draft => {
  const out = env.run(['fdesetup', 'status']);
  if (out.error !== null || out.code !== 0) {
    return d('volume_unlock', 'unlock', 'unknown', null, 'encryption state unreadable');
  }
  const text = out.stdout.trim();
  if (/FileVault is On/i.test(text)) {
    return d(
      'volume_unlock',
      'unlock',
      'degraded',
      text,
      'boot volume encryption is on: after power loss the host needs a physical unlock before ' +
        'autostart can run. Accepted limitation, Appendix C.',
    );
  }
  return /FileVault is Off/i.test(text)
    ? d('volume_unlock', 'unlock', 'ok', text, 'no unlock needed to boot unattended')
    : d('volume_unlock', 'unlock', 'unknown', text, 'unrecognised encryption status');
};

/** A LaunchAgent only runs inside a login session, so "is anyone logged in" is health data. */
const consoleLogin = (env: DarwinEnv): Draft => {
  if (env.user_id === null) {
    return d('console_login', 'unlock', 'unknown', null, 'this process has no known user id');
  }
  try {
    const owner = env.ownerUid('/dev/console');
    return owner === env.user_id
      ? d('console_login', 'unlock', 'ok', String(owner), 'the owner holds the console session')
      : d(
          'console_login',
          'unlock',
          'degraded',
          String(owner),
          'the console session belongs to another user; login-time autostart may not run',
          fix(
            'Restore an automatic login session',
            'Enabling automatic login changes the security posture of the machine.',
            [['Log in physically once, or enable automatic login in System Settings', false]],
          ),
        );
  } catch {
    return d('console_login', 'unlock', 'unknown', null, 'the console owner was not readable');
  }
};

export const runHealthProbes = (env: DarwinEnv): HealthReport => {
  const checked_at = env.now().toISOString();
  const drafts = [filesystemAccess, sleepPolicy, diskHeadroom, volumeUnlock, consoleLogin];
  return summarizeProbes(
    checked_at,
    drafts.map((probe) => ({ ...probe(env), checked_at })),
  );
};
