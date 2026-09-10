import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// M-01: a gate check that cannot be trusted is worse than no gate check.
//
// Both audits guard every check with `[[ -d ]]` over packages/, apps/ and adapters/. On a tree
// without them they exit 0 having scanned nothing, and condition 0.1 reported that as PASS -- a
// green light for a check that never ran. Blueprint §23 and CLAUDE.md §2.1: unknown must look
// unknown, and UNPROVEN is never PASS.
//
// Both cases run against synthetic trees, never against this repo. Running the real gate here
// would recurse: its 0.2 shells out to `pnpm run verify`, which runs this suite, which runs the
// gate again. That is not hypothetical -- the first version of this file did exactly that and
// took 120s before failing.

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPTS = ['gate-check.sh', 'audit-seams.sh', 'audit-identity.sh'];

/** A throwaway tree holding only the scripts, plus whichever scan roots are asked for. */
const makeTree = (scanRoots: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  mkdirSync(join(dir, 'scripts'));
  for (const s of SCRIPTS) {
    const dest = join(dir, 'scripts', s);
    cpSync(join(repoRoot, 'scripts', s), dest);
    chmodSync(dest, 0o755);
  }
  // No "verify" key: 0.2 must resolve without shelling back into this suite.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  for (const root of scanRoots) {
    mkdirSync(join(dir, root, 'src'), { recursive: true });
    writeFileSync(join(dir, root, 'src', 'index.ts'), 'export {};\n');
  }
  return dir;
};

const runGate = (cwd: string) => {
  const r = spawnSync('./scripts/gate-check.sh', ['0'], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.error !== undefined || r.signal !== null) {
    throw new Error(`gate-check did not exit: ${r.signal ?? r.error?.message}`);
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

/** The verdict line printed under a given condition heading, e.g. "0.1". */
const verdict = (out: string, id: string) => {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.startsWith(id));
  return i === -1 ? '' : (lines[i + 1] ?? '');
};

describe('gate-check phase 0', () => {
  it('reports UNPROVEN, not PASS, when the audits had nothing to scan', () => {
    // Exactly the shape `main` had before P0-01 landed, when 0.1 printed PASS.
    const out = runGate(makeTree([]));

    expect(verdict(out, '0.1')).toContain('UNPROVEN');
    expect(verdict(out, '0.1')).not.toContain('PASS');
    // The stronger property the issue asks for: nothing in an empty tree may claim PASS.
    expect(out.match(/^\s*PASS\b.*$/gm) ?? []).toEqual([]);
    expect(out).toContain('GATE 0: not met');
  });

  it('reports PASS for 0.1 only once the audits actually scan files', () => {
    const out = runGate(makeTree(['packages/domain', 'apps/gateway', 'adapters/host/darwin']));

    expect(verdict(out, '0.1')).toContain('PASS');
    expect(verdict(out, '0.1')).not.toContain('UNPROVEN');
  });

  it('reports UNPROVEN when a scan root exists but holds no files', () => {
    // A directory existing is not a scan. `mkdir packages` alone previously produced
    // "PASS audits green over packages" with zero files examined -- the same defect this issue
    // exists to fix, one notch down.
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    mkdirSync(join(dir, 'scripts'));
    for (const s of SCRIPTS) {
      const dest = join(dir, 'scripts', s);
      cpSync(join(repoRoot, 'scripts', s), dest);
      chmodSync(dest, 0o755);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
    mkdirSync(join(dir, 'packages'));

    const out = runGate(dir);
    expect(verdict(out, '0.1')).toContain('UNPROVEN');
    expect(out.match(/^\s*PASS\b.*$/gm) ?? []).toEqual([]);
  });

  it('still fails 0.1 when a populated tree actually violates an invariant', () => {
    // A PASS must mean "scanned and clean", not merely "scanned".
    const dir = makeTree(['packages/domain']);
    writeFileSync(join(dir, 'packages/domain/src/index.ts'), "export const x = 'worktree';\n");

    expect(verdict(runGate(dir), '0.1')).toContain('FAIL');
  });

  it('does not use a pnpm flag that pnpm rejects', () => {
    // `pnpm -s` is rejected by pnpm >=12 with `unexpected argument '-s'`, so 0.2 reported FAIL
    // whatever the truth was -- indistinguishable from a genuine failure. Asserted against the
    // script text because the symptom is invisible in the output.
    // Strip comments first: the script explains this very bug in prose, and a naive scan would
    // match its own explanation.
    const code = readFileSync(join(repoRoot, 'scripts/gate-check.sh'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/pnpm\s+-s\b/);
    expect(code).toMatch(/pnpm\s+--silent\s+run\s+verify/);
  });
});
