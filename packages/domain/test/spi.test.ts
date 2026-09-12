import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPI_METHODS } from '../src/index.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../src/spi.ts', import.meta.url)), 'utf8');

describe('the contract is the thirteen methods of §5.2', () => {
  it('lists them in blueprint order', () => {
    expect([...SPI_METHODS]).toEqual([
      'snapshot_basis',
      'is_basis_stale',
      'open_sandbox',
      'inspect_sandbox',
      'close_sandbox',
      'compute_change_set',
      'render_change_set',
      'declared_checks',
      'run_checks',
      'apply_plan',
      'confirm_applied',
      'revert_or_compensate',
      'reconcile',
    ]);
  });

  it('declares every method it lists, and lists every method it declares', () => {
    // `satisfies` catches a listed name that is not a method. It cannot catch a declared method
    // missing from the list — the direction that loses one silently. Read the source both ways.
    const declared = [...SOURCE.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...SPI_METHODS].sort());
  });
});

describe('every method commits to a binary-asset answer', () => {
  /**
   * CLAUDE.md §4: the SPI is provisional until a code adapter and a real asset workflow both pass.
   * Writing the asset answer before an asset adapter exists means the first disagreement produces
   * a contract revision against a recorded position, rather than an argument about intent.
   *
   * This can only check that someone committed to an answer. Whether the answer is right is what
   * the asset adapter will decide, and that is the point of writing it down now.
   */
  it('carries an Asset: line on each of the thirteen', () => {
    const missing = SPI_METHODS.filter((name) => {
      const at = SOURCE.indexOf(`\n  ${name}(`);
      return at === -1 || !SOURCE.slice(Math.max(0, at - 300), at).includes('Asset:');
    });
    expect(missing).toEqual([]);
  });

  it('does not let one method borrow the note above it', () => {
    // One note per method inside the interface, so deleting a method cannot silently reassign its
    // note to the next one. Counted within the block, not the file: the module header describes
    // the convention and names it too.
    const block = SOURCE.slice(
      SOURCE.indexOf('export type DomainAdapter'),
      SOURCE.indexOf('export const SPI_METHODS'),
    );
    expect([...block.matchAll(/Asset:/g)]).toHaveLength(SPI_METHODS.length);
  });
});

describe('the contract stays free of substrate and credentials', () => {
  const lines = SOURCE.split('\n').map((line, i) => `${i + 1}: ${line.trim()}`);

  it('names no substrate vocabulary, including in the Asset: notes (invariant 9)', () => {
    const forbidden =
      /\b(git|commit|commits|branch|branches|merge|worktree|diff|hunk|repo|repository|checkout|rebase|stash)\b/i;
    expect(lines.filter((l) => forbidden.test(l))).toEqual([]);
  });

  it('takes no credential and returns no executable command (§5.2.2)', () => {
    const forbidden =
      /\b\w*(credential|secret|token|password|keychain|api_key|auth|bearer)\w*\s*[?:]|\b(command|argv|exec|shell|script|cmd|env)\s*[?:]/i;
    expect(lines.filter((l) => forbidden.test(l))).toEqual([]);
  });
});
