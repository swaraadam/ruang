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

export type ContractSubject = {
  readonly adapter: DomainAdapter;
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
