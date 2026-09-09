# ADR-0000: Descriptive placeholder naming until Phase -1 clearance

- **Date:** 2026-09-09
- **Status:** accepted (temporary by construction)
- **Phase:** -1
- **Blueprint sections affected:** §03.3, §03.4, Appendix D

## Context

Naming clearance (product, repo, CLI, hostname, WebAuthn RP ID) is an open external Phase -1 gate.
The earlier "DevHQ" direction collided with an existing product. Phase 0 needs to write code before
the gate closes, but must not write persistent identifiers that would later require a migration —
an RP ID in particular is baked into every enrolled credential.

## Decision

All names live in `config/naming.ts` as explicitly-marked placeholders. Nothing else in the
repository may contain a product name. `Project` is the core entity name; "workspace" is UI copy
only, never a type name.

## Consequences

Renaming after clearance is a one-file change plus a grep audit, not a migration. Any code that
inlines a name is a defect the `pnpm verify` audit should eventually catch.

## Reversibility

`revertible` while no real hostname is registered and no passkey is enrolled. It becomes
`compensable` the moment an RP ID is used for a real credential — hence the hard rule that agents
never enrol one.
