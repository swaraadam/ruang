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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sandbox } from '@internal/domain';
import type { ChangeSet } from '@internal/protocol';
import { describe, expect, it } from 'vitest';
import { codeHarness } from '../../../../tests/contract/code-harness.js';
import { createCodeAdapter } from '../src/adapter.js';
import { runGit } from '../src/process.js';
import type { CodeAdapterOptions } from '../src/surface.js';

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
      const specs = await s.adapter.declared_checks(s.project);
      const a = s.adapter;
      // The last three are refusal paths: an error message is the easiest place for a leak to escape.
      for (const [label, fn] of [
        ['basis', async () => basis],
        ['staleness', () => a.is_basis_stale(basis)],
        ['sandbox', async () => sandbox],
        ['inspection', () => a.inspect_sandbox(sandbox)],
        ['change_set', async () => set],
        ['rendered', () => a.render_change_set(set, 'mobile')],
        ['specs', async () => specs],
        ['results', () => a.run_checks(sandbox, specs)],
        ['unknown project', () => a.snapshot_basis('another-project', [])],
        ['unknown basis', () => a.open_sandbox(s.project, s.unresolvableBasis())],
        ['unsafe identifier', () => a.inspect_sandbox(s.forgedSandbox().sandbox)],
      ] as const)
        await capture(label, fn);
    } finally {
      s.tearDown();
    }

    // Paths carry the temp directory's name, which is fixture noise rather than adapter output.
    const emitted = JSON.stringify(seen).replaceAll(/\/[^"]*contract-code-[^"]*?(?="|\\)/g, '');
    const words = [...emitted.matchAll(new RegExp(SUBSTRATE.source, 'gi'))].map((m) => m[0]);
    expect(words).toEqual([]);
    expect(seen.length).toBe(11);
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
  // by name alone permits all of them. `remove` and `prune` are on this list rather than the
  // allow-list because teardown left for #108 and took the only caller with it: a package with no
  // method that destroys a sandbox should not be one command away from being able to.
  it.each(['lock', 'move', 'repair', 'remove', 'prune'])(
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
const PROJECT = 'names-are-input';
const git = (cwd: string, args: readonly string[]): void => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture setup failed: git ${args.join(' ')}\n${r.stderr}`);
};

type Fixture = {
  set: ChangeSet;
  adapter: ReturnType<typeof createCodeAdapter>;
  sandbox: Sandbox;
  /** Where the sandbox is, and where the source of record is: hostile input arrives at both. */
  at: string;
  source: string;
  tearDown: () => void;
};

/**
 * One source of record, one sandbox, one change set. `work` receives the source of record as well
 * as the sandbox because a sandbox shares its source's configuration, which is an input too.
 */
const fixture = async (
  seed: (at: string) => void,
  work: (at: string, source: string) => void,
  options: Partial<CodeAdapterOptions> = {},
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
    ...options,
  });
  const basis = await adapter.snapshot_basis(PROJECT, []);
  const sandbox = await adapter.open_sandbox(PROJECT, basis);
  const at = join(sandboxes, PROJECT, sandbox.sandbox_id);
  work(at, source);
  return {
    set: await adapter.compute_change_set(sandbox),
    adapter,
    sandbox,
    at,
    source,
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
describe('a resource whose name the substrate cannot print literally (invariant 1, §16.6)', () => {
  /**
   * The cross-product, not the shapes someone happened to list. Two properties interact here and
   * each has now been fixed on its own: the substrate C-quotes a name holding a control character,
   * a quote or a backslash, and it appends a field separator when the *rendered* label -- quotes
   * included -- holds a space. One trigger per name is exactly why the quoted-and-spaced half of
   * this defect survived the first fix of it, so every trigger appears both with and without one.
   */
  // prettier-ignore
  const TRIGGERS = [
    'plain', '-leading-dash', 'nön-äscii-Ω-漢字',
    'new\nline', 'tab\there', 'back\\slash', 'double"quote',
  ];
  const NAMES = TRIGGERS.flatMap((t) => [t, `sp ace ${t}`]);
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
    } finally {
      f.tearDown();
    }
  });

  it('keeps a range inside a resource whose own content spells a patch header', async () => {
    const f = await fixture(
      (at: string) => {
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

/**
 * A sandbox shares its source of record's configuration file, so `git config` run *inside* a
 * sandbox decides what the adapter runs *outside* one -- and it persists there after the sandbox is
 * gone. `diff.external` is `GIT_EXTERNAL_DIFF` spelled differently, and it turned
 * `compute_change_set` into an execution of an arbitrary program; `core.fsmonitor` does the same
 * through `inspect_sandbox`, which §5.2.3 promises is non-mutating. A command-line `-c` outranks
 * every configuration file, which is the only way to reach that file.
 *
 * The table is the audit rather than the two keys that were reported. A driver's name comes from
 * the content itself -- `.gitattributes` selects `diff=<name>` -- so `diff.<name>.command` and
 * `diff.<name>.textconv` cannot be pinned by name and are refused per invocation instead. The two
 * channels that stay open are named in `process.ts`, not left for the next reviewer to rediscover.
 */
describe('the source of record’s own configuration cannot turn a read into an execution', () => {
  /** `tail` is what the program does after leaving its mark, so the substrate carries on as usual. */
  const CHANNELS = [
    { key: 'diff.external', tail: 'exit 0', attribute: null },
    { key: 'core.fsmonitor', tail: 'exit 1', attribute: null },
    { key: 'diff.evil.command', tail: 'exit 0', attribute: '* diff=evil\n' },
    { key: 'diff.evil.textconv', tail: 'cat "$1"', attribute: '* diff=evil\n' },
    { key: 'core.pager', tail: 'cat', attribute: null },
  ] as const;

  it.each(CHANNELS)('runs no program named by $key', async (channel) => {
    const mark = `ran-${channel.key}`;
    const f = await fixture(
      (at) => {
        writeFileSync(join(at, 'seed.md'), 'one\ntwo\n');
        if (channel.attribute !== null)
          writeFileSync(join(at, '.gitattributes'), channel.attribute);
      },
      (at, source) => {
        const program = join(source, '..', 'named-by-configuration.sh');
        const marker = join(source, '..', mark);
        writeFileSync(program, `#!/bin/sh\necho ran >> "${marker}"\n${channel.tail}\n`, {
          mode: 0o755,
        });
        // Armed the way an actor inside the sandbox arms it, from inside the sandbox.
        git(at, ['config', channel.key, program]);
        writeFileSync(join(at, 'seed.md'), 'one\nEDITED\n');
      },
    );
    try {
      await f.adapter.inspect_sandbox(f.sandbox);
      expect(existsSync(join(f.source, '..', mark))).toBe(false);
      // And the answer is still the answer: refusing the program costs no fidelity.
      expect(f.set.change_size).toBe(2);
    } finally {
      f.tearDown();
    }
  });

  /**
   * The same file reaching the same methods from the other direction, and the consequential one: one
   * key made a sandbox holding the only copy of a resource report "no unsaved changes", and the
   * teardown that followed was refused nothing -- `force` was never asked for (§10.4, invariant 3).
   * Teardown is #108. `safe_to_close` is still what it will read, so the report is what is pinned
   * here: a query that fails closed is what makes the teardown behind it safe to write at all.
   */
  it('reports the unsaved work that is there, whatever the configuration says to list', async () => {
    const f = await fixture(
      (at) => writeFileSync(join(at, 'seed.md'), 'one\n'),
      (at) => {
        writeFileSync(join(at, 'the-only-copy.md'), 'work that exists nowhere else\n');
        git(at, ['config', 'status.showUntrackedFiles', 'no']);
      },
    );
    try {
      const inspection = await f.adapter.inspect_sandbox(f.sandbox);
      expect(inspection).toMatchObject({ dirty: true, safe_to_close: false });
      expect(inspection.unsaved_summary).toContain('1 resource(s) with unsaved changes');
      expect(existsSync(join(f.at, 'the-only-copy.md'))).toBe(true);
    } finally {
      f.tearDown();
    }
  });
});

/**
 * A reference is a name for content held somewhere else, and it is never read *through*. Following
 * one counted 137 lines living outside the sandbox as work done inside it -- invariant 1 in the
 * number a budget decision is made on -- and, when the name led to a directory, threw the
 * substrate's own error out of `compute_change_set` instead of refusing (`surface.ts`: a refusal,
 * not a crash). What the reference holds is one line, which is what the source of record stores.
 */
describe('a reference is described, never read through (§5.2.1, invariant 1)', () => {
  const OUTSIDE = 137;
  const held = `${Array.from({ length: OUTSIDE }, (_, i) => `held ${i}`).join('\n')}\n`;

  it('counts the reference and not the resource it names, wherever that resource leads', async () => {
    const f = await fixture(
      (at) => writeFileSync(join(at, 'seed.md'), 'one\n'),
      (at, source) => {
        const outside = join(source, '..', 'not-the-sandbox');
        mkdirSync(join(outside, 'a-directory'), { recursive: true });
        writeFileSync(join(outside, 'held-elsewhere.md'), held);
        writeFileSync(join(outside, 'a-directory', 'more.md'), held);
        symlinkSync(join(outside, 'held-elsewhere.md'), join(at, 'pointer.md'));
        // The limb that is not a fidelity loss but an unhandled crash: a name leading to a
        // directory, whose bytes cannot be read as text at all.
        symlinkSync(join(outside, 'a-directory'), join(at, 'dir-pointer'));
      },
    );
    try {
      expect(byId(patchesOf(f.set))).toEqual([
        {
          kind: 'text_patch',
          resource_id: 'dir-pointer',
          anchors: [range('dir-pointer', 1, 1)],
          added: 1,
          removed: 0,
        },
        {
          kind: 'text_patch',
          resource_id: 'pointer.md',
          anchors: [range('pointer.md', 1, 1)],
          added: 1,
          removed: 0,
        },
      ]);
      // Two references, two lines. Never 137, and never 274.
      expect(f.set.change_size).toBe(2);
    } finally {
      f.tearDown();
    }
  });
});

/**
 * §16.6 with invariant 1. `lines` has nothing to say about a resource that is not text, and scoring
 * one zero made "nothing changed" and "fourteen megabytes changed, in a shape I cannot count" the
 * same number: six binary resources planned cleanly under a budget of **zero**, with nothing forged
 * and nothing for the gate to catch.
 *
 * That gate is issue #108. What this half owes it is a change set that does not hand it a bare zero
 * to be fooled by — so the assertions here are on what `compute_change_set` says, which is the only
 * thing a later gate has to go on.
 */
describe('a change set the declared unit cannot size says so, never just scores zero', () => {
  const OPAQUE = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe]);
  const REVISED = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0xab, 0xcd]);
  const seedAssets = (at: string): void => {
    writeFileSync(join(at, 'first.opaque'), OPAQUE);
    writeFileSync(join(at, 'second.opaque'), OPAQUE);
  };
  const reviseAssets = (at: string): void => {
    writeFileSync(join(at, 'first.opaque'), REVISED);
    writeFileSync(join(at, 'second.opaque'), REVISED);
  };

  it('names the resources its unit cannot express, beside the size that excludes them', async () => {
    const f = await fixture(seedAssets, reviseAssets);
    try {
      expect(f.set.changes.every((c) => c.kind === 'asset_delta')).toBe(true);
      // Zero *lines* is true. A change set that stopped there would be the lie, because the only
      // difference between it and an untouched sandbox is a sentence nobody wrote.
      expect(f.set.change_size).toBe(0);
      expect(f.set.summary).toContain('2 not countable in lines');
    } finally {
      f.tearDown();
    }
  });

  it('measures the same change set in a unit that can express it', async () => {
    const f = await fixture(seedAssets, reviseAssets, { change_unit: 'files' });
    try {
      expect(f.set.change_size).toBe(2);
      expect(f.set.summary).not.toContain('not countable');
    } finally {
      f.tearDown();
    }
  });
});
