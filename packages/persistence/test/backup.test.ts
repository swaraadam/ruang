/**
 * ACCEPTANCE 3 — "backup documentation covers DB plus artifacts plus config."
 *
 * A document is not evidence of coverage; a document nothing checks is a document that drifts. So
 * the components live in code (`BACKUP_SURFACE`) and this asserts the document speaks about each of
 * them. Adding a fourth durable location then fails here until the procedure for it is written,
 * which is the only version of "documentation covers X" that stays true.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKUP_SURFACE, RETENTION_CLASSES } from '../src/index.js';

const DOC = new URL('../../../docs/ops/backup.md', import.meta.url);
const text = readFileSync(DOC, 'utf8');

describe('the backup procedure', () => {
  it('covers the database, the artifact files and the configuration — all three', () => {
    expect(BACKUP_SURFACE.map((c) => c.id)).toEqual([
      'control-plane-database',
      'artifact-files',
      'configuration',
    ]);
    for (const component of BACKUP_SURFACE) {
      expect(text).toContain(component.id);
    }
  });

  it('says what a restore silently loses without each component', () => {
    for (const component of BACKUP_SURFACE) {
      // The sentence that stops a component from being quietly dropped as "probably regenerable".
      expect(component.incomplete_without.length).toBeGreaterThan(20);
    }
  });

  it('answers for every retention class, so a new class cannot arrive undocumented', () => {
    for (const retention_class of RETENTION_CLASSES) {
      expect(text).toContain(retention_class);
    }
  });

  it('tells the operator to verify the restore against the recorded hashes', () => {
    // Without this a restore is a belief. The hash is the only thing that can tell a restored
    // artifact from a plausible file sitting at the same path.
    expect(text).toContain('sha256');
    expect(text.toLowerCase()).toContain('verify');
  });

  it('names the write-ahead sidecars, since copying the database file alone loses history', () => {
    expect(text).toContain('-wal');
  });
});
