/**
 * Recording an artifact — blueprint §14.1 (the `Artifact` entity) and §14.3.
 *
 * Large outputs are files; the database holds a row and the log holds a fact (persistence SKILL:
 * "Large outputs ... are files with sha256 + a reference row"). This writes both, in one
 * transaction, or neither: a row with no `artifact.created` event would be evidence that cannot be
 * replayed, and an event with no row would be a claim about a file nothing tracks.
 *
 * Nothing here knows a filesystem. `path_ref` is opaque — the caller resolves it, and the same
 * discipline lets `collectArtifacts` hand it back to a caller-supplied remover rather than deleting
 * anything itself.
 */
import { PAYLOAD_VALIDATORS } from '@internal/protocol';
import type { Db } from './db.js';
import { appendEvent } from './event-log.js';
import { type RetentionClass, isRetentionClass } from './retention.js';

export type ArtifactRecord = {
  readonly id: string;
  readonly owner_id: string;
  readonly org_node_id: string;
  /** The owning task/attempt (§14.1). Null for an artifact that belongs to neither. */
  readonly task_id: string | null;
  readonly attempt_id: string | null;
  readonly kind: string;
  readonly path_ref: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly retention_class: RetentionClass;
  readonly created_at: string;
};

export type NewArtifact = Omit<ArtifactRecord, 'task_id' | 'attempt_id'> & {
  readonly task_id?: string | null;
  readonly attempt_id?: string | null;
  /** Who recorded it. The envelope's actor (§A.3); never inferred from the process. */
  readonly actor_member_id: string;
  readonly actor_role_id?: string | null;
  readonly actor_runtime_id?: string | null;
};

/** Refusal at the artifact write boundary. Separate name so a caller can tell it from an I/O error. */
export class ArtifactError extends Error {
  public override readonly name = 'ArtifactError';
}

/**
 * Lowercase hex, 64 characters. v1 types the column `TEXT` and checks nothing.
 *
 * This is not pedantry about format: the hash is the only thing that will later say whether a
 * restored file is the artifact the row describes. A row carrying `'pending'` or a truncated digest
 * makes the backup unverifiable while still looking complete, which is the failure shape this
 * repository keeps finding — a check that passes because it never really looked.
 */
const SHA256 = /^[0-9a-f]{64}$/;

const INSERT = `INSERT INTO artifact
  (id, owner_id, org_node_id, task_id, attempt_id, kind, path_ref, sha256,
   size_bytes, retention_class, created_at)
  VALUES (@id, @owner_id, @org_node_id, @task_id, @attempt_id, @kind, @path_ref, @sha256,
          @size_bytes, @retention_class, @created_at)`;

/**
 * Write the row and append `artifact.created`. Returns the sequence the event was given.
 *
 * The payload is validated against the closed protocol shape before either write. The validator is
 * the authority on what `artifact.created` means (`packages/protocol`), so checking it here means a
 * drift between this writer and that union fails at the write, not at the reader who needed the
 * event years later.
 */
export const recordArtifact = (db: Db, artifact: NewArtifact): number => {
  if (!SHA256.test(artifact.sha256)) {
    throw new ArtifactError(
      `artifact '${artifact.id}' has no usable sha256 ('${artifact.sha256}'): a row whose hash ` +
        'cannot verify its file is not a reference, it is a rumour',
    );
  }
  if (!isRetentionClass(artifact.retention_class)) {
    throw new ArtifactError(
      `artifact '${artifact.id}' has retention class '${String(artifact.retention_class)}', which ` +
        'no lifetime is defined for; GC would have to guess one',
    );
  }
  if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0) {
    throw new ArtifactError(
      `artifact '${artifact.id}' has size_bytes ${String(artifact.size_bytes)}; the build-cache ` +
        'size ceiling is summed from this column',
    );
  }

  const payload = {
    artifact_id: artifact.id,
    kind: artifact.kind,
    sha256: artifact.sha256,
    byte_size: artifact.size_bytes,
    retention_class: artifact.retention_class,
  };
  if (!PAYLOAD_VALIDATORS['artifact.created'](payload)) {
    throw new ArtifactError(
      `artifact '${artifact.id}' does not satisfy the artifact.created payload shape`,
    );
  }

  return db
    .transaction((): number => {
      db.prepare(INSERT).run({
        id: artifact.id,
        owner_id: artifact.owner_id,
        org_node_id: artifact.org_node_id,
        task_id: artifact.task_id ?? null,
        attempt_id: artifact.attempt_id ?? null,
        kind: artifact.kind,
        path_ref: artifact.path_ref,
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        retention_class: artifact.retention_class,
        created_at: artifact.created_at,
      });
      return appendEvent(db, {
        owner_id: artifact.owner_id,
        org_node_id: artifact.org_node_id,
        ts: artifact.created_at,
        type: 'artifact.created',
        task_id: artifact.task_id ?? null,
        attempt_id: artifact.attempt_id ?? null,
        actor_member_id: artifact.actor_member_id,
        actor_role_id: artifact.actor_role_id ?? null,
        actor_runtime_id: artifact.actor_runtime_id ?? null,
        payload,
        // The envelope's own reference field (§A.3). The owning task/attempt are the columns above;
        // together they are the "owner task/attempt" §14.1 requires of an Artifact.
        artifact_refs: [artifact.id],
      });
    })
    .immediate();
};

const SELECT_COLUMNS = `id, owner_id, org_node_id, task_id, attempt_id, kind, path_ref,
  sha256, size_bytes, retention_class, created_at`;

/**
 * Every artifact this owner still has a row for, oldest first.
 *
 * `retention_class` is typed as the union because v1's CHECK holds for rows this build wrote; a
 * caller that must survive a foreign value calls `isRetentionClass` on it, as `gc.ts` does.
 */
export const listArtifacts = (db: Db, owner_id: string): readonly ArtifactRecord[] =>
  db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM artifact WHERE owner_id = ? ORDER BY created_at, id`)
    .all(owner_id) as ArtifactRecord[];

/** One artifact, or `null` when no row exists — which after a GC pass means "collected". */
export const readArtifact = (db: Db, owner_id: string, id: string): ArtifactRecord | null =>
  (db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM artifact WHERE owner_id = ? AND id = ?`)
    .get(owner_id, id) as ArtifactRecord | undefined) ?? null;
