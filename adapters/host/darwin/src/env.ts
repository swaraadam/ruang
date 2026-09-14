/**
 * Everything this adapter is allowed to do to the machine, as one injectable record.
 *
 * Two reasons it is a parameter and not a set of imports. It lets the contract suite drive the
 * real adapter on any platform against a scripted host — a stronger proof than skipping half the
 * suite off-Darwin. And it puts every process launch behind one function, so `GUARDED_BINARIES` is
 * checked in one place rather than remembered in several.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS. This function inspects the BASENAME OF argv[0] and nothing else.
 * It catches an agent that adds a direct `launchctl load` line, which is the realistic accident and
 * is worth catching. It is not a sandbox: the choke point necessarily passes `tmux` and `osascript`
 * — a process launcher and a script interpreter — so anything reached one indirection down was never
 * in its view.
 *
 * That reach is a DECIDED CONTRACT, not this author's caveat. Owner decision of 2026-09-14 and
 * blueprint §12.1: the privilege boundary is the credential broker and the capability limits, and an
 * argv deny-list is neither. The binding statement lives on `refuseSessionCommand` in the host
 * contract; read it before adding anything here, and do not restate it as a stronger claim. Earlier
 * versions of this comment called the deny-list "an enforceable promise" and then claimed it "closes
 * the one-step laundering" -- a security review measured both false. That is the kind of sentence
 * that stops people looking, which is why this one runs long.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { foldProgramName } from '@internal/host-contract';

export type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not be launched at all; `code` is null then, never treat it as 0. */
  readonly error: string | null;
};

export type DarwinEnv = {
  readonly home: string;
  readonly user_id: number | null;
  readonly now: () => Date;
  readonly run: (argv: readonly string[]) => CommandResult;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, body: string) => void;
  /** Permission bits of an existing file, or null when there is nothing to stat. Null is "no
   * answer", never 0: a mode of zero is a real and very different posture. */
  readonly fileMode: (path: string) => number | null;
  readonly setFileMode: (path: string, mode: number) => void;
  readonly realpath: (path: string) => string;
  readonly ownerUid: (path: string) => number;
  readonly diskFree: (path: string) => { readonly available: number; readonly total: number };
  readonly allow_roots: readonly string[];
  readonly min_free_bytes: number;
};

/**
 * CLAUDE.md §8 and the P0-07 acceptance line: this adapter writes the autostart manifest and
 * prints the procedure; it never runs the service manager itself. The deny-list turns that from a
 * convention into a throw at the one choke point EVERY LAUNCH THIS ADAPTER MAKES goes through, so an
 * agent that later "just adds a load step" here fails a test rather than shipping it. It says
 * nothing about a process started by any other route — see the header.
 *
 * Every entry must be an ASCII identifier, because this same list is handed to
 * `refuseSessionCommand`, whose comparison has no answer for a folded name outside ASCII and
 * refuses rather than guessing. CASE is not a requirement: `guard` folds the entry as well as the
 * candidate, so an entry added in mixed case still matches. It used to be a requirement in effect
 * and nowhere in the code -- see `guard`.
 */
export const GUARDED_BINARIES = ['launchctl', 'sudo', 'defaults', 'systemsetup', 'csrutil'];

export class GuardedCommandError extends Error {}

/**
 * The one mode an autostart manifest this adapter owns is allowed to sit at. One constant, because
 * it is now applied from two places -- `writeFile` on the descriptor it just truncated, and
 * `restrictAccess` on a file whose body nothing rewrote -- and two literals that must agree are a
 * later divergence waiting to happen.
 *
 * `man launchctl`: a LaunchAgent under the loading user's home must be owned by that user and must
 * not be group- or world-WRITABLE. There is no read requirement, so 0600 satisfies it. That is
 * read from the manual page, not from an executed `launchctl bootstrap`; the owner procedure is
 * where a real load gets verified (`ownerProcedure`).
 */
export const MANIFEST_MODE = 0o600;

/**
 * The one choke point. `guarded` defaults to the list above; `run` never passes another, and the
 * parameter exists for the same reason `refuseSessionCommand` takes one -- the host owns the names,
 * this function owns the comparison -- which is also what makes the comparison testable against an
 * entry the canonical list cannot contain.
 */
export const guard = (
  argv: readonly string[],
  guarded: readonly string[] = GUARDED_BINARIES,
): void => {
  // Folded on BOTH SIDES by the contract's rule rather than compared raw. This is the sibling of
  // the session deny-list and had the same correctness bug: a comparison decided by code points,
  // against a volume that opens `/usr/bin/LAUNCHCTL` and `/usr/bin/launchctl` as one file. Folding
  // only the candidate and matching with `includes` fixed the reported half and left the other one
  // resting on a property of the DATA -- every entry happens to be lowercase ASCII today -- so an
  // entry added later in mixed case would have stopped matching in silence. One rule, imported
  // rather than re-spelled, applied to both operands, so the next folding fix lands in one place.
  const binary = foldProgramName(argv[0] ?? '');
  if (guarded.some((g) => foldProgramName(g) === binary)) {
    throw new GuardedCommandError(
      `${binary} is owner-run only: this adapter prints the procedure, it never executes it`,
    );
  }
};

/** The real host. Constructed explicitly by the composition root, never implicitly at import. */
export const defaultDarwinEnv = (overrides: Partial<DarwinEnv> = {}): DarwinEnv => {
  const home = overrides.home ?? homedir();
  let uid: number | null;
  try {
    uid = userInfo().uid;
  } catch {
    // No user id is `null`, not 0. Guessing root here would make `gui/<uid>` in the owner
    // procedure quietly wrong.
    uid = null;
  }
  return {
    home,
    user_id: uid,
    now: () => new Date(),
    // `shell: false` (the default) is deliberate: nothing here is ever re-parsed by a shell.
    run: (argv) => {
      guard(argv);
      const [binary, ...args] = argv;
      if (binary === undefined) return { code: null, stdout: '', stderr: '', error: 'empty argv' };
      const out = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000 });
      return {
        code: out.status,
        stdout: out.stdout ?? '',
        stderr: out.stderr ?? '',
        error: out.error === undefined ? null : out.error.message,
      };
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    /**
     * The only thing this adapter puts on a real disk, and it is the autostart manifest.
     *
     * WHY THE MODE IS 0600. The manifest renders `plan.environment` verbatim and then survives a
     * reboot, so the file is a durable, cleartext copy of whatever map a caller passed. Nothing
     * validates or redacts that map today, which makes the mode the only thing deciding who may
     * read it. It was 0644 (measured: umask 022 against `writeFileSync`'s default 0666), so every
     * local account could. The login agent that consumes this file runs in this user's own domain,
     * as this uid, so an owner-only read is the whole of the access the service manager needs, and
     * there is no group or other-user reader to widen for.
     *
     * WHAT 0600 DOES NOT DO, so that nobody reads more into it than it keeps: anything already
     * running as this user can read this file, so the mode is a boundary against OTHER LOCAL
     * ACCOUNTS and not a secret store. It says nothing about backups or snapshots of the file, and
     * nothing about the values once the launched process holds them in its environment. A secret
     * belongs in the credential broker (blueprint §12.1), not here, and this mode does not change
     * that.
     *
     * WHAT THIS FUNCTION COVERS, precisely, because an earlier version of this comment claimed
     * more than the code did. It narrows every manifest it WRITES, including a rewrite over an
     * older 0644 one. It does NOT reach a manifest whose body is already identical, because the
     * autostart contract does not call it then and re-writing unchanged bytes is not this
     * function's decision to make. That case -- the same plan re-installed after an adapter
     * upgrade, which is the common one -- is `restrictAccess` in `autostart.ts`, and it runs on
     * every install and every repair whether or not this function was called at all.
     *
     * The containing directory is NOT narrowed, and this comment says so rather than letting a
     * reader assume it: `mkdirSync` creates it with this process's default when it is missing
     * (0755 under a 0022 umask, measured) and leaves it alone when it already exists. It is shared
     * with every other login agent on the machine, and its mode decides who may LIST the unit ids
     * in it, not who may read what is inside this file. That second question is the mode above.
     */
    writeFile: (path, body) => {
      mkdirSync(dirname(path), { recursive: true });
      // The mode passed to `open` applies only when this call CREATES the file: an existing
      // manifest -- including a 0644 one an earlier version of this adapter wrote -- would keep the
      // mode it already had. So narrow it on the descriptor, after the truncate and before any byte
      // of the new body is in the file, rather than chmod-ing afterwards.
      const fd = openSync(path, 'w', MANIFEST_MODE);
      try {
        fchmodSync(fd, MANIFEST_MODE);
        writeFileSync(fd, body, 'utf8');
      } finally {
        closeSync(fd);
      }
    },
    fileMode: (path) => {
      try {
        return statSync(path).mode & 0o7777;
      } catch {
        return null;
      }
    },
    setFileMode: (path, mode) => chmodSync(path, mode),
    realpath: (path) => realpathSync.native(path),
    ownerUid: (path) => statSync(path).uid,
    diskFree: (path) => {
      const s = statfsSync(path);
      return { available: s.bavail * s.bsize, total: s.blocks * s.bsize };
    },
    allow_roots: [home],
    min_free_bytes: 5 * 1024 ** 3,
    ...overrides,
  };
};
