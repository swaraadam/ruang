import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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

/** M-05: 0.3/0.4 must EXECUTE a test, so a tree that cannot run vitest never reaches PASS. */
const withRunner = (dir: string) => {
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));
  return dir;
};

const put = (dir: string, rel: string, body: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

/** package.json with a verify script of our choosing, so 0.2 has a subject with a known answer. */
const withVerify = (dir: string, verify: string) => {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'f', private: true, scripts: { verify } }),
  );
  return dir;
};

/** PATH with every directory that provides `cmd` removed. */
const pathWithout = (cmd: string) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .filter((d) => d !== '' && !existsSync(join(d, cmd)))
    .join(delimiter);

/** What `command -v` finds under a given PATH. The control for pathWithout: a strip that missed a
 *  copy leaves the runner reachable and the test then measures nothing. That happened while
 *  writing this file -- node lived in two PATH directories and removing one changed no verdict. */
const resolves = (cmd: string, path: string) =>
  spawnSync('sh', ['-c', `command -v ${cmd} || true`], {
    env: { ...process.env, PATH: path },
    encoding: 'utf8',
  }).stdout.trim();

/** A stand-in `pnpm` first on PATH, so a runner's behaviour can be chosen rather than assumed. */
const shimPath = (dir: string, body: string) => {
  const bin = join(dir, 'shim-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pnpm'), body);
  chmodSync(join(bin, 'pnpm'), 0o755);
  return `${bin}${delimiter}${pathWithout('pnpm')}`;
};

const RESTART_TEST = 'adapters/host/darwin/tests/session-restart.test.ts';
const CONTRACT_TEST = 'packages/domain/src/basis.contract.test.ts';
const BROKEN_CONTRACT_TEST = 'packages/domain/src/collect-fail.contract.test.ts';
const oneTest = (green: boolean) =>
  `import { expect, it } from 'vitest';\nit('proves it', () => { expect(1).toBe(${green ? 1 : 2}); });\n`;

const runGateRaw = (cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  const opts = { cwd, env, encoding: 'utf8' as const, timeout: 60_000 };
  const r = spawnSync('./scripts/gate-check.sh', ['0'], opts);
  if (r.error !== undefined || r.signal !== null) {
    throw new Error(`gate-check did not exit: ${r.signal ?? r.error?.message}`);
  }
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
};
const runGate = (cwd: string) => runGateRaw(cwd).out;

/** The verdict line under a heading, e.g. "0.1". A `proof` line sits between them, so scan on. */
const verdict = (out: string, id: string) => {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.startsWith(id));
  if (i === -1) return '';
  return lines.slice(i + 1).find((l) => /^ {2}(PASS|FAIL|UNPROVEN)\b/.test(l)) ?? '';
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

  it('reports UNPROVEN, not FAIL, when an audit it runs is not there to run', () => {
    // 127 from a missing script is not an audit result. Same rule as 0.2, one condition up.
    const dir = makeTree(['packages/domain']);
    expect(verdict(runGate(dir), '0.1')).toContain('PASS'); // control: it passes when both exist
    rmSync(join(dir, 'scripts/audit-identity.sh'));

    const v = verdict(runGate(dir), '0.1');
    expect(v).toContain('UNPROVEN');
    expect(v).toContain('audit-identity.sh');
    expect(v).not.toContain('FAIL');
  }, 30_000);

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

// M-05 (#39): a condition RUNS something and READS ITS RESULT, or it reports UNPROVEN.
//
// 0.3 used to conclude from a recursive grep for "session survives gateway restart" over every
// .ts file, or from `ls adapters/host/darwin/**/*session*restart*`; 0.4 from a grep for
// "contract". In M-01 a fixture whose strings matched made this repo print "GATE 0: all
// conditions PASS", exit 0, with P0-08 and P0-13 never started. A filename and a file's contents
// are equally non-evidence, and so is a results artifact: its writer owns the filesystem the gate
// reads, and provenance fields are one `git rev-parse` from being correct on a fake.

describe('gate-check 0.3/0.4 prove themselves by executing a named test', () => {
  it('contains no recursive grep at all', () => {
    // Banned in comments too: the ban is only checkable if the literal never appears.
    expect(readFileSync(join(repoRoot, 'scripts/gate-check.sh'), 'utf8')).not.toMatch(
      /grep\s+(-[A-Za-z]*[rR]|--recursive)/,
    );
  });

  it('is unmoved by a .ts file holding the literal strings it used to grep for', () => {
    const dir = withRunner(makeTree(['packages/domain']));
    const before = runGate(dir);
    expect(before).toContain('basis.repo'); // the verdict states what it was computed against

    // The M-01 incident rebuilt: one file, both phrases, and the *.test.ts name 0.4 filtered on.
    put(
      dir,
      'packages/domain/src/decoy.test.ts',
      "export const n = ['session survives gateway restart', 'contract'];\n",
    );
    const after = runGate(dir);

    for (const id of ['0.1', '0.2', '0.3', '0.4'])
      expect(verdict(after, id)).toBe(verdict(before, id));
    expect(verdict(after, '0.3')).toContain('UNPROVEN');
    expect(verdict(after, '0.4')).toContain('UNPROVEN');
  }, 30_000);

  it('is unmoved by a zero-byte file at the exact path 0.3 names', () => {
    const dir = withRunner(makeTree(['packages/domain']));
    const before = verdict(runGate(dir), '0.3');
    put(dir, RESTART_TEST, ''); // on main this filename alone flipped 0.3 to PASS
    expect(readFileSync(join(dir, RESTART_TEST), 'utf8')).toBe('');

    expect(verdict(runGate(dir), '0.3')).toBe(before);
    expect(before).toContain('UNPROVEN');
  }, 30_000);

  it('reaches PASS only from a run, and follows that run when it stops passing', () => {
    const dir = withRunner(makeTree(['packages/domain']));
    // `true` is a real command with a real exit code and it does not re-enter the gate.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'f', scripts: { verify: 'true' } }),
    );
    put(dir, RESTART_TEST, oneTest(true));
    put(dir, CONTRACT_TEST, oneTest(true));

    const green = runGateRaw(dir);
    expect(verdict(green.out, '0.3')).toContain('PASS      restart survival: 1 test(s) executed');
    expect(verdict(green.out, '0.4')).toContain('PASS      contract suite: 1 test(s) executed');
    // The summary counts conditions; it is not merely the absence of a failure.
    expect(green.out.match(/^ {2}(PASS|FAIL|UNPROVEN)\b/gm) ?? []).toHaveLength(4);
    expect(green.out).toContain('GATE 0: all 4 conditions PASS');
    expect(green.status).toBe(0);

    // Only the assertion inside 0.3's test changes. A verdict read off the filesystem could not
    // notice; a verdict read off the runner has to.
    put(dir, RESTART_TEST, oneTest(false));
    expect(verdict(runGate(dir), '0.3')).toContain('FAIL');

    // Neither a skip nor a todo is a result. Each paired with a PASSING test so p>0 and only
    // the skip branch can produce this; a stub-only file yields p==0, indistinguishable from
    // nothing running. it.todo lands in a fourth vitest counter and is how a half-written
    // P0-08 would look.
    // Bodyless describe.todo declares zero tests: it lands only in numPendingTestSuites.
    const imp = ['{ expect, it }', '{ describe, expect, it }'] as const;
    for (const s of ["it.skip('x', () => {});", "it.todo('x');", "describe.todo('x');"]) {
      put(dir, RESTART_TEST, oneTest(true).replace(imp[0], imp[1]) + s + '\n');
      expect(verdict(runGate(dir), '0.3'), s).toContain('skipped');
    }
  }, 30_000);

  it('is unmoved by a hand-written artifact with a correct HEAD and a fresh timestamp', () => {
    const dir = withRunner(makeTree(['packages/domain']));
    put(dir, '.gitignore', 'node_modules\n');
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=f@example.invalid', '-c', 'user.name=f', 'commit', '-qm', 'fixture');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    // Freshness is not authenticity: the forger writes to the filesystem the gate reads, so both
    // provenance fields are genuinely correct here.
    const forged = JSON.stringify({
      ref: head,
      at: new Date().toISOString(),
      '0.3': 'pass',
      '0.4': 'pass',
    });
    for (const f of ['state/gate/results.json', 'state/artifacts/gate.json']) put(dir, f, forged);

    const out = runGate(dir);
    expect(verdict(out, '0.3')).toContain('UNPROVEN');
    expect(verdict(out, '0.4')).toContain('UNPROVEN');
    // There is no cache to poison: the gate reads no results file anywhere under state/.
    expect(readFileSync(join(repoRoot, 'scripts/gate-check.sh'), 'utf8')).not.toContain('state/');
    // It publishes its own basis instead, so a forgery cannot borrow the gate's authority.
    expect(out).toContain(`basis.ref   ${head}`);
    expect(out).toMatch(/basis\.tree\s+dirty/);
  }, 30_000);

  it('refuses a suite that could not be collected, though every counter it reads says green', () => {
    // The `rc != 0` branch of check_by_running, which had no test and is deletable without one.
    // vitest reports a file that cannot be collected in numFailedTestSuites, NOT in
    // numFailedTests: here it is 1 passed / 0 failed / 0 skipped and exit 1. Every counter the
    // verdict reads says green, so the runner's own exit code is the only evidence left that
    // half the selected suite never ran.
    const dir = withRunner(makeTree(['packages/domain']));
    put(dir, CONTRACT_TEST, oneTest(true));
    // Control: with only the healthy file this same tree reaches PASS, so the verdict below is
    // caused by the broken file and not by a fixture that could never pass.
    expect(verdict(runGate(dir), '0.4')).toContain('PASS      contract suite: 1 test(s) executed');

    put(
      dir,
      BROKEN_CONTRACT_TEST,
      "import './does-not-exist.js';\nimport { it } from 'vitest';\nit('never collected', () => {});\n",
    );
    const after = verdict(runGate(dir), '0.4');
    expect(after).toContain('UNPROVEN');
    expect(after).toMatch(/runner exited [1-9]\d* with 1 passing test\(s\)/);
    expect(after).not.toContain('PASS');
  }, 60_000);

  it('refuses to re-enter itself, by a guard rather than by a time bound', () => {
    const a = makeTree([]);
    const direct = runGateRaw(a, { ...process.env, GATE_CHECK_ROOTS: realpathSync(a) });
    expect(direct.status).not.toBe(0);
    expect(direct.out).toContain('re-entrant');
    expect(direct.out).not.toContain('0.1 vocabulary'); // no condition was even attempted

    // The real shape (gate -> verify -> vitest -> this file -> gate), minus vitest. A bounded
    // recursion is still a recursion, so depth 1 must already trip.
    const b = makeTree([]);
    writeFileSync(
      join(b, 'package.json'),
      JSON.stringify({ name: 'f', scripts: { verify: './scripts/gate-check.sh 0' } }),
    );
    // M-07: the refusal exits 2 with its reason on stderr, and 0.2 used to discard both and call
    // it "pnpm verify failing". A refusal is a run that did not happen, so it is UNPROVEN, and
    // the reason travels with it -- otherwise the gate reports a failing verify that never ran.
    const out = runGate(b);
    expect(verdict(out, '0.2')).toContain('UNPROVEN');
    expect(verdict(out, '0.2')).not.toContain('FAIL');
    expect(verdict(out, '0.2')).toContain('re-entrant invocation');
    expect(out).toContain('GATE 0: not met');
  }, 30_000);
});

// M-07 (#41): 0.2 ran `pnpm --silent run verify >/dev/null 2>&1` and mapped every non-zero exit to
// "pnpm verify failing". pnpm absent, pnpm rejecting a flag this gate passes, no verify script at
// all, and a run that refused itself all land on that same exit path -- so the gate reported a
// failing check where no check had run. Fail-closed, but not true, and untrue is how M-01 started.

describe('gate-check 0.2 tells a failing check from a runner that never ran', () => {
  it('reports UNPROVEN, not FAIL, when a runner it depends on is not on PATH', () => {
    const dir = withVerify(makeTree([]), 'true');
    // Control: with both runners present this exact tree reports PASS, so every UNPROVEN below is
    // the runner going missing rather than the fixture being unable to pass.
    expect(verdict(runGate(dir), '0.2')).toContain('PASS');

    for (const missing of ['pnpm', 'node'] as const) {
      const other = missing === 'pnpm' ? 'node' : 'pnpm';
      const path = pathWithout(missing);
      expect(resolves(missing, path), missing).toBe(''); // the strip worked ...
      expect(resolves(other, path), other).not.toBe(''); // ... and took nothing else with it

      const out = runGateRaw(dir, { ...process.env, PATH: path }).out;
      // 0.3 and 0.4 shell out to the same runner and must answer the same way.
      for (const id of ['0.2', '0.3', '0.4'])
        expect(verdict(out, id), `${missing} ${id}`).toContain(
          `runner '${missing}' is not on PATH`,
        );
      expect(verdict(out, '0.2'), missing).not.toContain('FAIL');
      expect(out, missing).toContain('GATE 0: not met'); // UNPROVEN is still not PASS
    }
  }, 30_000);

  it('reports what the verify script returned once the runner is proven', () => {
    const dir = makeTree([]);
    // `exit 2` is the control for the refusal branch below: exit 2 is what the re-entrancy guard
    // uses, and on its own it is not evidence that anything refused to run.
    const cases: [string, string][] = [
      ['true', 'PASS      pnpm verify green'],
      ['false', 'FAIL      pnpm verify failing (exit 1)'],
      ['exit 2', 'FAIL      pnpm verify failing (exit 2)'],
    ];
    for (const [script, want] of cases)
      expect(verdict(runGate(withVerify(dir, script)), '0.2'), script).toContain(want);
  }, 30_000);

  it('does not read the text "verify" in package.json as a verify script', () => {
    // The old predicate was `grep -q '\"verify\"' package.json`: text, not a script. pnpm exits 1
    // for both of these, and the gate called that a failing verify. Nothing ran.
    const dir = makeTree([]);
    for (const body of [
      '{"name":"f","private":true,"config":{"verify":"a key in the wrong place"}}',
      '{"name":"f","private":true,"scripts":{"verify":""}}',
      '{"name":"f","private":true,"scripts":{"verify":["true"]}}',
    ]) {
      expect(body).toContain('"verify"'); // the old predicate matched both
      writeFileSync(join(dir, 'package.json'), body);
      const v = verdict(runGate(dir), '0.2');
      expect(v, body).toContain('no verify script');
      expect(v, body).not.toContain('FAIL');
    }
  }, 30_000);

  it('believes a runner only after a known-good and a known-bad control invocation', () => {
    // Three runners that differ only in behaviour. If the verdict were the same for all three the
    // controls would be measuring nothing, so the discrimination is the point: two of these must
    // not produce a verdict about verify at all, and the third must.
    const version = '[ "$1" = "--version" ] && { echo 13.0.0-fake; exit 0; }\n';
    const dir = withVerify(makeTree([]), 'true'); // would PASS if the runner were taken on trust
    const runners: { why: string; body: string; want: string; says: string }[] = [
      {
        why: 'rejects the global flag this gate passes, as pnpm 12 rejects an unknown flag',
        body: `#!/bin/sh\n${version}for a in "$@"; do [ "$a" = "--silent" ] && { echo "error: unexpected argument '--silent' found" >&2; exit 2; }; done\nexit 0\n`,
        want: 'UNPROVEN',
        says: "pnpm 13.0.0-fake rejects the '--silent' this gate passes",
      },
      {
        why: 'answers 0 to everything, including a script that does not exist',
        body: `#!/bin/sh\n${version}exit 0\n`,
        want: 'UNPROVEN',
        says: 'which does not exist',
      },
      {
        why: 'accepts the flag, fails the known-bad control, and reports verify as failing',
        body: `#!/bin/sh\n${version}for a in "$@"; do [ "$a" = "--help" ] && exit 0; [ "$a" = "verify" ] && exit 1; done\nexit 1\n`,
        want: 'FAIL',
        says: 'pnpm verify failing (exit 1)',
      },
    ];
    for (const r of runners) {
      const out = runGateRaw(dir, { ...process.env, PATH: shimPath(dir, r.body) }).out;
      expect(verdict(out, '0.2'), r.why).toContain(r.want);
      expect(verdict(out, '0.2'), r.why).toContain(r.says);
    }
  }, 30_000);
});
