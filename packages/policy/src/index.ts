/**
 * Seam C — who may do what, as data (CLAUDE.md §4, blueprint §07).
 *
 * `decide` is the entry point. Everything else here exists to get a `LoadedPolicy` built and to
 * read the numbers a decision implies. Nothing in this package knows a role name, an org shape or
 * an owner id.
 */
export type {
  Capability,
  ChangeUnit,
  ContractOverride,
  EffectiveContract,
  EvidenceProfile,
  MemberId,
  OrgNodeId,
  OwnerId,
  ProjectId,
  Resolution,
  RoleId,
  Scope,
} from './vocabulary.js';
export { CAPABILITIES, CHANGE_UNITS, EVIDENCE_PROFILES, isCapability } from './vocabulary.js';

export type { ContractField, TightenOutcome } from './restriction.js';
export { EVIDENCE_STRICTNESS, asOverride, tighten, tightestEvidence } from './restriction.js';

export type {
  MemberPolicy,
  OrgNodePolicy,
  ProjectPolicy,
  RoleLimits,
  RolePolicy,
} from './config.js';
export { POLICY_SCHEMA_VERSION, PolicyConfigError } from './config.js';

export type { LoadedPolicy, PolicySources } from './load.js';
export { loadPolicy } from './load.js';

export type { CapabilityRequest, DenyReason, PolicyDecision } from './capability.js';
export { decide, effectiveContract } from './capability.js';

export type {
  BudgetPosition,
  CarveOutcome,
  CarveRefusal,
  DelegationDecision,
  DelegationDenyReason,
  DelegationRequest,
} from './delegation.js';
export { authorizeDelegation, carveChildCeiling, parentRemainingCents } from './delegation.js';
