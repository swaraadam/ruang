/**
 * Everything this adapter is allowed to do to the machine, as one injectable record.
 *
 * Two reasons it is a parameter and not a set of imports. It lets the contract suite drive the
 * real adapter on any platform against a scripted host — a stronger proof than skipping half the
 * suite off-Darwin. And it puts every process launch behind one function, which is what makes
 * `GUARDED_BINARIES` an enforceable promise rather than a claim about code nobody re-reads.
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
 * convention into a throw at the single choke point every launch goes through, so an unattended
 * agent that later "just adds a load step" fails a test instead of gaining a start-up foothold.
 */
export const GUARDED_BINARIES = ['launchctl', 'sudo', 'defaults', 'systemsetup', 'csrutil'];

export class GuardedCommandError extends Error {}

export const guard = (argv: readonly string[]): void => {
  const binary = (argv[0] ?? '').split('/').pop() ?? '';
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
