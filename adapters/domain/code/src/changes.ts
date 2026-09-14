/**
 * ChangeSet and ChangeAnchor over text patches (§5.2.1, §5.3). An anchor is a file plus a range of
 * lines, read from the patch's own range headers rather than guessed. A file the substrate reports
 * as binary is emitted as `asset_delta` instead of being squeezed into a text shape — reporting it
 * as "0 lines changed" would be a lie the office would then animate (invariant 1).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RenderSurface, Sandbox } from '@internal/domain';
import {
  type ChangeAnchor,
  type ChangeSet,
  type RenderableChange,
  changeSetHash,
  isRenderableChange,
} from '@internal/protocol';
import { runGit } from './process.js';
import { sandboxPath } from './sandbox.js';
import type { CodeAdapterOptions } from './surface.js';

/** Ranges live in the `+` side of a patch range header: `@@ -a,b +c,d @@`. */
const RANGE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const FILE_HEADER = /^\+\+\+ b\/(.*)$/;
/** Anything larger is treated as an asset rather than read into memory to count lines. */
const MAX_TEXT_BYTES = 1_000_000;

type Counts = { added: number; removed: number; binary: boolean };

const parseCounts = (numstat: string): Map<string, Counts> => {
  const out = new Map<string, Counts>();
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [a, r] = parts;
    const path = parts.slice(2).join('\t');
    const binary = a === '-' || r === '-';
    out.set(path, { added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary });
  }
  return out;
};

const parseAnchors = (patch: string): Map<string, ChangeAnchor[]> => {
  const out = new Map<string, ChangeAnchor[]>();
  let current: string | null = null;
  for (const line of patch.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    const range = RANGE.exec(line);
    if (range === null || current === null) continue;
    const start = Number(range[1]);
    const span = Math.max(range[2] === undefined ? 1 : Number(range[2]), 1);
    out.get(current)?.push(textRange(current, start, start + span - 1));
  }
  return out;
};

const textRange = (resource_id: string, start_line: number, end_line: number): ChangeAnchor => ({
  kind: 'text_range',
  resource_id,
  start_line,
  end_line,
});

const lineCount = (path: string): number => {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
};

// prettier-ignore
const assetChange = async (root: string, ref: string, id: string, full: string): Promise<RenderableChange> => {
  const before = await runGit(root, ['cat-file', '-s', `${ref}:${id}`]);
  const was = before.code === 0 ? Number(before.stdout.trim()) : 0;
  const now = existsSync(full) ? statSync(full).size : 0;
  // Artifact references (§14.3), never inline bytes: a change must fit inside an event payload.
  const refs = { before_ref: `${ref}:${id}`, after_ref: `sandbox:${id}` };
  return { kind: 'asset_delta', asset_id: id, ...refs, bytes_delta: now - was };
};

export const computeChangeSet = async (
  o: CodeAdapterOptions,
  sandbox: Sandbox,
): Promise<ChangeSet> => {
  const path = sandboxPath(o, sandbox.sandbox_id);
  const ref = sandbox.basis.ref;
  const counts = parseCounts((await runGit(path, ['diff', '--numstat', 'HEAD'])).stdout);
  const anchors = parseAnchors(
    (await runGit(path, ['diff', '--unified=0', '--no-color', 'HEAD'])).stdout,
  );
  const others = (await runGit(path, ['ls-files', '--others', '--exclude-standard'])).stdout
    .split('\n')
    .filter((l) => l.length > 0);

  const changes: RenderableChange[] = [];
  const asset = (resource_id: string): Promise<RenderableChange> =>
    assetChange(o.source_of_record, ref, resource_id, join(path, resource_id));
  for (const [resource_id, c] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const { binary, ...counted } = c;
    const anchors_for = anchors.get(resource_id) ?? [];
    const patch = { kind: 'text_patch', resource_id, anchors: anchors_for } as const;
    changes.push(binary ? await asset(resource_id) : { ...patch, ...counted });
  }
  // A resource that exists only in the sandbox has no patch to read ranges from: its whole extent
  // is the change, unless it is too large to be text at all.
  for (const resource_id of others.sort()) {
    const full = join(path, resource_id);
    const size = existsSync(full) ? statSync(full).size : 0;
    if (size > MAX_TEXT_BYTES) {
      changes.push(await asset(resource_id));
      continue;
    }
    const lines = size === 0 ? 0 : lineCount(full);
    const whole = lines > 0 ? [textRange(resource_id, 1, lines)] : [];
    changes.push({ kind: 'text_patch', resource_id, anchors: whole, added: lines, removed: 0 });
  }

  const added = changes.reduce((n, c) => n + (c.kind === 'text_patch' ? c.added : 0), 0);
  const removed = changes.reduce((n, c) => n + (c.kind === 'text_patch' ? c.removed : 0), 0);
  const change_unit = o.change_unit ?? 'lines';
  const body = {
    change_set_id: '',
    summary: `${changes.length} resource(s) changed (+${added} -${removed})`,
    change_unit,
    change_size: change_unit === 'files' ? changes.length : added + removed,
    changes,
  } as const;
  // The id is excluded from the hash, so two captures of an unchanged sandbox are one review under
  // two identities — contract item 4.
  const change_set_id = (o.new_id ?? (() => `c${Date.now().toString(36)}`))();
  return { ...body, change_set_id, content_hash: changeSetHash(body) };
};

const ANCHOR_BUDGET: Readonly<Record<RenderSurface, number>> = {
  review: Number.POSITIVE_INFINITY,
  mobile: 3,
  office: 1,
};

/**
 * Surface-aware rendering is an anchor *budget*, never a content filter: every change comes back
 * with its counts intact, so a small screen shows less detail and never less change. Each result is
 * re-validated against the closed union, so a bug fails here rather than at a renderer with no case.
 */
export const renderChangeSet = (
  change_set: ChangeSet,
  surface: RenderSurface,
): readonly RenderableChange[] => {
  const budget = ANCHOR_BUDGET[surface];
  return change_set.changes.map((change) => {
    const capped: RenderableChange =
      change.kind === 'asset_delta' || change.anchors.length <= budget
        ? change
        : { ...change, anchors: change.anchors.slice(0, budget) };
    if (!isRenderableChange(capped))
      throw new Error('adapter-domain-code: produced a change outside the closed protocol union');
    return capped;
  });
};
