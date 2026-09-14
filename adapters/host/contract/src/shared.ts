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

/**
 * The one folding rule. Both sides of every comparison below pass through it, and so does the host
 * adapter's own launch guard, so a folding fix lands once.
 *
 * `toLowerCase()` is not case FOLDING, and the difference showed: U+017F LATIN SMALL LETTER LONG S
 * is already lowercase, so `'\u017Fh'.toLowerCase()` is `'\u017Fh'` -- a name the filesystem opens as
 * `sh` that the comparison never saw. NFKC maps the compatibility spellings of an ASCII character
 * onto that character (long s, fullwidth forms, ligatures), and it maps the fullwidth solidus onto
 * `/`, which is why it runs BEFORE the basename split rather than after it.
 *
 * The result is a string to COMPARE. Nothing opens a file by it; callers keep the original.
 */
export const foldProgramName = (program: string): string =>
  (program.normalize('NFKC').split('/').pop() ?? '').toLowerCase();

/**
 * Every name this file compares against is an ASCII identifier, so ASCII is the comparison's whole
 * domain. A folded name still outside it cannot equal an entry and cannot be shown to differ from
 * one either: NFKC does not reach every lookalike and cannot -- `\u0130` folds to `i` plus a combining
 * dot, so `f\u0130sh` never becomes `fish`. Refusing is the fail-closed answer (invariant 4); calling
 * it acceptable would report a decision that was never made (invariant 1). The cost is a false
 * refusal for a binary whose own name is non-ASCII, which the message names precisely.
 */
const outsideAscii = (name: string): boolean =>
  [...name].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);

/** Anything a shell would treat as more than a filename. */
const SHELL_SYNTAX = /[\s;|&<>$`(){}[\]*?~!#\\'"]/;

/**
 * argv[0]s whose entire job is to run something else.
 *
 * A deny-list that inspects argv[0] is exactly one indirection deep: `sh -c '<anything>'` satisfies
 * it while running the very thing it forbids. Refusing the launcher is what makes the deny-list mean
 * what it says -- within the reach the contract below sets, and no further.
 */
export const COMMAND_LAUNCHERS: readonly string[] = [
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'env',
  'xargs',
  'nice',
  'nohup',
  'open',
  'osascript',
  'time',
  'timeout',
  'script',
  'command',
];

/**
 * Why a session command is refused, or `null` when it is acceptable.
 *
 * `guarded` is the host's own deny-list: this contract cannot know that `launchctl` is the dangerous
 * name on one platform and `systemctl` on another, so the host supplies it and the rule lives here
 * where both the real adapter and the double must obey it. Its entries must be ASCII identifiers --
 * ASCII is the whole domain of the comparison, see `outsideAscii`.
 *
 * ## THE REACH OF THIS GUARD IS A DECIDED CONTRACT, NOT THE AUTHOR'S CAVEAT
 *
 * Owner decision of 2026-09-14, closing the security review of this file: this guard is NOT a
 * security control, and no caller may treat it as one. Blueprint §12.1 puts the privilege boundary
 * in the credential broker and the capability limits; a deny-list over argv[0] is neither of those
 * and cannot be made into one. The decision binds in both directions.
 *
 * What it promises: it catches ACCIDENTS, with a legible reason. A shell as argv[0], a one-element
 * command the backend would hand to a shell, an owner-run binary named directly, any compatibility
 * spelling of one of those. Those are the shapes an unattended agent produces by mistake, and a
 * comparison that misses one of them is simply WRONG -- a correctness bug, which is what the folding
 * rule in `foldProgramName` fixes.
 *
 * What it does not promise: resistance to anyone TRYING. A session command is an arbitrary-execution
 * surface by design -- a provider agent runs there, and an interpreter that can open a socket can
 * start a process -- so an adversary who wants a deny-listed binary has other routes, and closing
 * one more of them here would not change that. Who may supply a `SessionSpec.command` at all is Seam
 * C's question (CLAUDE.md §4), and the answer belongs there rather than in a longer list here.
 *
 * So: fix a comparison that is wrong, and do not grow this into a boundary it cannot be. Nothing in
 * this repository -- code, comment, test name or error message -- may cite this function as a
 * privilege check.
 */
export const refuseSessionCommand = (
  command: readonly string[] | null | undefined,
  guarded: readonly string[],
): string | null => {
  if (command === null || command === undefined || command.length === 0) return null;
  const program = command[0];
  if (program === undefined || program.trim().length === 0) return 'the command names no program';
  // A ONE-ELEMENT command is handed to a shell by the backend, even after `--`. The "basename" of
  // `'launchctl list | head -3 > f'` is that entire string, so every check below matches nothing
  // while the shell runs all of it. Measured: this executed a deny-listed binary through the
  // session facet with no indirection at all.
  if (command.length === 1 && SHELL_SYNTAX.test(program)) {
    return `a single-element command is handed to a shell, so it may not carry shell syntax: ${JSON.stringify(program)}`;
  }
  // A leading `-` is read as an OPTION by the session backend rather than as a program, which is how
  // a caller reaches the backend's own flags -- including the one that decides where the session
  // runs. Measured against a real session backend: a command of ['-c', '/etc', 'sh'] placed the
  // session in /private/etc, discarding the canonicalized directory entirely.
  if (program.startsWith('-')) return `a command may not begin with an option: '${program}'`;
  // Folded, because the boot volume this runs on is case-insensitive and `/bin/SH` is `/bin/sh`
  // there. A comparison decided by code points, against a filesystem that opens both names as one
  // file, is a deny-list with a shift key for a bypass -- measured on `/bin/SH` and `/usr/bin/SUDO`,
  // and `'\u017Fh'` is the same bug one step further out (see `foldProgramName`).
  const base = foldProgramName(program);
  if (outsideAscii(base)) {
    return (
      `program name ${JSON.stringify(base)} is still outside ASCII after folding, and every name ` +
      'this guard compares against is an ASCII identifier, so the comparison has no answer and ' +
      'this refuses rather than guessing at one'
    );
  }
  if (guarded.some((g) => foldProgramName(g) === base))
    return `'${base}' is owner-run only and may not be a session command`;
  if (COMMAND_LAUNCHERS.some((l) => foldProgramName(l) === base))
    return `'${base}' exists to run another program, which would leave the deny-list one indirection away from what actually executes`;
  return null;
};

export const digestOf = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * A unit id becomes a FILENAME, and an unconstrained one becomes a path.
 *
 * `'../../../../tmp/pwn'` composed into `<login-agent directory>/<id>.<ext>` resolves to
 * `/tmp/pwn.<ext>`, and a writer that creates missing directories will build the chain to get there.
 * The read side is worse in a quieter way: `status(unit_id)` returns a state and a digest, so a
 * traversing id is an oracle for any file this process can read.
 *
 * Constrained here rather than in one host, because it is the identifier that is unsafe, not the
 * platform. Reverse-DNS-ish: dot-separated alphanumeric segments, no separator, no leading dot, no
 * empty segment -- so `..` is unrepresentable rather than merely filtered.
 */
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*$/;
const UNIT_ID_MAX = 128;

export class UnsafeUnitIdError extends Error {}

/** Refusing to overwrite a file at the composed path that this contract did not write. */
export class ForeignManifestError extends Error {}

/**
 * Present in every manifest this contract authors, and required before it will overwrite one.
 *
 * The login-agent directory is SHARED. A bare identifier is a perfectly valid unit id and also the
 * name of somebody else's agent, so `install` would replace that file and report `wrote: true`,
 * and `repair` would read it as `divergent` and rewrite it again. It also falsifies "reversible
 * with rm": under overwrite, `rm` does not restore what was there, so the operation would be at
 * best compensable and in practice irreversible.
 */
export const MANAGED_MARKER = 'managed-unit-of-this-control-plane';

const assertNotForeign = (path: string, existing: string | null): void => {
  if (existing !== null && !existing.includes(MANAGED_MARKER)) {
    throw new ForeignManifestError(
      `refusing to overwrite ${path}: it exists and carries no ${MANAGED_MARKER} marker, so this ` +
        'control plane did not write it, and overwriting destroys content rm cannot restore',
    );
  }
};

/** A plan field that would make the manifest do something the adapter may not do directly. */
export class UnsafeAutostartPlanError extends Error {}

export const assertSafeUnitId = (unit_id: string): void => {
  if (unit_id.length > UNIT_ID_MAX || !UNIT_ID.test(unit_id)) {
    throw new UnsafeUnitIdError(
      `unit id ${JSON.stringify(unit_id)} is not a bare identifier: it must be dot-separated ` +
        `alphanumeric segments, at most ${String(UNIT_ID_MAX)} characters, and it becomes a ` +
        `filename, so a path separator or a relative segment is refused rather than escaped`,
    );
  }
};

/**
 * The part of plan validation that is true on every host.
 *
 * A manifest is a PERSISTENCE payload: `program` is what the machine runs at login, so a launcher
 * there is the same laundering `refuseSessionCommand` refuses for a session, made permanent by a
 * reboot. It lives in the shared contract rather than in one adapter because the core suite runs
 * against the double -- a rule only the real host enforces is one a core caller can break in CI.
 *
 * Host-specific containment (which roots a directory may sit in, which binaries are owner-run) is
 * layered on top by the adapter, which is the only thing that knows those names.
 */
export const assertPlanIsPortable = (plan: AutostartPlan): void => {
  const unsafe = refuseSessionCommand(plan.program, []);
  if (unsafe !== null) {
    throw new UnsafeAutostartPlanError(
      `refusing to write an autostart manifest: program ${unsafe}`,
    );
  }
  // Costs nothing and does not touch the roots: without it the basename check above is decided by
  // whatever PATH the unit resolves under -- and the plan carries that PATH in `environment`.
  const program = plan.program[0];
  if (program === undefined || !program.startsWith('/')) {
    throw new UnsafeAutostartPlanError(
      `refusing to write an autostart manifest: program must be an absolute path, not ${JSON.stringify(program ?? null)}`,
    );
  }
};

export type ManifestHost = {
  readonly pathFor: (unit_id: string) => string;
  readonly render: (plan: AutostartPlan) => string;
  readonly procedureFor: (unit_id: string) => OwnerProcedure;
  readonly read: (path: string) => string | null;
  readonly write: (path: string, body: string) => void;
  /**
   * Who may read the stored manifest, in this host's own spelling, or null when there is no file
   * or no posture to report. Observation only: `status` must never change what it describes.
   */
  readonly readAccess: (path: string) => string | null;
  /**
   * Bring an EXISTING manifest to the access posture this host requires, whatever its body says,
   * and return a sentence describing what changed — null when nothing needed changing.
   *
   * Required, not optional. A host that narrows only on write has a manifest it wrote LAST version
   * still sitting at the older posture, and an optional hook is one a second adapter can forget in
   * silence. Making it part of the type means the compiler asks the question.
   */
  readonly restrictAccess: (path: string) => string | null;
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
    assertSafeUnitId(unit_id);
    const path = host.pathFor(unit_id);
    const stored = host.read(path);
    const base = {
      unit_id,
      registration: 'unknown' as const,
      manifest_path: stored === null ? null : path,
      manifest_digest: stored === null ? null : digestOf(stored),
      expected_digest: expected === null ? null : digestOf(expected),
      manifest_access: stored === null ? null : host.readAccess(path),
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

  // `async` rather than `Promise.resolve(...)`, so that a refusal REJECTS instead of throwing
  // synchronously past a caller holding a promise. The contract declares these as promise-returning;
  // a method that sometimes throws before the promise exists is one a `.catch()` cannot contain, and
  // a containment check nobody can catch is a containment check people route around.
  return {
    install: async (plan) => {
      assertSafeUnitId(plan.unit_id);
      assertPlanIsPortable(plan);
      const path = host.pathFor(plan.unit_id);
      const body = host.render(plan);
      const existing = host.read(path);
      assertNotForeign(path, existing);
      const wrote = existing !== body;
      if (wrote) host.write(path, body);
      // UNCONDITIONAL, and that is the whole of the point. `write` narrows what it writes, so a
      // manifest whose body already matches never reaches that narrowing -- which is exactly the
      // case this method is for: the same plan re-installed over a file an OLDER ADAPTER VERSION
      // left at a wider posture, where `render` produces identical bytes and nothing would write.
      // Placed after `assertNotForeign`, so it can only ever touch a manifest this code wrote.
      const restricted_access = host.restrictAccess(path);
      return {
        manifest_path: path,
        wrote,
        restricted_access,
        digest: digestOf(body),
        status: statusOf(plan.unit_id, body),
        procedure: host.procedureFor(plan.unit_id),
      };
    },
    status: (unit_id) => Promise.resolve().then(() => statusOf(unit_id, null)),
    repair: async (plan) => {
      assertSafeUnitId(plan.unit_id);
      assertPlanIsPortable(plan);
      const path = host.pathFor(plan.unit_id);
      const body = host.render(plan);
      const before = host.read(path);
      assertNotForeign(path, before);
      const actions: string[] = [];
      if (before !== body) {
        host.write(path, body);
        actions.push(before === null ? `wrote ${path}` : `rewrote divergent ${path}`);
      }
      // Same call as `install` makes, and here it is load-bearing twice over. `actions_taken: []`
      // is itself a claim -- "nothing needed doing" -- so a repair that returned it while leaving a
      // world-readable manifest in place would be reporting a state it did not leave behind
      // (invariant 1). The narrowing is appended rather than merged into the rewrite line, because
      // the two happen independently: a manifest can need one, the other, both or neither.
      const restricted = host.restrictAccess(path);
      if (restricted !== null) actions.push(restricted);
      return {
        status: statusOf(plan.unit_id, body),
        actions_taken: actions,
        procedure: host.procedureFor(plan.unit_id),
        // Repair restores the file; only the owner can restore the registration.
        needs_owner: true,
      };
    },
  };
};
