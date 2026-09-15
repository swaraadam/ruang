/**
 * Sandbox lifecycle, opening and inspection only: a git worktree under the configured sandbox root
 * (§5.3, §5.2.3). Teardown is issue #108, and until it lands nothing in this package deletes a
 * sandbox — `locate` below is still written as though something did, because something will. The
 * location is *derived* from the ids, never remembered: the spine restarts, and a sandbox it can no
 * longer find would be one whose dirty work it silently assumes away — invariant 7 says one
 * authoritative home per fact, and the filesystem is that home for this one.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Basis, Sandbox, SandboxInspection } from '@internal/domain';
import { basisStaleness } from './basis.js';
import { isPathSafeId, under } from './paths.js';
import { runGit } from './process.js';
import { AdapterRefusal, type CodeAdapterOptions } from './surface.js';

/**
 * Every path in this module is derived from an id the caller chose. An id this adapter could not
 * have issued therefore locates *nothing*: refused at the derivation, once, so no call site can
 * forget it.
 *
 * Guarded here rather than at the one call site that needs it, because which call site needs it
 * changes. Nothing in this package deletes anything today; teardown (#108) is destructive at the end
 * of exactly this derivation, and the rule it depends on should already be in place and already
 * tested when it arrives rather than being added alongside it.
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
  // Only the two status columns are read, never the name beside them, so an escaped spelling here
  // changes nothing: a quoted name is still exactly one record on one line.
  const r = await runGit(path, ['status', '--porcelain=v1']);
  // Cannot tell is not the same as clean. Fail closed: assume there is work to lose.
  if (r.code !== 0) return state(true, 'the state of this sandbox cannot be determined');
  const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
  const dirty = lines.length > 0;
  return state(dirty, dirty ? summarise(lines) : 'no unsaved changes');
};
