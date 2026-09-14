/**
 * Seam C test data. Plain objects, passed through `loadPolicy` as `unknown`, because that is how
 * real documents arrive — the tests exercise the validator rather than trusting a typed literal.
 *
 * `members` and `projects` are stand-ins for `member` and `project` rows: those live in SQLite, not
 * in `config/`, so there is no file to read them from at this layer.
 *
 * The human member is bound to a role like every other member. §7.1's "exactly one human row" is a
 * row count here, and `capability.test.ts` checks that being it grants nothing extra.
 */
import type { PolicySources } from '../src/index.js';

export const OWNER = 'owner-t';

export const NODE_ROOT = {
  id: 'root',
  owner_id: OWNER,
  parent_id: null,
  name: 'root',
  policy_overrides: null,
};

export const NODE_ENG = {
  id: 'root/eng',
  owner_id: OWNER,
  parent_id: 'root',
  name: 'eng',
  policy_overrides: null,
};

/** Appendix B.1's numbers: lines, 250, strong. */
export const PROJECT = {
  id: 'proj-a',
  owner_id: OWNER,
  org_node_id: 'root/eng',
  change_unit: 'lines',
  change_budget: 250,
  evidence_floor: 'strong',
};

export const LEAD = {
  id: 'lead-v1',
  owner_id: OWNER,
  org_node_id: 'root',
  name: 'lead',
  version: 1,
  capabilities: [
    'read_project',
    'apply_change_set_in_sandbox',
    'run_declared_command',
    'dispatch_task',
    'delegate_to_role',
  ],
  output_contract: null,
  limits: { cost_per_task_cents: 5000, concurrency: 2 },
  delegation: ['worker-v1'],
};

export const WORKER = {
  id: 'worker-v1',
  owner_id: OWNER,
  org_node_id: 'root/eng',
  name: 'worker',
  version: 1,
  capabilities: ['read_project', 'apply_change_set_in_sandbox', 'run_declared_command'],
  output_contract: { change_budget: 100 },
  limits: { cost_per_task_cents: 900, concurrency: 1 },
  delegation: [],
};

export const MEMBER_LEAD = {
  id: 'm-lead',
  owner_id: OWNER,
  org_node_id: 'root',
  kind: 'human',
  role_ref: 'lead-v1',
};

export const MEMBER_WORKER = {
  id: 'm-worker',
  owner_id: OWNER,
  org_node_id: 'root/eng',
  kind: 'agent',
  role_ref: 'worker-v1',
};

export const MEMBER_UNBOUND = {
  id: 'm-none',
  owner_id: OWNER,
  org_node_id: 'root',
  kind: 'agent',
  role_ref: null,
};

export type SourcePatch = {
  readonly orgNodes?: readonly unknown[];
  readonly roles?: readonly unknown[];
  readonly members?: readonly unknown[];
  readonly projects?: readonly unknown[];
};

export const sources = (patch: SourcePatch = {}): PolicySources => ({
  org: { policy_schema_version: 1, org_nodes: patch.orgNodes ?? [NODE_ROOT, NODE_ENG] },
  roles: { policy_schema_version: 1, roles: patch.roles ?? [LEAD, WORKER] },
  members: {
    policy_schema_version: 1,
    members: patch.members ?? [MEMBER_LEAD, MEMBER_WORKER, MEMBER_UNBOUND],
  },
  projects: { policy_schema_version: 1, projects: patch.projects ?? [PROJECT] },
});

/** One entry with fields replaced, so a test states only the thing it is about. */
export const withFields = <T extends object>(base: T, patch: Record<string, unknown>): unknown => ({
  ...base,
  ...patch,
});
