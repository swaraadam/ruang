import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  RENDERABLE_CHANGE_KINDS,
  RENDERABLE_FINGERPRINT,
  type ChangeSet,
  type RenderableChange,
  changeSetHash,
  isChangeSet,
  isRenderableChange,
} from '../src/index.js';

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

describe('the renderable union is closed', () => {
  it('is exactly the v1 set from §5.2.1, no more and no fewer', () => {
    expect([...RENDERABLE_CHANGE_KINDS].sort()).toEqual([
      'asset_delta',
      'node_tree_delta',
      'region_delta',
      'text_patch',
    ]);
  });

  it('refuses an unknown kind, a mismatched payload, and a bad anchor', () => {
    // The discriminant alone is not enough: each case validates its own fields, and the anchor
    // vocabulary is part 1's — this is the seam where a bad one would otherwise leak in.
    expect(isRenderableChange({ ...assetDelta, kind: 'binary_patch' })).toBe(false);
    expect(isRenderableChange({ ...assetDelta, kind: 'text_patch' })).toBe(false);
    expect(
      isRenderableChange({ ...nodeTreeDelta, anchors: [{ kind: 'byte_offset', path: '/x' }] }),
    ).toBe(false);
  });

  // §5.2.1: "new shapes require a protocol version bump and a renderer case" — which a comment
  // cannot enforce. Pinning the fingerprint to the version makes a new case fail here first.
  it('cannot gain a shape without a deliberate version bump', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(RENDERABLE_FINGERPRINT).toBe(
      'change:text_patch(resource_id,anchors,added,removed);' +
        'change:asset_delta(asset_id,before_ref,after_ref,bytes_delta);' +
        'change:node_tree_delta(resource_id,anchors,properties_changed);' +
        'change:region_delta(asset_id,anchors,before_ref,after_ref)',
    );
  });
});

// §5.2.1: "adapters do not ship browser code in v0.7". The risk is not a field named `script`, it
// is one whose value a renderer would execute, fetch or inject. Scan, do not assert in prose.
it('has no field that could carry code, markup or a fetchable location', () => {
  const forbidden =
    /(script|html|markup|css|style|render|component|template|widget|url|uri|href|src|endpoint|module|bundle|eval|code)/i;
  const offenders = RENDERABLE_FINGERPRINT.split(';').flatMap((entry) => {
    const fields = entry.slice(entry.indexOf('(') + 1, -1).split(',');
    return fields.filter((f) => forbidden.test(f)).map((f) => `${entry.split('(')[0]}.${f}`);
  });
  expect(offenders).toEqual([]);
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
    expect(changeSetHash(JSON.parse(JSON.stringify(set)) as typeof set)).toBe(once);
    expect(once).toMatch(/^[0-9a-f]{16}$/);
    // And the id is not content: the same changes under two ids are the same review.
    expect(changeSetHash({ ...set, change_set_id: 'cs-2' })).toBe(once);
  });

  it('verifies a stored change set against its own hash', () => {
    // Regression: a stored set used to fold its own content_hash in and never verify.
    const full: ChangeSet = { ...set, content_hash: changeSetHash(set) };
    expect(changeSetHash(full)).toBe(full.content_hash);
  });

  it('does not depend on the order keys were written in', () => {
    // JSON.stringify follows insertion order; the hash must not.
    const reordered = Object.fromEntries(Object.entries(set).reverse()) as typeof set;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(set));
    expect(changeSetHash(reordered)).toBe(changeSetHash(set));
  });

  it('moves when the content moves, including deep inside an anchor and in order', () => {
    const h = changeSetHash(set);
    expect(changeSetHash({ ...set, change_size: 3 })).not.toBe(h);
    const moved: RenderableChange = {
      ...nodeTreeDelta,
      anchors: [{ kind: 'node_path', resource_id: 'scene/main', path: '/root/light' }],
    };
    expect(changeSetHash({ ...set, changes: [assetDelta, moved] })).not.toBe(h);
    // Order is content: a reordered sequence is a different set, not the same one reserialized.
    expect(changeSetHash({ ...set, changes: [nodeTreeDelta, assetDelta] })).not.toBe(h);
  });
});
