import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = ['audit-seams.sh', 'audit-identity.sh', 'audit-scope.sh'];

/**
 * B2 from the review of PR #106, and it was right: #104's acceptance — "the scope and the invariant
 * cannot drift without something failing" — was backed only by a manual run quoted in the PR body.
 * A manual run is not evidence. Re-introducing a directory enumeration, or narrowing
 * audit_build_globs, would have passed `pnpm verify` in silence — reproducing the exact failure the
 * PR exists to close.
 *
 * These run the real scripts against a fixture tree. Each probe sits in a directory the OLD
 * enumeration did not scan, so each one fails if the scan is ever narrowed back.
 */
const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'));
  mkdirSync(join(root, 'scripts'));
  for (const s of SCRIPTS) {
    cpSync(join(repoRoot, 'scripts', s), join(root, 'scripts', s));
    chmodSync(join(root, 'scripts', s), 0o755);
  }
  // A file the audit must never flag, so a passing run means "scanned and clean", not "scanned
  // nothing" — the corpus guard needs something to count.
  mkdirSync(join(root, 'packages'), { recursive: true });
  writeFileSync(join(root, 'packages/inert.ts'), 'export const ok = 1;\n');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};
const audit = (root: string, which: 'seams' | 'identity') =>
  spawnSync(`./scripts/audit-${which}.sh`, [], { cwd: root, encoding: 'utf8', timeout: 60_000 });

describe('audit scope is inverted (#104)', () => {
  it('passes on a clean tree, and says what it scanned', () => {
    const r = audit(tree({}), 'seams');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SEAM AUDIT PASS');
    // A bare PASS is what made this issue invisible for three review rounds.
    expect(r.stdout).toMatch(/scope: \d+ files scanned/);
  });

  it('scans tests/, which the old enumeration did not — the file that started #104', () => {
    const r = audit(
      tree({ 'tests/contract/host.contract.test.ts': "const b = 'tmux';\n" }),
      'seams',
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('tests/contract/host.contract.test.ts');
  });

  it('scans config/ for invariant 8, which the old enumeration did not', () => {
    const r = audit(
      tree({ 'config/probe.ts': 'export const y = (u) => isOwner(u);\n' }),
      'identity',
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('config/probe.ts');
  });

  it('scans a directory nobody enumerated, because the default is now in-scope', () => {
    // The property the old form could not have: a directory invented after the audit was written.
    const r = audit(tree({ 'brand-new-top-level/thing.ts': "const b = 'launchd';\n" }), 'seams');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('brand-new-top-level/thing.ts');
  });

  it('exempts prose only at the root, not a docs/ nested anywhere', () => {
    const r = audit(tree({ 'packages/x/docs/leak.ts': "const b = 'tmux';\n" }), 'seams');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('packages/x/docs/leak.ts');
  });

  it('still exempts the root prose trees, or every run report would fail the build', () => {
    const r = audit(tree({ 'docs/runs/2026-01-01.md': 'we found a tmux argv bug\n' }), 'seams');
    expect(r.status).toBe(0);
  });

  it('refuses rather than passing when it cannot load its own scope', () => {
    const root = tree({});
    rmSync(join(root, 'scripts/audit-scope.sh'));
    const r = audit(root, 'seams');
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('ABORT');
    expect(r.stdout).not.toContain('PASS');
  });
});
