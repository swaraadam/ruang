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
  MANAGED_MARKER,
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
  /** Edit a manifest THIS adapter wrote: divergent, and repairable. */
  tamper(unit_id: string): void;
  /** Put a file this adapter never wrote at the path a unit id composes to. Not repairable. */
  plantForeign(unit_id: string): void;
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
    // Keeps the marker: this is OUR manifest, edited. A body with no marker is a different
    // situation and gets its own fixture below.
    tamper: (unit_id) =>
      void manifests.set(
        `/double/autostart/${unit_id}`,
        `{"marker":"${MANAGED_MARKER}","tampered":true}`,
      ),
    plantForeign: (unit_id) =>
      void manifests.set(`/double/autostart/${unit_id}`, '{"someone":"else"}'),
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
    // Keeps the marker: OUR manifest, edited. Marker-less is a different case, below.
    tamper: (unit) =>
      void files.set(
        `/Users/owner/Library/LaunchAgents/${unit}.plist`,
        `<!-- ${MANAGED_MARKER} --> tampered`,
      ),
    plantForeign: (unit) =>
      void files.set(
        `/Users/owner/Library/LaunchAgents/${unit}.plist`,
        '<plist><dict><key>Label</key><string>com.someone.else</string></dict></plist>',
      ),
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

  /**
   * The two criticals from the security review on PR #72, asserted against BOTH implementations.
   *
   * They are here rather than in the Darwin tests because the core suite runs against the double
   * (CLAUDE.md §4, Seam B): a rule the double does not enforce is a rule a core caller can violate
   * in CI and only discover on the real host. The substrate-specific halves -- tmux's `--` and the
   * LaunchAgents path -- stay in the Darwin tests, where they belong.
   */
  describe('a caller-supplied command cannot reconfigure the session backend', () => {
    const attach = (fixture: Fixture, command: readonly string[] | null) =>
      fixture.adapter.session_manager().attach({
        session_id: 'attempt-1',
        working_directory: fixture.inside,
        command,
      });

    it('refuses a command beginning with an option the backend would read as its own', async () => {
      const f = makeFixture();
      const attachment = await attach(f, ['-c', '/etc', 'sh']);
      expect(attachment.outcome).toBe('refused');
      expect(attachment.refused_reason).toMatch(/may not begin with an option/);
    });

    it('refuses a launcher, whose whole job is to run something the check never saw', async () => {
      const f = makeFixture();
      const attachment = await attach(f, ['sh', '-c', 'echo anything']);
      expect(attachment.outcome).toBe('refused');
      expect(attachment.refused_reason).toMatch(/exists to run another program/);
    });

    it('refuses before deciding whether the session already exists', async () => {
      // An invalid spec is invalid either way: a reattach that quietly succeeds on a command the
      // create path would refuse teaches a caller the command was acceptable.
      const f = makeFixture();
      expect((await attach(f, null)).outcome).toBe('created');
      const second = await attach(f, ['sh', '-c', 'echo anything']);
      expect(second.outcome).toBe('refused');
    });
  });

  /**
   * From the security re-review of the C1/C2 fix. Both bypasses below were MEASURED against the
   * real backend before being closed, which is why they are asserted rather than reasoned about.
   */
  describe('the command deny-list has no shift key and no shell', () => {
    const attach = (f: Fixture, command: readonly string[]) =>
      f.adapter
        .session_manager()
        .attach({ session_id: 'attempt-1', working_directory: f.inside, command });

    it('folds case, because the volume it runs on does', async () => {
      // /bin/SH is /bin/sh on a case-insensitive boot volume, and this codebase already knows that
      // -- `createPathPolicy` is constructed with caseInsensitive: true a few lines away. Asserted
      // on a LAUNCHER rather than an owner-run binary, because the host's deny-list is the host's:
      // the double is deliberately given an empty one. `/usr/bin/SUDO` is covered in the Darwin
      // tests, where GUARDED_BINARIES is the list actually in play.
      const attachment = await attach(makeFixture(), ['/bin/SH', '-c', 'echo x']);
      expect(attachment.outcome).toBe('refused');
    });

    it('refuses a one-element command carrying shell syntax, which the backend would interpret', async () => {
      // Measured: a single argument is handed to a shell even after `--`, so the whole string is a
      // script and its "basename" is the entire command line -- matching no deny-list entry while
      // running all of it. Zero indirections, not one.
      const attachment = await attach(makeFixture(), ['launchctl list | head -3 > proof']);
      expect(attachment.outcome).toBe('refused');
      expect(attachment.refused_reason).toMatch(/handed to a shell/);
    });

    it('still allows a one-element command that is only a program', async () => {
      const attachment = await attach(makeFixture(), ['/usr/local/bin/agent']);
      expect(attachment.outcome).not.toBe('refused');
    });
  });

  describe('the login-agent directory belongs to everyone', () => {
    it('refuses to overwrite a manifest this control plane did not write', async () => {
      const f = makeFixture();
      const autostart = f.adapter.autostart_contract();
      f.plantForeign('com.someone.else.agent');
      // A bare identifier is a valid unit id AND somebody else's agent name. Overwriting destroys
      // content `rm` cannot restore, which would also falsify the procedure's own reversibility
      // claim.
      await expect(autostart.install(plan('com.someone.else.agent', f.root))).rejects.toThrow(
        /did not write it/,
      );
      await expect(autostart.repair(plan('com.someone.else.agent', f.root))).rejects.toThrow(
        /did not write it/,
      );
    });

    it('still repairs a manifest it did write, however mangled', async () => {
      const f = makeFixture();
      const autostart = f.adapter.autostart_contract();
      await autostart.install(plan('ours.unit', f.root));
      f.tamper('ours.unit');
      const repair = await autostart.repair(plan('ours.unit', f.root));
      expect(repair.actions_taken.length).toBe(1);
      expect(repair.status.state).toBe('manifest_current');
    });

    it('refuses a program that is not an absolute path, so PATH cannot decide what ran', async () => {
      const f = makeFixture();
      await expect(
        f.adapter.autostart_contract().install({ ...plan('ok.unit', f.root), program: ['agent'] }),
      ).rejects.toThrow(/absolute path/);
    });

    it('writes the marker into every manifest it authors', async () => {
      const f = makeFixture();
      const result = await f.adapter.autostart_contract().install(plan('ok.unit', f.root));
      expect(result.wrote).toBe(true);
      const status = await f.adapter.autostart_contract().status('ok.unit');
      expect(status.state).toBe('unknown');
      expect(status.manifest_digest).not.toBeNull();
    });
  });

  describe('a unit id is an identifier, never a path', () => {
    it('refuses to install, status or repair a traversing unit id', async () => {
      const f = makeFixture();
      const autostart = f.adapter.autostart_contract();
      for (const unit_id of ['../../../../tmp/pwn', 'a/b', '.hidden']) {
        await expect(autostart.install(plan(unit_id, f.root))).rejects.toThrow(/bare identifier/);
        await expect(autostart.status(unit_id)).rejects.toThrow(/bare identifier/);
        await expect(autostart.repair(plan(unit_id, f.root))).rejects.toThrow(/bare identifier/);
      }
    });

    it('refuses a plan whose program is a launcher, which a reboot would make permanent', async () => {
      const f = makeFixture();
      await expect(
        f.adapter
          .autostart_contract()
          .install({ ...plan('ok.unit', f.root), program: ['/bin/sh', '-c', 'curl x | sh'] }),
      ).rejects.toThrow(/exists to run another program/);
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
