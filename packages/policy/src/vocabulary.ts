/**
 * Seam C vocabulary — blueprint §7.1, §7.2, §7.3.
 *
 * Two things live here and they are deliberately different in kind:
 *
 * - **The capability set is code.** It is the closed list of consequences the spine knows how to
 *   gate, exactly like `DURABLE_EVENT_TYPES` is the closed list of facts it knows how to record.
 *   Keeping it open would make an unrecognised capability id indistinguishable from a real one,
 *   and invariant 4 says an unrecognisable thing is a refusal, not a default. Adding a capability
 *   is therefore a code change with a gate behind it, never a config edit that silently widens
 *   authority.
 * - **Who holds a capability is data** (CLAUDE.md §4, Seam C). No role name, no org-tree shape and
 *   no owner id appears anywhere in this package's source. The one-human-owner case of §7.1 is a
 *   row in `member` pointing at a row in `role`, and it takes the same lookup path everything else
 *   takes. That is what invariant 8 buys: the identity branch §7.1 forbids has nowhere to grow,
 *   because no function here takes an actor identity as anything but a lookup key.
 *
 * `ChangeUnit` and `EvidenceProfile` restate the CHECK constraints already frozen into migration
 * v1 (`project.change_unit`, `project.evidence_floor`). They are duplicated on purpose: schema v1
 * cannot be edited, so these lists cannot drift without a test noticing (`precedence.test.ts`).
 */

export type OwnerId = string;
export type OrgNodeId = string;
export type RoleId = string;
export type MemberId = string;
export type ProjectId = string;

/**
 * Every consequence the spine gates, with the section that says it is a boundary.
 *
 * Read as a list of *verbs the mechanics perform*, not a list of API endpoints. Anything a role
 * could be told to do that has a consequence someone might refuse belongs here; anything else does
 * not belong in an authorization table at all.
 */
export const CAPABILITIES = [
  // §4.2, AI -> spine: "inspect". Reading is still a capability; it is just usually granted.
  'read_project',
  'read_change_set',
  // §8.2 Director may: propose/decompose tasks, select roles, prioritize.
  'propose_task',
  'dispatch_task',
  // §8.2 Director may: steer active work. §9.1: cancel is a provider-runtime verb.
  'steer_attempt',
  'cancel_attempt',
  // §10.1, §10.4. Closing a sandbox can destroy unapplied work, so it is separately gated.
  'open_sandbox',
  'close_sandbox',
  // §7.2 sample role. Sandbox-local mutation: revertible by construction.
  'apply_change_set_in_sandbox',
  'run_declared_command',
  // §8.2 Director may: request checks/reviews. §16.4: a review decision is a different authority.
  'run_declared_check',
  'request_review',
  'submit_review_decision',
  // §12.3. Deciding an approval is not the same authority as executing what it approved.
  'decide_approval',
  // §5.2.2. The consequence boundary: this is the one that leaves the sandbox.
  'apply_to_source_of_record',
  // §10.2. Acquiring is ordinary work; releasing a frozen lock is an audited repair operation.
  'acquire_exclusive_lock',
  'release_frozen_lock',
  // §10.2 + fail-closed SKILL: the Director may never clear `needs-repair`. It is a capability it
  // is not granted, not a branch that checks who is asking.
  'resolve_repair_case',
  // §12.2. The worker never holds the secret; it asks for the action.
  'request_broker_action',
  // §8.2 Director may not: raise its own budget, grant itself capability. Both are capabilities a
  // role can simply fail to hold — which is why neither needs a special case anywhere.
  'raise_budget_ceiling',
  'amend_capability_policy',
  // §7.3. Tasking another role is itself gated, before the escalation rules even run.
  'delegate_to_role',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITIES);

/** An id outside the closed set is not an error to throw — it is a denial. Invariant 4. */
export const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && CAPABILITY_SET.has(value);

/** Mirrors `project.change_unit` in migration v1. The Project owns it; a Role may not set it. */
export const CHANGE_UNITS = ['lines', 'files', 'assets', 'megabytes'] as const;
export type ChangeUnit = (typeof CHANGE_UNITS)[number];

/** Mirrors `project.evidence_floor` / `evidence.profile` in migration v1. §16.1 defines each. */
export const EVIDENCE_PROFILES = ['strong', 'partial', 'manual-required'] as const;
export type EvidenceProfile = (typeof EVIDENCE_PROFILES)[number];

/** §7.2 `output_contract`, resolved. The three numbers a task is actually held to. */
export type EffectiveContract = {
  readonly change_unit: ChangeUnit;
  readonly change_budget: number;
  readonly evidence_profile: EvidenceProfile;
};

/**
 * A partial contract: what an org node or a role *declares*. Every field optional, because absent
 * means "inherit", which is the only reading of §7.2 that lets a Role tighten one field without
 * restating the other two.
 */
export type ContractOverride = {
  readonly change_unit?: ChangeUnit;
  readonly change_budget?: number;
  readonly evidence_profile?: EvidenceProfile;
};

/**
 * A value the spine may act on, or an explicit refusal to produce one.
 *
 * Invariant 4 in the type system: there is no third constructor that means "probably fine", and
 * `value` is unreachable without checking `resolved`, so a caller cannot forget. Every lookup that
 * could come up empty returns this rather than `undefined`, because `undefined` invites `?? default`
 * and a default here is a silent permit.
 */
export type Resolution<T> =
  | { readonly resolved: true; readonly value: T }
  | { readonly resolved: false; readonly why: string };

/**
 * What an authorization question is asked *about*. There is deliberately no `global` scope: a
 * request that cannot name what it is acting on cannot be granted, because there would be nothing
 * for the org-tree containment check to compare against.
 */
export type Scope =
  | { readonly kind: 'project'; readonly project_id: ProjectId }
  | { readonly kind: 'org_node'; readonly org_node_id: OrgNodeId };

/** Reached only if a closed union grew without its consumer growing. Compile error first. */
export const unreachable = (value: never): never => {
  throw new Error(`unhandled policy variant: ${JSON.stringify(value)}`);
};
