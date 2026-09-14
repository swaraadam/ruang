/**
 * The only place this package starts a process. `runGit` reaches the source of record and is
 * restricted to an allow-list of subcommands *and*, where a subcommand has verbs of its own, of
 * verb pairs — so the adapter cannot grow a push, a merge or a history rewrite by accident. Apply
 * is planned here and executed by the spine's broker (§5.2.2), never from inside. `runProcess`
 * runs a declared check's argv and has no such list, because a check is arbitrary by definition;
 * it is still argv, never a shell string.
 *
 * An allow-list of subcommands only constrains what is *asked*. What is *answered* also depends on
 * the environment the child is given, which is why `gitEnv` below constructs one.
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
/**
 * Global options this package always passes, before any subcommand.
 *
 * `core.quotePath=false` covers non-ASCII names and **nothing else**: a control character, a quote
 * or a backslash is still escaped into a spelling that names nothing on disk. Any query whose
 * stdout is read *as a path* therefore needs `-z` as well, and the callers that read one say so at
 * the call site. Three of them did not, which is the same defect three times.
 */
const ALWAYS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.quotePath=false',
  // Two settings turn a read into an execution, and both are reachable from the repository's own
  // configuration -- which a sandbox shares with its source of record and cannot be pinned away.
  // A command-line `-c` outranks every configuration file, so they are overridden by name here.
  // `diff.external` is `GIT_EXTERNAL_DIFF` spelled differently; `core.fsmonitor` is reached by
  // `inspect_sandbox`, a method §5.2.3 promises is non-mutating.
  '-c',
  'diff.external=',
  '-c',
  'core.fsmonitor=',
];

/**
 * Options this package always passes to one subcommand, immediately after it.
 *
 * `-c` can only pin a key it can *name*, and a diff driver's name comes from the sandbox's own
 * content: `.gitattributes` selects `diff=<name>` and the configuration supplies
 * `diff.<name>.command` or `diff.<name>.textconv`, either of which runs a program on every read.
 * The class is therefore closed per invocation instead of by name, and neither option changes what
 * the answer means -- an external driver only decides how a difference is rendered, never whether
 * there is one.
 *
 * `status` is the same file reaching the same methods from the other direction, and it is the
 * destructive one: `status.showUntrackedFiles=no` made `inspect_sandbox` report a sandbox holding
 * the only copy of a resource as having no unsaved changes, and `close_sandbox` -- *without*
 * `force`, on the strength of that report -- destroyed it (§10.4, invariant 3). What a listing
 * mentions is this package's question. What counts as work at all is still the source of record's,
 * so its ignore rules are honoured exactly as they stand.
 */
const SUBCOMMAND_ALWAYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['diff', ['--no-ext-diff', '--no-textconv']],
  ['status', ['--untracked-files=normal']],
]);

type Env = Record<string, string | undefined>;

/**
 * A declared check's environment, which is still the parent's. That is a **known gap and not what
 * this file settles**: a check's argv belongs to the Project, so narrowing what it may read changes
 * what a Project is allowed to declare, and that is an owner's call rather than an adapter's.
 */
const inheritedEnv = (): Env => ({ ...process.env, ...ENV });

/**
 * Git reads configuration from files as well as from variables. The **user and system** files are
 * pinned to nothing. The **repository's own** file is not pinned and cannot be: a sandbox shares it
 * with its source of record, so `git config` run inside a sandbox changes what this package reads
 * outside one, and it persists there after the sandbox is gone. What is done instead is to override
 * the settings that turn a read into an execution, by name, at `ALWAYS` and `SUBCOMMAND_ALWAYS`
 * above -- where nothing in a file can outrank them.
 *
 * Two channels in the same class stay open, named here rather than implied away, because closing
 * either would change what a sandbox *contains* rather than how this package reads it:
 *
 *   - `filter.<name>.clean|smudge|process`, selected by an attribute in the content itself. No
 *     option refuses it, the driver name is content, and it is how large-asset storage legitimately
 *     works -- suppressing it would hand back resources that are not what the source of record says.
 *   - Repository hooks, which fire when a sandbox is materialised or released. They are the owner's
 *     own programs in the owner's own source of record, and the same storage integrations install
 *     them, so refusing to run them would quietly change what a sandbox is.
 *
 * Both are the owner's decision, like the check environment above, and neither is settled here.
 */
const NO_CONFIG = '/dev/null';
/** `PATH` decides which program runs and is this process's own identity, not a caller's input. */
const INHERITED_BY_GIT = ['PATH', 'HOME', 'TMPDIR'] as const;

/**
 * The environment for a substrate invocation is **constructed, never inherited**.
 *
 * The only containment this package has for *which* source of record a query reads is the working
 * directory it hands the child — and `GIT_DIR` overrides a working directory. One inherited
 * variable made the basis capture return a ref belonging to a source of record this adapter had
 * never been pointed at: invariant 4's fail-closed gate describing something else entirely, and
 * invariant 7's one authoritative home per fact quietly becoming two. `GIT_EXTERNAL_DIFF` is the
 * same seam in the other direction, turning a read into "run this program".
 *
 * An allow-list rather than a deny-list of substrate variables, because a deny-list has to stay
 * complete against a substrate that keeps adding them and this one is complete by construction.
 * Refusing when a hostile variable is present was the other candidate and it is weaker twice over:
 * it leaves behaviour depending on an environment this package does not control, when it can simply
 * decline to inherit one — and it would strand an owner whose shell exports one for unrelated
 * reasons. Explicit `--git-dir` was the third, and it closes only the variable it names while
 * teaching this package the substrate's on-disk layout, which a sandbox does not share with its
 * source of record anyway.
 *
 * The user and system configuration files go the same way: `diff.external` in a user-level file is
 * `GIT_EXTERNAL_DIFF` spelled differently, and every query here is a read that needs no user
 * configuration to answer. The repository's own file is a different problem, because a sandbox
 * shares it -- see `NO_CONFIG` below.
 */
const gitEnv = (): Env => {
  const env: Env = { ...ENV, GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_CONFIG_SYSTEM: NO_CONFIG };
  for (const name of INHERITED_BY_GIT) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

// prettier-ignore
export const runProcess = (cwd: string, argv: readonly string[], timeout_ms = DEFAULT_TIMEOUT_MS, env: Env = inheritedEnv()): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const [file, ...rest] = argv;
    if (file === undefined) {
      resolve({ code: -1, stdout: '', stderr: 'empty invocation', timed_out: false });
      return;
    }
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
  return runProcess(cwd, ['git', ...ALWAYS, sub, ...(SUBCOMMAND_ALWAYS.get(sub) ?? []), ...args.slice(1)], ms, gitEnv());
};
