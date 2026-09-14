/**
 * The only place this package starts a process. `runGit` reaches the source of record and is
 * restricted to an allow-list of subcommands *and*, where a subcommand has verbs of its own, of
 * verb pairs — so the adapter cannot grow a push, a merge or a history rewrite by accident. Apply
 * is planned here and executed by the spine's broker (§5.2.2), never from inside. `runProcess`
 * runs a declared check's argv and has no such list, because a check is arbitrary by definition;
 * it is still argv, never a shell string.
 */
import { spawn } from 'node:child_process';

export type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
};

/**
 * Read-only queries plus the sandbox lifecycle. `push`, `merge`, `rebase`, `reset`, `branch` and
 * `tag` are absent on purpose and adding one is a reviewable act.
 */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'rev-parse',
  'hash-object',
  'status',
  'diff',
  'ls-files',
  'cat-file',
  'worktree',
]);

/**
 * The one entry on the list above that carries verbs of its own, and only three are ever used:
 * naming the subcommand alone would admit `lock`, `move` and `repair` as well.
 */
const ALLOWED_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['worktree', new Set(['add', 'remove', 'prune'])],
]);

const DEFAULT_TIMEOUT_MS = 60_000;
// Non-interactive by construction: no terminal prompt, no optional index lock, no pager, and a
// stable locale so parsing is not localised.
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
/** Global options this package always passes, before any subcommand. */
const ALWAYS = ['--no-pager', '--no-optional-locks', '-c', 'core.quotePath=false'];

// prettier-ignore
export const runProcess = (cwd: string, argv: readonly string[], timeout_ms = DEFAULT_TIMEOUT_MS): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const [file, ...rest] = argv;
    if (file === undefined) {
      resolve({ code: -1, stdout: '', stderr: 'empty invocation', timed_out: false });
      return;
    }
    const env = { ...process.env, ...ENV };
    const child = spawn(file, rest, { cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timed_out = false;
    const done = (code: number, extra = ''): void =>
      resolve({ code, stdout, stderr: `${stderr}${extra}`, timed_out });
    const timer = setTimeout(
      () => {
        timed_out = true;
        child.kill('SIGKILL');
      },
      Math.max(1, timeout_ms),
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      done(-1, e.message);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
  });

// `async` so a refused subcommand rejects rather than throwing synchronously at every call site.
// prettier-ignore
export const runGit = async (cwd: string, args: readonly string[], ms?: number): Promise<ProcessResult> => {
  const sub = args[0];
  // Internal guard, not a seam error: reaching it is a defect in this package, not a state the
  // spine can drive the adapter into.
  if (sub === undefined || !ALLOWED_SUBCOMMANDS.has(sub))
    throw new Error(`adapter-domain-code: subcommand not on the allow-list: ${sub ?? '(none)'}`);
  const verbs = ALLOWED_VERBS.get(sub);
  if (verbs !== undefined && !verbs.has(args[1] ?? ''))
    throw new Error(`adapter-domain-code: verb not on the allow-list: ${sub} ${args[1] ?? '(none)'}`);
  return runProcess(cwd, ['git', ...ALWAYS, ...args], ms);
};
