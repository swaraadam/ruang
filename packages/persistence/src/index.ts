export type { Db } from './db.js';
export {
  ForeignDatabaseError,
  openControlPlaneDatabase,
  openDatabase,
  openMemoryDatabase,
} from './db.js';
export {
  LATEST_VERSION,
  MIGRATIONS,
  currentVersion,
  migrate,
  schemaFingerprint,
} from './migrate.js';
export type { AppendableEvent, StoredEvent } from './event-log.js';
export { appendEvent, eventLogIsWhole, latestSeq, readSince } from './event-log.js';
export type { RetentionClass, RetentionPolicy } from './retention.js';
export {
  DEFAULT_RETENTION_POLICY,
  RETENTION_CLASSES,
  classExpiryMs,
  isRetentionClass,
} from './retention.js';
export type { ArtifactRecord, NewArtifact } from './artifacts.js';
export { ArtifactError, listArtifacts, readArtifact, recordArtifact } from './artifacts.js';
export type {
  ArtifactDecision,
  ArtifactDisposition,
  CollectOptions,
  GcOutcome,
  GcPlan,
  GcReport,
  PlanOptions,
  RemoveFailure,
  SourceDisposition,
} from './gc.js';
export { GcRefusedError, REFERENCE_SOURCES, collectArtifacts, planCollection } from './gc.js';
export type { BackupComponent } from './backup.js';
export { BACKUP_SURFACE } from './backup.js';
