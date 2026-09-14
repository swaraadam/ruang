/**
 * Darwin facts the shared contract cannot express: what goes in the property list, what the owner
 * procedure actually says, and how §6.4's probes read this specific machine. Unit tests, not
 * contract tests — the seam-wide assertions live in tests/contract and run against both adapters.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AutostartPlan, DarwinEnv } from '../src/index.js';
import {
  MANIFEST_MODE,
  createDarwinHostAdapter,
  defaultDarwinEnv,
  manifestPath,
  ownerProcedure,
  renderManifest,
  runHealthProbes,
} from '../src/index.js';

const PLAN: AutostartPlan = {
  unit_id: 'placeholder.autostart',
  program: ['/bin/node', '--flag="x"', '/srv/a&b.js'],
  working_directory: '/Users/owner/projects',
  run_at_login: true,
  keep_alive: false,
  log_directory: '/Users/owner/logs',
  environment: { NODE_ENV: 'production' },
};

const env = (over: Partial<DarwinEnv> = {}): DarwinEnv => ({
  home: '/Users/owner',
  user_id: 501,
  now: () => new Date(0),
  run: () => ({ code: 0, stdout: '', stderr: '', error: null }),
  readFile: () => 'readable',
  writeFile: () => undefined,
  // No file exists for these unit tests, so there is no mode to report and nothing to narrow.
  // Null is the honest answer and it is what `restrictAccess` reads as "did nothing".
  fileMode: () => null,
  setFileMode: () => undefined,
  realpath: (p) => p,
  ownerUid: () => 501,
  diskFree: () => ({ available: 200 * 1024 ** 3, total: 500 * 1024 ** 3 }),
  allow_roots: ['/Users/owner/projects'],
  min_free_bytes: 5 * 1024 ** 3,
  ...over,
});

describe('the autostart manifest', () => {
  it('is written under the login-agent directory of this user', () => {
    expect(manifestPath(env(), 'x')).toBe('/Users/owner/Library/LaunchAgents/x.plist');
  });

  it('carries the plan and escapes every value it interpolates', () => {
    const body = renderManifest(PLAN);
    expect(body).toContain('<key>Label</key>\n  <string>placeholder.autostart</string>');
    expect(body).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(body).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(body).toContain('<string>--flag=&quot;x&quot;</string>');
    expect(body).toContain('<string>/srv/a&amp;b.js</string>');
  });

  it('prints the registration commands instead of running them, and says why', () => {
    const procedure = ownerProcedure(env(), 'x');
    const commands = procedure.steps.filter((s) => s.is_command).map((s) => s.instruction);
    expect(commands.some((c) => c.startsWith('launchctl bootstrap gui/501'))).toBe(true);
    expect(commands.some((c) => c.startsWith('launchctl enable gui/501'))).toBe(true);
    expect(procedure.why_owner_runs_it).toMatch(/unattended agent/);
    // The owner must not read a later "unknown" as this procedure having failed.
    expect(procedure.steps.some((s) => /registration "unknown"/.test(s.instruction))).toBe(true);
  });
});

describe('§6.4 probes read this machine', () => {
  const probe = (over: Partial<DarwinEnv>, id: string) =>
    runHealthProbes(env(over)).probes.find((p) => p.probe_id === id);

  it('reports encrypted-volume boot as an availability limit, not as a fault', () => {
    const found = probe(
      { run: () => ({ code: 0, stdout: 'FileVault is On.', stderr: '', error: null }) },
      'volume_unlock',
    );
    expect(found?.state).toBe('degraded');
    expect(found?.detail).toMatch(/physical unlock/);
  });

  it('blocks on a denied permission and stays unknown when the probe itself fails', () => {
    const denied = probe(
      {
        readFile: () => {
          throw Object.assign(new Error('denied'), { code: 'EPERM' });
        },
      },
      'full_filesystem_access',
    );
    expect(denied?.state).toBe('blocked');
    const missing = probe(
      {
        readFile: () => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        },
      },
      'full_filesystem_access',
    );
    expect(missing?.state).toBe('unknown');
  });

  it('blocks below the disk floor and degrades when idle sleep is enabled', () => {
    const disk = probe(
      { diskFree: () => ({ available: 1024 ** 3, total: 1024 ** 4 }) },
      'disk_headroom',
    );
    expect(disk?.state).toBe('blocked');
    const sleep = probe(
      { run: () => ({ code: 0, stdout: ' sleep\t30\n', stderr: '', error: null }) },
      'sleep_policy',
    );
    expect(sleep?.state).toBe('degraded');
  });
});

describe('darwin specifics of the session and path facets', () => {
  it('refuses a session id the multiplexer would read as an address', async () => {
    const adapter = createDarwinHostAdapter(env());
    const attachment = await adapter.session_manager().attach({
      session_id: 'attempt.1:2',
      working_directory: '/Users/owner/projects',
      command: null,
    });
    expect(attachment.outcome).toBe('refused');
    expect(attachment.refused_reason).toMatch(/not addressable/);
  });

  it('treats the allow roots as case-insensitive, as the default volume does', () => {
    const decision = createDarwinHostAdapter(env())
      .path_policy()
      .canonicalize('/users/OWNER/Projects/app');
    expect(decision.allowed).toBe(true);
  });
});

/**
 * C1 and C2 from the security review on PR #72. Both were reproduced against the real tools before
 * being fixed: tmux 3.7c placed a session in /private/etc when the command carried a second `-c`,
 * and a traversing unit id composed a path outside the login-agent directory.
 */
describe('refusing the caller-supplied commands that would reconfigure the backend', () => {
  /** The backend has no session until `new-session` runs. A fake that always lists one would send
   * every attach down the reattach path, and the creation argv -- the thing under test -- would
   * never be built. */
  const scriptedBackend = (): { run: DarwinEnv['run']; spawned: () => (readonly string[])[] } => {
    const spawned: (readonly string[])[] = [];
    let created = false;
    return {
      spawned: () => spawned,
      run: (argv) => {
        spawned.push(argv);
        if (argv[1] === 'new-session') {
          created = true;
          return { code: 0, stdout: '', stderr: '', error: null };
        }
        return created
          ? { code: 0, stdout: 'attempt-1\t1700000000\n', stderr: '', error: null }
          : { code: 1, stdout: '', stderr: 'no server running', error: null };
      },
    };
  };

  const attaching = async (command: readonly string[] | null, over: Partial<DarwinEnv> = {}) => {
    const adapter = createDarwinHostAdapter(env(over));
    return adapter.session_manager().attach({
      session_id: 'attempt-1',
      working_directory: '/Users/owner/projects',
      command,
    });
  };

  it('refuses a command that begins with an option, which the backend would read as its own', async () => {
    // The measured attack: tmux takes the LAST occurrence of a flag, so this overrode `-c` and put
    // the session in /private/etc, discarding the canonicalized directory entirely.
    const attachment = await attaching(['-c', '/etc', 'sh']);
    expect(attachment.outcome).toBe('refused');
    expect(attachment.refused_reason).toMatch(/may not begin with an option/);
  });

  it('refuses a launcher, which would put the deny-list one indirection from what runs', async () => {
    const attachment = await attaching(['sh', '-c', 'launchctl bootstrap gui/501 x.plist']);
    expect(attachment.outcome).toBe('refused');
    expect(attachment.refused_reason).toMatch(/exists to run another program/);
  });

  it('refuses an owner-run binary named directly, by basename and by full path', async () => {
    for (const command of [
      ['sudo', 'x'],
      ['/usr/bin/sudo', 'x'],
    ]) {
      const attachment = await attaching(command);
      expect(attachment.outcome).toBe('refused');
      expect(attachment.refused_reason).toMatch(/owner-run only/);
    }
  });

  it('ends option parsing before the command, so no later element can be read as a flag', async () => {
    const backend = scriptedBackend();
    await attaching(['/usr/local/bin/agent', '-c', '/etc'], { run: backend.run });
    const create = backend.spawned().find((a) => a[1] === 'new-session');
    expect(create).toBeDefined();
    if (create === undefined) return;
    const separator = create.indexOf('--');
    expect(separator).toBeGreaterThan(-1);
    // Every command element sits after the separator, and the canonicalized directory sits before
    // it -- so the backend cannot reach its own `-c` through anything the caller supplied.
    expect(create.indexOf('/usr/local/bin/agent')).toBeGreaterThan(separator);
    expect(create.lastIndexOf('-c')).toBeGreaterThan(separator);
    expect(create.indexOf('-c')).toBeLessThan(separator);
    expect(create[create.indexOf('-c') + 1]).toBe('/Users/owner/projects');
  });

  it('allows an ordinary command', async () => {
    const attachment = await attaching(['/usr/local/bin/agent', '--serve'], {
      run: scriptedBackend().run,
    });
    expect(attachment.outcome).toBe('created');
  });
});

describe('an autostart plan cannot write outside the login-agent directory', () => {
  // `env()`'s readFile returns a constant for EVERY path, which now reads as "a file is already
  // there, and we did not write it". An empty login-agent directory is what these tests mean.
  const empty = (): DarwinEnv =>
    env({
      readFile: () => {
        throw new Error('no such file');
      },
    });
  const adapter = () => createDarwinHostAdapter(empty()).autostart_contract();
  /**
   * PLAN above logs to `/Users/owner/logs`, outside the single allow root, and is now refused.
   * That is the new rule rather than a broken fixture: `allow_roots` is the filesystem scope this
   * adapter may touch, and a manifest is an instruction for login-time writes, so a plan that logs
   * outside that scope is the adapter arranging writes it is not itself permitted to make. Widening
   * the roots is the owner's move; PLAN is left alone because the rendering tests above are about
   * escaping, not installability.
   */
  const INSTALLABLE: AutostartPlan = { ...PLAN, log_directory: '/Users/owner/projects/logs' };

  it('refuses a unit id that would traverse out of the directory it names', async () => {
    for (const unit_id of ['../../../../tmp/pwn', 'a/b', '.hidden', 'x..y/../z']) {
      await expect(adapter().install({ ...INSTALLABLE, unit_id })).rejects.toThrow(
        /bare identifier/,
      );
      await expect(adapter().status(unit_id)).rejects.toThrow(/bare identifier/);
      await expect(adapter().repair({ ...INSTALLABLE, unit_id })).rejects.toThrow(
        /bare identifier/,
      );
    }
  });

  it('refuses a plan whose program is a launcher, which would survive a reboot', async () => {
    await expect(
      adapter().install({ ...INSTALLABLE, program: ['/bin/sh', '-c', 'curl x | sh'] }),
    ).rejects.toThrow(/exists to run another program/);
  });

  it('refuses a plan whose directories fall outside the allowed roots', async () => {
    await expect(adapter().install({ ...INSTALLABLE, log_directory: '/etc' })).rejects.toThrow(
      /log_directory/,
    );
    await expect(adapter().install({ ...INSTALLABLE, working_directory: '/etc' })).rejects.toThrow(
      /working_directory/,
    );
  });

  it('still accepts the ordinary reverse-DNS shape', async () => {
    const result = await adapter().install(INSTALLABLE);
    expect(result.manifest_path).toBe(
      '/Users/owner/Library/LaunchAgents/placeholder.autostart.plist',
    );
  });

  it('folds case on the owner-run deny-list, because the volume does', async () => {
    for (const program of [
      ['/usr/bin/SUDO', 'x'],
      ['/BIN/SH', '-c', 'x'],
    ]) {
      await expect(adapter().install({ ...INSTALLABLE, program })).rejects.toThrow(
        /owner-run only|run another program/,
      );
    }
  });
});

/**
 * On a real filesystem, because the thing under test is a mode bit and every other test in this
 * file writes into a Map. The manifest carries `plan.environment` verbatim into a file that
 * survives a reboot, so who can READ it is part of what this adapter does, not an ambient detail.
 */
describe('the mode of the manifest on disk', () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'p0-07-manifest-')));
  const real = defaultDarwinEnv({ home, user_id: 501, allow_roots: [home] });
  const installable = (unit_id: string): AutostartPlan => ({
    ...PLAN,
    unit_id,
    working_directory: home,
    log_directory: `${home}/logs`,
    environment: { NODE_ENV: 'production', GATEWAY_PORT: '7777' },
  });
  afterAll(() => void rmSync(home, { recursive: true, force: true }));

  it('is readable by the owner and by nobody else', async () => {
    const plan = installable('placeholder.mode');
    const result = await createDarwinHostAdapter(real).autostart_contract().install(plan);
    expect(result.wrote).toBe(true);
    const mode = statSync(result.manifest_path).mode & 0o777;
    expect((mode & 0o777).toString(8)).toBe('600');
    // Stated twice on purpose: the octal above is what the mode IS, this is the property the
    // security review asked for, and a later widening should fail on the sentence it breaks.
    expect(mode & 0o077).toBe(0);
    expect(real.readFile(result.manifest_path)).toContain('GATEWAY_PORT');
  });

  it('narrows a manifest that is already on disk with a wider mode', async () => {
    const plan = installable('placeholder.rewrite');
    const autostart = createDarwinHostAdapter(real).autostart_contract();
    const first = await autostart.install(plan);
    // What an earlier version of this adapter left behind. `writeFileSync`'s mode argument applies
    // only when the call CREATES the file, so a rewrite over this is where the bit would survive.
    chmodSync(first.manifest_path, 0o644);
    const repaired = await autostart.repair({ ...plan, keep_alive: !plan.keep_alive });
    expect(repaired.actions_taken.join(' ')).toMatch(/rewrote divergent/);
    expect((statSync(first.manifest_path).mode & 0o777).toString(8)).toBe('600');
  });

  /**
   * The case above changes the body (`keep_alive` is flipped), so a write happens and the write is
   * what narrows. This one does not, and it is the one the mode policy was written for: the SAME
   * plan, re-installed after the adapter changed. `renderManifest` is byte-identical, so nothing
   * is written and nothing on the write path runs. Before `restrictAccess` existed this stayed
   * 0644 through both `install()` and `repair()`, with `wrote: false` and `actions_taken: []`
   * reporting that there had been nothing to do.
   */
  it('narrows an existing manifest whose body did not change at all', async () => {
    const plan = installable('placeholder.upgraded');
    const autostart = createDarwinHostAdapter(real).autostart_contract();
    const path = (await autostart.install(plan)).manifest_path;
    expect(real.readFile(path)).toBe(renderManifest(plan));
    chmodSync(path, 0o644);

    const reinstalled = await autostart.install(plan);
    expect(reinstalled.wrote).toBe(false);
    expect(reinstalled.restricted_access).toBe(`narrowed ${path} from 644 to 600`);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(reinstalled.status.manifest_access).toBe('600');

    chmodSync(path, 0o644);
    const repaired = await autostart.repair(plan);
    expect(repaired.actions_taken).toEqual([`narrowed ${path} from 644 to 600`]);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    expect((await autostart.status(plan.unit_id)).manifest_access).toBe('600');
  });

  it('reports the mode it found without changing it, so status only observes', async () => {
    const plan = installable('placeholder.observed');
    const autostart = createDarwinHostAdapter(real).autostart_contract();
    const path = (await autostart.install(plan)).manifest_path;
    chmodSync(path, 0o640);
    expect((await autostart.status(plan.unit_id)).manifest_access).toBe('640');
    expect((statSync(path).mode & 0o777).toString(8)).toBe('640');
  });

  /**
   * The direction rule itself is bound for EVERY adapter in `tests/contract/` now — it had to be,
   * because the double implemented it backwards and this assertion could not see that. What stays
   * here is the half only a real filesystem proves: that the bits `stat` reports afterwards are
   * the ones the owner set, rather than a spelling the adapter stored and echoed back.
   */
  it('leaves a manifest the owner made STRICTER alone: this narrows, it never widens', async () => {
    const plan = installable('placeholder.stricter');
    const autostart = createDarwinHostAdapter(real).autostart_contract();
    const path = (await autostart.install(plan)).manifest_path;
    chmodSync(path, 0o400);
    const repaired = await autostart.repair(plan);
    expect(repaired.actions_taken).toEqual([]);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('400');
  });
});

/** The two facts about the mode that need no filesystem, so they do not pay for one. */
describe('what the adapter says about a manifest mode', () => {
  /** Backs the sentence on `octal`: the high bits are reported, not masked off. Driven through the
   * scripted env rather than a real chmod, because setting a setgid bit on a regular file is not
   * something a test should need permission for. */
  it('reports a high bit it found instead of rounding the mode down to three digits', async () => {
    const status = await createDarwinHostAdapter(env({ fileMode: () => 0o2644 }))
      .autostart_contract()
      .status('placeholder.highbit');
    expect(status.manifest_access).toBe('2644');
  });

  it('uses one constant for the mode it writes and the mode it restores to', () => {
    expect(MANIFEST_MODE).toBe(0o600);
    expect(MANIFEST_MODE & 0o077).toBe(0);
  });
});
