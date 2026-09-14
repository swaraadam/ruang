/**
 * ChangeSet and ChangeAnchor over text patches (§5.2.1, §5.3). An anchor is a file plus a range of
 * lines, read from the patch's own range headers rather than guessed. A file the substrate reports
 * as binary is emitted as `asset_delta` instead of being squeezed into a text shape — reporting it
 * as "0 lines changed" would be a lie the office would then animate (invariant 1).
 */
import { type Stats, lstatSync, readFileSync } from 'node:fs';
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
const RANGE = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/**
 * Either spelling of the patch's new-side header: `+++ b/name`, or `+++ "b/na\tme"` when quoted.
 *
 * The optional tab sits **outside** the alternation, and that placement is the whole point. The
 * substrate appends it when the *rendered label* contains a space -- and a quoted label includes
 * its quotes, so the tab lands after the closing one. Handling it on the unquoted branch alone
 * matched neither branch for a name that is quoted *and* spaced: four of twelve name shapes
 * resolved to nothing and silently lost every range they owned.
 */
const FILE_HEADER = /^\+\+\+ (?:"(.*)"|(.*?))\t?$/;
const NEW_SIDE_PREFIX = 'b/';
/** Anything larger is treated as an asset rather than read into memory to count lines. */
const MAX_TEXT_BYTES = 1_000_000;

type Counts = { added: number; removed: number; binary: boolean };

/**
 * NUL-delimited records, `added \t removed \t name`. A name is caller-controlled content, and every
 * listing that is not NUL-delimited comes back C-quoted once the name holds a control character, a
 * quote or a backslash — whatever `core.quotePath` says, which only covers non-ASCII. Read back,
 * that spelling names nothing on disk.
 *
 * The tab split survives a name containing tabs because only the first two fields are counts.
 */
const parseCounts = (numstat: string): Map<string, Counts> => {
  const out = new Map<string, Counts>();
  for (const record of numstat.split('\0')) {
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const [a, r] = parts;
    const path = parts.slice(2).join('\t');
    const binary = a === '-' || r === '-';
    out.set(path, { added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary });
  }
  return out;
};

/** The escapes the substrate uses when it quotes a name; anything else is a three-digit octal byte. */
const UNESCAPE: ReadonlyMap<string, string> = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['"', '"'],
  ['\\', '\\'],
]);

const unquoteName = (body: string): string => {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    const short = UNESCAPE.get(body[i + 1] ?? '');
    if (short !== undefined) {
      out += short;
      i += 1;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal === null) return body;
    out += String.fromCharCode(Number.parseInt(octal[0], 8));
    i += 3;
  }
  return out;
};

/**
 * Ranges, attributed to the resource they are actually about.
 *
 * Two things make that harder than reading the header. A quoted header is not the name the rest of
 * this module uses, and a header that does not parse used to leave the previous resource selected —
 * so a quoted name's ranges were appended to the resource *before* it, and a review surface showed
 * edits against a file that does not contain them (invariant 1). And a `+++` line inside a hunk
 * body is content: a resource whose own content is a patch would otherwise redirect the parse.
 *
 * So: ranges are counted out of the hunk body, which is exactly `old + new` lines at `--unified=0`,
 * and a header only counts outside one. `known` is the authoritative set of names, taken from the
 * NUL-delimited listing; a header that does not resolve into it selects **nothing**, so an
 * unexpected spelling costs detail and can never move a range onto a resource it does not belong to.
 * Unquoting is therefore fidelity on top of a rule that is already safe without it.
 */
const parseAnchors = (patch: string, known: ReadonlySet<string>): Map<string, ChangeAnchor[]> => {
  const out = new Map<string, ChangeAnchor[]>();
  let current: string | null = null;
  let body = 0;
  for (const line of patch.split('\n')) {
    if (body > 0) {
      // "\ No newline at end of file" annotates the preceding line rather than being one of them.
      if (!line.startsWith('\\')) body -= 1;
      continue;
    }
    const range = RANGE.exec(line);
    if (range !== null) {
      const removed = range[1] === undefined ? 1 : Number(range[1]);
      const start = Number(range[2]);
      const added = range[3] === undefined ? 1 : Number(range[3]);
      body = removed + added;
      if (current === null) continue;
      out.get(current)?.push(textRange(current, start, start + Math.max(added, 1) - 1));
      continue;
    }
    const header = FILE_HEADER.exec(line);
    if (header === null) continue;
    // A name containing a space keeps the patch format's tab between the label and the timestamp
    // field that follows it, which is empty here -- so the raw spelling carries one trailing tab
    // that is not part of the name, on *either* branch (`FILE_HEADER`). A name genuinely ending in
    // a tab holds a control character and therefore arrives quoted, so the tab consumed there can
    // never be a real character.
    const named = header[1] === undefined ? (header[2] ?? '') : unquoteName(header[1]);
    // A removal's new side is the null device, which resolves to nothing and so selects nothing.
    const id = named.startsWith(NEW_SIDE_PREFIX) ? named.slice(NEW_SIDE_PREFIX.length) : '';
    current = known.has(id) ? id : null;
    if (current !== null && !out.has(current)) out.set(current, []);
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

/**
 * The lines a resource that exists only in the sandbox contributes -- read from what the entry
 * *is*, never through it.
 *
 * A reference's own content is the name it holds: one line, which is exactly what the source of
 * record would store for it. Reading through one instead counted a 137-line resource living outside
 * the sandbox as work done inside it, and, when the name led to a directory, threw the substrate's
 * own error out of `compute_change_set` -- `surface.ts` asks for a refusal, not a crash, and a raw
 * error carrying a host path is the usual way a leak escapes. Nothing else that is not a regular
 * resource has lines to count, and neither has one that vanished between the listing and this read.
 */
const untrackedLines = (full: string, entry: Stats | undefined): number => {
  if (entry === undefined) return 0;
  if (entry.isSymbolicLink()) return 1;
  if (!entry.isFile() || entry.size === 0) return 0;
  return lineCount(full);
};

// prettier-ignore
const assetChange = async (root: string, ref: string, id: string, full: string): Promise<RenderableChange> => {
  // `id` is an argument and stdout is a byte count: no path is read back out of this one.
  const before = await runGit(root, ['cat-file', '-s', `${ref}:${id}`]);
  const was = before.code === 0 ? Number(before.stdout.trim()) : 0;
  // `lstat`, never `stat`: a reference's bytes are the name it holds, and following one would
  // report the size of a resource outside the sandbox as this sandbox's own change.
  const entry = lstatSync(full, { throwIfNoEntry: false });
  const now = entry?.isDirectory() === false ? entry.size : 0;
  // Artifact references (§14.3), never inline bytes: a change must fit inside an event payload.
  const refs = { before_ref: `${ref}:${id}`, after_ref: `sandbox:${id}` };
  return { kind: 'asset_delta', asset_id: id, ...refs, bytes_delta: now - was };
};

/** What one change contributes to a size in a given unit, or `null` when that unit cannot say. */
const CONTRIBUTION: Readonly<
  Partial<Record<ChangeSet['change_unit'], (change: RenderableChange) => number | null>>
> = {
  lines: (c) => (c.kind === 'text_patch' ? c.added + c.removed : null),
  files: () => 1,
};

const subjectOf = (c: RenderableChange): string =>
  c.kind === 'asset_delta' || c.kind === 'region_delta' ? c.asset_id : c.resource_id;

/**
 * A change set's size in its declared unit, **and** the resources that unit cannot describe.
 *
 * Keeping the two apart is the point. `lines` has nothing to say about a resource that is not text,
 * and scoring one zero made "nothing changed" and "fourteen megabytes changed, in a shape I cannot
 * count" the same number: a budget gate could not tell them apart, and neither could a reader
 * (invariant 1). A unit this adapter does not count in at all -- the protocol has four, this
 * adapter offers two -- measures nothing rather than being quietly treated as lines.
 *
 * `unmeasured` is the part a single number must not be asked to carry. Whoever decides on the size
 * has to refuse rather than round the rest down to zero (invariant 4, fail closed).
 */
export const measureChangeSet = (
  changes: readonly RenderableChange[],
  change_unit: ChangeSet['change_unit'],
): { readonly size: number; readonly unmeasured: readonly string[] } => {
  const contribution = CONTRIBUTION[change_unit];
  const unmeasured: string[] = [];
  let size = 0;
  for (const change of changes) {
    const n = contribution?.(change) ?? null;
    if (n === null) unmeasured.push(subjectOf(change));
    else size += n;
  }
  return { size, unmeasured };
};

export const computeChangeSet = async (
  o: CodeAdapterOptions,
  sandbox: Sandbox,
): Promise<ChangeSet> => {
  const path = sandboxPath(o, sandbox.sandbox_id);
  const ref = sandbox.basis.ref;
  // `-z` on both listings, and `--no-renames` so every record stays one field: a name that comes
  // back quoted is a name this module then fails to find on disk, and an untracked resource it
  // cannot find is counted as zero lines. That set the apparent size of a 506-line change set to 6
  // and walked it through a budget of 20 -- the budget gate driven by a *filename*.
  const counts = parseCounts(
    (await runGit(path, ['diff', '--numstat', '--no-renames', '-z', 'HEAD'])).stdout,
  );
  // The patch body has no NUL-delimited form, so it is reconciled against the names above instead.
  const anchors = parseAnchors(
    (await runGit(path, ['diff', '--unified=0', '--no-color', 'HEAD'])).stdout,
    new Set(counts.keys()),
  );
  const others = (await runGit(path, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
    .split('\0')
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
    const entry = lstatSync(full, { throwIfNoEntry: false });
    if (entry?.isFile() === true && entry.size > MAX_TEXT_BYTES) {
      changes.push(await asset(resource_id));
      continue;
    }
    const lines = untrackedLines(full, entry);
    const whole = lines > 0 ? [textRange(resource_id, 1, lines)] : [];
    changes.push({ kind: 'text_patch', resource_id, anchors: whole, added: lines, removed: 0 });
  }

  const added = changes.reduce((n, c) => n + (c.kind === 'text_patch' ? c.added : 0), 0);
  const removed = changes.reduce((n, c) => n + (c.kind === 'text_patch' ? c.removed : 0), 0);
  const change_unit = o.change_unit ?? 'lines';
  // The same measurement the apply gate makes, so an honest change set can never be reported as
  // disagreeing with itself by the gate that measures it.
  const { size, unmeasured } = measureChangeSet(changes, change_unit);
  const rest =
    unmeasured.length > 0 ? `, ${unmeasured.length} not countable in ${change_unit}` : '';
  const body = {
    change_set_id: '',
    summary: `${changes.length} resource(s) changed (+${added} -${removed}${rest})`,
    change_unit,
    change_size: size,
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
