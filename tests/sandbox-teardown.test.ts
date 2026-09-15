import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

/**
 * #103. `git status --porcelain` omits ignored files, so a sandbox whose ONLY copy of some work sat
 * under an ordinary .gitignore reported `dirty_files: 0` and `safe_to_close: true` — and §7.6 tells
 * every agent to trust that before teardown. The 2026-09-13 run nearly lost 1400 authored lines to
 * a sandbox believed empty; only `dirty_files: 21` saved it.
 *
 * The distinction teardown needs is reproducibility, not tracked-ness: an ignored `dist/` can be
 * rebuilt, an ignored `notes/` cannot. Both halves are asserted here, because a guard that flags
 * every build directory is one nobody reads — which is the same failure one notch along.
 */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'sbx-'));
  const ignores = 'notes/\nnode_modules/\ndist/\nstate/dev/\n';
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'config'));
  cpSync(join(repoRoot, 'scripts/sandbox.sh'), join(root, 'scripts/sandbox.sh'));
  chmodSync(join(root, 'scripts/sandbox.sh'), 0o755);
  cpSync(
    join(repoRoot, 'config/reproducible-paths.json'),
    join(root, 'config/reproducible-paths.json'),
  );
  writeFileSync(join(root, '.gitignore'), ignores);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');

  const sb = join(root, '.sandboxes/T');
  mkdirSync(sb, { recursive: true });
  git(sb, 'init', '-q', '-b', 'main', '.');
  git(sb, 'config', 'user.email', 't@t');
  git(sb, 'config', 'user.name', 't');
  writeFileSync(join(sb, '.gitignore'), ignores);
  git(sb, 'add', '.gitignore');
  git(sb, 'commit', '-qm', 'init');
  for (const d of [
    'notes',
    'node_modules',
    'dist',
    'state/dev',
    'apps/web/dist',
    'packages/x/node_modules',
  ])
    mkdirSync(join(sb, d), { recursive: true });
  writeFileSync(join(sb, 'notes/plan.md'), 'the only copy of this work\n');
  writeFileSync(join(sb, 'node_modules/x.js'), 'j\n');
  writeFileSync(join(sb, 'dist/o.js'), 'b\n');
  writeFileSync(join(sb, 'state/dev/db.sqlite'), 's\n');
  // A pnpm workspace nests dist/ and node_modules/ under every package. A root-anchored match left
  // these looking unreproducible and made every real sandbox read as unsafe.
  writeFileSync(join(sb, 'apps/web/dist/b.js'), 'b\n');
  writeFileSync(join(sb, 'packages/x/node_modules/y.js'), 'y\n');
  return root;
};

const run = (root: string, cmd: string) =>
  spawnSync('./scripts/sandbox.sh', [cmd, 'T'], { cwd: root, encoding: 'utf8', timeout: 30_000 });

describe('sandbox teardown (#103)', () => {
  it('does not report safe_to_close when the only copy of work is gitignored', () => {
    const out = run(fixture(), 'inspect').stdout;
    expect(out).toContain('safe_to_close: false');
    expect(out).toContain('notes/');
  });

  it('does not treat an ordinary build artifact as precious', () => {
    const out = run(fixture(), 'inspect').stdout;
    // The whole point: flagging these too would make inspect noise nobody reads.
    expect(out).toContain('unreproducible_ignored: 1');
    for (const d of [
      'node_modules/',
      'dist/',
      'state/dev/',
      'apps/web/dist/',
      'packages/x/node_modules/',
    ]) {
      expect(out.split('ignored, and not declared reproducible:')[1] ?? '').not.toContain(d);
    }
  });

  it('rescues the content before refusing, rather than gating the rescue on the same blind predicate', () => {
    const root = fixture();
    const r = run(root, 'close');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('rescued 1');
    const dir = join(root, 'state/debug/sandbox-rescue');
    expect(existsSync(dir)).toBe(true);
    const stamp = execFileSync('ls', [dir], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
    expect(stamp).not.toBe('');
    expect(readFileSync(join(dir, stamp, 'notes/plan.md'), 'utf8')).toBe(
      'the only copy of this work\n',
    );
  });

  /**
   * B1 from the review of PR #107, and it was right. The check ended in `|| true` to stop `set -e`
   * firing on grep's empty-match, which masked every other failure too: a crash produced empty
   * stdout, indistinguishable from "nothing unreproducible found", so `safe_to_close: true` and
   * `close` walked into an irreversible `git worktree remove`. #103's own defect one layer down.
   *
   * The first fix read the pipeline's exit status and tolerated 1 as grep's no-match — but an
   * unhandled Python exception also exits 1, so it still failed open. These tests exist because
   * that second version passed review-by-reasoning and failed the moment it was run.
   */
  it('refuses when the check itself crashes, rather than reading empty output as clean', () => {
    const root = fixture();
    writeFileSync(join(root, 'config/reproducible-paths.json'), '{ broken');
    const r = run(root, 'inspect');
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('did not complete');
    expect(r.stdout).not.toContain('safe_to_close: true');
  });

  it('does not destroy the sandbox when the check crashes', () => {
    const root = fixture();
    writeFileSync(join(root, 'config/reproducible-paths.json'), '{ broken');
    const r = run(root, 'close');
    expect(r.status).toBe(2);
    // The property that matters: an irreversible step never runs on an unanswered question.
    expect(existsSync(join(root, '.sandboxes/T'))).toBe(true);
  });

  it('refuses when python3 is unavailable, which the stack does not guarantee', () => {
    const root = fixture();
    mkdirSync(join(root, 'fakebin'));
    writeFileSync(join(root, 'fakebin/python3'), '#!/bin/sh\nexit 127\n');
    chmodSync(join(root, 'fakebin/python3'), 0o755);
    const r = spawnSync('./scripts/sandbox.sh', ['inspect', 'T'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${join(root, 'fakebin')}:${process.env.PATH ?? ''}` },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('safe_to_close: true');
  });

  it('finds content whose path contains a space', () => {
    const root = fixture();
    writeFileSync(join(root, '.sandboxes/T/notes/plan with space.md'), 'only copy\n');
    const out = run(root, 'inspect').stdout;
    expect(out).toContain('safe_to_close: false');
  });

  it('refuses outright when the reproducible list is absent, rather than guessing', () => {
    const root = fixture();
    writeFileSync(join(root, 'config/reproducible-paths.json'), '');
    execFileSync('rm', [join(root, 'config/reproducible-paths.json')]);
    const r = run(root, 'inspect');
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('cannot decide what is safe to destroy');
  });
});
