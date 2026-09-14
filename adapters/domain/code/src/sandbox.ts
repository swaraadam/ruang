/**
 * Sandbox lifecycle: a git worktree under the configured sandbox root (§5.3, §5.2.3, §10.4). The
 * location is *derived* from the ids, never remembered: the spine restarts, and a sandbox it can no
 * longer find would be one whose dirty work it silently assumes away — invariant 7 says one
 * authoritative home per fact, and the filesystem is that home for this one.
 */
// prettier-ignore
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// prettier-ignore
import type { Basis, ClosePolicy, SafetyRecord, Sandbox, SandboxInspection } from '@internal/domain';
import { basisStaleness } from './basis.js';
import { isPathSafeId, under } from './paths.js';
import { runGit } from './process.js';
import { AdapterRefusal, type CodeAdapterOptions } from './surface.js';

/**
 * Every path in this module is derived from an id the caller chose, and one of them is handed to a
 * recursive delete. An id this adapter could not have issued therefore locates *nothing*: refused
 * at the derivation, once, so no call site can forget it.
 */
const locate = (root: string, sandbox_id: string): string => {
  const full = isPathSafeId(sandbox_id) ? under(root, sandbox_id) : null;
  if (full === null)
    throw new AdapterRefusal(
      'unsafe_identifier',
      'this sandbox identifier is not one this adapter could have issued, so it locates nothing',
    );
  return full;
};

export const sandboxPath = (o: CodeAdapterOptions, sandbox_id: string): string =>
  locate(join(o.sandbox_root, o.project_id), sandbox_id);

export const artifactDir = (o: CodeAdapterOptions, sandbox_id: string): string =>
  locate(o.artifacts_root, sandbox_id);

export const retainedArtifacts = (o: CodeAdapterOptions, id: string): readonly string[] => {
  const dir = artifactDir(o, id);
  return existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((name) => join(dir, name))
    : [];
};

export const openSandbox = async (o: CodeAdapterOptions, basis: Basis): Promise<Sandbox> => {
  // Invariant 4: `unknown` refuses mutation, and materialising a sandbox is a mutation.
  const staleness = await basisStaleness(o.source_of_record, basis);
  if (staleness.state === 'unknown')
    throw new AdapterRefusal(
      'basis_unknown',
      `refusing to open a sandbox against an unknown basis: ${staleness.reason}`,
    );
  const sandbox_id = (o.new_id ?? defaultId)();
  mkdirSync(join(o.sandbox_root, o.project_id), { recursive: true });
  const path = sandboxPath(o, sandbox_id);
  const r = await runGit(o.source_of_record, ['worktree', 'add', '--detach', path, basis.ref]);
  if (r.code !== 0)
    throw new AdapterRefusal('sandbox_not_materialised', 'the sandbox could not be materialised');
  return { sandbox_id, project_id: o.project_id, basis };
};

const defaultId = (): string =>
  `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Counted from the porcelain status codes; the words that leave here are the core's, not git's. */
const summarise = (lines: readonly string[]): string => {
  const count = (p: (c: string) => boolean): number => lines.filter((l) => p(l.slice(0, 2))).length;
  const conflicted = count((c) => c.includes('U') || c === 'AA' || c === 'DD');
  const added = count((c) => c === '??' || c.includes('A'));
  const removed = count((c) => c.includes('D') && c !== 'DD');
  const changed = lines.length - conflicted - added - removed;
  return `${lines.length} resource(s) with unsaved changes (${Math.max(0, changed)} modified, ${added} added, ${removed} removed, ${conflicted} conflicted)`;
};

/**
 * §5.2.3: non-mutating and callable at any time. Every command below is a query, and the runner
 * refuses the optional index lock, so calling this cannot change what a later call would report.
 */
export const inspectSandbox = async (
  o: CodeAdapterOptions,
  sandbox: Sandbox,
): Promise<SandboxInspection> => {
  const path = sandboxPath(o, sandbox.sandbox_id);
  const artifacts = retainedArtifacts(o, sandbox.sandbox_id);
  const state = (dirty: boolean, unsaved_summary: string): SandboxInspection => ({
    dirty,
    unsaved_summary,
    retained_artifacts: artifacts,
    safe_to_close: !dirty,
  });
  if (!existsSync(path)) return state(false, 'this sandbox is not present');
  const r = await runGit(path, ['status', '--porcelain=v1']);
  // Cannot tell is not the same as clean. Fail closed: assume there is work to lose.
  if (r.code !== 0) return state(true, 'the state of this sandbox cannot be determined');
  const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
  const dirty = lines.length > 0;
  return state(dirty, dirty ? summarise(lines) : 'no unsaved changes');
};

/**
 * §10.4. A dirty sandbox is never torn down silently: without `force` the close is refused and the
 * refusal is the record; with `force` the unsaved work is written out as an artifact *first*, so a
 * SafetyRecord that says "closed" can also say where the work went.
 */
export const closeSandbox = async (
  o: CodeAdapterOptions,
  sandbox: Sandbox,
  policy: ClosePolicy,
): Promise<SafetyRecord> => {
  const inspection = await inspectSandbox(o, sandbox);
  if (!inspection.safe_to_close && !policy.force)
    return {
      sandbox_id: sandbox.sandbox_id,
      closed: false,
      retained_artifacts: inspection.retained_artifacts,
      refused_reason: `close refused: ${inspection.unsaved_summary}`,
    };

  // `retain_artifacts: false` discards check output, and is applied *before* the rescue below so
  // that a policy about evidence is never a licence to destroy the work itself.
  if (!policy.retain_artifacts)
    rmSync(artifactDir(o, sandbox.sandbox_id), { recursive: true, force: true });
  const path = sandboxPath(o, sandbox.sandbox_id);
  if (inspection.dirty && existsSync(path)) await rescueUnsavedWork(o, sandbox.sandbox_id, path);
  if (existsSync(path)) {
    const r = await runGit(o.source_of_record, ['worktree', 'remove', '--force', path]);
    if (r.code !== 0)
      return {
        sandbox_id: sandbox.sandbox_id,
        closed: false,
        retained_artifacts: retainedArtifacts(o, sandbox.sandbox_id),
        refused_reason: 'the sandbox could not be released',
      };
    await runGit(o.source_of_record, ['worktree', 'prune']);
  }
  return {
    sandbox_id: sandbox.sandbox_id,
    closed: true,
    retained_artifacts: retainedArtifacts(o, sandbox.sandbox_id),
    refused_reason: null,
  };
};

const rescueUnsavedWork = async (
  o: CodeAdapterOptions,
  sandbox_id: string,
  path: string,
): Promise<void> => {
  const patch = await runGit(path, ['diff', '--no-color', 'HEAD']);
  const others = await runGit(path, ['ls-files', '--others', '--exclude-standard']);
  const dir = artifactDir(o, sandbox_id);
  mkdirSync(dir, { recursive: true });

  // A patch is TEXT, and loses two whole classes of content on its own: a resource never added to
  // the index appears only as a *name* in that listing, and a changed binary renders as "Binary
  // files ... differ". The caller is about to force a teardown, so those bytes have no other home
  // -- and `retained_artifacts` would still report the work as retained.
  //
  // That is invariant 1 in the one record someone reads before deciding a sandbox is safe to
  // destroy, so bytes that are the sandbox's own are copied rather than described. Named for what
  // it holds, not for how the substrate classified it: a reader wants the resource back, not a
  // lesson about index state.
  const unretained: string[] = [];
  for (const rel of await unrecordedByPatch(path)) {
    const from = under(path, rel);
    const to = under(dir, 'unsaved-resources', rel);
    if (from === null || to === null) {
      unretained.push(`${rel}: names a location outside this sandbox`);
      continue;
    }
    const entry = lstatSync(from, { throwIfNoEntry: false });
    // A deletion is already fully described by the patch, and has no bytes left to copy.
    if (entry === undefined) continue;
    // A reference is not content, and it is never followed. Its bytes belong to whatever it names
    // -- anywhere on the host, an owner's keys included -- and copying those into a retained
    // artifact would rescue something that was never this sandbox's work. What the reference says
    // *is* the resource, so that is what the record keeps.
    if (entry.isSymbolicLink()) {
      unretained.push(
        `${rel}: a reference to ${readlinkSync(from)}, recorded rather than followed`,
      );
      continue;
    }
    if (!entry.isFile()) {
      unretained.push(`${rel}: not a resource whose bytes can be retained`);
      continue;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    } catch {
      unretained.push(`${rel}: could not be retained`);
    }
  }

  // What was *not* retained belongs in the record too. A rescue that drops a resource in silence
  // reads exactly like one that had nothing to drop, and this is the record someone reads before
  // accepting the loss -- invariant 1 again, from the other side.
  writeFileSync(
    join(dir, 'unsaved-work.txt'),
    [
      patch.stdout,
      '--- resources present only in the sandbox ---',
      others.stdout,
      '--- resources whose bytes were not retained ---',
      unretained.length > 0 ? `${unretained.join('\n')}\n` : '(none)\n',
    ].join('\n'),
    'utf8',
  );
};

/**
 * The resources whose *content* the patch does not carry: everything untracked, plus every changed
 * resource the diff declined to render. `--numstat` marks the second kind with `-` in both count
 * columns, which is the only place that distinction is reported without parsing the diff body.
 */
const unrecordedByPatch = async (path: string): Promise<readonly string[]> => {
  // NUL-delimited: a path may contain a space, and `ls-files` would otherwise quote and escape it,
  // producing a name that does not exist on disk.
  const untracked = await runGit(path, ['ls-files', '--others', '--exclude-standard', '-z']);
  // Same `-z`, same reason, and it was missing here: git C-quotes a name containing a control
  // character, a quote or a backslash whatever `core.quotePath` says, so without it the name comes
  // back in a spelling that does not exist on disk and the copy above skips it -- a teardown that
  // reports the work as retained and keeps none of it. `--no-renames` keeps every record one field.
  const unrendered = await runGit(path, ['diff', '--numstat', '--no-renames', '-z', 'HEAD']);
  return [
    ...new Set([
      ...untracked.stdout.split('\0').filter((p) => p.length > 0),
      ...unrendered.stdout
        .split('\0')
        .filter((l) => l.startsWith('-\t-\t'))
        .map((l) => l.slice(4))
        .filter((p) => p.length > 0),
    ]),
  ];
};
