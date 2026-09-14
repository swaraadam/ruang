/**
 * The authorization primitive — blueprint §7.1, §21.2.
 *
 * §7.1 states the rule as a hard one: no identity special-case authorization branches anywhere in
 * the codebase; the one-owner case is represented by data, not by special control flow.
 *
 * `decide` is the only function in this repository that answers "may this happen". It is a sequence
 * of table lookups and nothing else: there is no actor it treats differently, no short circuit for
 * a privileged id, and no argument that could carry one. The human owner of §7.1 reaches an `allow`
 * through the same five lookups an agent does, because the owner is a `member` row bound to a
 * `role` row like every other member.
 *
 * **Every exit that is not `allow` is `deny`.** The union has two arms, so there is no way to
 * return "probably" and no `undefined` for a caller to coalesce into a permit. `reason` is a closed
 * set so the office view can render *why* something was refused without parsing prose (invariant 1:
 * unknown must look unknown, which first requires knowing it was unknown).
 */
import { key, type LoadedPolicy } from './load.js';
import {
  type Capability,
  type EffectiveContract,
  type MemberId,
  type OrgNodeId,
  type OwnerId,
  type ProjectId,
  type Resolution,
  type RoleId,
  type Scope,
  isCapability,
  unreachable,
} from './vocabulary.js';

export type CapabilityRequest = {
  readonly owner_id: OwnerId;
  readonly member_id: MemberId;
  /**
   * Typed `string`, not `Capability`, on purpose. Requests arrive from the wire and from a planner
   * that may be an LLM (§8.1); an id outside the closed set has to be *denied*, which it cannot be
   * if the type system refused to let it be asked in the first place.
   */
  readonly capability: string;
  readonly scope: Scope;
};

export type DenyReason =
  | 'unknown_capability'
  | 'unknown_member'
  | 'member_has_no_role'
  | 'unknown_role'
  | 'unknown_org_node'
  | 'unknown_project'
  | 'not_granted'
  | 'out_of_org_scope'
  | 'unresolved_contract';

export type PolicyDecision =
  | {
      readonly outcome: 'allow';
      readonly capability: Capability;
      readonly role_id: RoleId;
      readonly org_node_id: OrgNodeId;
      /** The §7.2 contract for this role on this project; `null` when the scope is an org node. */
      readonly contract: EffectiveContract | null;
    }
  | { readonly outcome: 'deny'; readonly reason: DenyReason; readonly detail: string };

const deny = (reason: DenyReason, detail: string): PolicyDecision => ({
  outcome: 'deny',
  reason,
  detail,
});

/** Capability-table lookup. The only authorization primitive; everything else calls this. */
export const decide = (policy: LoadedPolicy, request: CapabilityRequest): PolicyDecision => {
  const { owner_id, member_id, capability, scope } = request;

  if (!isCapability(capability)) {
    return deny(
      'unknown_capability',
      `'${capability}' is not in the closed capability set; an unrecognised capability is refused, never assumed harmless`,
    );
  }

  const member = policy.members.get(key(owner_id, member_id));
  if (member === undefined) {
    return deny('unknown_member', `no member '${member_id}' under owner '${owner_id}'`);
  }

  const roleRef = member.role_ref;
  if (roleRef === null) {
    return deny(
      'member_has_no_role',
      `member '${member_id}' is bound to no role, so it holds no capabilities`,
    );
  }

  const role = policy.roles.get(key(owner_id, roleRef));
  if (role === undefined) {
    return deny(
      'unknown_role',
      `member '${member_id}' names role '${roleRef}', which does not exist`,
    );
  }

  if (!policy.grants.has(key(owner_id, role.id, capability))) {
    return deny(
      'not_granted',
      `role '${role.name}' v${role.version} does not hold '${capability}'`,
    );
  }

  switch (scope.kind) {
    case 'org_node': {
      const chain = policy.ancestry.get(key(owner_id, scope.org_node_id));
      if (chain === undefined) {
        return deny(
          'unknown_org_node',
          `no org node '${scope.org_node_id}' under owner '${owner_id}'`,
        );
      }
      if (!chain.includes(role.org_node_id)) {
        return deny(
          'out_of_org_scope',
          `role '${role.name}' sits at '${role.org_node_id}', which is not on the chain to '${scope.org_node_id}'`,
        );
      }
      return {
        outcome: 'allow',
        capability,
        role_id: role.id,
        org_node_id: scope.org_node_id,
        contract: null,
      };
    }
    case 'project': {
      const project = policy.projects.get(key(owner_id, scope.project_id));
      if (project === undefined) {
        return deny(
          'unknown_project',
          `no project '${scope.project_id}' under owner '${owner_id}'`,
        );
      }
      const chain = policy.ancestry.get(key(owner_id, project.org_node_id));
      if (chain === undefined) {
        return deny(
          'unknown_org_node',
          `project '${project.id}' names org node '${project.org_node_id}'`,
        );
      }
      if (!chain.includes(role.org_node_id)) {
        return deny(
          'out_of_org_scope',
          `role '${role.name}' sits at '${role.org_node_id}', which is not on the chain to project '${project.id}'`,
        );
      }
      // Unreachable while the pair is in scope, because `loadPolicy` computes the contract for
      // every in-scope pair and refuses the document otherwise. Kept because a resolved contract
      // is a precondition of acting, and inventing one here is exactly the default-allow that
      // invariant 4 rules out.
      const contract = policy.contracts.get(key(owner_id, role.id, project.id));
      if (contract === undefined) {
        return deny(
          'unresolved_contract',
          `no resolved change_budget/evidence floor for role '${role.id}' on project '${project.id}'`,
        );
      }
      return {
        outcome: 'allow',
        capability,
        role_id: role.id,
        org_node_id: project.org_node_id,
        contract,
      };
    }
    default:
      return unreachable(scope);
  }
};

/**
 * The §7.2 contract a role is held to on a project, or an explicit refusal to produce one.
 *
 * Separate from `decide` because a caller often needs the numbers after the capability question is
 * already settled — sizing a change set, choosing an evidence profile — and re-deciding would
 * invite passing a capability id just to get at the budget.
 */
export const effectiveContract = (
  policy: LoadedPolicy,
  owner_id: OwnerId,
  role_id: RoleId,
  project_id: ProjectId,
): Resolution<EffectiveContract> => {
  const contract = policy.contracts.get(key(owner_id, role_id, project_id));
  return contract === undefined
    ? {
        resolved: false,
        why: `role '${role_id}' has no resolved contract on project '${project_id}'; the role is out of the project's org scope or one of them does not exist`,
      }
    : { resolved: true, value: contract };
};
