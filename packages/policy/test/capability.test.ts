/**
 * §7.1 / §21.2: the capability table is the only authorization primitive, and being the one human
 * owner is not an argument anywhere in it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, type PolicyDecision, type Scope, decide, loadPolicy } from '../src/index.js';
import { LEAD, MEMBER_LEAD, OWNER, WORKER, sources, withFields } from './fixture.js';

const policy = loadPolicy(sources());
const onProject: Scope = { kind: 'project', project_id: 'proj-a' };

const ask = (member_id: string, capability: string, scope: Scope = onProject): PolicyDecision =>
  decide(policy, { owner_id: OWNER, member_id, capability, scope });

describe('an allow is a grant found in the table', () => {
  it('allows a capability the bound role holds, and returns the resolved contract', () => {
    expect(ask('m-worker', 'apply_change_set_in_sandbox')).toEqual({
      outcome: 'allow',
      capability: 'apply_change_set_in_sandbox',
      role_id: 'worker-v1',
      org_node_id: 'root/eng',
      contract: { change_unit: 'lines', change_budget: 100, evidence_profile: 'strong' },
    });
  });

  it('allows an org-node scoped question without inventing a change contract', () => {
    expect(
      ask('m-lead', 'dispatch_task', { kind: 'org_node', org_node_id: 'root/eng' }),
    ).toMatchObject({ outcome: 'allow', contract: null });
  });
});

describe('the human owner is a member row, not a branch', () => {
  it('denies the human member a capability its role does not hold', () => {
    // m-lead is the single `kind: 'human'` row of §7.1. It reaches `deny` through exactly the
    // lookup an agent reaches, which is the whole content of invariant 8.
    expect(ask('m-lead', 'apply_to_source_of_record')).toMatchObject({
      outcome: 'deny',
      reason: 'not_granted',
    });
  });

  it('grants the same human member a capability its role does hold', () => {
    expect(ask('m-lead', 'dispatch_task')).toMatchObject({ outcome: 'allow' });
  });

  it('mentions no identity branch anywhere in the package source', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const source = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(`${dir}${f}`, 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/\b(isMe|isOwner)\b/);
  });
});

describe('every refusal is explicit and fails closed', () => {
  it('denies a capability id outside the closed set', () => {
    expect(ask('m-worker', 'become_owner')).toMatchObject({
      outcome: 'deny',
      reason: 'unknown_capability',
    });
  });

  it('denies a member that does not exist under this owner', () => {
    expect(ask('m-ghost', 'read_project')).toMatchObject({
      outcome: 'deny',
      reason: 'unknown_member',
    });
  });

  it('denies a real member asked about under a different owner, because tenancy is the key', () => {
    expect(
      decide(policy, {
        owner_id: 'owner-other',
        member_id: 'm-worker',
        capability: 'read_project',
        scope: onProject,
      }),
    ).toMatchObject({ outcome: 'deny', reason: 'unknown_member' });
  });

  it('denies a member bound to no role', () => {
    expect(ask('m-none', 'read_project')).toMatchObject({
      outcome: 'deny',
      reason: 'member_has_no_role',
    });
  });

  it('denies an unknown project rather than falling back to an org-wide answer', () => {
    expect(
      ask('m-worker', 'read_project', { kind: 'project', project_id: 'proj-ghost' }),
    ).toMatchObject({ outcome: 'deny', reason: 'unknown_project' });
  });

  it('denies a role asked about a scope above its own org node', () => {
    expect(
      ask('m-worker', 'read_project', { kind: 'org_node', org_node_id: 'root' }),
    ).toMatchObject({
      outcome: 'deny',
      reason: 'out_of_org_scope',
    });
  });

  it('denies a project outside the role subtree, so a sibling desk is not reachable', () => {
    const sibling = loadPolicy(
      sources({
        orgNodes: [
          { id: 'root', owner_id: OWNER, parent_id: null, name: 'root', policy_overrides: null },
          {
            id: 'root/eng',
            owner_id: OWNER,
            parent_id: 'root',
            name: 'eng',
            policy_overrides: null,
          },
          {
            id: 'root/art',
            owner_id: OWNER,
            parent_id: 'root',
            name: 'art',
            policy_overrides: null,
          },
        ],
        projects: [
          {
            id: 'proj-art',
            owner_id: OWNER,
            org_node_id: 'root/art',
            change_unit: 'assets',
            change_budget: 6,
            evidence_floor: 'manual-required',
          },
        ],
      }),
    );
    expect(
      decide(sibling, {
        owner_id: OWNER,
        member_id: 'm-worker',
        capability: 'read_project',
        scope: { kind: 'project', project_id: 'proj-art' },
      }),
    ).toMatchObject({ outcome: 'deny', reason: 'out_of_org_scope' });
  });

  it('denies every capability a role holding none could ask for', () => {
    const bare = loadPolicy(sources({ roles: [LEAD, withFields(WORKER, { capabilities: [] })] }));
    for (const capability of CAPABILITIES) {
      expect(
        decide(bare, {
          owner_id: OWNER,
          member_id: 'm-worker',
          capability,
          scope: onProject,
        }),
      ).toMatchObject({ outcome: 'deny', reason: 'not_granted' });
    }
  });

  it('answers allow or deny for every capability in the closed set, never throws', () => {
    for (const capability of CAPABILITIES) {
      expect(['allow', 'deny']).toContain(ask('m-lead', capability).outcome);
    }
  });
});

describe('the fixture states what it relies on', () => {
  it('binds the human member to a role rather than to an owner id', () => {
    expect(MEMBER_LEAD.kind).toBe('human');
    expect(MEMBER_LEAD.role_ref).toBe('lead-v1');
  });
});
