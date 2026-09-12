/**
 * Seam A — the provisional domain contract, blueprint §5.2. The thirteen methods, in that order.
 *
 * Part 2 of P0-04; `vocabulary.ts` owns the shapes these pass. Types only.
 *
 * **Provisional means provisional.** CLAUDE.md §4: the SPI is not frozen until a code adapter
 * *and* a real binary-asset workflow both pass the contract tests, and if the asset adapter cannot
 * implement a method, the contract is revised — never worked around in the core.
 *
 * Every method therefore carries a one-line **Asset:** note. They are written now, before any
 * asset adapter exists, so the first disagreement produces a contract revision against a recorded
 * starting position rather than an argument about what was always meant. `spi.test.ts` requires
 * one on each method; it cannot check that the answer is *right*, only that someone committed to
 * one.
 */
import type { ChangeSet, RenderableChange } from '@internal/protocol';
import type {
  ApplyPlan,
  ApplyPolicy,
  ApplyResult,
  Basis,
  BrokerOutcome,
  CheckResult,
  CheckSpec,
  ClosePolicy,
  ProjectId,
  ReconcileResult,
  RenderSurface,
  ResourceId,
  ReversalPlan,
  SafetyRecord,
  Sandbox,
  SandboxInspection,
  Staleness,
} from './vocabulary.js';

export type DomainAdapter = {
  /** Asset: the import graph's content hashes, not one pointer at the source of record. */
  snapshot_basis(project: ProjectId, consulted_inputs: readonly ResourceId[]): Promise<Basis>;

  /** Asset: an asset re-exported byte-identical is `fresh`; one that cannot be read is `unknown`. */
  is_basis_stale(basis: Basis): Promise<Staleness>;

  /** Asset: a scratch copy of the source assets, which may be large and may be slow to make. */
  open_sandbox(project: ProjectId, basis: Basis): Promise<Sandbox>;

  /** Asset: unsaved editor state counts as dirty even when nothing on disk has changed. */
  inspect_sandbox(sandbox: Sandbox): Promise<SandboxInspection>;

  /** Asset: refuses while an exclusive editor lock is held, and says so in `refused_reason`. */
  close_sandbox(sandbox: Sandbox, policy: ClosePolicy): Promise<SafetyRecord>;

  /** Asset: changed asset ids with before/after artifact refs, never inline bytes. */
  compute_change_set(sandbox: Sandbox): Promise<ChangeSet>;

  /** Asset: `asset_delta` or `region_delta`; the adapter ships no code to draw either. */
  render_change_set(
    change_set: ChangeSet,
    surface: RenderSurface,
  ): Promise<readonly RenderableChange[]>;

  /** Asset: import validation and a reference render, declared like any other check. */
  declared_checks(project: ProjectId): Promise<readonly CheckSpec[]>;

  /** Asset: may need an exclusive resource lock; the spine acquires it, not the adapter. */
  run_checks(sandbox: Sandbox, specs: readonly CheckSpec[]): Promise<readonly CheckResult[]>;

  /** Asset: a re-import or a publish step — declarative, and frequently `irreversible`. */
  apply_plan(change_set: ChangeSet, policy: ApplyPolicy): Promise<ApplyPlan>;

  /** Asset: reconciles the asset database against what the broker reported it actually did. */
  confirm_applied(plan_id: string, broker_results: readonly BrokerOutcome[]): Promise<ApplyResult>;

  /** Asset: usually `not_reversible` for a publish; a compensating re-import where one exists. */
  revert_or_compensate(result: ApplyResult): Promise<ReversalPlan>;

  /** Asset: a half-finished import is `needs_repair` with probes, never a guessed state. */
  reconcile(known_state: Readonly<Record<string, string>>): Promise<ReconcileResult>;
};

/**
 * The method names in §5.2 order.
 *
 * `satisfies` catches a name here that is not a method. It does not catch a method missing from
 * here, which is the direction that loses one silently — `spi.test.ts` closes that by reading the
 * declarations out of the source and comparing both ways.
 */
export const SPI_METHODS = [
  'snapshot_basis',
  'is_basis_stale',
  'open_sandbox',
  'inspect_sandbox',
  'close_sandbox',
  'compute_change_set',
  'render_change_set',
  'declared_checks',
  'run_checks',
  'apply_plan',
  'confirm_applied',
  'revert_or_compensate',
  'reconcile',
] as const satisfies readonly (keyof DomainAdapter)[];
