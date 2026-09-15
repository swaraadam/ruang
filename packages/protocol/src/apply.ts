/**
 * Apply authority — what a plan applies, and what an approval is bound to (§5.2.2, §5.5, §12.3).
 *
 * These shapes lived in `packages/domain` and are re-exported from there unchanged. They move here
 * because a plan identity is a *digest*, not a type: the adapter that builds a plan, the spine that
 * validates it, the row that stores the approval and the view that renders it must all compute the
 * same string, and `packages/domain` is types-only. One authoritative home (invariant 7).
 *
 * Two rules hold over everything below, both asserted against this file's source text in
 * `packages/domain/test/vocabulary.test.ts`: no substrate vocabulary (invariant 9), and no field a
 * credential or a broker handle could travel in (§5.2.2). An operation says what is touched and
 * what capability that needs; the spine invokes the broker itself.
 */
import { type Check, list, nullable, oneOf, shape, str } from './check.js';
import { DigestRefusal, digestExcluding } from './digest.js';

/** §5.1: what a plan was built against — a ref plus the inputs actually consulted. */
export type BasisInput = { readonly resource_id: string; readonly version: string };
export type Basis = {
  readonly ref: string;
  readonly inputs: readonly BasisInput[];
  readonly captured_at: string;
};

/** §13.2. `unknown` is a value, not an error: invariant 4 makes it refuse dispatch and mutation. */
export type Staleness =
  | { readonly state: 'fresh' }
  | { readonly state: 'stale'; readonly reason: string; readonly stale_inputs: readonly string[] }
  | { readonly state: 'unknown'; readonly reason: string };

/** §5.5, §12.4. Weakest to strongest; invariant 5 turns on the last one. */
export type ReversibilityClass = 'revertible' | 'compensable' | 'irreversible';

/**
 * Which direction an operation runs. A reversal used to be emitted from the same constructors as
 * the operation it reversed, so executing the reversal of a publish published again. This is the
 * structural fix: a forward operation and the operation that undoes it differ in two fields before
 * anything else about them is compared, so they can never be byte-identical.
 */
export type OperationDisposition = 'forward' | 'reversal' | 'compensation';

export type ApplyOperation = {
  readonly operation_id: string;
  /** The adapter's own verb, opaque to the core. A first-class field so that reversal never has
   *  to parse it back out of an id — the shape of defect that made an unreadable kind possible. */
  readonly operation: string;
  readonly target_ref: string;
  readonly required_capability: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly reversibility: ReversibilityClass;
  readonly disposition: OperationDisposition;
  /** The `operation_id` this undoes; `null` exactly when `disposition` is `forward`. */
  readonly undoes: string | null;
};

export type ApplyPlan = {
  readonly plan_id: string;
  readonly basis: Basis;
  /** The `ChangeSet.content_hash` this plan applies. §12.3 calls it `change_set_hash`. */
  readonly change_set_hash: string;
  readonly operations: readonly ApplyOperation[];
};

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

/**
 * §12.3: "every reversal/compensation is itself an ApplyPlan. It is validated, budgeted and
 * authorized like any other apply." So the `reversal` arm carries a whole plan, with its own basis
 * and its own hash — which is what makes it separately approvable, and what stops a forward
 * approval from covering it. `not_reversible` stays a first-class answer (invariant 5).
 */
export type ReversalPlan =
  | { readonly kind: 'reversal'; readonly plan: ApplyPlan }
  | { readonly kind: 'not_reversible'; readonly reason: string };

const BASIS_INPUT = shape({ resource_id: str, version: str });
const BASIS = shape({ ref: str, inputs: list(BASIS_INPUT), captured_at: str });
const OPERATION = shape({
  operation_id: str,
  operation: str,
  target_ref: str,
  required_capability: str,
  risk: oneOf('low', 'medium', 'high'),
  reversibility: oneOf('revertible', 'compensable', 'irreversible'),
  disposition: oneOf('forward', 'reversal', 'compensation'),
  undoes: nullable(str),
});

export const isBasisInput: Check<BasisInput> = BASIS_INPUT;
export const isBasis: Check<Basis> = BASIS;

export const isApplyOperation: Check<ApplyOperation> = (v): v is ApplyOperation =>
  OPERATION(v) && (v.disposition === 'forward') === (v.undoes === null);

const PLAN = shape({
  plan_id: str,
  basis: BASIS,
  change_set_hash: str,
  operations: list(isApplyOperation),
});

/**
 * Structure, plus the three things that make a plan hashable and answerable.
 *
 * - **At least one operation.** A plan that does nothing cannot be what an approval authorized.
 * - **At least one basis input.** `inputs: []` is not "nothing was consulted", it is "we did not
 *   record what was consulted" — and a basis with nothing in it is vacuously `fresh` forever, so
 *   the staleness gate can never fire on it. Refusing it here is invariant 4 at the boundary.
 * - **Inputs strictly ascending by `resource_id`.** Canonical order, so two captures of the same
 *   basis hash alike; and no duplicate id, because a basis naming one resource at two versions is
 *   ambiguous, and invariant 3 freezes on ambiguity rather than picking one.
 */
export const isApplyPlan: Check<ApplyPlan> = (v): v is ApplyPlan => {
  if (!PLAN(v)) return false;
  const { inputs } = v.basis;
  return (
    v.operations.length > 0 &&
    inputs.length > 0 &&
    inputs.every((x, i) => i === 0 || x.resource_id > inputs[i - 1]!.resource_id)
  );
};

export const isReversalPlan: Check<ReversalPlan> = (v): v is ReversalPlan =>
  shape({ kind: oneOf('reversal'), plan: isApplyPlan })(v) ||
  shape({ kind: oneOf('not_reversible'), reason: str })(v);

/**
 * **What `apply_plan_hash` covers, and why.**
 *
 * The hash is taken over the *whole plan*, walked recursively, minus the paths listed here. That
 * direction matters more than the list: a field added to `ApplyPlan` or `ApplyOperation` later is
 * inside the digest the day it is added, with nobody remembering to do anything. An enumerated
 * list of covered fields would have the opposite property, and every enforcement defect found on
 * 2026-09-14 was a check that enumerated what to look at and failed open on what nobody named.
 * `digestExcluding` throws on any value it cannot canonicalise and on any exclusion below that no
 * longer matches anything, so the two ways this could rot are both loud.
 *
 * **In**, because an approval for one of these is not an approval for another:
 * `basis.ref` and `basis.inputs[]` (what it was built against — a plan over a moved basis is a
 * different action); `change_set_hash` (the content applied — this is the field whose absence let
 * a one-line change and a rewrite of a policy module produce identical plans); every operation's
 * `operation`, `target_ref`, `required_capability`, `risk`, `reversibility`, `disposition` and
 * `undoes`; and the order of `operations`, because order changes the outcome.
 *
 * **Out**, each for a reason, not for convenience:
 * - `plan_id` — identity, not content. Two plans built over the same basis and the same change set
 *   *are* the same action, and an approval that could not recognise a re-planned identical action
 *   would be a single-use token bound to an ephemeral id rather than a binding to an action.
 *   Replay protection is the approval row's job (one decision, recorded, spent), not the hash's.
 * - `operations[].operation_id` — the same argument, one level down, with a sharper edge: an
 *   adapter is free to derive an operation id from the plan id, and including it would smuggle
 *   `plan_id` back into a digest that deliberately excludes it.
 * - `basis.captured_at` — when we looked, not what we saw. Freshness is a separate deterministic
 *   gate (`basisStaleness`); folding a clock in here would make every re-plan a different action
 *   and leave the binding permanently unmatchable, which is the pressure that gets a check relaxed.
 * - `project_id` / `task_id` — not on the plan at all. §12.3 passes them to the fingerprint
 *   alongside `apply_plan_hash`, so they are bound one level up; restating them here would give
 *   one fact two homes.
 */
export const APPLY_PLAN_HASH_SCHEME = 'apply_plan/1';
export const APPLY_PLAN_HASH_OUTSIDE = [
  'plan_id',
  'basis.captured_at',
  'operations[].operation_id',
] as const;

export const applyPlanHash = (plan: ApplyPlan): string => {
  if (!isApplyPlan(plan)) {
    throw new DigestRefusal('', 'the value is not a well-formed ApplyPlan (see isApplyPlan)');
  }
  return digestExcluding(APPLY_PLAN_HASH_SCHEME, plan, APPLY_PLAN_HASH_OUTSIDE);
};

/** One operation's content identity, used to prove a reversal differs from what it reverses. */
export const applyOperationHash = (operation: ApplyOperation): string =>
  digestExcluding('apply_operation/1', operation, ['operation_id']);

/**
 * §12.3 fixes these eight fields, so this one is an enumeration and cannot be anything else. It is
 * made loud instead: a key too many or too few is a refusal, not a silently narrower fingerprint.
 * It is safe as an enumeration only because `apply_plan_hash` is one of its inputs and covers the
 * plan by default — anything the plan grows is bound here without this list changing.
 */
export const ACTION_FINGERPRINT_FIELDS = [
  'operation',
  'project_id',
  'task_id',
  'basis_ref',
  'change_set_hash',
  'target_ref',
  'apply_plan_hash',
  'reversibility_class',
] as const;

export type ActionFingerprintInput = {
  readonly [K in (typeof ACTION_FINGERPRINT_FIELDS)[number]]: string;
};

export const actionFingerprint = (input: ActionFingerprintInput): string => {
  const want = [...ACTION_FINGERPRINT_FIELDS].sort().join(',');
  const got = Object.keys(input).sort().join(',');
  if (got !== want) throw new DigestRefusal('', `§12.3 names exactly [${want}]; got [${got}]`);
  return digestExcluding('action_fingerprint/1', input, []);
};

/** One operation of one plan, in one task — the unit invariant 5 calls "per-action". */
export type ApplyAction = {
  readonly project_id: string;
  readonly task_id: string;
  readonly plan: ApplyPlan;
  readonly operation_id: string;
};

/** The three columns `approval` binds on (migration v1). */
export type ApprovalBinding = {
  readonly action_fingerprint: string;
  readonly target_ref: string;
  readonly apply_plan_hash: string;
};

export const approvalBinding = (action: ApplyAction): ApprovalBinding => {
  const op = action.plan.operations.find((o) => o.operation_id === action.operation_id);
  if (op === undefined) {
    throw new DigestRefusal('', `operation '${action.operation_id}' is not in this plan`);
  }
  const apply_plan_hash = applyPlanHash(action.plan);
  return {
    action_fingerprint: actionFingerprint({
      operation: op.operation,
      project_id: action.project_id,
      task_id: action.task_id,
      basis_ref: action.plan.basis.ref,
      change_set_hash: action.plan.change_set_hash,
      target_ref: op.target_ref,
      apply_plan_hash,
      reversibility_class: op.reversibility,
    }),
    target_ref: op.target_ref,
    apply_plan_hash,
  };
};

export type BindingVerdict =
  | { readonly matches: true }
  | { readonly matches: false; readonly mismatch: keyof ApprovalBinding };

/**
 * Does a recorded approval authorize *this* action? All three columns are compared, even though
 * the fingerprint already covers the other two: they are stored separately, so a row where they
 * disagree is corrupt, and a corrupt row must refuse rather than be trusted for its opaque half.
 */
export const bindingMatches = (approved: ApprovalBinding, action: ApplyAction): BindingVerdict => {
  const actual = approvalBinding(action);
  const field = (['action_fingerprint', 'target_ref', 'apply_plan_hash'] as const).find(
    (k) => approved[k] !== actual[k],
  );
  return field === undefined ? { matches: true } : { matches: false, mismatch: field };
};

/** §5.5 read as a function: what undoing an operation of each class actually *is*. */
export const UNDO_DISPOSITION: Readonly<Record<ReversibilityClass, OperationDisposition | null>> = {
  revertible: 'reversal',
  compensable: 'compensation',
  irreversible: null,
};

export type ReversalVerdict =
  { readonly sound: true } | { readonly sound: false; readonly defect: string };

/**
 * The claim "undoing a `compensable` operation needs a new forward action", checked rather than
 * asserted in a comment. A reversal plan is sound when every operation in it names an applied
 * operation it undoes, undoes it in the way that operation's class allows, and is not the same
 * operation coming back.
 */
export const checkReversalPlan = (
  applied: readonly ApplyOperation[],
  reversal: ReversalPlan,
): ReversalVerdict => {
  if (reversal.kind === 'not_reversible') return { sound: true };
  const byId = new Map(applied.map((o) => [o.operation_id, o]));
  for (const op of reversal.plan.operations) {
    const undone = op.undoes === null ? undefined : byId.get(op.undoes);
    if (op.disposition === 'forward') {
      return { sound: false, defect: `'${op.operation_id}' is forward, inside a reversal plan` };
    }
    if (undone === undefined) {
      return { sound: false, defect: `'${op.operation_id}' undoes something that was not applied` };
    }
    const allowed = UNDO_DISPOSITION[undone.reversibility];
    if (allowed !== op.disposition) {
      return {
        sound: false,
        defect: `undoing a ${undone.reversibility} operation is ${allowed ?? 'not possible'}, not ${op.disposition}`,
      };
    }
    if (applyOperationHash(op) === applyOperationHash(undone)) {
      return {
        sound: false,
        defect: `'${op.operation_id}' is identical to what it claims to undo`,
      };
    }
  }
  return { sound: true };
};

/**
 * The deterministic freshness gate the basis exists for. Every exit that is not `fresh` refuses
 * mutation; an input we cannot see a current version of is `unknown`, never assumed unchanged.
 */
export const basisStaleness = (planned: Basis, observed: readonly BasisInput[]): Staleness => {
  if (planned.inputs.length === 0) {
    return { state: 'unknown', reason: 'the basis records no consulted inputs' };
  }
  const now = new Map<string, string>();
  for (const x of observed) {
    if (now.has(x.resource_id)) {
      return { state: 'unknown', reason: `'${x.resource_id}' was observed at two versions` };
    }
    now.set(x.resource_id, x.version);
  }
  const unseen = planned.inputs.filter((x) => !now.has(x.resource_id)).map((x) => x.resource_id);
  if (unseen.length > 0) {
    return { state: 'unknown', reason: `no current version for ${unseen.join(', ')}` };
  }
  const stale_inputs = planned.inputs
    .filter((x) => now.get(x.resource_id) !== x.version)
    .map((x) => x.resource_id);
  return stale_inputs.length > 0
    ? { state: 'stale', reason: `${stale_inputs.length} consulted input(s) moved`, stale_inputs }
    : { state: 'fresh' };
};

/**
 * Identity of this vocabulary, pinned against `PROTOCOL_VERSION` the way the anchor and renderable
 * fingerprints are. A field added to a plan or an operation changes it, which forces a version
 * decision — and a path quietly added to the exclusion list changes it too, which is the edit that
 * would otherwise widen what an approval covers without anything noticing.
 */
export const APPLY_FINGERPRINT = [
  `basis(${(BASIS.fields ?? []).join(',')})`,
  `operation(${(OPERATION.fields ?? []).join(',')})`,
  `plan(${(PLAN.fields ?? []).join(',')})`,
  `outside(${APPLY_PLAN_HASH_OUTSIDE.join(',')})`,
  `fingerprint(${ACTION_FINGERPRINT_FIELDS.join(',')})`,
].join(';');
