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

/**
 * The one canonical browser origin (blueprint §4.2 Trust boundaries; Appendix D, the Phase 1
 * canonical-origin gate) — the only origin the gateway serves.
 *
 * Derived, not typed out again: the hostname is spelled once, above, so clearance stays a one-file
 * change. Nothing here registers anything; `.invalid` resolves nowhere by definition (RFC 6761),
 * which is the point while the naming gate is open.
 */
export const CANONICAL_ORIGIN = `https://${PLACEHOLDER.hostname}`;

/** Core entity vocabulary. `Project` is the entity; "workspace" is copy, never a type. */
export const CORE_ENTITY = 'Project' as const;
