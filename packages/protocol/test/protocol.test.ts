import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type DurableEvent,
  type DurableEventType,
  type EventEnvelope,
  DURABLE_EVENT_TYPES,
  PAYLOAD_VALIDATORS,
  PROTOCOL_VERSION,
  VOCABULARY_FINGERPRINT,
  assertNever,
  isDurableEvent,
} from '../src/index.js';
import { type EphemeralMessage, EPHEMERAL_CHANNELS } from '../src/ephemeral.js';

/**
 * Acceptance 1. Stands in for a renderer or a replay dispatcher: every durable type must be
 * handled and `assertNever` makes the compiler enforce it. Add a case to the closed union
 * without adding it here and this file stops compiling (TS2345 on `event`).
 */
const subjectOf = (event: DurableEvent): string => {
  switch (event.type) {
    case 'project.registered':
    case 'project.claimed':
    case 'project.claim_released':
    case 'project.claim_expired':
      return 'project';
    case 'task.created':
    case 'task.basis.captured':
    case 'task.stale':
    case 'task.dispatched':
    case 'task.completed':
    case 'task.cancelled':
      return 'task';
    case 'attempt.started':
    case 'attempt.completed':
    case 'attempt.failed':
      return 'attempt';
    case 'sandbox.opened':
    case 'sandbox.closed':
      return 'sandbox';
    case 'lock.acquired':
    case 'lock.released':
      return 'lock';
    case 'agent.needs_input':
    case 'agent.session.id_captured':
    case 'session.reattached':
    case 'session.resumed':
      return 'session';
    case 'steer.requested':
    case 'steer.acknowledged':
    case 'steer.failed':
    case 'steer.unresolved':
      return 'steer';
    case 'review.thread.created':
    case 'review.comment.added':
    case 'review.feedback.delivered':
    case 'review.waiver_recorded':
      return 'review';
    case 'evidence.ready':
      return 'evidence';
    case 'approval.requested':
    case 'approval.decided':
      return 'approval';
    case 'apply.started':
    case 'apply.completed':
    case 'apply.failed':
    case 'apply.reversed':
    case 'apply.compensated':
      return 'apply';
    case 'repair.requested':
    case 'repair.resolved':
    case 'repair.lock_released':
    case 'state.needs_repair':
      return 'repair';
    case 'notification.queued':
    case 'notification.delivered':
    case 'notification.delivery_failed':
    case 'notification.opened':
      return 'notification';
    case 'budget.threshold':
    case 'budget.pause':
      return 'budget';
    case 'preview.started':
    case 'preview.healthy':
    case 'preview.failed':
    case 'preview.stopped':
      return 'preview';
    case 'artifact.created':
      return 'artifact';
    case 'adapter.divergence':
      return 'adapter';
    default:
      return assertNever(event);
  }
};

const completed: EventEnvelope<'task.completed'> = {
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  type: 'task.completed',
  owner_id: 'owner-1',
  org_node_id: 'studio/engineering',
  task_id: 'task-1',
  actor: { member_id: 'member-1', role_id: 'role-1', runtime_id: null },
  payload: { task_id: 'task-1', outcome: 'applied' },
  artifact_refs: ['sha256:abc'],
};

const stub = (type: DurableEventType): DurableEvent =>
  ({ ...completed, type, payload: {} }) as unknown as DurableEvent;

describe('durable event vocabulary', () => {
  it('is the whole of Appendix A.1 and every type has a validator', () => {
    expect(DURABLE_EVENT_TYPES).toHaveLength(53);
    expect(Object.keys(PAYLOAD_VALIDATORS)).toEqual([...DURABLE_EVENT_TYPES]);
  });

  it('is exhaustively switchable — no type falls through to assertNever', () => {
    expect(DURABLE_EVENT_TYPES.filter((type) => subjectOf(stub(type)) === '')).toEqual([]);
  });

  it('validates a well-formed envelope and its own payload', () => {
    expect(isDurableEvent(completed)).toBe(true);
  });

  it('fails closed on a missing identity column (invariant 8)', () => {
    expect(isDurableEvent({ ...completed, owner_id: undefined })).toBe(false);
    expect(isDurableEvent({ ...completed, org_node_id: undefined })).toBe(false);
  });

  it("carries the scope column as project_id, not A.3's workspace_id (erratum, ADR-0004)", () => {
    expect(isDurableEvent({ ...completed, project_id: 'project-1' })).toBe(true);
    expect(isDurableEvent({ ...completed, project_id: 5 })).toBe(false); // it really is validated
    // The old spelling is not merely unused, it is not assignable. If this stops erroring the
    // rename has been undone somewhere. @ts-expect-error is itself an error when nothing errors.
    // @ts-expect-error `workspace_id` is not a field of EventEnvelope (CLAUDE.md section 1).
    const old: EventEnvelope<'task.completed'> = { ...completed, workspace_id: 'workspace-1' };
    expect(old.project_id).toBeUndefined();
  });

  it('fails closed on a payload that does not match its own type', () => {
    expect(isDurableEvent({ ...completed, payload: { task_id: 't', outcome: 'landed' } })).toBe(
      false,
    );
    expect(isDurableEvent({ ...completed, type: 'not.a.type' })).toBe(false);
  });
});

/**
 * Acceptance 2. `PersistDurableEvent` is the shape packages/persistence will expose. Nothing in
 * ../src/ephemeral.js can satisfy it, and nothing durable can be sent down an ephemeral channel.
 */
type PersistDurableEvent = (event: DurableEvent) => number;
type SendEphemeral = (message: EphemeralMessage) => void;
type DurableIsEphemeral = DurableEvent extends EphemeralMessage ? true : false;
type EphemeralIsDurable = EphemeralMessage extends DurableEvent ? true : false;

describe('ephemeral channels are unpersistable by type (invariant 2)', () => {
  const persist: PersistDurableEvent = (event) => event.seq;
  const send: SendEphemeral = () => undefined;

  it('rejects an ephemeral frame at the persistence signature', () => {
    const message: EphemeralMessage = {
      channel: 'pty.binary',
      session_id: 'session-1',
      at_ms: 1,
      body: { bytes: new Uint8Array([7]) },
    };
    // @ts-expect-error invariant 2: an ephemeral frame carries no seq, no identity columns and
    // forbids the `type` discriminant, so it cannot reach a durable persistence signature.
    persist(message);
    // @ts-expect-error and the firewall holds in the other direction too.
    send(completed);
    expect(EPHEMERAL_CHANNELS).toHaveLength(6);
  });

  it('shares no assignable base type in either direction', () => {
    const overlap: [DurableIsEphemeral, EphemeralIsDurable] = [false, false];
    expect(overlap).toEqual([false, false]);
  });
});

/**
 * Acceptance 4. The fingerprint covers every type name and every payload field name. Adding,
 * removing or renaming any of them changes it, and the only way back to green is a new
 * PROTOCOL_VERSION with its own pinned entry below.
 */
const PINNED_FINGERPRINTS: Readonly<Record<number, string>> = {
  1: 'aaeedb35ed4b5a471110ec3a05b45c107637815aa79ffde3c478e996a88ab399',
};

describe('PROTOCOL_VERSION', () => {
  it('is pinned to the exact vocabulary it describes', () => {
    const actual = createHash('sha256').update(VOCABULARY_FINGERPRINT).digest('hex');
    expect(PINNED_FINGERPRINTS[PROTOCOL_VERSION]).toBe(actual);
  });
});
