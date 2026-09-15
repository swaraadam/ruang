/**
 * What a complete backup has to cover — persistence SKILL, last practical rule.
 *
 * "Backups cover the DB *plus* referenced artifacts *plus* configuration. A backup of only the DB
 * is a broken backup." That sentence is the whole module. It lives in code rather than only in
 * `docs/ops/backup.md` because a document nothing checks drifts the moment a fourth durable
 * location appears: `backup.test.ts` asserts the document names every component below, so adding
 * one here fails the suite until the procedure is written.
 *
 * This is a manifest, not a backup tool. It deliberately spells no path — paths are the host
 * adapter's and the operator's, and `config/naming.ts` owns the one filename that is a product
 * identifier.
 */

export type BackupComponent = {
  readonly id: string;
  readonly what: string;
  /** What a restore silently loses if this component is skipped. Every entry must answer it. */
  readonly incomplete_without: string;
};

export const BACKUP_SURFACE: readonly BackupComponent[] = [
  {
    id: 'control-plane-database',
    what: 'the SQLite file and its -wal/-shm sidecars, captured as one consistent copy',
    incomplete_without:
      'every durable row and the whole event log; without the sidecars the copy can be missing ' +
      'committed transactions that never got checkpointed',
  },
  {
    id: 'artifact-files',
    what: 'the files behind every artifact row, addressed by path_ref and verified by sha256',
    incomplete_without:
      'the evidence the rows point at — check logs, rendered changes, milestone captures. The ' +
      'rows restore, the references dangle, and review-ready becomes unprovable',
  },
  {
    id: 'configuration',
    what: 'the versioned role, org and context-pack data that authorization resolves against',
    incomplete_without:
      'Seam C. Capability lookups resolve against roles and org nodes held as data, so a restore ' +
      'without them cannot authorize the work the restored history describes',
  },
];
