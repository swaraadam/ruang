/**
 * Seam A vocabulary — the shapes the spine passes across the domain contract, blueprint §5.2.
 *
 * Part 1 of P0-04, split from the `DomainAdapter` interface itself to stay inside the §10 budget.
 * Types only; no implementation lives here and none should.
 *
 * Two rules hold over every type below, and `vocabulary.test.ts` asserts both against the source
 * text rather than in prose:
 *
 * - **No substrate vocabulary** (invariant 9). Not in a type, a field, a doc comment or a string —
 *   naming it even to forbid it puts the word in this package. `basis.ref` is a ref; `Sandbox` is
 *   a sandbox; how either is realised belongs to the adapter.
 * - **Nothing a credential could travel in** (§5.2.2). Adapters never receive broker handles: an
 *   adapter returns declarative operations and the spine invokes the broker itself.
 */

export type ProjectId = string;
export type ResourceId = string;

/** What a plan was made against. §5.1: a ref plus the inputs actually consulted. */
export type Basis = {
  readonly ref: string;
  readonly inputs: readonly { readonly resource_id: ResourceId; readonly version: string }[];
  readonly captured_at: string;
};

/**
 * §13.2, staleness without false invalidation. `unknown` is a real answer rather than an error —
 * invariant 4 makes it refuse dispatch and refuse mutation, so it has to be representable.
 */
export type Staleness =
  | { readonly state: 'fresh' }
  | {
      readonly state: 'stale';
      readonly reason: string;
      readonly stale_inputs: readonly ResourceId[];
    }
  | { readonly state: 'unknown'; readonly reason: string };

/** §10.1. `Sandbox` is the core term; what backs it is the adapter's business. */
export type Sandbox = {
  readonly sandbox_id: string;
  readonly project_id: ProjectId;
  readonly basis: Basis;
};

/** §5.2.3. Non-mutating, callable at any time, and read before a close is even considered. */
export type SandboxInspection = {
  readonly dirty: boolean;
  readonly unsaved_summary: string;
  readonly retained_artifacts: readonly string[];
  readonly safe_to_close: boolean;
};

/** §10.4. What teardown actually did, so a lost sandbox is never silently assumed clean. */
export type SafetyRecord = {
  readonly sandbox_id: string;
  readonly closed: boolean;
  readonly retained_artifacts: readonly string[];
  readonly refused_reason: string | null;
};

/** §16.1. Declared per project; `required` is what gates review-readiness. */
export type CheckSpec = {
  readonly check_id: string;
  readonly required: boolean;
  readonly timeout_s: number;
  readonly flake_policy: 'mark' | 'fail';
};

export type CheckResult = {
  readonly check_id: string;
  readonly result: 'passed' | 'failed' | 'skipped' | 'flaky';
  readonly artifact_ref: string | null;
};

/** §5.5, §12.4. Weakest to strongest; invariant 5 turns on the last one. */
export type ReversibilityClass = 'revertible' | 'compensable' | 'irreversible';

/**
 * §5.2.2, and the reason this package can be handed to an adapter safely.
 *
 * Declarative only: `target_ref` names what is touched and `required_capability` what the spine
 * must hold to touch it. No handle, no token, no command line — an operation describes an intent
 * the spine then validates against role, basis, approval fingerprint and budget.
 */
export type ApplyOperation = {
  readonly operation_id: string;
  readonly target_ref: string;
  readonly required_capability: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly reversibility: ReversibilityClass;
};

export type ApplyPlan = {
  readonly plan_id: string;
  readonly basis: Basis;
  readonly operations: readonly ApplyOperation[];
};

/** What the spine observed executing one operation, handed back for the adapter to reconcile. */
export type BrokerOutcome = {
  readonly operation_id: string;
  readonly succeeded: boolean;
  readonly detail: string;
};

export type ApplyResult = {
  readonly plan_id: string;
  readonly outcomes: readonly BrokerOutcome[];
  readonly applied: boolean;
};

/** `not_reversible` is a first-class answer: invariant 5 would rather freeze than improvise. */
export type ReversalPlan =
  | { readonly kind: 'reversal'; readonly operations: readonly ApplyOperation[] }
  | { readonly kind: 'not_reversible'; readonly reason: string };

/** §14.4. `needs_repair` carries probes, because ambiguity is resolved by looking, not guessing. */
export type ReconcileResult =
  | { readonly kind: 'converged'; readonly state: Readonly<Record<string, string>> }
  | { readonly kind: 'needs_repair'; readonly probes: readonly string[] };

export type ClosePolicy = { readonly force: boolean; readonly retain_artifacts: boolean };

export type ApplyPolicy = {
  readonly change_budget: number;
  readonly max_risk: 'low' | 'medium' | 'high';
};

export type RenderSurface = 'review' | 'mobile' | 'office';
