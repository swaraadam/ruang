/**
 * Apply planning, confirmation, reversal and reconciliation (§5.2.2, §5.5, §14.4). The adapter
 * plans; the spine's broker executes. Nothing returned from here is a handle, a credential or a
 * command — an operation says what is touched, what capability that needs, how risky it is and
 * whether it can be undone, and the spine validates all four before anything runs.
 */
// prettier-ignore
import type { ApplyOperation, ApplyPlan, ApplyPolicy, ApplyResult, BrokerOutcome, ReconcileResult, ReversalPlan } from '@internal/domain';
import type { ChangeSet } from '@internal/protocol';
import { existsSync } from 'node:fs';
import { currentRef, UNRESOLVED_REF } from './basis.js';
import { sandboxPath } from './sandbox.js';
import { AdapterRefusal, type CodeAdapterOptions } from './surface.js';

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;
type Risk = keyof typeof RISK_ORDER;

// The operation kind travels inside the operation id because that is the only thing the spine hands
// back in a `BrokerOutcome`. Without it `revert_or_compensate` would have to guess what it was
// reversing, and invariant 5 would rather it refused.
const OPERATION_KINDS = ['integrate', 'publish'] as const;
type OperationKind = (typeof OPERATION_KINDS)[number];
const operationId = (plan_id: string, index: number, kind: OperationKind): string =>
  `${plan_id}/${index}/${kind}`;
const kindOf = (operation_id: string): OperationKind | null => {
  const tail = operation_id.split('/').at(-1);
  return OPERATION_KINDS.find((k) => k === tail) ?? null;
};

// prettier-ignore
export const applyPlan = async (o: CodeAdapterOptions, change_set: ChangeSet, policy: ApplyPolicy): Promise<ApplyPlan> => {
  const { change_size, change_unit } = change_set;
  if (change_size > policy.change_budget)
    throw new AdapterRefusal(
      'change_budget_exceeded',
      `change set of ${change_size} ${change_unit} exceeds the change budget of ${policy.change_budget}`,
    );
  const ref = await currentRef(o.source_of_record);
  if (ref === UNRESOLVED_REF)
    throw new AdapterRefusal(
      'basis_unknown',
      'refusing to plan an apply against a source of record with no resolvable basis ref',
    );

  const plan_id = (o.new_id ?? (() => `p${Date.now().toString(36)}`))();
  // §5.5: integrating into the source of record has a clean automated reversal; undoing a publish
  // needs a new forward action instead, which is what `compensable` means.
  const operations: ApplyOperation[] = [
    { ...integrate(o), operation_id: operationId(plan_id, 1, 'integrate') },
  ];
  if (o.publish_target != null && o.publish_target.length > 0)
    operations.push({ ...publish(o), operation_id: operationId(plan_id, 2, 'publish') });

  // Truncating the plan to fit the policy would hand back a plan that means something else.
  // Refuse instead, and let the spine widen the policy deliberately or not at all.
  const over = operations.find((op) => RISK_ORDER[op.risk as Risk] > RISK_ORDER[policy.max_risk]);
  if (over !== undefined)
    throw new AdapterRefusal(
      'risk_not_permitted',
      `this plan needs a ${over.risk} risk operation and the policy permits at most ${policy.max_risk}`,
    );

  return { plan_id, basis: { ref, inputs: [], captured_at: (o.now ?? isoNow)() }, operations };
};

const isoNow = (): string => new Date().toISOString();

type Shape = Omit<ApplyOperation, 'operation_id'>;
const integrate = (o: CodeAdapterOptions): Shape => ({
  target_ref: `project:${o.project_id}`,
  required_capability: 'change_set.integrate',
  risk: 'medium',
  reversibility: 'revertible',
});
const publish = (o: CodeAdapterOptions): Shape => ({
  target_ref: `project:${o.project_id}/${o.publish_target ?? 'downstream'}`,
  required_capability: 'change_set.publish',
  risk: 'high',
  reversibility: 'compensable',
});

/** Nothing observed is not the same as applied. Both must hold: outcomes exist, and all succeeded. */
export const confirmApplied = (
  plan_id: string,
  broker_results: readonly BrokerOutcome[],
): ApplyResult => ({
  plan_id,
  outcomes: [...broker_results],
  applied: broker_results.length > 0 && broker_results.every((o) => o.succeeded),
});

/**
 * Reversal is planned for what actually succeeded, newest first. An operation whose kind cannot be
 * read is `not_reversible` with a reason: invariant 5 does not let AI judgement improvise an undo.
 */
export const revertOrCompensate = (o: CodeAdapterOptions, result: ApplyResult): ReversalPlan => {
  const succeeded = result.outcomes.filter((x) => x.succeeded);
  const unrecognised = succeeded.filter((x) => kindOf(x.operation_id) === null);
  if (unrecognised.length > 0)
    return {
      kind: 'not_reversible',
      reason: `${unrecognised.length} applied operation(s) were not planned by this adapter, so no reversal can be derived`,
    };

  const operations: ApplyOperation[] = [...succeeded].reverse().map((outcome, index) => ({
    ...(kindOf(outcome.operation_id) === 'publish' ? publish(o) : integrate(o)),
    operation_id: `${result.plan_id}/reversal/${index + 1}`,
  }));
  return { kind: 'reversal', operations };
};

/**
 * §14.4. Every key the spine believes is checked against what is there. Anything this adapter cannot
 * observe, and anything that disagrees, becomes a probe rather than a correction — invariant 3:
 * ambiguity freezes mutation instead of guessing.
 */
export const reconcile = async (
  o: CodeAdapterOptions,
  known_state: Readonly<Record<string, string>>,
): Promise<ReconcileResult> => {
  const ref = await currentRef(o.source_of_record);
  const observed: Record<string, string> = { 'source_of_record.ref': ref };
  const probes: string[] = [];
  if (ref === UNRESOLVED_REF) probes.push('probe:source_of_record.ref');

  for (const [key, believed] of Object.entries(known_state)) {
    if (key.startsWith('sandbox:')) {
      const there = existsSync(sandboxPath(o, key.slice('sandbox:'.length)));
      observed[key] = there ? 'present' : 'absent';
    } else if (!(key in observed)) {
      probes.push(`probe:${key}`);
      continue;
    }
    if (observed[key] !== believed) probes.push(`probe:${key}`);
  }
  return probes.length > 0
    ? { kind: 'needs_repair', probes: [...new Set(probes)] }
    : { kind: 'converged', state: observed };
};
