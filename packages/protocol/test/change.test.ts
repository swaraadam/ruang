import { describe, expect, it } from 'vitest';
import {
  CHANGE_ANCHOR_KINDS,
  isDurableEvent,
  CHANGE_FINGERPRINT,
  PROTOCOL_VERSION,
  RENDERABLE_CHANGE_KINDS,
  type ChangeSet,
  type RenderableChange,
  changeSetHash,
  isAnchor,
  isChangeSet,
  isRenderableChange,
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

const assetDelta: RenderableChange = {
  kind: 'asset_delta',
  asset_id: 'asset-1',
  before_ref: 'sha256:aaa',
  after_ref: 'sha256:bbb',
  bytes_delta: 2048,
};

const nodeTreeDelta: RenderableChange = {
  kind: 'node_tree_delta',
  resource_id: 'scene/main',
  anchors: [{ kind: 'node_path', resource_id: 'scene/main', path: '/root/camera' }],
  properties_changed: 3,
};

const set: Omit<ChangeSet, 'content_hash'> = {
  change_set_id: 'cs-1',
  summary: 'retune the camera and reimport its texture',
  change_unit: 'assets',
  change_size: 2,
  changes: [assetDelta, nodeTreeDelta],
};

describe('the unions are closed', () => {
  it('is exactly the v1 set from §5.2.1, no more and no fewer', () => {
    expect([...RENDERABLE_CHANGE_KINDS].sort()).toEqual([
      'asset_delta',
      'node_tree_delta',
      'region_delta',
      'text_patch',
    ]);
    expect([...CHANGE_ANCHOR_KINDS].sort()).toEqual([
      'asset_id',
      'node_path',
      'region',
      'text_range',
    ]);
  });

  /**
   * Invariant 7, one authoritative home per fact. `events.ts` needs the same vocabulary for
   * `review.thread.created`; it now imports this list rather than restating it, and this pins that
   * so a fifth kind added here cannot leave the event envelope accepting only four.
   */
  it('is the same vocabulary the event envelope anchors on', () => {
    const envelopeAnchor = { kind: 'node_path', locator: 'scene/main#/root/camera' };
    expect(isDurableEvent(threadCreated(envelopeAnchor))).toBe(true);
    for (const kind of CHANGE_ANCHOR_KINDS) {
      expect(isDurableEvent(threadCreated({ kind, locator: 'x' }))).toBe(true);
    }
    expect(isDurableEvent(threadCreated({ kind: 'byte_offset', locator: 'x' }))).toBe(false);
  });

  it('refuses a kind that is not in the union, however well-formed the rest is', () => {
    expect(isRenderableChange({ ...assetDelta, kind: 'binary_patch' })).toBe(false);
    expect(isAnchor({ kind: 'byte_offset', resource_id: 'a', start_line: 1, end_line: 2 })).toBe(
      false,
    );
  });

  it('refuses a known kind carrying another kind’s payload', () => {
    // The discriminant alone is not enough: each case validates its own fields.
    expect(isRenderableChange({ ...assetDelta, kind: 'text_patch' })).toBe(false);
    expect(isAnchor({ kind: 'region', resource_id: 'a', path: '/x' })).toBe(false);
  });

  // §5.2.1: "new shapes require a protocol version bump and a renderer case" — which a comment
  // cannot enforce. Pinning the fingerprint to the version makes a new case fail here first.
  it('cannot gain a shape without a deliberate version bump', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(CHANGE_FINGERPRINT).toBe(
      'anchor:text_range(resource_id,start_line,end_line);' +
        'anchor:asset_id(asset_id);' +
        'anchor:node_path(resource_id,path);' +
        'anchor:region(asset_id,x,y,width,height);' +
        'change:text_patch(resource_id,anchors,added,removed);' +
        'change:asset_delta(asset_id,before_ref,after_ref,bytes_delta);' +
        'change:node_tree_delta(resource_id,anchors,properties_changed);' +
        'change:region_delta(asset_id,anchors,before_ref,after_ref)',
    );
  });
});

describe('an adapter ships no browser code through this surface', () => {
  // §5.2.1: "adapters do not ship browser code in v0.7". The risk is not a field named `script`,
  // it is one whose value a renderer would execute, fetch or inject. Scan, do not assert in prose.
  it('has no field that could carry code, markup or a fetchable location', () => {
    const forbidden =
      /(script|html|markup|css|style|render|component|template|widget|url|uri|href|src|endpoint|module|bundle|eval|code)/i;
    const offenders = CHANGE_FINGERPRINT.split(';').flatMap((entry) => {
      const fields = entry.slice(entry.indexOf('(') + 1, -1).split(',');
      return fields.filter((f) => forbidden.test(f)).map((f) => `${entry.split('(')[0]}.${f}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe('fixtures validate and round-trip', () => {
  it('accepts an asset_delta and a node_tree_delta, and survives JSON', () => {
    for (const change of [assetDelta, nodeTreeDelta]) {
      expect(isRenderableChange(change)).toBe(true);
      const revived: unknown = JSON.parse(JSON.stringify(change));
      expect(isRenderableChange(revived)).toBe(true);
      expect(revived).toEqual(change);
    }
  });

  it('accepts a whole change set and survives JSON', () => {
    const full: ChangeSet = { ...set, content_hash: changeSetHash(set) };
    expect(isChangeSet(full)).toBe(true);
    expect(isChangeSet(JSON.parse(JSON.stringify(full)))).toBe(true);
  });

  it('fails closed on a change set whose changes are not all renderable', () => {
    const bad = { ...set, content_hash: 'x', changes: [assetDelta, { kind: 'binary_patch' }] };
    expect(isChangeSet(bad)).toBe(false);
  });
});

describe('the content hash is stable', () => {
  it('is unchanged across repeated serialization of the same content', () => {
    const once = changeSetHash(set);
    const twice = changeSetHash(JSON.parse(JSON.stringify(set)) as typeof set);
    expect(twice).toBe(once);
    expect(once).toMatch(/^[0-9a-f]{16}$/);
    // And the id is not content: the same changes under two ids are the same review.
    expect(changeSetHash({ ...set, change_set_id: 'cs-2' })).toBe(once);
  });

  it('does not depend on the order keys were written in', () => {
    // JSON.stringify follows insertion order, so a value rebuilt field-by-field in a different
    // order serializes differently. The hash must not.
    const reordered = {
      changes: [...set.changes],
      change_size: set.change_size,
      summary: set.summary,
      change_set_id: set.change_set_id,
      change_unit: set.change_unit,
    } as typeof set;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(set));
    expect(changeSetHash(reordered)).toBe(changeSetHash(set));
  });

  it('changes when the content changes, including deep inside an anchor', () => {
    expect(changeSetHash({ ...set, change_size: 3 })).not.toBe(changeSetHash(set));
    const moved: RenderableChange = {
      ...nodeTreeDelta,
      anchors: [{ kind: 'node_path', resource_id: 'scene/main', path: '/root/light' }],
    };
    expect(changeSetHash({ ...set, changes: [assetDelta, moved] })).not.toBe(changeSetHash(set));
  });

  it('treats anchor order as content, because a reordered sequence is a different set', () => {
    expect(changeSetHash({ ...set, changes: [nodeTreeDelta, assetDelta] })).not.toBe(
      changeSetHash(set),
    );
  });
});
