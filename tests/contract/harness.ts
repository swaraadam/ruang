/**
 * The shape a domain adapter presents to the shared contract suite.
 *
 * The suite is written once against the SPI and parameterized by adapter (contract-testing SKILL).
 * Everything an assertion needs that only the adapter's own domain can arrange — change a resource
 * the brief consulted, leave unsaved work in a sandbox, hand back a basis that cannot be resolved —
 * is asked for here in core vocabulary. No assertion in the suite may reach past this type; that is
 * what stops the suite quietly becoming a test of one substrate.
 */
import type { Basis, DomainAdapter, ProjectId, ResourceId, Sandbox } from '@internal/domain';

/**
 * The methods this suite exercises today, named as a subset of the contract rather than as a
 * contract of their own. `packages/domain/src/spi.ts` is unchanged and still declares all thirteen;
 * `Pick` keeps every signature the SPI's own, so what is narrower here is what has been built.
 * Teardown and apply are issue #108, and restoring them here is a `Pick` list plus assertions.
 */
export type ContractSurface = Pick<
  DomainAdapter,
  | 'snapshot_basis'
  | 'is_basis_stale'
  | 'open_sandbox'
  | 'inspect_sandbox'
  | 'compute_change_set'
  | 'render_change_set'
  | 'declared_checks'
  | 'run_checks'
>;

export type ContractSubject = {
  readonly adapter: ContractSurface;
  readonly project: ProjectId;
  /** The resources the brief actually consulted, and so the only ones fingerprinted. */
  readonly consulted: readonly ResourceId[];
  /** Ids the subject declares: one that passes, one that passes only on a retry, one undeclared. */
  readonly checks: {
    readonly passing: string;
    readonly flaky: string;
    readonly undeclared: string;
  };
  /** Change a resource the brief consulted. */
  changeConsulted(): void;
  /** Change a resource the brief never consulted. */
  changeUnconsulted(): void;
  /** Leave unsaved work inside a sandbox. */
  leaveUnsavedWork(sandbox: Sandbox): void;
  /**
   * A sandbox this adapter never issued, whose id is shaped to reach outside wherever the adapter
   * keeps sandboxes, together with content that must be untouched afterwards. Every adapter derives
   * *some* location from a sandbox id, and a query at the end of that derivation is the cheapest
   * place to prove the derivation is guarded — before teardown (#108) makes it destructive.
   */
  forgedSandbox(): { readonly sandbox: Sandbox; readonly untouchable: readonly string[] };
  /** A basis this adapter cannot resolve — the input for the `unknown` path. */
  unresolvableBasis(): Basis;
  /** Every path whose bytes must not change when a query is called. */
  observablePaths(sandbox: Sandbox): readonly string[];
  tearDown(): void;
};

export type ContractHarness = {
  readonly name: string;
  setUp(): Promise<ContractSubject>;
};
