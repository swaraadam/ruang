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
  mkdirSync,
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
 * Every entry is a lowercase ASCII identifier, which is what lets `foldProgramName` decide the
 * comparison; `GUARDED_BINARIES` and `refuseSessionCommand`'s `guarded` are the same list.
 */
export const GUARDED_BINARIES = ['launchctl', 'sudo', 'defaults', 'systemsetup', 'csrutil'];

export class GuardedCommandError extends Error {}

export const guard = (argv: readonly string[]): void => {
  // Folded by the contract's rule rather than compared raw. This is the sibling of the session
  // deny-list and had the same correctness bug: a comparison decided by code points, against a
  // volume that opens `/usr/bin/LAUNCHCTL` and `/usr/bin/launchctl` as one file. One rule, imported
  // rather than re-spelled, so the next folding fix lands in one place.
  const binary = foldProgramName(argv[0] ?? '');
  if (GUARDED_BINARIES.includes(binary)) {
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
    writeFile: (path, body) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, 'utf8');
    },
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
