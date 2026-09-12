import { describe, expect, it } from 'vitest';
import {
  ANCHOR_FINGERPRINT,
  CHANGE_ANCHOR_KINDS,
  PROTOCOL_VERSION,
  isAnchor,
  isDurableEvent,
} from '../src/index.js';

/** A `review.thread.created` envelope carrying a given anchor, for the invariant-7 pin below. */
const threadCreated = (anchor: unknown) => ({
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  type: 'review.thread.created',
  owner_id: 'owner-1',
  org_node_id: 'studio/engineering',
  actor: { member_id: 'member-1', role_id: null, runtime_id: null },
  payload: { thread_id: 't-1', task_id: 'task-1', attempt_id: 'a-1', anchor },
  artifact_refs: [],
});

describe('the anchor union is closed', () => {
  it('is exactly the four domain-neutral kinds from §16.4', () => {
    expect([...CHANGE_ANCHOR_KINDS].sort()).toEqual([
      'asset_id',
      'node_path',
      'region',
      'text_range',
    ]);
  });

  it('accepts one well-formed value of every kind', () => {
    expect(isAnchor({ kind: 'text_range', resource_id: 'src/a', start_line: 1, end_line: 9 })).toBe(
      true,
    );
    expect(isAnchor({ kind: 'asset_id', asset_id: 'asset-1' })).toBe(true);
    expect(isAnchor({ kind: 'node_path', resource_id: 'scene/main', path: '/root/camera' })).toBe(
      true,
    );
    expect(
      isAnchor({ kind: 'region', asset_id: 'asset-1', x: 0, y: 0, width: 64, height: 64 }),
    ).toBe(true);
  });

  it('refuses a kind that is not in the union, however well-formed the rest is', () => {
    expect(
      isAnchor({ kind: 'byte_offset', resource_id: 'src/a', start_line: 1, end_line: 9 }),
    ).toBe(false);
  });

  it('refuses a known kind carrying another kind’s payload', () => {
    // The discriminant alone is not enough: each case validates its own fields.
    expect(isAnchor({ kind: 'region', resource_id: 'scene/main', path: '/root' })).toBe(false);
    expect(isAnchor({ kind: 'text_range', asset_id: 'asset-1' })).toBe(false);
  });

  it('refuses a non-integer coordinate, so a renderer never gets a fractional line', () => {
    expect(
      isAnchor({ kind: 'text_range', resource_id: 'src/a', start_line: 1.5, end_line: 9 }),
    ).toBe(false);
  });

  it('round-trips through JSON unchanged', () => {
    const anchor = { kind: 'region', asset_id: 'a-1', x: 4, y: 8, width: 16, height: 16 };
    const revived: unknown = JSON.parse(JSON.stringify(anchor));
    expect(isAnchor(revived)).toBe(true);
    expect(revived).toEqual(anchor);
  });

  // §5.2.1: "new shapes require a protocol version bump and a renderer case" — which a comment
  // cannot enforce. Pinning the fingerprint to the version makes a new kind fail here first.
  it('cannot gain a kind without a deliberate version bump', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(ANCHOR_FINGERPRINT).toBe(
      'anchor:text_range(resource_id,start_line,end_line);' +
        'anchor:asset_id(asset_id);' +
        'anchor:node_path(resource_id,path);' +
        'anchor:region(asset_id,x,y,width,height)',
    );
  });
});

describe('the event envelope anchors on the same vocabulary', () => {
  /**
   * Invariant 7, one authoritative home per fact. `events.ts` needs this vocabulary for
   * `review.thread.created` and now imports it rather than restating it. This pins that: a fifth
   * kind added to `anchor.ts` cannot leave the envelope accepting only four.
   */
  it('accepts every kind this module declares, and nothing outside it', () => {
    for (const kind of CHANGE_ANCHOR_KINDS) {
      expect(isDurableEvent(threadCreated({ kind, locator: 'x' }))).toBe(true);
    }
    expect(isDurableEvent(threadCreated({ kind: 'byte_offset', locator: 'x' }))).toBe(false);
  });

  it('keeps the envelope’s opaque locator, rather than the per-kind coordinates', () => {
    // Different depth on purpose: a thread only needs to point somewhere stable.
    expect(
      isDurableEvent(threadCreated({ kind: 'text_range', resource_id: 'src/a', start_line: 1 })),
    ).toBe(false);
  });
});
