/**
 * What changed, in a shape the core can render — blueprint §5.2.1.
 *
 * Part 2 of P0-03. `anchor.ts` owns where a change sits; this owns what it is and the set carrying
 * it. The core renders these without learning how an adapter produced them, and an adapter ships no
 * code to render one — "adapters do not ship browser code in v0.7". The type surface is data only,
 * which `change.test.ts` asserts by scanning every field name rather than trusting this comment.
 */
import { isAnchor, unionCheck } from './anchor.js';
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
 * A reviewable unit. `change_unit` is a core term (§3, §16.6): the unit is domain-specific, so the
 * core stores it rather than assuming lines.
 */
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
 * Identity of the closed renderable vocabulary: every kind with its field names, in catalog order.
 *
 * `ANCHOR_FINGERPRINT` does the same for the anchor half in `anchor.ts`. Adding, removing or
 * renaming a case or a field changes this string, and `change.test.ts` pins it against
 * `PROTOCOL_VERSION` — §5.2.1's "new shapes require a protocol version bump and a renderer case",
 * enforced rather than asked for.
 */
export const RENDERABLE_FINGERPRINT = RENDERABLE_CHANGE_KINDS.map(
  (k) => `change:${k}(${(RENDERABLE[k].fields ?? []).join(',')})`,
).join(';');

/** Canonical JSON: keys sorted at every depth, array order preserved — order is content. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * A hash over the *content*, excluding `content_hash` and `change_set_id`. Excluding the id is what
 * makes it a content hash: the same changes captured twice are one review under two identities.
 * Stability comes from `canonical`, not from JSON.stringify, whose key order follows insertion.
 *
 * **Not cryptographic.** 64 bits, two FNV-style rounds: `packages/protocol` is imported by the
 * browser bundle, so `node:crypto` is unavailable and §8 forbids a new dependency without an ADR
 * line. The acceptance asks for stability, which this meets; it would not withstand a deliberate
 * collision. If a change-set hash ever gates an apply decision, revisit then — it does not today.
 */
export const changeSetHash = (set: Omit<ChangeSet, 'content_hash'>): string => {
  const content = { ...set, change_set_id: undefined };
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = canonical(content);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};
