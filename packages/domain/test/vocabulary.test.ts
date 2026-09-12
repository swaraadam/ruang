import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * These read the source text, not the compiled types, on purpose. Both rules here are about what
 * the *text* says — a doc comment or a string literal is exactly where a leak reads naturally, and
 * a type-level assertion cannot see either.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/vocabulary.ts', import.meta.url)),
  'utf8',
);
const lines = SOURCE.split('\n').map((line, i) => `${i + 1}: ${line.trim()}`);
const offending = (re: RegExp) => lines.filter((l) => re.test(l));

describe('no git vocabulary anywhere in the surface (invariant 9)', () => {
  /**
   * Stricter than `scripts/audit-seams.sh` in two ways, deliberately: the audit exempts `.test.`
   * paths and matches only the seven words in CLAUDE.md §2.9. This also catches the §3 table's
   * right-hand column — `repo`, `repository`, `checkout` — which is the vocabulary a reader would
   * reach for without noticing. It caught one in this very file while it was being written
   * ("not a repository pointer"), which is the argument for having it.
   */
  it('has none in a type, field, doc comment or string literal', () => {
    const forbidden =
      /\b(git|commit|commits|branch|branches|merge|worktree|diff|hunk|repo|repository|checkout|rebase|stash)\b/i;
    expect(offending(forbidden)).toEqual([]);
  });

  it('reaches for the core term where a substrate word would be natural', () => {
    // §3's left-hand column, in the places most likely to drift back.
    expect(SOURCE).toContain('Sandbox');
    expect(SOURCE).toContain('basis');
    expect(SOURCE).toContain('change_budget');
  });
});

describe('nothing here can carry a credential (§5.2.2)', () => {
  /**
   * "Adapters never receive credential-broker handles." The risk is not a field named `credential`;
   * it is any field a secret could travel in, and any field that would make the adapter the
   * executor rather than the planner. Scan for both families.
   */
  it('has no field a credential or broker handle could travel in', () => {
    const forbidden =
      /\b\w*(credential|secret|token|password|passphrase|keychain|api_key|auth|bearer|session_key)\w*\s*[?:]/i;
    expect(offending(forbidden)).toEqual([]);
  });

  it('has no field that would make the adapter the executor', () => {
    // A `command`, `argv` or `exec` field would invert §5.2.2: the spine validates the plan and
    // invokes the broker: the adapter only describes what it wants done.
    const forbidden = /\b(command|argv|exec|shell|script|cmd|env)\s*[?:]/i;
    expect(offending(forbidden)).toEqual([]);
  });
});

describe('an apply operation is reviewable before it runs', () => {
  it('carries a target, a required capability, a risk and a reversibility class', () => {
    const block = SOURCE.slice(SOURCE.indexOf('export type ApplyOperation'));
    const body = block.slice(0, block.indexOf('};'));
    for (const field of ['target_ref', 'required_capability', 'risk', 'reversibility']) {
      expect(body).toContain(field);
    }
  });

  it('spells the reversibility classes exactly as §5.5 does', () => {
    // Invariant 5 keys off `irreversible`; a renamed class would silently disarm it.
    expect(SOURCE).toContain("'revertible' | 'compensable' | 'irreversible'");
  });
});

describe('the states that must stay representable', () => {
  it('keeps unknown staleness as a value, not an error (invariant 4)', () => {
    expect(SOURCE).toContain("state: 'unknown'");
  });

  it('keeps needs_repair and not_reversible as values (invariants 3 and 5)', () => {
    expect(SOURCE).toContain("kind: 'needs_repair'");
    expect(SOURCE).toContain("kind: 'not_reversible'");
  });
});
