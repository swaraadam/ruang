/**
 * Loading Seam C data into a capability table — blueprint §7.1, §7.2.
 *
 * Everything expensive happens here, once, at load: every reference is resolved, every org chain is
 * walked, and the effective contract of every (role, project) pair is computed. Two reasons, and
 * neither is performance.
 *
 * 1. §7.2 requires a looser Role to be a **load-time error**. A rule that only fires when someone
 *    happens to ask is not a load-time error; it is a landmine. So the loader evaluates the whole
 *    cross product and refuses the document, naming the declaration at fault.
 * 2. A lookup that can fail for a *configuration* reason cannot distinguish "denied" from
 *    "misconfigured" at the moment it matters. After `loadPolicy` returns, every remaining refusal
 *    means the answer really is no.
 *
 * **Tenancy lives in the keys, not in a branch.** Maps are keyed by `owner_id` joined with the row
 * id, so asking about a member of another owner is a miss, handled by the same code path that
 * handles a member that does not exist. There is no `owner_id` comparison to write and therefore no
 * place an identity special case could grow (invariant 8). `LoadedPolicy` holds no "the owner"
 * field for the same reason: one owner is a row count, not a type.
 */
import {
  PolicyConfigError,
  type MemberPolicy,
  type OrgNodePolicy,
  type ProjectPolicy,
  type RolePolicy,
  parseMembers,
  parseOrgNodes,
  parseProjects,
  parseRoles,
} from './config.js';
import { tighten } from './restriction.js';
import type { EffectiveContract, OrgNodeId, OwnerId } from './vocabulary.js';

/**
 * Unit separator. It cannot occur inside an id (`config.ts` `ID_PATTERN` rejects it), so a joined
 * key has exactly one reading and no id can impersonate a different key by containing a separator.
 */
const SEP = '\u001f';

export const key = (...parts: readonly string[]): string => parts.join(SEP);

/** The four documents. Already parsed, so the on-disk format stays out of this package (config.ts). */
export type PolicySources = {
  /** `config/org` — org tree and any `policy_overrides`. */
  readonly org: unknown;
  /** `config/roles` — versioned role templates. */
  readonly roles: unknown;
  /** `member` rows: who exists and which role they are bound to. */
  readonly members: unknown;
  /** `project` rows: the authoritative `change_unit`, `change_budget` and `evidence_floor`. */
  readonly projects: unknown;
};

export type LoadedPolicy = {
  readonly orgNodes: ReadonlyMap<string, OrgNodePolicy>;
  readonly roles: ReadonlyMap<string, RolePolicy>;
  readonly members: ReadonlyMap<string, MemberPolicy>;
  readonly projects: ReadonlyMap<string, ProjectPolicy>;
  /** `owner + role + capability`. Membership is the grant; absence is the denial. */
  readonly grants: ReadonlySet<string>;
  /** `owner + role + project` -> the contract resolved through §7.2 precedence. */
  readonly contracts: ReadonlyMap<string, EffectiveContract>;
  /** `owner + org node` -> the root-first chain of ids, used for subtree containment. */
  readonly ancestry: ReadonlyMap<string, readonly OrgNodeId[]>;
};

type Indexed<T> = { readonly byKey: Map<string, T>; readonly positionOf: Map<string, number> };

const indexBy = <T>(
  items: readonly T[],
  arrayKey: string,
  keyOf: (item: T) => string,
): Indexed<T> => {
  const byKey = new Map<string, T>();
  const positionOf = new Map<string, number>();
  items.forEach((item, i) => {
    const k = keyOf(item);
    if (byKey.has(k)) {
      throw new PolicyConfigError(
        `${arrayKey}[${i}].id`,
        `duplicate id; ${arrayKey}[${positionOf.get(k)}] already declares it for the same owner`,
      );
    }
    byKey.set(k, item);
    positionOf.set(k, i);
  });
  return { byKey, positionOf };
};

/** Root-first chain of org node ids ending at `node`, refusing a missing parent or a cycle. */
const chainOf = (
  node: OrgNodePolicy,
  nodes: ReadonlyMap<string, OrgNodePolicy>,
  at: number,
): readonly OrgNodeId[] => {
  const chain: OrgNodeId[] = [];
  const seen = new Set<string>();
  let cursor: OrgNodePolicy = node;
  for (;;) {
    if (seen.has(cursor.id)) {
      throw new PolicyConfigError(
        `org_nodes[${at}].parent_id`,
        `the parent chain cycles at '${cursor.id}'; an org tree with a cycle has no root and therefore no defined precedence order`,
      );
    }
    seen.add(cursor.id);
    chain.unshift(cursor.id);
    const parentId = cursor.parent_id;
    if (parentId === null) return chain;
    const parent = nodes.get(key(cursor.owner_id, parentId));
    if (parent === undefined) {
      throw new PolicyConfigError(
        `org_nodes[${at}].parent_id`,
        `'${parentId}' is not an org node of owner '${cursor.owner_id}' (reached from '${cursor.id}')`,
      );
    }
    cursor = parent;
  }
};

const mustExist = (present: boolean, path: string, detail: string): void => {
  if (!present) throw new PolicyConfigError(path, detail);
};

/**
 * Validate the four documents together and precompute the capability table.
 *
 * Throws `PolicyConfigError` on the first problem, with the path of the offending declaration.
 * Refusing the whole document rather than dropping the bad entry is the fail-closed choice: a
 * partially loaded policy would authorize with rules the owner never approved.
 */
export const loadPolicy = (sources: PolicySources): LoadedPolicy => {
  const orgNodeList = parseOrgNodes(sources.org);
  const roleList = parseRoles(sources.roles);
  const memberList = parseMembers(sources.members);
  const projectList = parseProjects(sources.projects);

  const orgNodes = indexBy(orgNodeList, 'org_nodes', (n) => key(n.owner_id, n.id));
  const roles = indexBy(roleList, 'roles', (r) => key(r.owner_id, r.id));
  const members = indexBy(memberList, 'members', (m) => key(m.owner_id, m.id));
  const projects = indexBy(projectList, 'projects', (p) => key(p.owner_id, p.id));

  // v1 declares UNIQUE (owner_id, name, version) on `role`. Checking it here means a bad document
  // is refused before it can reach the database and fail as a constraint violation instead.
  const roleVersions = new Set<string>();
  roleList.forEach((role, i) => {
    const k = key(role.owner_id, role.name, String(role.version));
    mustExist(
      !roleVersions.has(k),
      `roles[${i}].version`,
      `role '${role.name}' version ${role.version} is declared twice for owner '${role.owner_id}'; v1 declares UNIQUE (owner_id, name, version)`,
    );
    roleVersions.add(k);
  });

  const ancestry = new Map<string, readonly OrgNodeId[]>();
  orgNodeList.forEach((node, i) => {
    ancestry.set(key(node.owner_id, node.id), chainOf(node, orgNodes.byKey, i));
  });

  roleList.forEach((role, i) => {
    mustExist(
      orgNodes.byKey.has(key(role.owner_id, role.org_node_id)),
      `roles[${i}].org_node_id`,
      `'${role.org_node_id}' is not an org node of owner '${role.owner_id}'`,
    );
    role.delegation.forEach((target, j) => {
      mustExist(
        roles.byKey.has(key(role.owner_id, target)),
        `roles[${i}].delegation[${j}]`,
        `'${target}' is not a role of owner '${role.owner_id}'`,
      );
    });
  });

  memberList.forEach((member, i) => {
    mustExist(
      orgNodes.byKey.has(key(member.owner_id, member.org_node_id)),
      `members[${i}].org_node_id`,
      `'${member.org_node_id}' is not an org node of owner '${member.owner_id}'`,
    );
    const roleRef = member.role_ref;
    mustExist(
      roleRef === null || roles.byKey.has(key(member.owner_id, roleRef)),
      `members[${i}].role_ref`,
      `'${String(roleRef)}' is not a role of owner '${member.owner_id}'`,
    );
  });

  projectList.forEach((project, i) => {
    mustExist(
      orgNodes.byKey.has(key(project.owner_id, project.org_node_id)),
      `projects[${i}].org_node_id`,
      `'${project.org_node_id}' is not an org node of owner '${project.owner_id}'`,
    );
  });

  const grants = new Set<string>();
  for (const role of roleList) {
    for (const capability of role.capabilities) grants.add(key(role.owner_id, role.id, capability));
  }

  // Grouped rather than compared. Iterating "roles of this project's owner" is a lookup; writing
  // `role.owner_id === project.owner_id` would be a branch on identity, which invariant 8 forbids
  // in spirit even where it would be harmless.
  const rolesByOwner = new Map<OwnerId, RolePolicy[]>();
  roleList.forEach((role) => {
    const bucket = rolesByOwner.get(role.owner_id);
    if (bucket === undefined) rolesByOwner.set(role.owner_id, [role]);
    else bucket.push(role);
  });

  const contracts = new Map<string, EffectiveContract>();
  projectList.forEach((project, i) => {
    const base = withOrgOverrides(project, i, orgNodes, ancestry);
    const chain = ancestry.get(key(project.owner_id, project.org_node_id)) ?? [];
    for (const role of rolesByOwner.get(project.owner_id) ?? []) {
      // §7.2 precedence applies where a role can actually be used: its own org node and below.
      if (!chain.includes(role.org_node_id)) continue;
      const outcome = tighten(base, role.output_contract);
      if (!outcome.ok) {
        const at = roles.positionOf.get(key(role.owner_id, role.id));
        throw new PolicyConfigError(
          `roles[${at}].output_contract.${outcome.field}`,
          `role '${role.name}' v${role.version} ${outcome.why}, resolved against project '${project.id}'`,
        );
      }
      contracts.set(key(project.owner_id, role.id, project.id), outcome.contract);
    }
  });

  return {
    orgNodes: orgNodes.byKey,
    roles: roles.byKey,
    members: members.byKey,
    projects: projects.byKey,
    grants,
    contracts,
    ancestry,
  };
};

/**
 * Fold the org chain's `policy_overrides` onto the Project's own declaration.
 *
 * The blueprint gives the Project the unit and the safety floor (§7.2) and gives org nodes
 * "optional policy overrides" (§7.1) without saying which way they may move. **Decision:** they
 * follow the Role rule exactly — tighten or error, root first. A loosening override would otherwise
 * be a silent widening of a Project's floor from a node the Project does not name, which is the one
 * outcome §7.2 rules out in the case it does describe.
 */
const withOrgOverrides = (
  project: ProjectPolicy,
  at: number,
  orgNodes: Indexed<OrgNodePolicy>,
  ancestry: ReadonlyMap<string, readonly OrgNodeId[]>,
): EffectiveContract => {
  let contract: EffectiveContract = {
    change_unit: project.change_unit,
    change_budget: project.change_budget,
    evidence_profile: project.evidence_floor,
  };
  const chain = ancestry.get(key(project.owner_id, project.org_node_id));
  if (chain === undefined) {
    throw new PolicyConfigError(
      `projects[${at}].org_node_id`,
      `'${project.org_node_id}' has no resolved org chain`,
    );
  }
  for (const nodeId of chain) {
    const nodeKey = key(project.owner_id, nodeId);
    const node = orgNodes.byKey.get(nodeKey);
    if (node === undefined) continue;
    const outcome = tighten(contract, node.policy_overrides);
    if (!outcome.ok) {
      throw new PolicyConfigError(
        `org_nodes[${orgNodes.positionOf.get(nodeKey)}].policy_overrides.${outcome.field}`,
        `org node '${node.id}' ${outcome.why}, resolved against project '${project.id}'`,
      );
    }
    contract = outcome.contract;
  }
  return contract;
};
