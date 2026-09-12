/**
 * Darwin facts the shared contract cannot express: what goes in the property list, what the owner
 * procedure actually says, and how §6.4's probes read this specific machine. Unit tests, not
 * contract tests — the seam-wide assertions live in tests/contract and run against both adapters.
 */
import { describe, expect, it } from 'vitest';
import type { AutostartPlan, DarwinEnv } from '../src/index.js';
import {
  createDarwinHostAdapter,
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
