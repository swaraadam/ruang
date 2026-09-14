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
  /**
   * Leave work inside a sandbox that a *textual* change record cannot carry: a resource the source
   * of record has never seen, and bytes that are not text. Returns what must still be recoverable
   * afterwards.
   *
   * Stated in domain terms rather than substrate ones deliberately. For the code adapter these are
   * an untracked file and a binary blob; for a binary-asset adapter they are most of the workspace.
   * An adapter whose change records carry every byte may return an empty list, and the contract
   * then asserts nothing -- but it may not claim retention it does not perform.
   */
  leaveUnrecordableWork(sandbox: Sandbox): readonly UnrecordableResource[];
  /**
   * Place a *reference* to content held outside the sandbox inside the sandbox, and return what it
   * points at. Those bytes were never the sandbox's own work, so a teardown record may name the
   * reference and must never resolve it — otherwise sandbox content, which is agent output and
   * project content, decides what a privileged read copies into durable evidence.
   *
   * An adapter whose domain has no notion of a reference returns an empty list and the contract
   * asserts nothing of it.
   */
  leaveReferenceToOutsideWork(sandbox: Sandbox): readonly OutsideReference[];
  /**
   * A sandbox this adapter never issued, whose id is shaped to reach outside wherever the adapter
   * keeps sandboxes, together with content that must be untouched afterwards. Every adapter derives
   * *some* location from a sandbox id, and teardown is destructive at the end of that derivation.
   */
  forgedSandbox(): { readonly sandbox: Sandbox; readonly untouchable: readonly string[] };
  /** A basis this adapter cannot resolve — the input for the `unknown` path. */
  unresolvableBasis(): Basis;
  /** Every path whose bytes must not change when a query is called. */
  observablePaths(sandbox: Sandbox): readonly string[];
  tearDown(): void;
};

/** Content that must survive a forced teardown, identified by its bytes rather than its location. */
export type UnrecordableResource = {
  /** For test output only. The assertion is on bytes; where the adapter puts them is its business. */
  readonly label: string;
  readonly bytes: Uint8Array;
};

/** A reference inside a sandbox to content stored elsewhere, and the bytes it names. */
export type OutsideReference = {
  /** For test output only. */
  readonly label: string;
  /** How the reference is identified inside the sandbox; a teardown record has to name it. */
  readonly resource_id: ResourceId;
  /** The bytes it points at. They were never the sandbox's own, so they must not be retained. */
  readonly referent: Uint8Array;
};

export type ContractHarness = {
  readonly name: string;
  setUp(): Promise<ContractSubject>;
};
