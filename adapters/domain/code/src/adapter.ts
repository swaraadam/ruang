/**
 * The thirteen methods of §5.2, assembled. Each delegates; the mapping from core concept to
 * substrate lives in the module it belongs to, and the table is in this package's README. One
 * instance binds one Project, and a method asked about a different Project refuses rather than
 * answering about the one it holds — a wrong answer here is attributed to the wrong Project for
 * the rest of its life.
 */
import type { DomainAdapter, ProjectId } from '@internal/domain';
import { applyPlan, confirmApplied, reconcile, revertOrCompensate } from './apply.js';
import { basisStaleness, snapshotBasis } from './basis.js';
import { computeChangeSet, renderChangeSet } from './changes.js';
import { declaredChecks, runChecks } from './checks.js';
import { closeSandbox, inspectSandbox, openSandbox } from './sandbox.js';
import { AdapterRefusal, type CodeAdapterOptions } from './surface.js';

export const createCodeAdapter = (options: CodeAdapterOptions): DomainAdapter => {
  const sameProject = (project: ProjectId): void => {
    if (project !== options.project_id)
      throw new AdapterRefusal(
        'unknown_project',
        'this adapter instance is bound to a different project',
      );
  };
  const now = options.now ?? ((): string => new Date().toISOString());

  return {
    snapshot_basis: async (project, consulted_inputs) => {
      sameProject(project);
      return snapshotBasis(options.source_of_record, consulted_inputs, now);
    },
    is_basis_stale: (basis) => basisStaleness(options.source_of_record, basis),
    open_sandbox: async (project, basis) => {
      sameProject(project);
      return openSandbox(options, basis);
    },
    // A sandbox carries the Project it belongs to, and these four were taking that on trust. An
    // instance bound to one Project answering about another's sandbox reaches into this Project's
    // locations under another Project's name -- the wrong answer, attributed wrongly, for good.
    inspect_sandbox: async (sandbox) => {
      sameProject(sandbox.project_id);
      return inspectSandbox(options, sandbox);
    },
    close_sandbox: async (sandbox, policy) => {
      sameProject(sandbox.project_id);
      return closeSandbox(options, sandbox, policy);
    },
    compute_change_set: async (sandbox) => {
      sameProject(sandbox.project_id);
      return computeChangeSet(options, sandbox);
    },
    render_change_set: async (change_set, surface) => renderChangeSet(change_set, surface),
    declared_checks: async (project) => {
      sameProject(project);
      return declaredChecks(options);
    },
    run_checks: async (sandbox, specs) => {
      sameProject(sandbox.project_id);
      return runChecks(options, sandbox, specs);
    },
    apply_plan: (change_set, policy) => applyPlan(options, change_set, policy),
    confirm_applied: async (plan_id, broker_results) => confirmApplied(plan_id, broker_results),
    revert_or_compensate: async (result) => revertOrCompensate(options, result),
    reconcile: (known_state) => reconcile(options, known_state),
  };
};
