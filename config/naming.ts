/**
 * Single source of every product-facing identifier.
 *
 * Naming clearance is an OPEN Phase -1 gate (docs/gates/phase-minus-1.md, ADR-0000).
 * These are deliberate placeholders. Do not copy any of these strings anywhere else —
 * import from here so that clearance is a one-file change.
 *
 * Never register the hostname or enrol a passkey against RP_ID while CLEARED is false.
 */
export const NAMING_CLEARED = false;

export const PLACEHOLDER = {
  /** Descriptive product title, used in UI copy only. */
  productTitle: 'Personal Agent Workspace',
  /** CLI binary name. */
  cli: 'paw',
  /** Throwaway hostname for the canonical-origin proof. */
  hostname: 'paw-proof.invalid',
  /** WebAuthn relying-party id. MUST NOT be used for a real credential yet. */
  rpId: 'paw-proof.invalid',
  /** SQLite control-plane database filename. */
  dbFile: 'control-plane.sqlite',
} as const;

/** Core entity vocabulary. `Project` is the entity; "workspace" is copy, never a type. */
export const CORE_ENTITY = 'Project' as const;
