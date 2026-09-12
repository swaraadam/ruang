/**
 * Review shapes the core knows without knowing how an adapter produced them — blueprint §5.2.1.
 *
 * Two closed unions and the set that carries them. The core renders these; it never learns what a
 * text range came from, and an adapter never ships code to render one (§5.2.1: "adapters do not
 * ship browser code in v0.7"). The type surface is data only, which `change.test.ts` asserts by
 * scanning every field name rather than by trusting this comment.
 */
import { type Check, int, isRecord, list, oneOf, shape, str } from './check.js';

/**
 * Where a change sits, in terms the core can anchor a review comment to (§16.4). Domain-neutral by
 * construction: an adapter maps its own coordinates onto one of these four and the core stays
 * ignorant of the mapping.
 */
const ANCHORS = {
  text_range: shape({ resource_id: str, start_line: int, end_line: int }),
  asset_id: shape({ asset_id: str }),
  node_path: shape({ resource_id: str, path: str }),
  region: shape({ asset_id: str, x: int, y: int, width: int, height: int }),
};

export type ChangeAnchorKind = keyof typeof ANCHORS;

type Payload<C> = C extends Check<infer P> ? P : never;

/** The closed anchor union: discriminated on `kind`, one locator shape per case. */
export type ChangeAnchor = {
  [K in ChangeAnchorKind]: { readonly kind: K } & Payload<(typeof ANCHORS)[K]>;
}[ChangeAnchorKind];

export const CHANGE_ANCHOR_KINDS = Object.keys(ANCHORS) as readonly ChangeAnchorKind[];

/** Narrow `unknown` to one case of a `kind`-discriminated catalog. */
const unionCheck =
  <T>(catalog: Readonly<Record<string, (v: unknown) => boolean>>) =>
  (value: unknown): value is T => {
    if (!isRecord(value)) return false;
    const kind = value['kind'];
    return typeof kind === 'string' && Object.hasOwn(catalog, kind) && catalog[kind]!(value);
  };

export const isAnchor: Check<ChangeAnchor> = unionCheck<ChangeAnchor>(ANCHORS);

/**
 * What changed, in a shape the core can render. §5.2.1 fixes the v1 set at four.
 *
 * Every variant carries its anchors rather than coordinates of its own, so a reviewer's comment
 * and the change it refers to are the same vocabulary. `before_ref`/`after_ref` are artifact
 * references (§14.3), never inline content: a renderable change must stay small enough to live in
 * an event payload, and the artifact store already owns retention.
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
  [K in RenderableChangeKind]: { readonly kind: K } & Payload<(typeof RENDERABLE)[K]>;
}[RenderableChangeKind];

/**
 * A reviewable unit: what it is, what it touched, and a hash that is stable across serializations.
 *
 * `change_unit` and `change_budget` are the core terms (CLAUDE.md §3, §16.6) — the budget is a
 * review-burden guardrail and the unit is domain-specific, so the core stores both rather than
 * assuming lines.
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
 * Identity of both closed unions: every kind with its field names, in catalog order.
 *
 * Adding, removing or renaming a case or a field changes this string. `change.test.ts` pins it
 * against `PROTOCOL_VERSION`, so a new shape cannot arrive without a deliberate version bump —
 * §5.2.1's "new shapes require a protocol version bump and a renderer case", enforced rather than
 * asked for.
 */
export const CHANGE_FINGERPRINT = [
  ...CHANGE_ANCHOR_KINDS.map((k) => `anchor:${k}(${(ANCHORS[k].fields ?? []).join(',')})`),
  ...RENDERABLE_CHANGE_KINDS.map((k) => `change:${k}(${(RENDERABLE[k].fields ?? []).join(',')})`),
].join(';');

/**
 * Canonical JSON: object keys sorted at every depth, array order preserved.
 *
 * Array order is content here — the anchors of a change are a sequence, and reordering them is a
 * different change set, not the same one serialized differently.
 */
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
 * A hash over the *content* of a change set, excluding `content_hash` itself and `change_set_id`.
 *
 * Excluding the id is what makes it a content hash: the same changes captured twice are the same
 * content under two identities, and a reviewer who has read one has read the other. Stability
 * across serializations comes from `canonical`, not from JSON.stringify's key order, which follows
 * insertion.
 *
 * **Not cryptographic.** 64 bits from two FNV-style rounds, chosen because `packages/protocol` is
 * imported by the browser bundle as well as the gateway, so `node:crypto` is unavailable and
 * CLAUDE.md §8 forbids a new runtime dependency without an ADR line. This issue's acceptance asks
 * for stability across repeated serialization, which this meets; it would not withstand someone
 * constructing a collision deliberately. If a change-set hash ever gates an apply decision, that is
 * the moment to revisit — it does not today.
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
