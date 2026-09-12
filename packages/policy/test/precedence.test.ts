/**
 * §7.2 precedence and the load-time refusals it requires.
 *
 * The acceptance criterion is not "loosening is prevented" but "loosening is a *configuration
 * error at load time* with the offending path named", so every refusal below asserts the path and
 * not only that something threw.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_UNITS,
  EVIDENCE_PROFILES,
  EVIDENCE_STRICTNESS,
  PolicyConfigError,
  effectiveContract,
  loadPolicy,
  tighten,
} from '../src/index.js';
import {
  LEAD,
  NODE_ENG,
  NODE_ROOT,
  OWNER,
  PROJECT,
  WORKER,
  sources,
  withFields,
} from './fixture.js';
import type { SourcePatch } from './fixture.js';

const refusal = (patch: SourcePatch): PolicyConfigError => {
  try {
    loadPolicy(sources(patch));
  } catch (error) {
    if (error instanceof PolicyConfigError) return error;
    throw error;
  }
  throw new Error('expected loadPolicy to refuse this document');
};

describe('the Project owns change_unit and the safety floor', () => {
  it('resolves a role contract by tightening the project, keeping the project unit', () => {
    const policy = loadPolicy(sources());
    expect(effectiveContract(policy, OWNER, 'worker-v1', 'proj-a')).toEqual({
      resolved: true,
      value: { change_unit: 'lines', change_budget: 100, evidence_profile: 'strong' },
    });
  });

  it('gives a role that declares nothing exactly the project contract', () => {
    const policy = loadPolicy(sources());
    expect(effectiveContract(policy, OWNER, 'lead-v1', 'proj-a')).toEqual({
      resolved: true,
      value: { change_unit: 'lines', change_budget: 250, evidence_profile: 'strong' },
    });
  });

  it('refuses a role whose change_budget loosens the project, naming the path', () => {
    const error = refusal({
      roles: [LEAD, withFields(WORKER, { output_contract: { change_budget: 400 } })],
    });
    expect(error.path).toBe('roles[1].output_contract.change_budget');
    expect(error.message).toContain('400');
    expect(error.message).toContain('250 lines');
    expect(error.message).toContain("project 'proj-a'");
  });

  it('refuses a role that declares a different change_unit at all', () => {
    const error = refusal({
      roles: [LEAD, withFields(WORKER, { output_contract: { change_unit: 'files' } })],
    });
    expect(error.path).toBe('roles[1].output_contract.change_unit');
    expect(error.message).toContain("the Project owns change_unit 'lines'");
  });

  it('refuses a role whose evidence_profile is weaker than the project floor', () => {
    const error = refusal({
      roles: [LEAD, withFields(WORKER, { output_contract: { evidence_profile: 'partial' } })],
    });
    expect(error.path).toBe('roles[1].output_contract.evidence_profile');
  });

  it('accepts an equal declaration: tightening includes leaving it where it was', () => {
    const policy = loadPolicy({
      ...sources(),
      roles: {
        policy_schema_version: 1,
        roles: [
          LEAD,
          withFields(WORKER, {
            output_contract: {
              change_unit: 'lines',
              change_budget: 250,
              evidence_profile: 'strong',
            },
          }),
        ],
      },
    });
    expect(effectiveContract(policy, OWNER, 'worker-v1', 'proj-a')).toEqual({
      resolved: true,
      value: { change_unit: 'lines', change_budget: 250, evidence_profile: 'strong' },
    });
  });

  it('lets a role raise the evidence floor, because that is a tightening', () => {
    const policy = loadPolicy(
      sources({
        roles: [
          LEAD,
          withFields(WORKER, { output_contract: { evidence_profile: 'manual-required' } }),
        ],
      }),
    );
    expect(effectiveContract(policy, OWNER, 'worker-v1', 'proj-a')).toEqual({
      resolved: true,
      value: { change_unit: 'lines', change_budget: 250, evidence_profile: 'manual-required' },
    });
  });
});

describe('org node policy_overrides follow the same direction as a role', () => {
  it('applies a tightening override before the role is folded in', () => {
    const policy = loadPolicy(
      sources({
        orgNodes: [withFields(NODE_ROOT, { policy_overrides: { change_budget: 150 } }), NODE_ENG],
      }),
    );
    expect(effectiveContract(policy, OWNER, 'lead-v1', 'proj-a')).toEqual({
      resolved: true,
      value: { change_unit: 'lines', change_budget: 150, evidence_profile: 'strong' },
    });
  });

  it('refuses a role that loosens what the org chain already tightened', () => {
    const error = refusal({
      orgNodes: [withFields(NODE_ROOT, { policy_overrides: { change_budget: 80 } }), NODE_ENG],
    });
    // WORKER declares 100, legal against the project's 250 and illegal against the inherited 80.
    // Fold order is what this asserts: org chain first, role last.
    expect(error.path).toBe('roles[1].output_contract.change_budget');
    expect(error.message).toContain('80 lines');
  });

  it('refuses a loosening override, naming the org node', () => {
    const error = refusal({
      orgNodes: [NODE_ROOT, withFields(NODE_ENG, { policy_overrides: { change_budget: 900 } })],
    });
    expect(error.path).toBe('org_nodes[1].policy_overrides.change_budget');
  });
});

describe('a document that cannot be understood is refused, never partially applied', () => {
  it('refuses a capability id outside the closed set, naming the element', () => {
    const error = refusal({
      roles: [LEAD, withFields(WORKER, { capabilities: ['read_project', 'sudo_everything'] })],
    });
    expect(error.path).toBe('roles[1].capabilities[1]');
    expect(error.message).toContain('the capability set is closed');
  });

  it('refuses a schema version it does not know rather than guessing what changed', () => {
    const error = (() => {
      try {
        loadPolicy({ ...sources(), roles: { policy_schema_version: 2, roles: [] } });
      } catch (e) {
        return e as PolicyConfigError;
      }
      throw new Error('expected a refusal');
    })();
    expect(error.path).toBe('roles.policy_schema_version');
  });

  it('refuses a dangling org node reference', () => {
    const error = refusal({ roles: [withFields(LEAD, { org_node_id: 'nowhere' }), WORKER] });
    expect(error.path).toBe('roles[0].org_node_id');
  });

  it('refuses a cyclic org tree, because a cycle has no precedence order', () => {
    const error = refusal({
      orgNodes: [withFields(NODE_ROOT, { parent_id: 'root/eng' }), NODE_ENG],
    });
    expect(error.path).toBe('org_nodes[0].parent_id');
    expect(error.message).toContain('cycles');
  });

  it('refuses an id containing the key separator', () => {
    const error = refusal({ projects: [withFields(PROJECT, { id: 'proj\u001fa' })] });
    expect(error.path).toBe('projects[0].id');
  });

  it('refuses two roles sharing (owner, name, version), as v1 would', () => {
    const error = refusal({ roles: [LEAD, WORKER, withFields(WORKER, { id: 'worker-v1-copy' })] });
    expect(error.path).toBe('roles[2].version');
  });
});

describe('most-restrictive-wins is total', () => {
  it('ranks every profile the closed union declares', () => {
    expect(Object.keys(EVIDENCE_STRICTNESS).sort()).toEqual([...EVIDENCE_PROFILES].sort());
  });

  it('orders the profiles by how hard they are to satisfy (§16.1)', () => {
    expect(EVIDENCE_STRICTNESS.partial).toBeLessThan(EVIDENCE_STRICTNESS.strong);
    expect(EVIDENCE_STRICTNESS.strong).toBeLessThan(EVIDENCE_STRICTNESS['manual-required']);
  });

  it('answers for every ordered pair of profiles without a default-permit', () => {
    for (const base of EVIDENCE_PROFILES) {
      for (const override of EVIDENCE_PROFILES) {
        const outcome = tighten(
          { change_unit: 'lines', change_budget: 10, evidence_profile: base },
          { evidence_profile: override },
        );
        const loosening = EVIDENCE_STRICTNESS[override] < EVIDENCE_STRICTNESS[base];
        expect(outcome.ok).toBe(!loosening);
        if (outcome.ok) {
          expect(EVIDENCE_STRICTNESS[outcome.contract.evidence_profile]).toBeGreaterThanOrEqual(
            EVIDENCE_STRICTNESS[base],
          );
        }
      }
    }
  });

  it('refuses a budget that is not a whole count of units', () => {
    for (const budget of [-1, 1.5, Number.NaN]) {
      const outcome = tighten(
        { change_unit: 'lines', change_budget: 10, evidence_profile: 'strong' },
        { change_budget: budget },
      );
      expect(outcome).toMatchObject({ ok: false, field: 'change_budget' });
    }
  });
});

describe('the vocabulary agrees with frozen migration v1', () => {
  const v1 = readFileSync(
    fileURLToPath(new URL('../../persistence/src/migrations/v1.ts', import.meta.url)),
    'utf8',
  );

  it('uses the change_unit values the schema will accept', () => {
    expect(v1).toContain(`change_unit IN (${CHANGE_UNITS.map((u) => `'${u}'`).join(',')})`);
  });

  it('uses the evidence values the schema will accept', () => {
    expect(v1).toContain(`evidence_floor IN (${EVIDENCE_PROFILES.map((p) => `'${p}'`).join(',')})`);
  });
});

describe('the example Seam C data in config/ is loadable as written', () => {
  const read = (relative: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

  it('loads config/org and config/roles against a project row', () => {
    const policy = loadPolicy({
      org: read('../../../config/org/example.org.json'),
      roles: read('../../../config/roles/example.roles.json'),
      members: {
        policy_schema_version: 1,
        members: [
          {
            id: 'member-owner',
            owner_id: 'owner-example',
            org_node_id: 'studio',
            kind: 'human',
            role_ref: 'director-v1',
          },
        ],
      },
      projects: {
        policy_schema_version: 1,
        projects: [
          {
            id: 'project-example',
            owner_id: 'owner-example',
            org_node_id: 'studio/engineering',
            change_unit: 'lines',
            change_budget: 250,
            evidence_floor: 'strong',
          },
        ],
      },
    });
    expect(
      effectiveContract(policy, 'owner-example', 'build-engineer-v1', 'project-example'),
    ).toEqual({
      resolved: true,
      value: { change_unit: 'lines', change_budget: 120, evidence_profile: 'strong' },
    });
  });
});
