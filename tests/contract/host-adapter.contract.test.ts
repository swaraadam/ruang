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
  /**
   * Put the manifest's access posture at `mode`, in the octal spelling both hosts use, leaving the
   * body untouched. The body is what makes it a regression fixture — a plan that still renders
   * these exact bytes is the upgrade nothing rewrites.
   *
   * Takes the mode rather than only widening, because the contract constrains BOTH directions: a
   * posture an older adapter version left wide must be narrowed, and one the owner tightened must
   * be left exactly where it is.
   */
  setAccess(unit_id: string, mode: string): void;
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
  const manifest_modes = new Map<string, string>();
  const build = (): HostAdapter =>
    createHostDouble({
      sessions,
      manifests,
      manifest_modes,
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
    setAccess: (unit_id, mode) => void manifest_modes.set(`/double/autostart/${unit_id}`, mode),
    restart: build,
  };
};

/** What both implementations spell a group- and world-readable manifest as. Octal on the real
 * host; the double borrows the spelling so one assertion reads both. */
const WIDE_ACCESS = '644';
const REQUIRED_ACCESS = '600';

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
  // The scripted host's permission bits. `0o644` is what `defaultDarwinEnv` produced before the
  // mode was narrowed, so it is what an upgraded install finds on disk.
  const modes = new Map<string, number>();
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
    writeFile: (path, body) => {
      files.set(path, body);
      modes.set(path, 0o600);
    },
    fileMode: (path) => (files.has(path) ? (modes.get(path) ?? 0o644) : null),
    setFileMode: (path, mode) => void modes.set(path, mode),
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
    setAccess: (unit, mode) =>
      void modes.set(`/Users/owner/Library/LaunchAgents/${unit}.plist`, Number.parseInt(mode, 8)),
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
      // Stronger than "never runs launchctl": autostart spawns nothing at all, so a load step added
      // anywhere on this path fails this assertion instead of needing an argv to be audited. A
      // statement about this code path, not about what some other process could do.
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
      expect(status.manifest_access).toBeNull();
    });
  });

  /**
   * THE UPGRADE CASE. A manifest is not only its bytes: who may READ it is part of the unit's
   * state, because the body carries `plan.environment` verbatim and survives a reboot.
   *
   * The first fix for this narrowed the mode inside the host's write, and the write only happens
   * when the body changed. So the exact case it was written for — the same plan re-installed after
   * the adapter's mode policy changed, where `render` produces identical bytes — never reached it,
   * and `install` answered `wrote: false`, `repair` answered `actions_taken: []`, and the file
   * stayed readable by every local account with nothing anywhere saying so.
   *
   * Here rather than in the Darwin tests because the rule belongs to the contract: an adapter that
   * narrows only on write passes every other assertion in this file. The Darwin tests keep the
   * half only a real filesystem can prove, which is that the octal on disk is the one claimed.
   */
  describe('a manifest already in place is brought to the required access posture', () => {
    const unit = 'autostart-upgraded-in-place';

    const installed = async (f: Fixture) => {
      const first = await f.adapter.autostart_contract().install(plan(unit, f.root));
      expect(first.wrote).toBe(true);
      // The write narrowed what it wrote, so nothing is left to narrow on an untouched install.
      expect(first.restricted_access).toBeNull();
      expect(first.status.manifest_access).toBe(REQUIRED_ACCESS);
      return first;
    };

    it('reports the posture it observed, so a wrong one is visible from status alone', async () => {
      const f = makeFixture();
      await installed(f);
      f.setAccess(unit, WIDE_ACCESS);
      const status = await f.adapter.autostart_contract().status(unit);
      expect(status.manifest_access).toBe(WIDE_ACCESS);
      // Status OBSERVES. It reported the wide posture and left it exactly where it found it.
      expect((await f.adapter.autostart_contract().status(unit)).manifest_access).toBe(WIDE_ACCESS);
    });

    it('install narrows it even though the body is byte-identical and nothing was written', async () => {
      const f = makeFixture();
      const first = await installed(f);
      f.setAccess(unit, WIDE_ACCESS);
      const again = await f.adapter.autostart_contract().install(plan(unit, f.root));
      // Unchanged bytes: this is the case the write path cannot reach, which is the whole point.
      expect(again.wrote).toBe(false);
      expect(again.digest).toBe(first.digest);
      expect(again.restricted_access).toMatch(/narrowed/);
      expect(again.status.manifest_access).toBe(REQUIRED_ACCESS);
    });

    it('repair narrows it, and never reports an empty action list while leaving it wide', async () => {
      const f = makeFixture();
      await installed(f);
      f.setAccess(unit, WIDE_ACCESS);
      const repaired = await f.adapter.autostart_contract().repair(plan(unit, f.root));
      expect(repaired.actions_taken).toHaveLength(1);
      expect(repaired.actions_taken[0]).toMatch(/narrowed/);
      expect(repaired.status.manifest_access).toBe(REQUIRED_ACCESS);
      expect(repaired.needs_owner).toBe(true);
    });

    it('is idempotent: a second pass finds nothing to narrow and says nothing', async () => {
      const f = makeFixture();
      await installed(f);
      f.setAccess(unit, WIDE_ACCESS);
      await f.adapter.autostart_contract().repair(plan(unit, f.root));
      const second = await f.adapter.autostart_contract().repair(plan(unit, f.root));
      expect(second.actions_taken).toEqual([]);
      expect(
        (await f.adapter.autostart_contract().install(plan(unit, f.root))).restricted_access,
      ).toBeNull();
    });

    it('survives the gateway restarting: the posture is on the host, not in the adapter', async () => {
      const f = makeFixture();
      await installed(f);
      f.setAccess(unit, WIDE_ACCESS);
      const repaired = await f.restart().autostart_contract().repair(plan(unit, f.root));
      expect(repaired.actions_taken[0]).toMatch(/narrowed/);
      expect((await f.restart().autostart_contract().status(unit)).manifest_access).toBe(
        REQUIRED_ACCESS,
      );
    });

    /**
     * THE DIRECTION, which is the half a fixture seeded only with `644` cannot see.
     *
     * Every assertion above passes against a host that simply forces the required posture onto
     * whatever it finds. The double was exactly that host: it compared the stored posture to `600`
     * for equality, so it took a manifest an owner had tightened to `400` up to `600` — adding the
     * owner write bit — and reported `narrowed 400 to 600`. A false sentence in the one field this
     * contract added so that `install` and `repair` would stop misreporting (invariant 1).
     *
     * Asserted here rather than only in the Darwin tests because it is a rule of the CONTRACT and
     * not of a filesystem. The core suite running against the double is what proves the seam held
     * (CLAUDE.md §4, Seam B); a direction that suite does not constrain is one the next adapter
     * inherits backwards, since the double is the implementation it reads first.
     */
    describe('and never made wider: correcting a posture has a direction', () => {
      /** Seeded posture, and the posture required afterwards — `null` meaning "left exactly as
       * found". Nothing with an empty group-and-other half may be touched: each of those is a
       * posture an owner could have chosen deliberately. The high bits are carried through the
       * seeds because both hosts report them rather than rounding a mode down to three digits. */
      const DIRECTIONS: [string, string | null][] = [
        ['400', null],
        ['500', null],
        ['600', null],
        ['700', null],
        ['1600', null],
        ['4600', null],
        ['601', REQUIRED_ACCESS],
        ['604', REQUIRED_ACCESS],
        ['610', REQUIRED_ACCESS],
        ['640', REQUIRED_ACCESS],
        [WIDE_ACCESS, REQUIRED_ACCESS],
        ['777', REQUIRED_ACCESS],
        ['2644', REQUIRED_ACCESS],
      ];

      /** Bits set afterwards that were not set before. Zero is the entire rule, stated without
       * naming a mode, so it binds the postures this table does not list as well. */
      const granted = (before: string, after: string): number =>
        Number.parseInt(after, 8) & ~Number.parseInt(before, 8);

      it.each(DIRECTIONS)('install over %s', async (seeded, expected) => {
        const f = makeFixture();
        await installed(f);
        f.setAccess(unit, seeded);
        const again = await f.adapter.autostart_contract().install(plan(unit, f.root));
        // Byte-identical body throughout: the posture is the only thing under test.
        expect(again.wrote).toBe(false);
        const after = again.status.manifest_access ?? '';
        expect(after).toBe(expected ?? seeded);
        // The sentence and the act agree: it reports a narrowing exactly when it performed one.
        expect(again.restricted_access === null).toBe(expected === null);
        expect(granted(seeded, after)).toBe(0);
      });

      it.each(DIRECTIONS)('repair over %s', async (seeded, expected) => {
        const f = makeFixture();
        await installed(f);
        f.setAccess(unit, seeded);
        const repaired = await f.adapter.autostart_contract().repair(plan(unit, f.root));
        expect(repaired.actions_taken).toHaveLength(expected === null ? 0 : 1);
        // Naming the posture it started from, so a host that narrowed the wrong file, or reported
        // a `from` it did not read, cannot satisfy this by matching the word "narrowed".
        if (expected !== null)
          expect(repaired.actions_taken[0]).toContain(`from ${seeded} to ${REQUIRED_ACCESS}`);
        const after = repaired.status.manifest_access ?? '';
        expect(after).toBe(expected ?? seeded);
        expect(granted(seeded, after)).toBe(0);
      });

      it('status observes a tightened posture too, and corrects neither direction', async () => {
        const f = makeFixture();
        await installed(f);
        f.setAccess(unit, '400');
        const autostart = f.adapter.autostart_contract();
        expect((await autostart.status(unit)).manifest_access).toBe('400');
        expect((await autostart.status(unit)).manifest_access).toBe('400');
      });
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
  describe('refusing the caller-supplied commands that would reconfigure the backend', () => {
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
   * Comparison correctness, not adversary resistance — the guard's reach is fixed by the contract on
   * `refuseSessionCommand` (owner decision of 2026-09-14, blueprint §12.1) and nothing here widens
   * it. What these assert is narrower and checkable: the comparison must agree with the thing that
   * actually opens the file. The first two shapes were MEASURED against the real backend before
   * being closed; the folding cases below are the same bug reached through Unicode instead of the
   * shift key.
   */
  describe('the command deny-list compares folded names, never raw ones', () => {
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

    /**
     * `toLowerCase()` is not case FOLDING, and the gap is not academic: U+017F LATIN SMALL LETTER
     * LONG S is ALREADY lowercase, so `'\u017Fh'.toLowerCase()` is `'\u017Fh'` and the comparison
     * never fired. NFKC maps the compatibility spellings of an ASCII letter onto that letter first
     * -- long s, the fullwidth forms, the ligatures -- and it maps the fullwidth solidus onto `/`,
     * so a separator lookalike cannot hide the basename from the split either.
     */
    it.each([
      ['a long s, already lowercase and so untouched by toLowerCase()', '\u017Fh'],
      ['a fullwidth letter', '\uFF53h'],
      ['a fullwidth solidus, which a raw split does not read as a separator', '\uFF0Fbin\uFF0Fsh'],
    ])('refuses the %s spelling of a launcher', async (_case, program) => {
      const attachment = await attach(makeFixture(), [program, '-c', 'echo x']);
      expect(attachment.outcome).toBe('refused');
    });

    it('refuses a name it cannot compare instead of guessing at it (invariant 4)', async () => {
      // NFKC does not reach every lookalike and cannot: `\u0130` folds to `i` plus a combining dot, so
      // `f\u0130sh` never becomes `fish`. Every deny-list entry is an ASCII identifier, so a name still
      // outside ASCII after folding is outside the comparison's DOMAIN -- and an undecidable
      // comparison reported as "acceptable" is the guard claiming a decision it never made.
      const attachment = await attach(makeFixture(), ['/bin/f\u0130sh']);
      expect(attachment.outcome).toBe('refused');
      expect(attachment.refused_reason).toMatch(/outside ASCII/);
    });

    it('leaves plain ASCII where it was: folding is not a new refusal', async () => {
      // The regression half. Neither answer may move: an ordinary program still attaches, and an
      // uppercase launcher is still refused for being a launcher.
      expect((await attach(makeFixture(), ['/usr/local/bin/agent', '--serve'])).outcome).not.toBe(
        'refused',
      );
      const upper = await attach(makeFixture(), ['/bin/BASH', '-c', 'x']);
      expect(upper.outcome).toBe('refused');
      expect(upper.refused_reason).toMatch(/exists to run another program/);
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

  it('folds the name at that choke point too, by the same rule as the session deny-list', () => {
    // The sibling comparison had the same correctness bug: an exact match decided by code points,
    // against a filesystem that opens `/usr/bin/LAUNCHCTL` and `/usr/bin/launchctl` as one file.
    // One folding rule, used on both sides of both comparisons, so a fix lands once -- the
    // both-sides half of that sentence is what the last describe in this file pins, because it was
    // a claim this comment made and the code did not keep.
    expect(() => guard(['/usr/bin/LAUNCHCTL', 'load'])).toThrow(/owner-run only/);
    expect(() => guard(['\uFF53udo', '-v'])).toThrow(/owner-run only/);
    expect(() => guard(['/usr/bin/tmux', 'list-sessions'])).not.toThrow();
  });
});

describe('the launch guard folds both sides of its comparison', () => {
  /**
   * Pinning a claim the code did not keep. Every name in `GUARDED_BINARIES` is already lowercase
   * ASCII, so folding only argv[0] matched today by accident of the list rather than by
   * construction -- an entry added later in mixed case would have stopped matching silently. The
   * list is therefore supplied here rather than taken from the constant: that is the only way to
   * drive the comparison with an entry the canonical list cannot contain.
   */
  it('matches an entry that is not itself already in folded form', () => {
    expect(() => guard(['/usr/bin/rmtrash'], ['RmTrash'])).toThrow(/owner-run only/);
    expect(() => guard(['/usr/bin/RMTRASH'], ['rmtrash'])).toThrow(/owner-run only/);
    // The same entry reached by a compatibility spelling, which is what folding is for.
    expect(() => guard(['ｒmtrash'], ['RmTrash'])).toThrow(/owner-run only/);
    expect(() => guard(['/usr/bin/tmux'], ['RmTrash'])).not.toThrow();
  });

  it('keeps the host list as the default, so the one choke point is unchanged', () => {
    for (const binary of GUARDED_BINARIES) {
      expect(() => guard([`/usr/bin/${binary.toUpperCase()}`])).toThrow(/owner-run only/);
    }
  });
});
