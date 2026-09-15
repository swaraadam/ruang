/**
 * The renderer case for the apply-authority union (CLAUDE.md §10: a new protocol shape requires
 * one). Pure data in, pure data out — no framework, because what has to be proved here is
 * exhaustiveness, not layout: `assertNever` makes a new `OperationDisposition` or a new
 * `ReversalPlan` arm a compile error in this file rather than a blank box in the office.
 *
 * Invariant 1, twice over. `not_reversible` renders as a stated absence carrying its reason, never
 * as an empty reversal; and `reversalView` returns the reversal's *own* `apply_plan_hash`, so the
 * approval card cannot show a reversal under the hash of the action it undoes.
 */
import {
  type ApplyOperation,
  type ApplyPlan,
  type ReversalPlan,
  applyPlanHash,
  assertNever,
} from '@internal/protocol';

export type OperationView = {
  readonly target_ref: string;
  readonly operation: string;
  readonly risk: 'low' | 'medium' | 'high';
  /** Reversibility and risk are shown separately and never combined — §12.4. */
  readonly reversibility: string;
  readonly direction: string;
  readonly undoes: string | null;
};

export const operationView = (op: ApplyOperation): OperationView => {
  const direction = ((): string => {
    switch (op.disposition) {
      case 'forward':
        return 'applies';
      case 'reversal':
        return 'reverses';
      case 'compensation':
        return 'compensates for';
      default:
        return assertNever(op.disposition);
    }
  })();
  return {
    target_ref: op.target_ref,
    operation: op.operation,
    risk: op.risk,
    reversibility: op.reversibility,
    direction,
    undoes: op.undoes,
  };
};

export type PlanView = {
  readonly apply_plan_hash: string;
  readonly basis_ref: string;
  readonly change_set_hash: string;
  readonly consulted_inputs: number;
  readonly operations: readonly OperationView[];
};

export const planView = (plan: ApplyPlan): PlanView => ({
  apply_plan_hash: applyPlanHash(plan),
  basis_ref: plan.basis.ref,
  change_set_hash: plan.change_set_hash,
  consulted_inputs: plan.basis.inputs.length,
  operations: plan.operations.map(operationView),
});

export type ReversalView =
  | { readonly available: true; readonly plan: PlanView }
  | { readonly available: false; readonly reason: string };

export const reversalView = (reversal: ReversalPlan): ReversalView => {
  switch (reversal.kind) {
    case 'reversal':
      return { available: true, plan: planView(reversal.plan) };
    case 'not_reversible':
      return { available: false, reason: reversal.reason };
    default:
      return assertNever(reversal);
  }
};
