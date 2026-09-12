/**
 * Seam C configuration — the shapes of the versioned data, and how a bad document is reported.
 *
 * These types are deliberately column-shaped. `role`, `member`, `org_node` and `project` already
 * exist in migration v1 and v1 is frozen, so the policy layer reads what the schema can actually
 * store (`capabilities`, `limits`, `delegation`, `policy_overrides`, `change_unit`, `change_budget`,
 * `evidence_floor`) rather than a shape that would need a v2 to persist. Extra keys are ignored on
 * purpose: the `role` row carries `charter` and `context_refs`, which are real fields that
 * authorization has no business reading.
 *
 * **Format is not baked in.** `loadPolicy` takes already-parsed `unknown`, so the bytes on disk can
 * be JSON today and the YAML of Appendix B later without touching this package. JSON is what ships
 * because a YAML parser would be a new runtime dependency and CLAUDE.md §8 requires an ADR for one;
 * nothing about the rules below depends on which it is.
 *
 * **Errors name a path.** §7.2 requires a looser Role to be "a configuration error at load time,
 * not a silent override", and an error that cannot say *which* declaration was wrong sends the
 * owner hunting. Every throw below carries a path like `roles[1].output_contract.change_budget`.
 */
import { type Check, int, isRecord, list, oneOf, str } from '@internal/protocol';
import {
  CHANGE_UNITS,
  type Capability,
  type ContractOverride,
  EVIDENCE_PROFILES,
  type EvidenceProfile,
  type MemberId,
  type OrgNodeId,
  type OwnerId,
  type ProjectId,
  type RoleId,
  isCapability,
} from './vocabulary.js';

/** Bumped when the meaning of a field changes. A document from the future is refused, not guessed. */
export const POLICY_SCHEMA_VERSION = 1;

/** A load-time refusal. `path` is the offending declaration, not the file. */
export class PolicyConfigError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'PolicyConfigError';
    this.path = path;
  }
}

export type RoleLimits = {
  /** §7.2 `limits.cost_per_task`, in cents to match `budget_ledger`. `null` = no role-level cap. */
  readonly cost_per_task_cents: number | null;
  readonly concurrency: number | null;
};

export type OrgNodePolicy = {
  readonly id: OrgNodeId;
  readonly owner_id: OwnerId;
  readonly parent_id: OrgNodeId | null;
  readonly name: string;
  readonly policy_overrides: ContractOverride;
};

export type RolePolicy = {
  readonly id: RoleId;
  readonly owner_id: OwnerId;
  readonly org_node_id: OrgNodeId;
  readonly name: string;
  readonly version: number;
  readonly capabilities: readonly Capability[];
  readonly output_contract: ContractOverride;
  readonly limits: RoleLimits;
  /** Role ids this role may task (§7.3). Empty means it may task nobody — the fail-closed default. */
  readonly delegation: readonly RoleId[];
};

export type MemberPolicy = {
  readonly id: MemberId;
  readonly owner_id: OwnerId;
  readonly org_node_id: OrgNodeId;
  readonly kind: 'human' | 'agent';
  /** `role_ref` is nullable in v1. A member without a role holds no capabilities at all. */
  readonly role_ref: RoleId | null;
};

export type ProjectPolicy = {
  readonly id: ProjectId;
  readonly owner_id: OwnerId;
  readonly org_node_id: OrgNodeId;
  readonly change_unit: (typeof CHANGE_UNITS)[number];
  readonly change_budget: number;
  readonly evidence_floor: EvidenceProfile;
};

const changeUnit = oneOf(...CHANGE_UNITS);
const evidenceProfile = oneOf(...EVIDENCE_PROFILES);
const memberKind = oneOf('human', 'agent');

const typeName = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

const record = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  if (!isRecord(value))
    throw new PolicyConfigError(path, `expected an object, got ${typeName(value)}`);
  return value;
};

const field = <T>(
  source: Readonly<Record<string, unknown>>,
  path: string,
  key: string,
  check: Check<T>,
  expected: string,
): T => {
  const value = source[key];
  if (!check(value)) {
    throw new PolicyConfigError(`${path}.${key}`, `expected ${expected}, got ${typeName(value)}`);
  }
  return value;
};

/** Absent and `null` both mean "not declared"; JSON has no way to omit a key inside an array entry. */
const optional = <T>(
  source: Readonly<Record<string, unknown>>,
  path: string,
  key: string,
  check: Check<T>,
  expected: string,
): T | undefined =>
  source[key] === undefined || source[key] === null
    ? undefined
    : field(source, path, key, check, expected);

/**
 * Ids are joined with a separator to build lookup keys, so a separator *inside* an id would let one
 * id impersonate another key. Restricting the charset at load is cheaper than escaping at every
 * lookup, and it fails closed: an id this rejects never reaches the table.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const id = (source: Readonly<Record<string, unknown>>, path: string, key: string): string => {
  const value = field(source, path, key, str, 'a string id');
  if (!ID_PATTERN.test(value)) {
    throw new PolicyConfigError(
      `${path}.${key}`,
      `id ${JSON.stringify(value)} must match ${String(ID_PATTERN)}`,
    );
  }
  return value;
};

const optionalId = (
  source: Readonly<Record<string, unknown>>,
  path: string,
  key: string,
): string | null =>
  source[key] === undefined || source[key] === null ? null : id(source, path, key);

/** Read one section document: a version header plus a named array. */
const entries = (document: unknown, arrayKey: string): readonly unknown[] => {
  const root = record(document, arrayKey);
  const version = field(root, arrayKey, 'policy_schema_version', int, 'an integer');
  if (version !== POLICY_SCHEMA_VERSION) {
    throw new PolicyConfigError(
      `${arrayKey}.policy_schema_version`,
      `this build reads policy schema ${POLICY_SCHEMA_VERSION}, the document declares ${version}; refusing to interpret a version it does not know`,
    );
  }
  return field(
    root,
    arrayKey,
    arrayKey,
    list((v): v is unknown => v !== undefined),
    'an array',
  );
};

/**
 * A declared, partial contract. Only the three §7.2 `output_contract` fields are read; `change_unit`
 * is read so that declaring a *different* one can be refused, never so that it can take effect.
 */
const overrideAt = (value: unknown, path: string): ContractOverride => {
  if (value === undefined || value === null) return {};
  const source = record(value, path);
  const unit = optional(
    source,
    path,
    'change_unit',
    changeUnit,
    `one of ${CHANGE_UNITS.join(', ')}`,
  );
  const budget = optional(source, path, 'change_budget', int, 'an integer count of change units');
  const evidence = optional(
    source,
    path,
    'evidence_profile',
    evidenceProfile,
    `one of ${EVIDENCE_PROFILES.join(', ')}`,
  );
  return {
    ...(unit === undefined ? {} : { change_unit: unit }),
    ...(budget === undefined ? {} : { change_budget: budget }),
    ...(evidence === undefined ? {} : { evidence_profile: evidence }),
  };
};

export const parseOrgNodes = (document: unknown): readonly OrgNodePolicy[] =>
  entries(document, 'org_nodes').map((entry, i) => {
    const path = `org_nodes[${i}]`;
    const source = record(entry, path);
    return {
      id: id(source, path, 'id'),
      owner_id: id(source, path, 'owner_id'),
      parent_id: optionalId(source, path, 'parent_id'),
      name: field(source, path, 'name', str, 'a string'),
      policy_overrides: overrideAt(source['policy_overrides'], `${path}.policy_overrides`),
    };
  });

export const parseRoles = (document: unknown): readonly RolePolicy[] =>
  entries(document, 'roles').map((entry, i) => {
    const path = `roles[${i}]`;
    const source = record(entry, path);
    const declared = field(source, path, 'capabilities', list(str), 'an array of capability ids');
    const capabilities = declared.map((value, j) => {
      // An unrecognised capability cannot be granted and cannot be ignored: ignoring it would let a
      // typo silently shrink a role, and accepting it would let a typo silently invent authority.
      if (!isCapability(value)) {
        throw new PolicyConfigError(
          `${path}.capabilities[${j}]`,
          `${JSON.stringify(value)} is not a capability this build knows; the capability set is closed (vocabulary.ts)`,
        );
      }
      return value;
    });
    const limits = record(source['limits'] ?? {}, `${path}.limits`);
    return {
      id: id(source, path, 'id'),
      owner_id: id(source, path, 'owner_id'),
      org_node_id: id(source, path, 'org_node_id'),
      name: field(source, path, 'name', str, 'a string'),
      version: field(source, path, 'version', int, 'an integer version'),
      capabilities,
      output_contract: overrideAt(source['output_contract'], `${path}.output_contract`),
      limits: {
        cost_per_task_cents:
          optional(limits, `${path}.limits`, 'cost_per_task_cents', int, 'an integer of cents') ??
          null,
        concurrency: optional(limits, `${path}.limits`, 'concurrency', int, 'an integer') ?? null,
      },
      delegation: field(source, path, 'delegation', list(str), 'an array of role ids'),
    };
  });

export const parseMembers = (document: unknown): readonly MemberPolicy[] =>
  entries(document, 'members').map((entry, i) => {
    const path = `members[${i}]`;
    const source = record(entry, path);
    return {
      id: id(source, path, 'id'),
      owner_id: id(source, path, 'owner_id'),
      org_node_id: id(source, path, 'org_node_id'),
      kind: field(source, path, 'kind', memberKind, "'human' or 'agent'"),
      role_ref: optionalId(source, path, 'role_ref'),
    };
  });

export const parseProjects = (document: unknown): readonly ProjectPolicy[] =>
  entries(document, 'projects').map((entry, i) => {
    const path = `projects[${i}]`;
    const source = record(entry, path);
    const budget = field(source, path, 'change_budget', int, 'an integer count of change units');
    if (budget < 0) {
      throw new PolicyConfigError(`${path}.change_budget`, `must not be negative, got ${budget}`);
    }
    return {
      id: id(source, path, 'id'),
      owner_id: id(source, path, 'owner_id'),
      org_node_id: id(source, path, 'org_node_id'),
      change_unit: field(
        source,
        path,
        'change_unit',
        changeUnit,
        `one of ${CHANGE_UNITS.join(', ')}`,
      ),
      change_budget: budget,
      evidence_floor: field(
        source,
        path,
        'evidence_floor',
        evidenceProfile,
        `one of ${EVIDENCE_PROFILES.join(', ')}`,
      ),
    };
  });
