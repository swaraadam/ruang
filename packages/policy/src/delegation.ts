/**
 * Delegation invariants — blueprint §7.3.
 *
 * > 5. No privilege escalation by delegation: a role cannot create/task a role whose capability set
 * >    exceeds its own effective capabilities.
 * > 6. Budget is sub-allocated, never additive: child/org-node ceilings are carved from the parent
 * >    remaining budget.
 *
 * Both are checked against the same capability table `decide` reads, so a delegation cannot grant
 * something a direct request would have been refused. The order matters: the delegator must first
 * hold `delegate_to_role` at all, which makes "may I task anyone" an ordinary capability question
 * rather than a privilege that exists implicitly because a function was callable.
 *
 * Two budgets meet here and they are not the same thing. `change_budget` is a count of change units
 * and follows §7.2 most-restrictive-wins; the cost ceiling is cents and follows §7.3 sub-allocation.
 * A child may have a tighter change budget *and* a smaller slice of money, and neither rule implies
 * the other.
 */
import { type DenyReason, type PolicyDecision, decide, effectiveContract } from './capability.js';
import { key, type LoadedPolicy } from './load.js';
import { asOverride, tighten } from './restriction.js';
import {
  type Capability,
  type EffectiveContract,
  type MemberId,
  type OwnerId,
  type Resolution,
  type RoleId,
  type Scope,
  isCapability,
} from './vocabulary.js';

/**
 * A parent's money position, in the columns v1 already stores: `budget_ledger.ceiling_cents`,
 * `budget_ledger.spent_cents`, and the sum of unreleased `budget_reservation.reserved_cents`.
 * Reservations count against remaining because §7.3 sub-allocates: money promised to a sibling is
 * not available to carve again, even though it has not been spent yet.
 */
export type BudgetPosition = {
  readonly ceiling_cents: number;
  readonly spent_cents: number;
  readonly reserved_cents: number;
};

export type CarveRefusal =
  'parent_position_unknown' | 'requested_not_an_amount' | 'exceeds_parent_remaining';

export type CarveOutcome =
  | { readonly ok: true; readonly ceiling_cents: number; readonly parent_remaining_cents: number }
  | { readonly ok: false; readonly reason: CarveRefusal; readonly detail: string };

const isCents = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * What is left to give away, or a refusal to estimate.
 *
 * A position that is not three whole non-negative cent counts is not a position this code can
 * subtract; guessing one would be the "assume fresh if we cannot tell" shape invariant 4 forbids.
 * The result may legitimately be negative — an already-overspent parent — and that is a known
 * answer, not an unknown one: it carves nothing, not even zero.
 */
export const parentRemainingCents = (parent: BudgetPosition): Resolution<number> => {
  const bad = (
    [
      ['ceiling_cents', parent.ceiling_cents],
      ['spent_cents', parent.spent_cents],
      ['reserved_cents', parent.reserved_cents],
    ] as const
  ).find(([, value]) => !isCents(value));
  return bad === undefined
    ? { resolved: true, value: parent.ceiling_cents - parent.spent_cents - parent.reserved_cents }
    : {
        resolved: false,
        why: `${bad[0]} is ${JSON.stringify(bad[1])}, not a whole number of cents; the parent's remaining budget is unknown and nothing can be carved from an unknown remainder`,
      };
};

/** §7.3 invariant 6, on its own so it can be tested without a whole policy document. */
export const carveChildCeiling = (
  parent: BudgetPosition,
  requested_cents: number,
): CarveOutcome => {
  if (!isCents(requested_cents)) {
    return {
      ok: false,
      reason: 'requested_not_an_amount',
      detail: `requested ceiling ${JSON.stringify(requested_cents)} is not a whole number of cents`,
    };
  }
  const remaining = parentRemainingCents(parent);
  if (!remaining.resolved) {
    return { ok: false, reason: 'parent_position_unknown', detail: remaining.why };
  }
  if (requested_cents > remaining.value) {
    return {
      ok: false,
      reason: 'exceeds_parent_remaining',
      detail: `requested ${requested_cents} cents but the parent has ${remaining.value} remaining (ceiling ${parent.ceiling_cents} - spent ${parent.spent_cents} - reserved ${parent.reserved_cents}); §7.3 sub-allocates, it never adds`,
    };
  }
  return { ok: true, ceiling_cents: requested_cents, parent_remaining_cents: remaining.value };
};

export type DelegationRequest = {
  readonly owner_id: OwnerId;
  readonly delegator_member_id: MemberId;
  readonly delegate_role_id: RoleId;
  readonly scope: Scope;
  /** The subset the delegate is actually being tasked with. Each must be a capability it holds. */
  readonly requested_capabilities: readonly string[];
  readonly requested_ceiling_cents: number;
  readonly parent_budget: BudgetPosition;
};

export type DelegationDenyReason =
  | DenyReason
  | CarveRefusal
  | 'delegate_not_listed'
  | 'capability_escalation'
  | 'contract_loosening'
  | 'exceeds_role_limit';

export type DelegationDecision =
  | {
      readonly outcome: 'allow';
      readonly delegator_role_id: RoleId;
      readonly delegate_role_id: RoleId;
      readonly capabilities: readonly Capability[];
      readonly ceiling_cents: number;
      readonly contract: EffectiveContract | null;
    }
  | { readonly outcome: 'deny'; readonly reason: DelegationDenyReason; readonly detail: string };

const refuse = (reason: DelegationDenyReason, detail: string): DelegationDecision => ({
  outcome: 'deny',
  reason,
  detail,
});

export const authorizeDelegation = (
  policy: LoadedPolicy,
  request: DelegationRequest,
): DelegationDecision => {
  const { owner_id, scope } = request;

  // Tasking anyone at all is a capability, checked through the same primitive as everything else.
  const permission: PolicyDecision = decide(policy, {
    owner_id,
    member_id: request.delegator_member_id,
    capability: 'delegate_to_role',
    scope,
  });
  if (permission.outcome === 'deny') return refuse(permission.reason, permission.detail);

  const delegator = policy.roles.get(key(owner_id, permission.role_id));
  if (delegator === undefined) {
    return refuse('unknown_role', `role '${permission.role_id}' vanished between lookups`);
  }

  const delegate = policy.roles.get(key(owner_id, request.delegate_role_id));
  if (delegate === undefined) {
    return refuse(
      'unknown_role',
      `no role '${request.delegate_role_id}' under owner '${owner_id}'`,
    );
  }

  // §7.3 is about capability sets, but a role that is not named in `delegation` was never offered
  // as a target at all. Empty list means "tasks nobody", which is the right default for data that
  // someone forgot to fill in.
  if (!delegator.delegation.includes(delegate.id)) {
    return refuse(
      'delegate_not_listed',
      `role '${delegator.name}' does not list '${delegate.id}' in its delegation set`,
    );
  }

  const reach = policy.ancestry.get(key(owner_id, delegate.org_node_id));
  if (reach === undefined || !reach.includes(delegator.org_node_id)) {
    return refuse(
      'out_of_org_scope',
      `role '${delegate.id}' sits at '${delegate.org_node_id}', outside the subtree of '${delegator.org_node_id}'`,
    );
  }

  // §7.3 invariant 5. Compared over the delegate's *whole* capability set, not just the subset
  // being tasked: once a role is running it holds everything it was granted, so a delegate that
  // could later do more than its delegator is an escalation whatever this particular task asked
  // for.
  const delegatorHolds = new Set<string>(delegator.capabilities);
  const excess = delegate.capabilities.find((capability) => !delegatorHolds.has(capability));
  if (excess !== undefined) {
    return refuse(
      'capability_escalation',
      `role '${delegate.name}' v${delegate.version} holds '${excess}', which role '${delegator.name}' v${delegator.version} does not; §7.3 forbids tasking a role whose capabilities exceed the delegator's`,
    );
  }

  const capabilities: Capability[] = [];
  for (const requested of request.requested_capabilities) {
    if (!isCapability(requested)) {
      return refuse('unknown_capability', `'${requested}' is not in the closed capability set`);
    }
    if (!policy.grants.has(key(owner_id, delegate.id, requested))) {
      return refuse('not_granted', `role '${delegate.name}' does not hold '${requested}'`);
    }
    capabilities.push(requested);
  }

  const contract = contractFor(policy, owner_id, delegator.id, delegate.id, scope);
  if (contract.outcome === 'deny') return contract.decision;

  const roleCap = delegate.limits.cost_per_task_cents;
  if (roleCap !== null && request.requested_ceiling_cents > roleCap) {
    return refuse(
      'exceeds_role_limit',
      `requested ${request.requested_ceiling_cents} cents but role '${delegate.name}' declares cost_per_task_cents ${roleCap}`,
    );
  }

  const carve = carveChildCeiling(request.parent_budget, request.requested_ceiling_cents);
  if (!carve.ok) return refuse(carve.reason, carve.detail);

  return {
    outcome: 'allow',
    delegator_role_id: delegator.id,
    delegate_role_id: delegate.id,
    capabilities,
    ceiling_cents: carve.ceiling_cents,
    contract: contract.contract,
  };
};

type ContractCheck =
  | { readonly outcome: 'ok'; readonly contract: EffectiveContract | null }
  | { readonly outcome: 'deny'; readonly decision: DelegationDecision };

/** §7.2 applied down the delegation edge: the delegate's contract may tighten, never loosen. */
const contractFor = (
  policy: LoadedPolicy,
  owner_id: OwnerId,
  delegator_role_id: RoleId,
  delegate_role_id: RoleId,
  scope: Scope,
): ContractCheck => {
  if (scope.kind !== 'project') return { outcome: 'ok', contract: null };

  const parent = effectiveContract(policy, owner_id, delegator_role_id, scope.project_id);
  if (!parent.resolved) {
    return { outcome: 'deny', decision: refuse('unresolved_contract', parent.why) };
  }
  const child = effectiveContract(policy, owner_id, delegate_role_id, scope.project_id);
  if (!child.resolved) {
    return { outcome: 'deny', decision: refuse('unresolved_contract', child.why) };
  }

  const outcome = tighten(parent.value, asOverride(child.value));
  return outcome.ok
    ? { outcome: 'ok', contract: outcome.contract }
    : {
        outcome: 'deny',
        decision: refuse(
          'contract_loosening',
          `delegate's ${outcome.field} ${outcome.why}, measured against the delegator's contract on project '${scope.project_id}'`,
        ),
      };
};
