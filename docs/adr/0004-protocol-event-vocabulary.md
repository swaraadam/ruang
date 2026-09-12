# ADR-0004: durable event payload shapes are derived, provisional, and diverge from Appendix A in three places

- **Date:** 2026-09-12
- **Status:** accepted
- **Phase:** 0
- **Blueprint sections affected:** Appendix A.1, A.2, A.3; §5.1, §12.3, §14.1, §15.3, §16.1, §25.1

## Context

P0-02 closes the wire vocabulary: 53 durable event types, one payload per type, an envelope, and an
ephemeral channel set that shares no type with the durable union.

**Appendix A.1 specifies 53 event names and zero payload schemas.** A.2 lists four ephemeral type
names and two prose descriptions. A.3 gives the envelope as a JSON sketch. That is the whole of the
specification. Every payload field set in `packages/protocol/src/events.ts` was therefore *derived*
from the entity and contract sections of the blueprint — and derived is not specified.

This matters because a green test suite proves these shapes are self-consistent, never that they
are right, and every downstream Phase 0 issue inherits them. Recording where each shape came from
is what makes a later correction a *revision* rather than an archaeology exercise.

The owner reviewed this and decided to land rather than split (see **Budget waiver**).

## Derivation source per event group

| Group | Types | Derived from |
|---|---|---|
| `project.*` | registered, claimed, claim_released, claim_expired | §14.1 core entities; §10.3 human claim / presence lease; Appendix B.1 for the Project field set |
| `task.*` | created, basis.captured, stale, dispatched, completed, cancelled | §14.1 entities; **§5.1 basis fingerprint** for `basis_ref` + `inputs[resource_id, version]`; §13.2 staleness without false invalidation |
| `attempt.*` | started, completed, failed | §14.1 entities; §16.3 execution class |
| `sandbox.*` | opened, closed | §10.1 sandbox is the core term; §10.4 teardown safety |
| `lock.*` | acquired, released | §10.2 exclusive resource locks |
| `apply.*` | started, completed, failed, reversed, compensated | **§12.3 per-action user verification** for the action fingerprint; §5.5 and §12.4 for reversibility class |
| `approval.*` | requested, decided | §12.3 step-up binding; §12.4 reversibility appears on approval |
| `steer.*` | requested, acknowledged, failed, unresolved | **§15.3 steering delivery contract** — the four states are that contract's, not invented |
| `review.*` | thread.created, comment.added, feedback.delivered, waiver_recorded | §16.4 review threads; §16.2 for the waiver record; anchors are the domain-neutral set from §16.4 |
| `evidence.ready` | — | **§16.1 evidence profiles**; §16.2 review-readiness rule |
| `budget.*` | threshold, pause | §16.6 change budgets are domain-specific; §18.2 cost controls |
| `notification.*` | queued, delivered, delivery_failed, opened | §11.4 notifications |
| `preview.*` | started, healthy, failed, stopped | §11.2 port broker and preview identity |
| `session.*`, `agent.session.id_captured` | reattached, resumed | §9.2 session identity and resume are early contracts |
| `agent.needs_input` | — | §9.3 terminal bell as universal attention fallback; §8.3 event-driven supervision |
| `repair.*`, `state.needs_repair` | requested, resolved, lock_released | §14.4 needs-repair |
| `artifact.created` | — | §14.3 storage rules, retention classes |
| `adapter.divergence` | — | §5.2 provisional adapter contract — the event exists so a contract revision is visible rather than absorbed |

## Options

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Land as specified by Appendix A, verbatim | none now | Re-imports `workspace_id` and `provider`, both of which contradict mandated vocabulary elsewhere in the same blueprint | Rejected |
| Land with divergences, undocumented | none now | The next reader cannot tell a decision from a typo | Rejected — this is the failure mode ADRs exist for |
| **Land with divergences recorded and shapes marked provisional** | one ADR, one doc comment | A later revision is a protocol change, not a surprise | **Chosen** |
| Defer the union until P0-13 and the asset adapter can exercise it | blocks nearly all of Phase 0 | The union is the critical path; nothing downstream can start | Rejected |

## Decision

Land the closed union now, with the payload field sets **explicitly provisional**, and with three
deliberate divergences from Appendix A recorded here.

### Divergence 1 — `workspace_id` → `project_id` on the envelope (erratum)

A.3 spells the optional scope column `workspace_id`. §3 of CLAUDE.md makes `Project` the core entity
name and reserves "workspace" for UI copy; §2.4 of the blueprint is a vocabulary-rename section that
A.3 was not updated against.

**Classified as an erratum against Appendix A.3, not a divergence in intent** — the field's meaning
is unchanged, only its name, and the name it had contradicted the vocabulary the same document
mandates. The backlog text for P0-02 carried the same spelling and has been corrected with it.

### Divergence 2 — `actor.provider` → `actor.runtime_id` (deliberate)

A.3 gives the actor as `{ member_id, role_id?, provider? }`. **§25.1 makes the provider runtime
Seam D, "a substitution seam deliberately not generalized until two integrations exist."** A.3
predates that decision. Naming a vendor in the envelope re-imports into every durable row the
assumption Seam D exists to prevent, and `owner_id`/`org_node_id` aside, the envelope is the one
shape that every future adapter must accept unchanged.

Kept as `runtime_id`. This is a real divergence from the appendix, not an erratum: A.3 is internally
consistent, it is merely older than §25.1.

### Divergence 3 — `paint.state` and `tool.progress` are coined names

A.2 lists four ephemeral type names (`agent.message.delta`, `process.output`, `pty.binary`,
`progress.tick`) and then two prose descriptions: "cursor/terminal paint state" and "high-frequency
tool progress". Those two needed identifiers to exist as types at all.

`paint.state` and `tool.progress` are **coined here, not blueprint terms.** A future reader should
not cite them as Appendix A vocabulary. They are ephemeral-only, so they never reach SQLite and a
rename costs nothing durable (invariant 2).

### Provisional status, stated precisely

The payload field sets remain revisable **without a major version bump** until both P0-13 and the
first real binary-asset workflow have exercised them against something other than this package's own
tests. `PROTOCOL_VERSION` continues to pin the vocabulary — `VOCABULARY_FINGERPRINT` covers every
type name and payload field name, and a change to it fails a test — so a revision is still a
*versioned, visible* act. What is deferred is the promise that a field set is **final**, not the
discipline of versioning a change to one.

The envelope rename in Divergence 1 does not bump `PROTOCOL_VERSION`: the fingerprint covers payload
fields, the version is still `1`, and nothing has consumed the protocol yet. The first consumer
makes that no longer true.

## Budget waiver

The owner waived the 250-line change budget for P0-02 on issue #2, per §16.2 (only the owner may
waive, and the waiver is durable evidence), with the reason:

> 353 of 665 lines are one repeating declarative shape, and splitting a closed union leaves `main`
> in a state where the closed-union invariant is false.

Recorded on the issue and mirrored in `docs/backlog/backlog.yaml` as `budget_waiver`.

## Consequences

**Easier:** every downstream Phase 0 issue can start against a closed union instead of waiting for
three partial ones. A reader who disagrees with a field set can find where it came from in one table
rather than re-deriving it.

**Harder:** the three divergences must survive contact with Appendix A every time someone reads the
blueprint first and the code second. The doc comments in `events.ts` and this ADR are the only thing
preventing a well-meaning "fix" back to `workspace_id` or `provider`. The test
`carries the scope column as project_id` pins the first of those at compile time.

**Foreclosed:** nothing. No consumer exists yet.

## Reversibility

`revertible` — one package, no schema, no persisted rows, no consumer. Reverting is deleting the
package's source and the version constant.

## Deferred, and which seam carries it

- **Whether the payload shapes are right** — deferred to P0-13 and Seam A's second adapter. The
  invariant held now: the union is closed, versioned and fingerprinted, so a wrong shape is a
  visible protocol change and not a silent one.
- **A provider-vocabulary audit.** Acceptance 3 of P0-02 originally claimed the seam audit proves
  "no git/host/**provider** vocabulary in any exported name or field". `scripts/audit-seams.sh`
  carries a git pattern and a macOS pattern and **no provider pattern**, so that half of the
  criterion named a mechanism that does not exist. The provider half has been struck from P0-02 and
  folded into **M-02** (widen audit patterns), which is the issue that owns audit coverage. Seam D
  carries it. The invariant held now: `runtime_id` is the only runtime-facing name in the union, and
  Divergence 2 above is the reason it is spelled that way.
