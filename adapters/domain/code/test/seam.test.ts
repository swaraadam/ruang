/**
 * Adapter-private unit tests: the things that are true of *this* adapter and no other.
 *
 * The shared contract assertions live in `tests/contract/` and are deliberately not repeated here
 * — an adapter that carries its own copy of the contract is a hole in the seam. What is checked
 * here is git-specific: that the substrate stays inside the package, that the process runner cannot
 * grow a mutating verb, and that patch range headers become the anchors they claim to be.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeHarness } from '../../../../tests/contract/code-harness.js';
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
