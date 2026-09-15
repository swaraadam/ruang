/**
 * What changed, in a shape the core can render — blueprint §5.2.1.
 *
 * `anchor.ts` owns where a change sits; this owns what it is and the set carrying it. An adapter
 * ships no code to render one — "adapters do not ship browser code in v0.7" — and the type surface
 * is data only, which `change.test.ts` asserts by scanning field names rather than trusting this.
 */
import { isAnchor, unionCheck } from './anchor.js';
import { canonicalJson, sha256Hex } from './digest.js';
import { type Check, type Of, int, isRecord, list, oneOf, shape, str } from './check.js';

/**
 * §5.2.1 fixes the v1 set at four. Every variant carries anchors rather than coordinates of its
 * own, so a comment and the change it refers to share one vocabulary. `before_ref`/`after_ref` are
 * artifact references (§14.3), never inline content: a change must fit in an event payload.
 */
const RENDERABLE = {
  text_patch: shape({ resource_id: str, anchors: list(isAnchor), added: int, removed: int }),
  asset_delta: shape({ asset_id: str, before_ref: str, after_ref: str, bytes_delta: int }),
  node_tree_delta: shape({ resource_id: str, anchors: list(isAnchor), properties_changed: int }),
  region_delta: shape({ asset_id: str, anchors: list(isAnchor), before_ref: str, after_ref: str }),
};

export type RenderableChangeKind = keyof typeof RENDERABLE;

/** The closed change union: discriminated on `kind`, one payload per case. */
export type RenderableChange = {
  [K in RenderableChangeKind]: { readonly kind: K } & Of<(typeof RENDERABLE)[K]>;
}[RenderableChangeKind];

/**
 * A reviewable unit. `change_unit` is a core term (§3, §16.6): domain-specific, so the core stores
 * it rather than assuming lines. */
export type ChangeSet = {
  readonly change_set_id: string;
  readonly summary: string;
  readonly change_unit: 'lines' | 'files' | 'assets' | 'megabytes';
  readonly change_size: number;
  readonly changes: readonly RenderableChange[];
  readonly content_hash: string;
};

export const RENDERABLE_CHANGE_KINDS = Object.keys(RENDERABLE) as readonly RenderableChangeKind[];

export const isRenderableChange: Check<RenderableChange> = unionCheck<RenderableChange>(RENDERABLE);

const changeUnit = oneOf('lines', 'files', 'assets', 'megabytes');

export const isChangeSet = (value: unknown): value is ChangeSet =>
  isRecord(value) &&
  str(value['change_set_id']) &&
  str(value['summary']) &&
  changeUnit(value['change_unit']) &&
  int(value['change_size']) &&
  list(isRenderableChange)(value['changes']) &&
  str(value['content_hash']);

/**
 * Identity of the renderable vocabulary; `ANCHOR_FINGERPRINT` does the same for the anchor half.
 * Renaming a case or a field changes this, and `change.test.ts` pins it against `PROTOCOL_VERSION`
 * — §5.2.1's version-bump rule, enforced rather than asked for.
 */
export const RENDERABLE_FINGERPRINT = RENDERABLE_CHANGE_KINDS.map(
  (k) => `change:${k}(${(RENDERABLE[k].fields ?? []).join(',')})`,
).join(';');

/**
 * A hash over the *content*, excluding `content_hash` and `change_set_id`. Excluding the id is what
 * makes it a content hash: the same changes captured twice are one review under two identities.
 * Stability comes from `canonicalJson`, not from JSON.stringify, whose key order follows insertion.
 *
 * Everything is copied in and two keys are removed by name, rather than the covered fields being
 * listed, so a field added to `ChangeSet` is inside the digest without anyone remembering to add it.
 *
 * **Now cryptographic.** This was 64 bits of FNV, with a note saying to revisit "if a change-set
 * hash ever gates an apply decision". P0-20 is that day: `ApplyPlan.change_set_hash` carries this
 * value into `action_fingerprint` (§12.3), so its collision resistance is the binding's. See
 * `digest.ts` for why SHA-256 is written out rather than imported.
 */
export const changeSetHash = (set: Omit<ChangeSet, 'content_hash'>): string => {
  // Both, not just the id: `Omit` does not stop a full ChangeSet being passed (excess-property
  // checks apply only to fresh literals), so a stored set would fold its own hash into the digest.
  const content: Record<string, unknown> = { ...set };
  delete content['change_set_id'];
  delete content['content_hash'];
  return sha256Hex(`change_set/2\n${canonicalJson(content)}`);
};
