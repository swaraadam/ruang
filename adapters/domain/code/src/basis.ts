/**
 * basis.ref and basis.inputs over a git source of record (§5.1, §13.2). The ref is the commit SHA;
 * an input's version is the blob hash of a consulted file, and **only** of consulted files —
 * §13.2: "Editing an unrelated gotchas file does not stale a task that never read it."
 *
 * Staleness is therefore decided by the inputs, not the ref. A moved HEAD with no consulted input
 * touched is precisely the false invalidation §13.2 forbids; the ref stays on the basis for
 * attribution and for materialising a sandbox. It keeps one veto: a ref that no longer resolves
 * makes the answer `unknown`, which fails closed (invariant 4).
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Basis, ResourceId, Staleness } from '@internal/domain';
import { under } from './paths.js';
import { runGit } from './process.js';

/** Not a plausible default: the literal word, so an unresolved ref reads as unresolved. */
export const UNRESOLVED_REF = 'unknown';
/** Absent at capture and still absent is not a change; unreadable at all forces `unknown`. */
export const ABSENT_VERSION = 'absent';
export const UNREADABLE_VERSION = 'unknown';

export const currentRef = async (root: string): Promise<string> => {
  const r = await runGit(root, ['rev-parse', 'HEAD']);
  return r.code === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : UNRESOLVED_REF;
};

export const refResolves = async (root: string, ref: string): Promise<boolean> =>
  (await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;

/**
 * A resource id is a path relative to the source of record. One that climbs out of it is a defect
 * in the caller, and it is answered with `unknown` rather than an exception — `unknown` already
 * means "refuse to act on this", which is the correct outcome and needs no new failure mode.
 */
export const versionOf = async (root: string, resource_id: ResourceId): Promise<string> => {
  const full = under(root, resource_id);
  if (full === null) return UNREADABLE_VERSION;
  if (!existsSync(full)) return ABSENT_VERSION;
  const r = await runGit(root, ['hash-object', '--', relative(root, full)]);
  return r.code === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : UNREADABLE_VERSION;
};

export const snapshotBasis = async (
  root: string,
  consulted_inputs: readonly ResourceId[],
  now: () => string,
): Promise<Basis> => {
  // Deduplicated and ordered so that the same consultation produces the same basis twice.
  const ids = [...new Set(consulted_inputs)].sort();
  const inputs = await Promise.all(
    ids.map(async (resource_id) => ({ resource_id, version: await versionOf(root, resource_id) })),
  );
  return { ref: await currentRef(root), inputs, captured_at: now() };
};

export const basisStaleness = async (root: string, basis: Basis): Promise<Staleness> => {
  const unknown = (reason: string): Staleness => ({ state: 'unknown', reason });
  if (basis.ref === UNRESOLVED_REF)
    return unknown('this plan was captured without a resolvable basis ref');
  if (!existsSync(root)) return unknown('the source of record cannot be read');
  if (!(await refResolves(root, basis.ref)))
    return unknown('the recorded basis ref is no longer present in the source of record');

  const unreadable: ResourceId[] = [];
  const stale_inputs: ResourceId[] = [];
  for (const input of basis.inputs) {
    const version = await versionOf(root, input.resource_id);
    if (version === UNREADABLE_VERSION) unreadable.push(input.resource_id);
    else if (version !== input.version) stale_inputs.push(input.resource_id);
  }
  if (unreadable.length > 0)
    return unknown(`the version of ${unreadable.length} consulted resource(s) cannot be read`);
  if (stale_inputs.length > 0)
    return {
      state: 'stale',
      reason: `${stale_inputs.length} consulted resource(s) changed since this plan was prepared`,
      stale_inputs,
    };
  return { state: 'fresh' };
};
