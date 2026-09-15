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

import type { Basis } from '@internal/protocol';

export type ProjectId = string;
export type ResourceId = string;

/**
 * The apply-authority half of this vocabulary now lives in `@internal/protocol` and is re-exported
 * here unchanged, so the SPI signatures below read the same as they always did.
 *
 * It moved because a plan's identity is a digest, not a type (P0-20, issue #89): the adapter that
 * builds a plan, the spine that validates it, the row that stores the approval and the view that
 * renders it must all compute one string, and this package holds no implementation. The shapes,
 * their validators and `apply_plan_hash` therefore sit together in one file — invariant 7 — and
 * `packages/protocol/src/apply.ts` carries the rules and the reasoning that used to sit here.
 */
export type {
  ApplyOperation,
  ApplyPlan,
  ApplyResult,
  Basis,
  BrokerOutcome,
  OperationDisposition,
  ReversalPlan,
  ReversibilityClass,
  Staleness,
} from '@internal/protocol';

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
