/**
 * Durable control-plane vocabulary — blueprint Appendix A.1 and A.3, all 53 types.
 *
 * Durable means: written to SQLite with a monotonic `seq`, replayable, and sufficient to
 * reconstruct any view from a snapshot (invariant 1). Anything that cannot meet that bar is an
 * ephemeral channel and lives in ./ephemeral.ts, which shares no type with this module.
 */
import { CHANGE_ANCHOR_KINDS } from './anchor.js';
import {
  type Check,
  bool,
  int,
  isRecord,
  list,
  nullable,
  num,
  oneOf,
  shape,
  str,
} from './check.js';

/** Bump on any change to the closed unions below. See the fingerprint test. */
export const PROTOCOL_VERSION = 1;

const staleness = oneOf('fresh', 'stale', 'unknown');
const reversibility = oneOf('revertible', 'compensable', 'irreversible');
const profile = oneOf('strong', 'partial', 'manual-required');
const scopeKind = oneOf('owner', 'org_node', 'project', 'task', 'run');
const subject = {
  subject_kind: oneOf('project', 'task', 'attempt', 'lock', 'apply'),
  subject_id: str,
};
const basisInput = shape({ resource_id: str, version: str });
/**
 * The anchor vocabulary has one authoritative home (invariant 7): `anchor.ts`. This spelled the
 * same four kinds out again, so a fifth kind added there would have left `review.thread.created`
 * silently accepting a narrower set. `anchor.test.ts` pins the two together.
 */
const anchor = shape({
  kind: oneOf(...CHANGE_ANCHOR_KINDS),
  locator: str,
});
const checkResult = shape({
  check_id: str,
  required: bool,
  result: oneOf('passed', 'failed', 'skipped', 'flaky'),
  artifact_ref: nullable(str),
});

/**
 * The closed catalog: one payload validator per durable type, in Appendix A.1 order.
 *
 * **The payload field sets are provisional.** Appendix A.1 specifies 53 event *names* and no
 * payload schemas. Every field set below is derived — from §14.1 (entities), §5.1 (basis), §12.3
 * (action fingerprint), §15.3 (steer states) and §16.1 (evidence) — and derived is not specified.
 * A green suite proves these shapes are self-consistent, never that they are right.
 *
 * They therefore remain revisable **without a major version bump** until P0-13 and the first real
 * binary-asset workflow have exercised them against something other than this file's own tests.
 * `PROTOCOL_VERSION` still pins the vocabulary (see VOCABULARY_FINGERPRINT); what is deferred is
 * the promise that a field set is final, not the discipline of versioning a change to it.
 *
 * Derivation source per group and the three deliberate divergences from Appendix A:
 * docs/adr/0004-protocol-event-vocabulary.md.
 */
const PAYLOADS = {
  'project.registered': shape({
    project_id: str,
    domain: str,
    adapter_binding: str,
    source_of_record: str,
    change_unit: oneOf('lines', 'files', 'assets', 'megabytes'),
    change_budget: int,
    evidence_floor: profile,
  }),
  'task.created': shape({
    task_id: str,
    project_id: str,
    role_id: str,
    title: str,
    execution_class: oneOf('mechanical', 'standard', 'deep'),
    expected_reversibility: reversibility,
  }),
  'task.basis.captured': shape({
    task_id: str,
    basis_ref: str,
    inputs: list(basisInput),
    captured_at: str,
  }),
  'task.stale': shape({
    task_id: str,
    basis_ref: str,
    staleness,
    reason: nullable(str),
    stale_inputs: list(str),
  }),
  'task.dispatched': shape({ task_id: str, attempt_id: str, runtime_id: str, basis_ref: str }),
  'attempt.started': shape({
    attempt_id: str,
    task_id: str,
    runtime_id: str,
    sandbox_id: nullable(str),
  }),
  'attempt.completed': shape({
    attempt_id: str,
    task_id: str,
    change_set_id: nullable(str),
    units_changed: int,
  }),
  'attempt.failed': shape({ attempt_id: str, task_id: str, reason: str, retryable: bool }),
  'sandbox.opened': shape({
    sandbox_id: str,
    task_id: str,
    attempt_id: str,
    adapter_id: str,
    kind: str,
  }),
  'sandbox.closed': shape({
    sandbox_id: str,
    safety_record_ref: str,
    was_dirty: bool,
    retained_artifacts: list(str),
  }),
  'lock.acquired': shape({ lock_id: str, lock_name: str, holder_task_id: str, acquired_at: str }),
  'lock.released': shape({
    lock_id: str,
    lock_name: str,
    release_reason: oneOf('completed', 'expired', 'repair'),
  }),
  'agent.needs_input': shape({
    task_id: str,
    attempt_id: str,
    prompt: str,
    detected_by: oneOf('runtime-event', 'terminal-bell', 'prompt-heuristic'),
  }),
  'steer.requested': shape({ steer_id: str, task_id: str, attempt_id: str, intent: str }),
  'steer.acknowledged': shape({ steer_id: str, task_id: str, acknowledged_at: str }),
  'steer.failed': shape({ steer_id: str, task_id: str, reason: str, delivery_attempts: int }),
  'steer.unresolved': shape({
    steer_id: str,
    task_id: str,
    delivery_attempts: int,
    blocks_further_steering: bool,
  }),
  'review.thread.created': shape({ thread_id: str, task_id: str, attempt_id: str, anchor }),
  'review.comment.added': shape({
    thread_id: str,
    comment_id: str,
    author_member_id: str,
    body: str,
  }),
  'review.feedback.delivered': shape({
    thread_id: str,
    task_id: str,
    next_attempt_id: str,
    artifact_ref: str,
  }),
  'evidence.ready': shape({
    task_id: str,
    attempt_id: str,
    profile,
    review_ready: bool,
    results: list(checkResult),
  }),
  'approval.requested': shape({
    approval_id: str,
    task_id: str,
    action_fingerprint: str,
    risk_tier: oneOf('low', 'medium', 'high'),
    reversibility,
    reversal_plan_ref: nullable(str),
  }),
  'approval.decided': shape({
    approval_id: str,
    task_id: str,
    decision: oneOf('approved', 'declined'),
    verification: oneOf('none', 'session', 'fresh-per-action'),
    decided_by_member_id: str,
  }),
  'apply.started': shape({
    apply_id: str,
    task_id: str,
    change_set_id: str,
    apply_plan_hash: str,
    action_fingerprint: str,
  }),
  'apply.completed': shape({ apply_id: str, task_id: str, target_ref: str, resulting_ref: str }),
  'apply.failed': shape({ apply_id: str, task_id: str, reason: str, partial_effect: bool }),
  'repair.requested': shape({ repair_id: str, ...subject, probes: list(str) }),
  'repair.resolved': shape({
    repair_id: str,
    resolution: oneOf('reprobe', 'adopt', 'reset', 'lock-released', 'adapter-specific'),
    resolved_by_member_id: str,
  }),
  'state.needs_repair': shape({
    ...subject,
    reason: str,
    frozen_lock_ids: list(str),
    allowed_operations: list(str),
  }),
  'task.completed': shape({ task_id: str, outcome: oneOf('applied', 'discarded', 'superseded') }),
  'task.cancelled': shape({ task_id: str, reason: str, cancelled_by_member_id: str }),
  'agent.session.id_captured': shape({
    attempt_id: str,
    runtime_session_id: str,
    capture_method: oneOf('native-api', 'status-parse', 'operator-confirmed'),
    captured_at: str,
  }),
  'session.reattached': shape({ attempt_id: str, host_session_ref: str, last_verified_at: str }),
  'session.resumed': shape({ attempt_id: str, runtime_session_id: str, resumed_at: str }),
  'notification.queued': shape({
    notification_id: str,
    channel_id: str,
    ...subject,
    attention_item_id: str,
  }),
  'notification.delivered': shape({ notification_id: str, channel_id: str, confirmed_at: str }),
  'notification.delivery_failed': shape({
    notification_id: str,
    channel_id: str,
    reason: str,
    will_retry: bool,
  }),
  'notification.opened': shape({ notification_id: str, channel_id: str, opened_at: str }),
  'budget.threshold': shape({
    scope_kind: scopeKind,
    scope_id: str,
    window: str,
    consumed: num,
    ceiling: num,
  }),
  'budget.pause': shape({
    scope_kind: scopeKind,
    scope_id: str,
    drained_task_ids: list(str),
    interrupted_task_ids: list(str),
  }),
  'preview.started': shape({
    preview_id: str,
    project_id: str,
    task_id: str,
    port: int,
    canonical_route: str,
  }),
  'preview.healthy': shape({ preview_id: str, checked_at: str }),
  'preview.failed': shape({ preview_id: str, reason: str }),
  'preview.stopped': shape({
    preview_id: str,
    reason: oneOf('task-completed', 'owner-requested', 'host-restart', 'unhealthy'),
  }),
  'project.claimed': shape({
    project_id: str,
    claim_id: str,
    claimant_member_id: str,
    lease_expires_at: str,
  }),
  'project.claim_released': shape({ project_id: str, claim_id: str, released_by_member_id: str }),
  'project.claim_expired': shape({ project_id: str, claim_id: str, expired_at: str }),
  'artifact.created': shape({
    artifact_id: str,
    kind: str,
    sha256: str,
    byte_size: int,
    retention_class: oneOf('transient', 'task-evidence', 'milestone', 'build-cache'),
  }),
  'adapter.divergence': shape({
    adapter_id: str,
    project_id: str,
    expected: str,
    observed: str,
    reconciliation: oneOf('converged', 'needs_repair'),
  }),
  'apply.reversed': shape({ apply_id: str, task_id: str, reversal_apply_id: str, target_ref: str }),
  'apply.compensated': shape({
    apply_id: str,
    task_id: str,
    compensation_apply_id: str,
    residual_effect: str,
  }),
  'repair.lock_released': shape({
    repair_id: str,
    lock_id: str,
    lock_name: str,
    released_by_member_id: str,
  }),
  'review.waiver_recorded': shape({
    thread_id: nullable(str),
    task_id: str,
    check_id: str,
    reason: str,
    waived_by_member_id: str,
  }),
};

/**
 * Who caused the event. `runtime_id` names the Seam D runtime, never a vendor (§4).
 *
 * Appendix A.3 calls this field `provider`. It predates the Seam D decision in §25.1, and naming a
 * vendor in the envelope re-imports the substitution assumption that seam exists to prevent. Kept
 * as a deliberate divergence — docs/adr/0004-protocol-event-vocabulary.md.
 */
export type Actor = {
  readonly member_id: string;
  readonly role_id: string | null;
  readonly runtime_id: string | null;
};

type PayloadFor<C> = C extends Check<infer P> ? P : never;
export type DurableEventType = keyof typeof PAYLOADS;
export type PayloadOf<T extends DurableEventType> = PayloadFor<(typeof PAYLOADS)[T]>;

/**
 * Blueprint A.3. `owner_id` and `org_node_id` are non-optional from migration v1 (invariant 8,
 * §14.2): a single-owner deployment still routes through the same capability lookup, so every
 * event carries the columns that lookup needs.
 *
 * `project_id` is spelled `workspace_id` in Appendix A.3. That is an erratum, not a divergence in
 * intent: §3 makes `Project` the core entity and CLAUDE.md §1 reserves "workspace" for UI copy, so
 * A.3's field name contradicts the vocabulary the same blueprint mandates. Recorded in
 * docs/adr/0004-protocol-event-vocabulary.md; the field is otherwise unchanged in meaning.
 */
export type EventEnvelope<T extends DurableEventType = DurableEventType> = {
  readonly seq: number;
  readonly ts: string;
  readonly type: T;
  readonly owner_id: string;
  readonly org_node_id: string;
  readonly project_id?: string;
  readonly task_id?: string;
  readonly attempt_id?: string;
  readonly actor: Actor;
  readonly payload: PayloadOf<T>;
  readonly artifact_refs: readonly string[];
};

/** The closed union: discriminated on `type`, one payload per case. */
export type DurableEvent = { [K in DurableEventType]: EventEnvelope<K> }[DurableEventType];

export const DURABLE_EVENT_TYPES = Object.keys(PAYLOADS) as readonly DurableEventType[];

export const PAYLOAD_VALIDATORS: { readonly [K in DurableEventType]: Check<PayloadOf<K>> } =
  PAYLOADS;

/**
 * Identity of the closed vocabulary: every type name with its payload field names. Adding,
 * removing or renaming anything changes this string, which is what pins PROTOCOL_VERSION.
 */
export const VOCABULARY_FINGERPRINT = DURABLE_EVENT_TYPES.map(
  (t) => `${t}(${(PAYLOAD_VALIDATORS[t].fields ?? []).join(',')})`,
).join(';');

const optionalId = (v: unknown): boolean => v === undefined || str(v);
const isActor = shape({ member_id: str, role_id: nullable(str), runtime_id: nullable(str) });

/** Boundary validator for a whole envelope, payload included. The gateway calls this. */
export const isDurableEvent = (value: unknown): value is DurableEvent => {
  if (!isRecord(value)) return false;
  const type = value['type'];
  if (typeof type !== 'string' || !Object.hasOwn(PAYLOADS, type)) return false;
  const payload: (v: unknown) => boolean = PAYLOAD_VALIDATORS[type as DurableEventType];
  return (
    int(value['seq']) &&
    (value['seq'] as number) >= 0 &&
    str(value['ts']) &&
    str(value['owner_id']) &&
    str(value['org_node_id']) &&
    optionalId(value['project_id']) &&
    optionalId(value['task_id']) &&
    optionalId(value['attempt_id']) &&
    isActor(value['actor']) &&
    list(str)(value['artifact_refs']) &&
    payload(value['payload'])
  );
};

/** Narrow to a single case: `isDurableEventOf('apply.completed')(value)`. */
export const isDurableEventOf =
  <T extends DurableEventType>(type: T) =>
  (value: unknown): value is EventEnvelope<T> =>
    isDurableEvent(value) && value.type === type;

/** Exhaustiveness guard for a switch over the closed union. */
export const assertNever = (value: never): never => {
  throw new Error(`unhandled durable event: ${JSON.stringify(value)}`);
};
