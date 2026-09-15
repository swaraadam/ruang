/**
 * The part of §5.2 this adapter implements today, assembled. Each method delegates; the mapping from
 * core concept to substrate lives in the module it belongs to, and the table is in this package's
 * README. One instance binds one Project, and a method asked about a different Project refuses
 * rather than answering about the one it holds — a wrong answer here is attributed to the wrong
 * Project for the rest of its life.
 */
import type { DomainAdapter, ProjectId } from '@internal/domain';
import { basisStaleness, snapshotBasis } from './basis.js';
import { computeChangeSet, renderChangeSet } from './changes.js';
import { declaredChecks, runChecks } from './checks.js';
import { inspectSandbox, openSandbox } from './sandbox.js';
import { AdapterRefusal, type CodeAdapterOptions } from './surface.js';

/**
 * The methods implemented here, named as a subset of the contract rather than as a contract of their
 * own. **`packages/domain/src/spi.ts` is unchanged and still declares all thirteen**: what is
 * narrower is what has been built, not what is required of a domain adapter, and every signature
 * below is still the SPI's own. Writing it as a `Pick` is what keeps those two facts apart — a
 * hand-written thirteen-minus-five interface would read as a revised contract.
 *
 * The five that are absent — `close_sandbox`, `apply_plan`, `confirm_applied`,
 * `revert_or_compensate`, `reconcile` — are the surface the owner cut on 2026-09-15 (issue #10) and
 * belong to #108. The remainder answers questions; it decides nothing irreversible.
 */
export type ImplementedMethods =
  | 'snapshot_basis'
  | 'is_basis_stale'
  | 'open_sandbox'
  | 'inspect_sandbox'
  | 'compute_change_set'
  | 'render_change_set'
  | 'declared_checks'
  | 'run_checks';

export const createCodeAdapter = (
  options: CodeAdapterOptions,
): Pick<DomainAdapter, ImplementedMethods> => {
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
    // A sandbox carries the Project it belongs to, and these were taking that on trust. An instance
    // bound to one Project answering about another's sandbox reaches into this Project's locations
    // under another Project's name -- the wrong answer, attributed wrongly, for good.
    inspect_sandbox: async (sandbox) => {
      sameProject(sandbox.project_id);
      return inspectSandbox(options, sandbox);
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
  };
};
