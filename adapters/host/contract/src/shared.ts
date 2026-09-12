/**
 * Implementation every host adapter shares, because these two rules belong to the contract rather
 * than to a substrate: what "inside an allowed root" means, and what an adapter may do about
 * autostart. The substrate-specific halves are injected.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  AutostartContract,
  AutostartPlan,
  AutostartStatus,
  OwnerProcedure,
  PathDecision,
  PathPolicy,
} from './spi.js';

/** Resolves symlinks; throws when the path does not exist, like `fs.realpathSync` does. */
export type RealPath = (path: string) => string;

/** Deepest ancestor that resolves, with the unresolved tail re-appended. Null when none does. */
const resolveDeepest = (normalized: string, realpath: RealPath): string | null => {
  const parts = normalized.split('/');
  for (let i = parts.length; i >= 1; i--) {
    try {
      const real = realpath(parts.slice(0, i).join('/') || '/');
      const tail = parts.slice(i);
      return tail.length > 0 ? posix.join(real, ...tail) : real;
    } catch {
      continue;
    }
  }
  return null;
};

export type PathPolicyOptions = {
  readonly roots: readonly string[];
  readonly realpath: RealPath;
  /** Darwin volumes are case-insensitive by default, so `/Users` and `/users` are one root. */
  readonly caseInsensitive: boolean;
};

/**
 * Appendix C: "Allowed workspace roots and path canonicalization tested." The dangerous half —
 * turning a name into the thing it actually points at — is injected, because it is the only part
 * that differs by host. Sharing the containment arithmetic means a traversal fix lands once, and
 * injecting `realpath` lets the contract suite drive a symlink escape on a platform without one.
 */
export const createPathPolicy = (options: PathPolicyOptions): PathPolicy => {
  const fold = (v: string): string => (options.caseInsensitive ? v.toLowerCase() : v);
  // Roots canonicalize once. A root that does not exist yet still constrains: falling back to its
  // normalized form refuses everything under it rather than disabling the policy (invariant 4).
  const roots = options.roots
    .filter((r) => r.startsWith('/'))
    .map((r) => {
      const normalized = posix.normalize(r).replace(/\/+$/, '') || '/';
      return resolveDeepest(normalized, options.realpath) ?? normalized;
    });

  const canonicalize = (candidate: string): PathDecision => {
    if (candidate.trim() === '')
      return { allowed: false, reason: 'empty', detail: 'no path given' };
    if (candidate.includes('\0')) {
      return { allowed: false, reason: 'illegal_character', detail: 'path contains a null byte' };
    }
    // Resolving a relative path against a working directory would make the answer depend on
    // ambient state, so it is refused rather than interpreted.
    if (!candidate.startsWith('/')) {
      return {
        allowed: false,
        reason: 'not_absolute',
        detail: 'only absolute paths are decidable',
      };
    }
    const normalized = posix.normalize(candidate).replace(/(.)\/+$/, '$1');
    const canonical = resolveDeepest(normalized, options.realpath);
    if (canonical === null) {
      return {
        allowed: false,
        reason: 'not_canonicalizable',
        detail: `unresolvable ${normalized}`,
      };
    }
    const folded = fold(canonical);
    for (const root of roots) {
      const base = fold(root).replace(/\/$/, '');
      // `startsWith(base + '/')` and not `startsWith(base)`: the latter lets `/rootsuffix` pass.
      if (folded === fold(root) || folded.startsWith(`${base}/`)) {
        return { allowed: true, canonical, root };
      }
    }
    return {
      allowed: false,
      reason: 'outside_allow_roots',
      detail: `${canonical} resolves outside every allowed root`,
    };
  };

  return { allow_roots: () => roots, canonicalize };
};

export const digestOf = (value: string): string => createHash('sha256').update(value).digest('hex');

export type ManifestHost = {
  readonly pathFor: (unit_id: string) => string;
  readonly render: (plan: AutostartPlan) => string;
  readonly procedureFor: (unit_id: string) => OwnerProcedure;
  readonly read: (path: string) => string | null;
  readonly write: (path: string, body: string) => void;
};

/**
 * Autostart as a file and a procedure, never as an action.
 *
 * CLAUDE.md §8 and the P0-07 acceptance line: writing a manifest the owner can read, diff and
 * delete is reversible; asking the service manager to load it is a privilege change an unattended
 * agent must not make for itself. Nothing in here launches a process, which is why `registration`
 * is always `unknown` — the honest report on a thing this code declined to observe (invariant 1).
 */
export const createManifestAutostart = (host: ManifestHost): AutostartContract => {
  const statusOf = (unit_id: string, expected: string | null): AutostartStatus => {
    const path = host.pathFor(unit_id);
    const stored = host.read(path);
    const base = {
      unit_id,
      registration: 'unknown' as const,
      manifest_path: stored === null ? null : path,
      manifest_digest: stored === null ? null : digestOf(stored),
      expected_digest: expected === null ? null : digestOf(expected),
      // Always true: registration is unobserved, so autostart is never provably working from here.
      needs_owner: true,
      procedure: host.procedureFor(unit_id),
    };
    if (stored === null)
      return { ...base, state: 'not_installed', detail: `no manifest at ${path}` };
    if (expected !== null && stored !== expected) {
      return { ...base, state: 'divergent', detail: 'manifest on disk differs from the plan' };
    }
    return expected === null
      ? { ...base, state: 'unknown', detail: 'a manifest exists; no plan to compare it against' }
      : { ...base, state: 'manifest_current', detail: 'matches the plan; registration unobserved' };
  };

  return {
    install: (plan) => {
      const path = host.pathFor(plan.unit_id);
      const body = host.render(plan);
      const wrote = host.read(path) !== body;
      if (wrote) host.write(path, body);
      return Promise.resolve({
        manifest_path: path,
        wrote,
        digest: digestOf(body),
        status: statusOf(plan.unit_id, body),
        procedure: host.procedureFor(plan.unit_id),
      });
    },
    status: (unit_id) => Promise.resolve(statusOf(unit_id, null)),
    repair: (plan) => {
      const path = host.pathFor(plan.unit_id);
      const body = host.render(plan);
      const before = host.read(path);
      const actions: string[] = [];
      if (before !== body) {
        host.write(path, body);
        actions.push(before === null ? `wrote ${path}` : `rewrote divergent ${path}`);
      }
      return Promise.resolve({
        status: statusOf(plan.unit_id, body),
        actions_taken: actions,
        procedure: host.procedureFor(plan.unit_id),
        // Repair restores the file; only the owner can restore the registration.
        needs_owner: true,
      });
    },
  };
};
