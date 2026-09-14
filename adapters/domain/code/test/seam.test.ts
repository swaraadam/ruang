/**
 * Adapter-private unit tests: the things that are true of *this* adapter and no other.
 *
 * The shared contract assertions live in `tests/contract/` and are deliberately not repeated here
 * — an adapter that carries its own copy of the contract is a hole in the seam. What is checked
 * here is git-specific: that the substrate stays inside the package, that the process runner cannot
 * grow a mutating verb, and that patch range headers become the anchors they claim to be.
 */
import { spawnSync } from 'node:child_process';
// prettier-ignore
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DomainAdapter } from '@internal/domain';
import type { ChangeSet } from '@internal/protocol';
import { describe, expect, it } from 'vitest';
import { codeHarness } from '../../../../tests/contract/code-harness.js';
import { createCodeAdapter } from '../src/adapter.js';
import { runGit } from '../src/process.js';

/**
 * Wider than `scripts/audit-seams.sh`, on purpose: the audit does not scan `adapters/` for git
 * words at all (they are legitimate here), so the only thing standing between the substrate and
 * the seam is this file. It therefore also catches the §3 table's right-hand column.
 */
const SUBSTRATE =
  /\b(git|commit|commits|branch|branches|merge|merged|worktree|diff|hunk|repo|repository|checkout|rebase|stash)\b/i;

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

describe('the exported surface names no substrate (invariant 9, acceptance 4)', () => {
  it.each(['index.ts', 'surface.ts'])(
    '%s has no substrate word in a type, field, doc comment or string',
    (name) => {
      const offending = read(name)
        .split('\n')
        .map((line, i) => `${i + 1}: ${line.trim()}`)
        .filter((l) => SUBSTRATE.test(l));
      expect(offending).toEqual([]);
    },
  );

  it('exports nothing from a module that is allowed to name the substrate', () => {
    // If `index.ts` ever re-exports from an implementation module, the scan above stops covering
    // the surface. Pin the two files it does cover.
    const from = [...read('index.ts').matchAll(/from '\.\/(\w+)\.js'/g)].map((m) => m[1]);
    expect([...new Set(from)].sort()).toEqual(['adapter', 'surface']);
  });
});

describe('nothing the adapter produces at runtime leaks substrate (acceptance 4)', () => {
  it('emits no substrate word in any returned value or refusal message', async () => {
    const s = await codeHarness.setUp();
    const seen: unknown[] = [];
    const capture = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        seen.push({ label, value: await fn() });
      } catch (error) {
        seen.push({ label, refusal: error instanceof Error ? error.message : String(error) });
      }
    };
    try {
      const basis = await s.adapter.snapshot_basis(s.project, s.consulted);
      const sandbox = await s.adapter.open_sandbox(s.project, basis);
      s.leaveUnsavedWork(sandbox);
      const set = await s.adapter.compute_change_set(sandbox);
      const wide = { change_budget: 9999, max_risk: 'high' } as const;
      const plan = await s.adapter.apply_plan(set, wide);
      const done = plan.operations.map((op) => ({ ...op, succeeded: true, detail: 'applied' }));
      const applied = await s.adapter.confirm_applied(plan.plan_id, done);
      const specs = await s.adapter.declared_checks(s.project);
      const a = s.adapter;
      // The last four are refusal paths: an error message is the easiest place for a leak to escape.
      for (const [label, fn] of [
        ['basis', async () => basis],
        ['staleness', () => a.is_basis_stale(basis)],
        ['sandbox', async () => sandbox],
        ['inspection', () => a.inspect_sandbox(sandbox)],
        ['change_set', async () => set],
        ['rendered', () => a.render_change_set(set, 'mobile')],
        ['specs', async () => specs],
        ['results', () => a.run_checks(sandbox, specs)],
        ['plan', async () => plan],
        ['applied', async () => applied],
        ['reversal', () => a.revert_or_compensate(applied)],
        ['reconcile', () => a.reconcile({ nothing_observable: 'x' })],
        ['closed', () => a.close_sandbox(sandbox, { force: false, retain_artifacts: true })],
        ['unknown project', () => a.snapshot_basis('another-project', [])],
        ['unknown basis', () => a.open_sandbox(s.project, s.unresolvableBasis())],
        ['over budget', () => a.apply_plan(set, { ...wide, change_budget: 0 })],
        ['over risk', () => a.apply_plan(set, { ...wide, max_risk: 'low' })],
      ] as const)
        await capture(label, fn);
    } finally {
      s.tearDown();
    }

    // Paths carry the temp directory's name, which is fixture noise rather than adapter output.
    const emitted = JSON.stringify(seen).replaceAll(/\/[^"]*contract-code-[^"]*?(?="|\\)/g, '');
    const words = [...emitted.matchAll(new RegExp(SUBSTRATE.source, 'gi'))].map((m) => m[0]);
    expect(words).toEqual([]);
    expect(seen.length).toBe(17);
  });
});

describe('the process runner cannot grow a mutating verb', () => {
  it.each(['push', 'merge', 'rebase', 'reset', 'branch', 'tag', 'filter-branch'])(
    'refuses to run %s',
    async (subcommand) => {
      await expect(runGit(process.cwd(), [subcommand])).rejects.toThrow(/allow-list/);
    },
  );

  // The sandbox lifecycle is the one permitted subcommand with verbs of its own, so permitting it
  // by name alone permitted all of them -- including three the package never uses.
  it.each(['lock', 'move', 'repair'])(
    'refuses the %s verb of a permitted subcommand',
    async (v) => {
      await expect(runGit(process.cwd(), ['worktree', v])).rejects.toThrow(/allow-list/);
    },
  );
});

describe('patch range headers become the anchors they claim to be (§5.2.1)', () => {
  it('anchors the exact lines the patch reports, with matching counts', async () => {
    const s = await codeHarness.setUp();
    try {
      const basis = await s.adapter.snapshot_basis(s.project, s.consulted);
      const sandbox = await s.adapter.open_sandbox(s.project, basis);
      // The harness appends a fourth line to a three-line resource.
      s.leaveUnsavedWork(sandbox);
      const set = await s.adapter.compute_change_set(sandbox);
      expect(set.changes).toHaveLength(1);
      expect(set.changes[0]).toEqual({
        kind: 'text_patch',
        resource_id: 'architecture.md',
        anchors: [
          { kind: 'text_range', resource_id: 'architecture.md', start_line: 4, end_line: 4 },
        ],
        added: 1,
        removed: 0,
      });
      expect(set.change_unit).toBe('lines');
      expect(set.change_size).toBe(1);
    } finally {
      s.tearDown();
    }
  });
});

/**
 * A name is an input too, and the substrate does not print every name literally: a control
 * character, a quote or a backslash makes it escape the name in every listing that is not
 * NUL-delimited, and `core.quotePath=false` covers only the non-ASCII case. Read back, that
 * spelling names nothing on disk.
 *
 * Neither consequence was cosmetic. An untracked resource under a name this module then failed to
 * find counted as **zero** lines, so a filename set the apparent size of a change set -- 506 real
 * lines reported as 6, planned cleanly under a budget of 20. And an escaped patch header did not
 * match, so the ranges belonging to that resource were appended to the anchors of the resource
 * rendered *before* it: a review surface showing edits against a file that does not contain them,
 * which is invariant 1 in the record a reviewer trusts.
 *
 * So the assertions are the size the caller is told against the size that is there, and every range
 * against the resource it names. A name that merely round-trips as a string satisfies neither.
 */
describe('a resource whose name the substrate cannot print literally (invariant 1, §16.6)', () => {
  const PROJECT = 'names-are-input';
  const git = (cwd: string, args: readonly string[]): void => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture setup failed: git ${args.join(' ')}\n${r.stderr}`);
  };

  type Fixture = {
    set: ChangeSet;
    adapter: DomainAdapter;
    at: string;
    tearDown: () => void;
  };

  const fixture = async (
    seed: (at: string) => void,
    work: (at: string) => void,
  ): Promise<Fixture> => {
    const root = mkdtempSync(join(tmpdir(), 'hostile-names-'));
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    git(source, ['init', '-q', '-b', 'main', '.']);
    seed(source);
    git(source, ['add', '-A']);
    const who = ['user.name=fixture', 'user.email=f@example.invalid', 'commit.gpgsign=false'];
    git(source, [...who.flatMap((c) => ['-c', c]), 'commit', '-q', '-m', 'baseline']);

    const sandboxes = join(root, 'sandboxes');
    const adapter = createCodeAdapter({
      project_id: PROJECT,
      source_of_record: source,
      sandbox_root: sandboxes,
      artifacts_root: join(root, 'artifacts'),
    });
    const basis = await adapter.snapshot_basis(PROJECT, []);
    const sandbox = await adapter.open_sandbox(PROJECT, basis);
    const at = join(sandboxes, PROJECT, sandbox.sandbox_id);
    work(at);
    return {
      set: await adapter.compute_change_set(sandbox),
      adapter,
      at,
      tearDown: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  type Named = { resource_id: string };
  const byId = <T extends Named>(xs: readonly T[]): T[] =>
    [...xs].sort((a, b) => (a.resource_id < b.resource_id ? -1 : 1));
  const patchesOf = (set: ChangeSet): Named[] =>
    set.changes.flatMap((c) => (c.kind === 'text_patch' ? [c] : []));
  const range = (resource_id: string, start_line: number, end_line: number): unknown => ({
    kind: 'text_range',
    resource_id,
    start_line,
    end_line,
  });

  /** Every spelling that forces an escape, plus two that do not, so the plain path stays covered. */
  // prettier-ignore
  const NAMES = [
    'plain', 'with space', '-leading-dash', 'nön-äscii-Ω-漢字',
    'new\nline', 'tab\there', 'back\\slash', 'double"quote',
  ];
  const BEFORE = 't1\nt2\nt3\n';
  const AFTER = 't1\nEDITED\nt3\n';
  const FRESH_LINES = 7;
  const fresh = `${Array.from({ length: FRESH_LINES }, (_, i) => `n${i}`).join('\n')}\n`;

  it('is counted, found and anchored under the name it is actually stored as', async () => {
    const f = await fixture(
      (at) => {
        for (const n of NAMES) writeFileSync(join(at, `${n}-t.md`), BEFORE);
        writeFileSync(join(at, 'removed.md'), 'r1\nr2\n');
      },
      (at) => {
        for (const n of NAMES) {
          writeFileSync(join(at, `${n}-t.md`), AFTER);
          writeFileSync(join(at, `${n}-u.md`), fresh);
        }
        unlinkSync(join(at, 'removed.md'));
      },
    );
    try {
      const expected = [
        ...NAMES.map((n) => ({
          kind: 'text_patch',
          resource_id: `${n}-t.md`,
          anchors: [range(`${n}-t.md`, 2, 2)],
          added: 1,
          removed: 1,
        })),
        ...NAMES.map((n) => ({
          kind: 'text_patch',
          resource_id: `${n}-u.md`,
          anchors: [range(`${n}-u.md`, 1, FRESH_LINES)],
          added: FRESH_LINES,
          removed: 0,
        })),
        // A removal's new side names the null device, which is no resource at all: nothing to
        // anchor, and nothing to spill onto whichever resource the patch rendered before it.
        { kind: 'text_patch', resource_id: 'removed.md', anchors: [], added: 0, removed: 2 },
      ];
      expect(byId(patchesOf(f.set))).toEqual(byId(expected));

      const truth = NAMES.length * 2 + NAMES.length * FRESH_LINES + 2;
      expect(f.set.change_size).toBe(truth);
      // Not just a matching string: the name handed back is the one the resource is stored under.
      for (const n of NAMES) {
        expect(existsSync(join(f.at, `${n}-t.md`))).toBe(true);
        expect(existsSync(join(f.at, `${n}-u.md`))).toBe(true);
      }

      // The consequence the count actually has. Understating it is not a fidelity loss, it is the
      // budget gate answering about a change set that does not exist.
      const risk = { max_risk: 'high' } as const;
      await expect(
        f.adapter.apply_plan(f.set, { ...risk, change_budget: truth - 1 }),
      ).rejects.toThrow();
      await expect(
        f.adapter.apply_plan(f.set, { ...risk, change_budget: truth }),
      ).resolves.toBeDefined();
    } finally {
      f.tearDown();
    }
  });

  it('keeps a range inside a resource whose own content spells a patch header', async () => {
    const f = await fixture(
      (at) => {
        writeFileSync(
          join(at, 'guide.md'),
          `${Array.from({ length: 10 }, (_, i) => `g${i + 1}`).join('\n')}\n`,
        );
        writeFileSync(join(at, 'target.md'), 'x1\nx2\n');
      },
      (at) => {
        // Content, not structure. Rendered with its leading `+`, this added line is indistinguishable
        // from the header of the next resource -- and a repository full of documents about patches
        // is not an exotic input here.
        const body = [
          'g1',
          '++ b/target.md',
          'g2',
          'g3',
          'g4',
          'g5',
          'g6',
          'g7',
          'g8',
          'g9',
          'EDITED',
        ];
        writeFileSync(join(at, 'guide.md'), `${body.join('\n')}\n`);
        writeFileSync(join(at, 'target.md'), 'x1\nEDITED\n');
      },
    );
    try {
      expect(byId(patchesOf(f.set))).toEqual([
        {
          kind: 'text_patch',
          resource_id: 'guide.md',
          anchors: [range('guide.md', 2, 2), range('guide.md', 11, 11)],
          added: 2,
          removed: 1,
        },
        {
          kind: 'text_patch',
          resource_id: 'target.md',
          anchors: [range('target.md', 2, 2)],
          added: 1,
          removed: 1,
        },
      ]);
    } finally {
      f.tearDown();
    }
  });
});
