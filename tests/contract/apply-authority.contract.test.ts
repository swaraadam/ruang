/**
 * P0-20 / issue #89. Apply authority binds to the action it authorizes, or it binds to nothing.
 *
 * Every assertion here pins **discrimination**, never field presence. The defect this replaces was
 * a plan that carried an `apply_plan_hash` column's worth of meaning and no way to tell two applies
 * apart: a one-line documentation fix and a rewrite of a policy module produced byte-identical
 * operations and `target_ref`s. A test that only asserted the field existed would have passed then
 * and would pass now, which is why none of these do that.
 */
import type { ApplyPlan as DomainApplyPlan } from '@internal/domain';
import {
  type ApplyOperation,
  type ApplyPlan,
  type Basis,
  type ChangeSet,
  APPLY_PLAN_HASH_OUTSIDE,
  actionFingerprint,
  applyPlanHash,
  approvalBinding,
  basisStaleness,
  bindingMatches,
  changeSetHash,
  checkReversalPlan,
  isApplyPlan,
} from '@internal/protocol';
import { reversalView } from '@internal/web';
import { describe, expect, it } from 'vitest';

const changeSet = (resource_id: string, lines: number): Omit<ChangeSet, 'content_hash'> => ({
  change_set_id: 'cs-1',
  summary: 'a change',
  change_unit: 'lines',
  change_size: lines,
  changes: [
    {
      kind: 'text_patch',
      resource_id,
      anchors: [{ kind: 'text_range', resource_id, start_line: 1, end_line: lines }],
      added: lines,
      removed: 0,
    },
  ],
});

/** The two change sets from the issue, by name. */
const TRIVIAL = changeSetHash(changeSet('docs/readme', 1));
const DANGEROUS = changeSetHash(changeSet('policy/capability', 1800));

const BASIS: Basis = {
  ref: 'basis-ref-1',
  inputs: [
    { resource_id: 'docs/readme', version: 'v1' },
    { resource_id: 'policy/capability', version: 'v1' },
  ],
  captured_at: '2026-09-15T00:00:00.000Z',
};

const operation = (over: Partial<ApplyOperation> = {}): ApplyOperation => ({
  operation_id: 'op-1',
  operation: 'integrate',
  target_ref: 'project:demo',
  required_capability: 'apply_to_source_of_record',
  risk: 'medium',
  reversibility: 'revertible',
  disposition: 'forward',
  undoes: null,
  ...over,
});

const planOver = (over: Partial<ApplyPlan> = {}): ApplyPlan => ({
  plan_id: 'plan-1',
  basis: BASIS,
  change_set_hash: TRIVIAL,
  operations: [operation()],
  ...over,
});

const action = (plan: ApplyPlan, operation_id = 'op-1') => ({
  project_id: 'project-1',
  task_id: 'task-1',
  plan,
  operation_id,
});

describe('an ApplyPlan says what it applies (#89 C3)', () => {
  it('gives the documentation fix and the policy rewrite different hashes', () => {
    const trivial = planOver();
    const dangerous = planOver({ change_set_hash: DANGEROUS });
    // The operations really are byte-identical: this is the exact pair that used to collide.
    expect(trivial.operations).toEqual(dangerous.operations);
    expect(applyPlanHash(trivial)).not.toBe(applyPlanHash(dangerous));
  });

  it('reproduces one hash for the same content under a different identity', () => {
    const once = applyPlanHash(planOver());
    expect(applyPlanHash(planOver({ plan_id: 'plan-2' }))).toBe(once);
    expect(applyPlanHash(JSON.parse(JSON.stringify(planOver())) as ApplyPlan)).toBe(once);
    // Key order follows insertion in JSON; the digest must not.
    const reordered = Object.fromEntries(Object.entries(planOver()).reverse()) as ApplyPlan;
    expect(applyPlanHash(reordered)).toBe(once);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same shape the domain contract passes — one authoritative home', () => {
    const shared: DomainApplyPlan = planOver();
    expect(isApplyPlan(shared)).toBe(true);
  });
});

/**
 * The regression guard that matters most. Rather than listing the fields the hash should cover —
 * the enumeration shape that fails open on whatever nobody named — this walks the plan and pins
 * every leaf it finds. A field added to `ApplyPlan` or `ApplyOperation` tomorrow is checked here
 * the day it is added, with nobody remembering to update this file.
 */
type Leaf = {
  readonly at: readonly (string | number)[];
  readonly path: string;
  readonly v: unknown;
};

const leaves = (value: unknown, at: readonly (string | number)[] = [], path = ''): Leaf[] => {
  if (Array.isArray(value)) return value.flatMap((x, i) => leaves(x, [...at, i], `${path}[]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) =>
      leaves(v, [...at, k], path === '' ? k : `${path}.${k}`),
    );
  }
  return [{ at, path, v: value }];
};

const bumped = (v: unknown): unknown =>
  typeof v === 'string' ? `${v}!` : typeof v === 'number' ? v + 1 : v === null ? 'x' : !v;

const withLeafChanged = (plan: ApplyPlan, leaf: Leaf): ApplyPlan => {
  const copy = structuredClone(plan) as unknown as Record<string, unknown>;
  let node: Record<string | number, unknown> = copy;
  for (const step of leaf.at.slice(0, -1)) node = node[step] as Record<string | number, unknown>;
  node[leaf.at.at(-1)!] = bumped(leaf.v);
  return copy as unknown as ApplyPlan;
};

describe('the hash covers new content by default, not an enumerated list', () => {
  const plan = planOver({
    operations: [operation(), operation({ operation_id: 'op-2', operation: 'publish' })],
  });
  const baseline = applyPlanHash(plan);
  const hashOrRefusal = (p: ApplyPlan): string => {
    try {
      return applyPlanHash(p);
    } catch {
      return 'refused';
    }
  };

  it('leaves out exactly these three paths and no others', () => {
    // Pinned as a literal, deliberately. Every other assertion in this block reads the exclusion
    // list out of the implementation, so widening that list would move the expectation with it —
    // the same "enumerate what to look at" failure this whole issue is about, one level up.
    expect([...APPLY_PLAN_HASH_OUTSIDE]).toEqual([
      'plan_id',
      'basis.captured_at',
      'operations[].operation_id',
    ]);
  });

  it('finds every declared exclusion actually present in a plan', () => {
    // An exclusion naming a path that no longer exists excludes nothing, or excludes something
    // that moved. Both are silent holes, so the list is pinned against the real shape.
    const paths = new Set(leaves(plan).map((l) => l.path));
    for (const outside of APPLY_PLAN_HASH_OUTSIDE) expect([...paths]).toContain(outside);
  });

  it('moves for every leaf it covers, and stands still for every leaf it excludes', () => {
    const found = leaves(plan);
    expect(found.length).toBeGreaterThan(12);
    for (const leaf of found) {
      const after = hashOrRefusal(withLeafChanged(plan, leaf));
      const outside = (APPLY_PLAN_HASH_OUTSIDE as readonly string[]).includes(leaf.path);
      // Covered: the digest moves, or the plan stops being one. Excluded: nothing happens at all.
      if (outside) expect([leaf.path, after]).toEqual([leaf.path, baseline]);
      else expect([leaf.path, after]).not.toEqual([leaf.path, baseline]);
    }
  });

  it('refuses loudly rather than digesting something it cannot read', () => {
    const odd = { ...plan, basis: { ...plan.basis, captured_at: new Date() } };
    expect(() => applyPlanHash(odd as unknown as ApplyPlan)).toThrow(/cannot digest/);
    expect(() => actionFingerprint({ operation: 'x' } as never)).toThrow(/names exactly/);
  });
});

describe('an approval cannot be replayed against a different apply (#89 acceptance)', () => {
  const trivial = planOver();
  const approved = approvalBinding(action(trivial));

  it('authorizes the exact action it was taken for, including a re-plan of it', () => {
    expect(bindingMatches(approved, action(trivial))).toEqual({ matches: true });
    expect(bindingMatches(approved, action(planOver({ plan_id: 'replanned' })))).toEqual({
      matches: true,
    });
  });

  it('refuses the dangerous apply the trivial one was approved for', () => {
    const dangerous = action(planOver({ change_set_hash: DANGEROUS }));
    expect(bindingMatches(approved, dangerous)).toEqual({
      matches: false,
      mismatch: 'action_fingerprint',
    });
  });

  it('refuses a different target, a different basis and a raised risk', () => {
    const cases: readonly ApplyPlan[] = [
      planOver({ operations: [operation({ target_ref: 'project:other' })] }),
      planOver({ basis: { ...BASIS, ref: 'basis-ref-2' } }),
      planOver({ operations: [operation({ risk: 'high' })] }),
      planOver({ operations: [operation({ required_capability: 'apply_change_set_in_sandbox' })] }),
      planOver({ operations: [operation({ reversibility: 'irreversible' })] }),
    ];
    for (const plan of cases) expect(bindingMatches(approved, action(plan)).matches).toBe(false);
  });

  it('refuses the same plan under a different task or project', () => {
    for (const over of [{ task_id: 'task-2' }, { project_id: 'project-2' }]) {
      expect(bindingMatches(approved, { ...action(trivial), ...over }).matches).toBe(false);
    }
  });

  it('refuses a row whose stored columns disagree with its own fingerprint', () => {
    // The three columns are redundant by design (§12.3 folds two of them into the first). A row
    // where they disagree is corrupt, and corrupt must refuse rather than be trusted by halves.
    const tampered = { ...approved, target_ref: 'project:other' };
    expect(bindingMatches(tampered, action(trivial))).toEqual({
      matches: false,
      mismatch: 'target_ref',
    });
  });
});

describe('basis.inputs carry the real pairs, and can actually go stale (#89 C3 major)', () => {
  it('refuses a plan that cannot say what it was built against', () => {
    expect(isApplyPlan(planOver({ basis: { ...BASIS, inputs: [] } }))).toBe(false);
    expect(
      isApplyPlan(planOver({ basis: { ...BASIS, inputs: [...BASIS.inputs].reverse() } })),
    ).toBe(false);
    const twice = [BASIS.inputs[0]!, BASIS.inputs[0]!];
    expect(isApplyPlan(planOver({ basis: { ...BASIS, inputs: twice } }))).toBe(false);
  });

  it('is fresh only when every consulted input is observed unchanged', () => {
    const observed = [...BASIS.inputs];
    expect(basisStaleness(BASIS, observed)).toEqual({ state: 'fresh' });
    const moved = [observed[0]!, { resource_id: 'policy/capability', version: 'v2' }];
    expect(basisStaleness(BASIS, moved)).toMatchObject({
      state: 'stale',
      stale_inputs: ['policy/capability'],
    });
  });

  it('is unknown, never fresh, when an input cannot be seen (invariant 4)', () => {
    expect(basisStaleness(BASIS, [BASIS.inputs[0]!]).state).toBe('unknown');
    // The `inputs: []` plan was vacuously fresh forever. It is unknown now, which refuses.
    expect(basisStaleness({ ...BASIS, inputs: [] }, []).state).toBe('unknown');
  });
});

describe('a reversal cannot be executed as the action it reverses (#89 C4)', () => {
  const forward = planOver({
    operations: [
      operation({ operation_id: 'op-1', operation: 'publish', reversibility: 'compensable' }),
    ],
  });
  const applied = [...forward.operations];
  const compensation = operation({
    operation_id: 'rev-1',
    operation: 'publish',
    reversibility: 'compensable',
    disposition: 'compensation',
    undoes: 'op-1',
  });
  const reversal = {
    kind: 'reversal' as const,
    plan: planOver({ plan_id: 'plan-r', operations: [compensation] }),
  };

  it('hashes differently from the plan it undoes, so no approval spans both', () => {
    expect(applyPlanHash(reversal.plan)).not.toBe(applyPlanHash(forward));
    const approved = approvalBinding(action(forward, 'op-1'));
    expect(bindingMatches(approved, action(reversal.plan, 'rev-1')).matches).toBe(false);
  });

  it('accepts a compensation that is a new forward action against the same target', () => {
    expect(checkReversalPlan(applied, reversal)).toEqual({ sound: true });
  });

  it('catches the old defect: the forward operation handed back as its own undo', () => {
    const echo = { kind: 'reversal' as const, plan: planOver({ operations: applied }) };
    expect(checkReversalPlan(applied, echo)).toMatchObject({ sound: false });
  });

  it('refuses an undo whose content is identical to what it undoes', () => {
    // Defence in depth for the day `disposition` and `undoes` stop being the only things that
    // differ. Both operations here are well-formed compensations; only the content check sees it.
    const self = operation({
      operation_id: 'c1',
      reversibility: 'compensable',
      disposition: 'compensation',
      undoes: 'c1',
    });
    const echo = {
      kind: 'reversal' as const,
      plan: planOver({ operations: [{ ...self, operation_id: 'c2' }] }),
    };
    expect(checkReversalPlan([self], echo)).toMatchObject({ sound: false });
  });

  it('refuses a class and a disposition that do not agree', () => {
    const wrong = {
      kind: 'reversal' as const,
      plan: planOver({ operations: [{ ...compensation, disposition: 'reversal' as const }] }),
    };
    expect(checkReversalPlan(applied, wrong)).toMatchObject({ sound: false });
  });

  it('refuses to undo something that was never applied, and accepts an honest refusal', () => {
    const orphan = {
      kind: 'reversal' as const,
      plan: planOver({ operations: [{ ...compensation, undoes: 'op-9' }] }),
    };
    expect(checkReversalPlan(applied, orphan)).toMatchObject({ sound: false });
    expect(checkReversalPlan(applied, { kind: 'not_reversible', reason: 'published' })).toEqual({
      sound: true,
    });
  });

  it('renders both arms, and shows an absent reversal as an absence with a reason', () => {
    const view = reversalView(reversal);
    expect(view).toMatchObject({ available: true });
    expect(view.available && view.plan.apply_plan_hash).toBe(applyPlanHash(reversal.plan));
    expect(view.available && view.plan.operations[0]?.direction).toBe('compensates for');
    expect(reversalView({ kind: 'not_reversible', reason: 'published' })).toEqual({
      available: false,
      reason: 'published',
    });
  });
});
