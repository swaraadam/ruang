/**
 * `recordArtifact` writes a row AND the durable fact, or neither.
 *
 * The issue's goal is "evidence outlives the run that produced it". A row with no
 * `artifact.created` event is evidence that cannot be replayed; an event with no row is a claim
 * about a file nothing tracks. Both halves, one transaction, is the whole promise.
 */
import { describe, expect, it } from 'vitest';
import {
  ArtifactError,
  type NewArtifact,
  listArtifacts,
  readArtifact,
  readSince,
  recordArtifact,
} from '../src/index.js';
import { seedControlPlane } from './fixture.js';

const HASH = 'a'.repeat(64);

const artifact = (over: Partial<NewArtifact> = {}): NewArtifact => ({
  id: 'a-1',
  owner_id: 'o1',
  org_node_id: 'n-o1',
  kind: 'check-log',
  path_ref: 'artifacts/a-1.log',
  sha256: HASH,
  size_bytes: 128,
  retention_class: 'task-evidence',
  created_at: '2026-01-01T00:00:00.000Z',
  actor_member_id: 'm1',
  ...over,
});

describe('recording an artifact', () => {
  it('writes the row with its identity columns, class, hash and owning task/attempt', () => {
    const db = seedControlPlane();
    recordArtifact(db, artifact({ task_id: 't-1', attempt_id: 'at-1' }));

    // owner_id/org_node_id are mandatory on every durable row (invariant 8, §14.2). Read back
    // rather than trusted: the column is NOT NULL, the VALUE being the right owner is this test's.
    expect(readArtifact(db, 'o1', 'a-1')).toEqual({
      id: 'a-1',
      owner_id: 'o1',
      org_node_id: 'n-o1',
      task_id: 't-1',
      attempt_id: 'at-1',
      kind: 'check-log',
      path_ref: 'artifacts/a-1.log',
      sha256: HASH,
      size_bytes: 128,
      retention_class: 'task-evidence',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('appends artifact.created carrying the hash, class, size and the owning task/attempt', () => {
    const db = seedControlPlane();
    const seq = recordArtifact(db, artifact({ task_id: 't-1', attempt_id: 'at-1' }));
    const events = readSince(db, 'o1', 0) ?? [];

    expect(seq).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'artifact.created',
      owner_id: 'o1',
      org_node_id: 'n-o1',
      task_id: 't-1',
      attempt_id: 'at-1',
      artifact_refs: ['a-1'],
      payload: {
        artifact_id: 'a-1',
        kind: 'check-log',
        sha256: HASH,
        byte_size: 128,
        retention_class: 'task-evidence',
      },
    });
  });

  it('refuses a hash that could never verify a restored file, and writes nothing', () => {
    const db = seedControlPlane();
    expect(() => recordArtifact(db, artifact({ sha256: 'pending' }))).toThrow(ArtifactError);
    expect(listArtifacts(db, 'o1')).toEqual([]);
    expect(readSince(db, 'o1', 0)).toEqual([]);
  });

  it('refuses a retention class no lifetime is defined for', () => {
    const db = seedControlPlane();
    expect(() =>
      // Deliberately outside the union: this is the value a newer build or a hand-edit produces,
      // and guessing a lifetime for it is how evidence disappears.
      recordArtifact(db, artifact({ retention_class: 'forever' as never })),
    ).toThrow(ArtifactError);
    expect(listArtifacts(db, 'o1')).toEqual([]);
  });

  it('refuses a size the build-cache ceiling could not sum', () => {
    const db = seedControlPlane();
    expect(() => recordArtifact(db, artifact({ size_bytes: -1 }))).toThrow(ArtifactError);
    expect(listArtifacts(db, 'o1')).toEqual([]);
  });
});
