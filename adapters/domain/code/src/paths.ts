/**
 * One rule for every caller-supplied identifier this package turns into a filesystem path.
 *
 * Three identifiers reach a path here — a sandbox id, a check id and a resource id — and each was
 * guarded on its own terms, which is how the sandbox id came to be guarded not at all while it fed
 * a recursive delete. They share `under` from here on: derive the path, then prove the result is
 * still inside the root it was derived from. Deriving proves nothing by itself, because `join`
 * collapses `..` in silence.
 *
 * The shape rule is deliberately *not* shared, because only one of the three needs it. A sandbox id
 * names a location that has to be found again, so an id outside the shape this package issues is
 * refused rather than rewritten. A check id only has to be usable as a filename and its rewritten
 * form is what the caller gets back (`checks.ts`), so rewriting loses nothing. A resource id is a
 * relative path of several segments and has no single-segment shape to check at all.
 */
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * What `openSandbox` issues, widened only to punctuation an owner could reasonably choose: one
 * segment, no separator, never a leading dot — so neither `..` nor a hidden name can be spelled.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isPathSafeId = (id: string): boolean => SAFE_ID.test(id);

/**
 * `root` joined with `parts`, or `null` when the result would leave `root`. A value rather than an
 * exception because two callers need to carry on: staleness answers `unknown` and reconciliation
 * raises a probe, and both of those already mean "refuse to act on this".
 */
export const under = (root: string, ...parts: readonly string[]): string | null => {
  if (parts.some((part) => isAbsolute(part))) return null;
  const full = resolve(root, ...parts);
  const inside = relative(root, full);
  return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside) ? full : null;
};
