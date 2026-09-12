/**
 * Seam B contract suite — blueprint §6 and §20.5: "one real Darwin implementation and a test
 * double. The core suite must run against the double, proving that launchd/tmux/TCC assumptions
 * did not leak across the seam."
 *
 * Written once against `HostAdapter` and parameterized by adapter. The Darwin adapter is driven
 * through a scripted `DarwinEnv` rather than the real machine, so both cases run identically on
 * any platform — stronger than skipping half the suite off-Darwin, because the assertions below
 * then constrain the real implementation and not only the double.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAYLOAD_VALIDATORS } from '@internal/protocol';
import {
  HOST_ADAPTER_METHODS,
  PROBE_KINDS,
  createHostDouble,
  createPathPolicy,
  createSessionStore,
} from '@internal/host-contract';
import type { AutostartPlan, HostAdapter, HostSession } from '@internal/host-contract';
import { GUARDED_BINARIES, createDarwinHostAdapter, guard } from '@internal/adapter-host-darwin';
import type { CommandResult, DarwinEnv } from '@internal/adapter-host-darwin';

type Scenario = { unknown_power?: boolean; notify_fails?: boolean; backend_down?: boolean };

type Fixture = {
  readonly adapter: HostAdapter;
  readonly root: string;
  readonly inside: string;
  readonly outside: string;
  readonly escaping_symlink: string;
  readonly prefix_trap: string;
  /** Every process the adapter launched. Autostart must leave it empty. */
  readonly spawned: () => readonly (readonly string[])[];
  tamper(unit_id: string): void;
  /** A second adapter over the same host state: what "the gateway restarted" means here. */
  restart(): HostAdapter;
};

const plan = (unit_id: string, root: string): AutostartPlan => ({
  unit_id,
  program: ['/usr/local/bin/node', '/srv/gateway.js'],
  working_directory: root,
  run_at_login: true,
  keep_alive: true,
  log_directory: `${root}/logs`,
  environment: { NODE_ENV: 'production' },
});

const doubleFixture = (scenario: Scenario = {}): Fixture => {
  const sessions = createSessionStore();
  const manifests = new Map<string, string>();
  const build = (): HostAdapter =>
    createHostDouble({
      sessions,
      manifests,
      allow_roots: ['/allowed'],
      symlinks: { '/allowed/link': '/etc' },
      existing_paths: ['/', '/allowed', '/allowed/link'],
      ...(scenario.unknown_power === true
        ? { probe_overrides: { power: { state: 'unknown' as const, observed: null } } }
        : {}),
      ...(scenario.notify_fails === true ? { notify_outcome: 'failed' as const } : {}),
      ...(scenario.backend_down === true ? { backend_available: false } : {}),
    });
  return {
    adapter: build(),
    root: '/allowed',
    inside: '/allowed/project',
    outside: '/allowed/../etc/passwd',
    escaping_symlink: '/allowed/link/passwd',
    prefix_trap: '/allowedx/project',
    spawned: () => [],
    tamper: (unit_id) => void manifests.set(`/double/autostart/${unit_id}`, 'tampered'),
    restart: build,
  };
};

const ROOT = '/Users/owner/projects';
const REAL = new Set(['/', '/Users/owner', ROOT, `${ROOT}/link`]);
const LINKS: Record<string, string> = { [`${ROOT}/link`]: '/etc' };
const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', error: null });
const down = (b: string): CommandResult => ({
  code: null,
  stdout: '',
  stderr: '',
  error: `spawn ${b} ENOENT`,
});

const darwinFixture = (scenario: Scenario = {}): Fixture => {
  const files = new Map<string, string>();
  const live = new Map<string, number>();
  const spawned: string[][] = [];

  const respond = (argv: readonly string[]): CommandResult => {
    const [binary, verb] = argv;
    if (binary === 'tmux') {
      if (scenario.backend_down === true) return down('tmux');
      if (verb === 'new-session') {
        const name = argv[argv.indexOf('-s') + 1];
        if (name !== undefined) live.set(name, 1_700_000_000);
        return ok('');
      }
      if (live.size === 0) return { code: 1, stdout: '', stderr: 'no server running', error: null };
      return ok(`${[...live].map(([n, t]) => `${n}\t${String(t)}`).join('\n')}\n`);
    }
    if (binary === 'pmset')
      return scenario.unknown_power === true ? down('pmset') : ok(' sleep\t0\n');
    if (binary === 'fdesetup') return ok('FileVault is On.\n');
    if (binary === 'osascript') return scenario.notify_fails === true ? down('osascript') : ok('');
    return down(binary ?? '');
  };

  const env: DarwinEnv = {
    home: '/Users/owner',
    user_id: 501,
    now: () => new Date(0),
    run: (argv) => {
      guard(argv);
      spawned.push([...argv]);
      return respond(argv);
    },
    readFile: (path) => {
      const body = files.get(path);
      if (body === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return body;
    },
    writeFile: (path, body) => void files.set(path, body),
    realpath: (path) => {
      if (!REAL.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const link = Object.keys(LINKS).find((k) => path === k || path.startsWith(`${k}/`));
      return link === undefined ? path : `${LINKS[link] ?? ''}${path.slice(link.length)}`;
    },
    ownerUid: () => 501,
    diskFree: () => ({ available: 200 * 1024 ** 3, total: 500 * 1024 ** 3 }),
    allow_roots: [ROOT],
    min_free_bytes: 5 * 1024 ** 3,
  };

  return {
    adapter: createDarwinHostAdapter(env),
    root: ROOT,
    inside: `${ROOT}/app`,
    outside: `${ROOT}/../../../etc/passwd`,
    escaping_symlink: `${ROOT}/link/passwd`,
    prefix_trap: `${ROOT}x/app`,
    spawned: () => spawned,
    tamper: (unit) => void files.set(`/Users/owner/Library/LaunchAgents/${unit}.plist`, 'tampered'),
    restart: () => createDarwinHostAdapter(env),
  };
};

const CASES: readonly (readonly [string, (s?: Scenario) => Fixture])[] = [
  ['test double', doubleFixture],
  ['darwin adapter on a scripted host', darwinFixture],
];

describe('§6.1 the host surface is six facets and nothing else', () => {
  it('lists them in blueprint order', () => {
    expect([...HOST_ADAPTER_METHODS]).toEqual([
      'session_manager',
      'autostart_contract',
      'path_policy',
      'notify_local',
      'health_probes',
      'capabilities',
    ]);
  });

  it('declares every facet it lists, and lists every facet it declares', () => {
    const source = readFileSync(
      new URL('../../adapters/host/contract/src/spi.ts', import.meta.url),
      'utf8',
    );
    const block = source.slice(source.indexOf('export type HostAdapter = {'));
    expect([...block.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).sort()).toEqual(
      [...HOST_ADAPTER_METHODS].sort(),
    );
  });

  it('cannot resume a provider conversation: that is Seam D and a different event (§6.2)', () => {
    // `session.resumed` needs a `runtime_session_id`, which nothing on this surface produces, so
    // the two durable events cannot be conflated by accident.
    expect(Object.keys(doubleFixture().adapter.session_manager()).sort()).toEqual([
      'attach',
      'list',
      'reattach',
    ]);
    expect(PAYLOAD_VALIDATORS['session.resumed'].fields).toContain('runtime_session_id');
  });
});

describe.each(CASES)('%s', (_name, makeFixture) => {
  it('§6.3 answers every capability field, egress inside the closed set', async () => {
    const caps = await makeFixture().adapter.capabilities();
    expect(['advisory', 'enforced', 'unknown']).toContain(caps.egress_enforcement);
    expect(Object.keys(caps).sort()).toEqual([
      'adapter_id',
      'biometric_step_up_via_webauthn',
      'egress_enforcement',
      'local_notifications',
      'persistent_sessions',
      'session_backend_id',
    ]);
  });

  describe('Appendix C path canonicalization and allow-roots', () => {
    it('allows the root itself and a path beneath it', () => {
      const f = makeFixture();
      const policy = f.adapter.path_policy();
      expect(policy.allow_roots().length).toBeGreaterThan(0);
      for (const candidate of [f.root, f.inside]) {
        const decision = policy.canonicalize(candidate);
        expect(decision.allowed, candidate).toBe(true);
        if (decision.allowed) expect(decision.canonical.startsWith('/')).toBe(true);
      }
    });

    it.each([
      ['dot-dot traversal out of the root', (f: Fixture) => f.outside, 'outside_allow_roots'],
      ['a symlink escaping the root', (f: Fixture) => f.escaping_symlink, 'outside_allow_roots'],
      ['a sibling sharing the root prefix', (f: Fixture) => f.prefix_trap, 'outside_allow_roots'],
      ['a relative path', () => 'relative/path', 'not_absolute'],
      ['an empty path', () => '   ', 'empty'],
      ['a null byte', (f: Fixture) => `${f.inside}\0.txt`, 'illegal_character'],
    ])('refuses %s', (_label, pick, reason) => {
      const f = makeFixture();
      const decision = f.adapter.path_policy().canonicalize(pick(f));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe(reason);
    });
  });

  describe('§6.2 sessions live below the gateway', () => {
    const spec = (f: Fixture) => ({
      session_id: 'attempt-1',
      working_directory: f.inside,
      command: null,
    });

    it('creates once, then reattaches, and never confuses the two', async () => {
      const f = makeFixture();
      const first = await f.adapter.session_manager().attach(spec(f));
      const second = await f.adapter.session_manager().attach(spec(f));
      expect(first.outcome).toBe('created');
      expect(second.outcome).toBe('reattached');
      expect(second.session?.host_session_ref).toBe(first.session?.host_session_ref);
    });

    it('survives the gateway restarting, and yields a valid session.reattached payload', async () => {
      const f = makeFixture();
      const before = await f.adapter.session_manager().attach(spec(f));
      const after = await f.restart().session_manager().reattach('attempt-1');
      expect(after.outcome).toBe('reattached');
      const session = after.session as HostSession;
      expect(session.host_session_ref).toBe(before.session?.host_session_ref);
      expect(
        PAYLOAD_VALIDATORS['session.reattached']({
          attempt_id: 'attempt-1',
          host_session_ref: session.host_session_ref,
          last_verified_at: session.last_verified_at,
        }),
      ).toBe(true);
      expect(Object.keys(session)).not.toContain('runtime_session_id');
    });

    it('refuses to reattach a session nobody kept, rather than creating one', async () => {
      const f = makeFixture();
      const attachment = await f.adapter.session_manager().reattach('attempt-404');
      expect(attachment.outcome).toBe('refused');
      expect(attachment.session).toBeNull();
      expect(await f.adapter.session_manager().list()).toEqual([]);
    });

    it('refuses a working directory outside the allow roots', async () => {
      const f = makeFixture();
      const attachment = await f.adapter
        .session_manager()
        .attach({ session_id: 'attempt-2', working_directory: f.outside, command: null });
      expect(attachment.outcome).toBe('refused');
    });

    it('invariant 1: an unreachable backend is unknown, not an empty session list', async () => {
      await expect(
        makeFixture({ backend_down: true }).adapter.session_manager().list(),
      ).rejects.toThrow();
    });
  });

  describe('autostart writes a manifest and refuses to register it', () => {
    const unit = 'autostart-under-test';

    it('launches no process at all while installing, inspecting or repairing', async () => {
      const f = makeFixture();
      const autostart = f.adapter.autostart_contract();
      await autostart.install(plan(unit, f.root));
      await autostart.status(unit);
      await autostart.repair(plan(unit, f.root));
      // Stronger than "never runs launchctl": autostart spawns nothing, so there is no argv to
      // audit and no way to add a load step without failing here first.
      expect(f.spawned()).toEqual([]);
    });

    it('writes once, is idempotent, and always returns an owner procedure', async () => {
      const f = makeFixture();
      const first = await f.adapter.autostart_contract().install(plan(unit, f.root));
      const second = await f.adapter.autostart_contract().install(plan(unit, f.root));
      expect(first.wrote).toBe(true);
      expect(first.procedure.steps.length).toBeGreaterThan(0);
      expect(first.procedure.why_owner_runs_it.length).toBeGreaterThan(20);
      expect(second.wrote).toBe(false);
      expect(second.digest).toBe(first.digest);
    });

    it('invariant 1: registration is unknown because it was never observed', async () => {
      const f = makeFixture();
      await f.adapter.autostart_contract().install(plan(unit, f.root));
      const status = await f.adapter.autostart_contract().status(unit);
      expect(status.registration).toBe('unknown');
      expect(status.needs_owner).toBe(true);
      expect(status.procedure).not.toBeNull();
    });

    it('reports a tampered manifest as divergent, repairs it, still needs the owner', async () => {
      const f = makeFixture();
      const autostart = f.adapter.autostart_contract();
      await autostart.install(plan(unit, f.root));
      f.tamper(unit);
      const repair = await autostart.repair(plan(unit, f.root));
      expect(repair.actions_taken.length).toBe(1);
      expect(repair.status.state).toBe('manifest_current');
      expect(repair.needs_owner).toBe(true);
    });

    it('never claims a state it cannot verify', async () => {
      const status = await makeFixture().adapter.autostart_contract().status('never-installed');
      expect(status.state).toBe('not_installed');
      expect(status.manifest_digest).toBeNull();
    });
  });

  describe('§6.4 health probes surface host facts as data', () => {
    it('covers permissions, power, disk and unlock state', async () => {
      const report = await makeFixture().adapter.health_probes();
      const kinds = new Set(report.probes.map((p) => p.kind));
      expect([...PROBE_KINDS].filter((k) => !kinds.has(k))).toEqual([]);
      for (const probe of report.probes) expect(probe.checked_at).toBe(report.checked_at);
    });

    it('invariants 1 and 4: an unreadable probe is unknown and refuses dispatch', async () => {
      const report = await makeFixture({ unknown_power: true }).adapter.health_probes();
      const power = report.probes.find((p) => p.kind === 'power');
      expect(power?.state).toBe('unknown');
      // No substitute value, no last-known reading, no optimistic default.
      expect(power?.observed).toBeNull();
      expect(report.unresolved).toContain(power?.probe_id);
      expect(report.safe_to_dispatch).toBe(false);
    });
  });

  describe('local notification is handed off, never confirmed', () => {
    const notification = {
      notification_id: 'n1',
      channel_id: 'local',
      title: 'needs input',
      body: 'attempt-1 is waiting',
      subject_kind: 'task',
      subject_id: 't1',
    };

    it('hands off without claiming delivery', async () => {
      const receipt = await makeFixture().adapter.notify_local(notification);
      expect(receipt.outcome).toBe('handed_off');
      // `notification.delivered` requires a confirmed_at. This surface cannot supply one.
      expect(receipt.confirmed_at).toBeNull();
      expect(PAYLOAD_VALIDATORS['notification.delivered'].fields).toContain('confirmed_at');
    });

    it('reports a failure as a failure, with a reason', async () => {
      const receipt = await makeFixture({ notify_fails: true }).adapter.notify_local(notification);
      expect(receipt.outcome).toBe('failed');
      expect(receipt.reason).not.toBeNull();
      expect(receipt.handed_off_at).toBeNull();
    });
  });
});

describe('invariant 4 at the edges of the shared implementation', () => {
  it('a path nothing can resolve is refused, not allowed', () => {
    const policy = createPathPolicy({
      roots: ['/allowed'],
      realpath: () => {
        throw new Error('ENOENT');
      },
      caseInsensitive: false,
    });
    const decision = policy.canonicalize('/allowed/thing');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('not_canonicalizable');
  });

  it.each(GUARDED_BINARIES)('the one choke point refuses to execute %s', (binary) => {
    expect(() => guard([`/usr/bin/${binary}`, 'anything'])).toThrow(/owner-run only/);
  });
});
