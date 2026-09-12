/**
 * §7.3: no privilege escalation by delegation, and budget sub-allocated rather than added.
 */
import { describe, expect, it } from 'vitest';
import {
  type BudgetPosition,
  type DelegationRequest,
  authorizeDelegation,
  carveChildCeiling,
  loadPolicy,
  parentRemainingCents,
} from '../src/index.js';
import { LEAD, OWNER, WORKER, sources, withFields } from './fixture.js';

const PARENT: BudgetPosition = { ceiling_cents: 5000, spent_cents: 1000, reserved_cents: 500 };

const request = (patch: Partial<DelegationRequest> = {}): DelegationRequest => ({
  owner_id: OWNER,
  delegator_member_id: 'm-lead',
  delegate_role_id: 'worker-v1',
  scope: { kind: 'project', project_id: 'proj-a' },
  requested_capabilities: ['read_project', 'apply_change_set_in_sandbox'],
  requested_ceiling_cents: 500,
  parent_budget: PARENT,
  ...patch,
});

describe('a delegation that satisfies every invariant is allowed', () => {
  it('carves the requested ceiling and reports the delegate contract', () => {
    expect(authorizeDelegation(loadPolicy(sources()), request())).toEqual({
      outcome: 'allow',
      delegator_role_id: 'lead-v1',
      delegate_role_id: 'worker-v1',
      capabilities: ['read_project', 'apply_change_set_in_sandbox'],
      ceiling_cents: 500,
      contract: { change_unit: 'lines', change_budget: 100, evidence_profile: 'strong' },
    });
  });
});

describe('invariant 5: a role cannot task a role whose capabilities exceed its own', () => {
  it('refuses when the delegate holds a capability the delegator does not', () => {
    const policy = loadPolicy(
      sources({
        roles: [
          LEAD,
          withFields(WORKER, {
            capabilities: [...WORKER.capabilities, 'apply_to_source_of_record'],
          }),
        ],
      }),
    );
    expect(authorizeDelegation(policy, request())).toMatchObject({
      outcome: 'deny',
      reason: 'capability_escalation',
      detail: expect.stringContaining('apply_to_source_of_record') as unknown as string,
    });
  });

  it('refuses even when the excess capability is not the one being tasked', () => {
    // The task asks only for read_project. The delegate would still *hold* the extra capability
    // for the whole of its run, so §7.3 is about the set, not about this request.
    const policy = loadPolicy(
      sources({
        roles: [
          LEAD,
          withFields(WORKER, {
            capabilities: [...WORKER.capabilities, 'release_frozen_lock'],
          }),
        ],
      }),
    );
    expect(
      authorizeDelegation(policy, request({ requested_capabilities: ['read_project'] })),
    ).toMatchObject({ outcome: 'deny', reason: 'capability_escalation' });
  });

  it('refuses a delegator that does not hold delegate_to_role at all', () => {
    const policy = loadPolicy(
      sources({
        roles: [
          withFields(LEAD, {
            capabilities: LEAD.capabilities.filter((c) => c !== 'delegate_to_role'),
          }),
          WORKER,
        ],
      }),
    );
    expect(authorizeDelegation(policy, request())).toMatchObject({
      outcome: 'deny',
      reason: 'not_granted',
    });
  });

  it('refuses a delegate the delegator never listed', () => {
    const policy = loadPolicy(sources({ roles: [withFields(LEAD, { delegation: [] }), WORKER] }));
    expect(authorizeDelegation(policy, request())).toMatchObject({
      outcome: 'deny',
      reason: 'delegate_not_listed',
    });
  });

  it('refuses tasking a capability the delegate does not hold', () => {
    expect(
      authorizeDelegation(
        loadPolicy(sources()),
        request({ requested_capabilities: ['decide_approval'] }),
      ),
    ).toMatchObject({ outcome: 'deny', reason: 'not_granted' });
  });

  it('refuses a delegate whose change contract is looser than the delegator', () => {
    const policy = loadPolicy(
      sources({ roles: [withFields(LEAD, { output_contract: { change_budget: 50 } }), WORKER] }),
    );
    expect(authorizeDelegation(policy, request())).toMatchObject({
      outcome: 'deny',
      reason: 'contract_loosening',
    });
  });
});

describe('invariant 6: a child budget is carved from parent remaining, never added to it', () => {
  it('refuses a child ceiling above the parent remaining', () => {
    // The delegate declares no per-task cap, so `exceeds_parent_remaining` is the only rule that
    // can refuse this and the assertion cannot pass for the wrong reason.
    const uncapped = loadPolicy(
      sources({
        roles: [
          LEAD,
          withFields(WORKER, { limits: { cost_per_task_cents: null, concurrency: 1 } }),
        ],
      }),
    );
    expect(authorizeDelegation(uncapped, request({ requested_ceiling_cents: 3501 }))).toMatchObject(
      {
        outcome: 'deny',
        reason: 'exceeds_parent_remaining',
      },
    );
    expect(authorizeDelegation(uncapped, request({ requested_ceiling_cents: 3500 }))).toMatchObject(
      {
        outcome: 'allow',
        ceiling_cents: 3500,
      },
    );
  });

  it('allows exactly the parent remaining and refuses one cent more', () => {
    expect(carveChildCeiling(PARENT, 3500)).toEqual({
      ok: true,
      ceiling_cents: 3500,
      parent_remaining_cents: 3500,
    });
    expect(carveChildCeiling(PARENT, 3501)).toMatchObject({
      ok: false,
      reason: 'exceeds_parent_remaining',
    });
  });

  it('counts unreleased reservations against remaining, not only spend', () => {
    const promised: BudgetPosition = { ceiling_cents: 1000, spent_cents: 0, reserved_cents: 900 };
    expect(parentRemainingCents(promised)).toEqual({ resolved: true, value: 100 });
    expect(carveChildCeiling(promised, 200)).toMatchObject({ ok: false });
  });

  it('carves nothing at all from an overspent parent, not even zero', () => {
    const overspent: BudgetPosition = { ceiling_cents: 100, spent_cents: 400, reserved_cents: 0 };
    expect(parentRemainingCents(overspent)).toEqual({ resolved: true, value: -300 });
    expect(carveChildCeiling(overspent, 0)).toMatchObject({
      ok: false,
      reason: 'exceeds_parent_remaining',
    });
  });

  it('refuses a position it cannot subtract instead of estimating one', () => {
    for (const broken of [
      { ceiling_cents: Number.NaN, spent_cents: 0, reserved_cents: 0 },
      { ceiling_cents: 100, spent_cents: -5, reserved_cents: 0 },
      { ceiling_cents: 100, spent_cents: 0, reserved_cents: 1.5 },
    ]) {
      expect(parentRemainingCents(broken).resolved).toBe(false);
      expect(carveChildCeiling(broken, 1)).toMatchObject({
        ok: false,
        reason: 'parent_position_unknown',
      });
    }
  });

  it('refuses a request that is not a whole number of cents', () => {
    for (const amount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(carveChildCeiling(PARENT, amount)).toMatchObject({
        ok: false,
        reason: 'requested_not_an_amount',
      });
    }
  });

  it('refuses a ceiling above the delegate role cost_per_task limit', () => {
    // WORKER declares 900; parent remaining is 3500, so only the role limit can refuse this.
    expect(
      authorizeDelegation(loadPolicy(sources()), request({ requested_ceiling_cents: 901 })),
    ).toMatchObject({ outcome: 'deny', reason: 'exceeds_role_limit' });
  });
});
