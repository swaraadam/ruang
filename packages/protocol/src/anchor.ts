/**
 * Where a change sits — the domain-neutral coordinate the core anchors a review comment to
 * (blueprint §16.4, §5.2.1).
 *
 * Part 1 of P0-03, split from `RenderableChange` to stay inside the §10 change budget. An adapter
 * maps its own coordinates onto one of these four kinds and the core stays ignorant of the
 * mapping: it never learns that a `text_range` came from a file, or a `region` from a texture.
 *
 * **One authoritative home (invariant 7).** `events.ts` needs this same vocabulary for
 * `review.thread.created`, and imports `CHANGE_ANCHOR_KINDS` rather than restating it. The two
 * shapes stay different on purpose — a review thread stores an opaque `locator` because it only
 * needs to point somewhere stable, while a `ChangeAnchor` carries the per-kind coordinates a
 * renderer needs. Same vocabulary, different depth.
 */
import { type Check, int, isRecord, shape, str } from './check.js';

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

/**
 * Narrow `unknown` to one case of a `kind`-discriminated catalog.
 *
 * Exported because `RenderableChange` (part 2) is the same shape of union and must narrow the same
 * way — a second hand-rolled copy is how two unions drift apart.
 */
export const unionCheck =
  <T>(catalog: Readonly<Record<string, (v: unknown) => boolean>>) =>
  (value: unknown): value is T => {
    if (!isRecord(value)) return false;
    const kind = value['kind'];
    return typeof kind === 'string' && Object.hasOwn(catalog, kind) && catalog[kind]!(value);
  };

export const isAnchor: Check<ChangeAnchor> = unionCheck<ChangeAnchor>(ANCHORS);

/**
 * Identity of the closed anchor vocabulary: every kind with its field names, in catalog order.
 *
 * §5.2.1 says new shapes require a protocol version bump and a renderer case. A comment cannot
 * enforce that, so `anchor.test.ts` pins this string against `PROTOCOL_VERSION` — adding a kind or
 * renaming a field fails there until someone decides what the new version is.
 */
export const ANCHOR_FINGERPRINT = CHANGE_ANCHOR_KINDS.map(
  (k) => `anchor:${k}(${(ANCHORS[k].fields ?? []).join(',')})`,
).join(';');
