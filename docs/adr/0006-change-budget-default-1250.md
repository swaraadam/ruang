# ADR-0006: the change budget is 1250 by default, per Project, and a prompt rather than a ceiling

- **Date:** 2026-09-12
- **Status:** accepted
- **Phase:** 0
- **Blueprint sections affected:** §7.2, §16.2, §16.6

## Context

CLAUDE.md §10 set one number — 250 lines — across every task, and every substantial PR in Phase 0
so far has exceeded it:

| Issue | Authored lines | Outcome |
|---|---|---|
| P0-02 protocol vocabulary | 665 | owner waiver on #2 |
| P0-03 change unions | 421 across two PRs | split, both parts under |
| P0-04 domain SPI | 434 across two PRs | split, both parts under |
| P0-05 migration v1 | 565 | owner waiver on #5 |

Two of those splits were useful — P0-03 and P0-04 each produced two diffs a reader can hold in their
head, and P0-04's split was decided before writing, which is when splitting is cheap. Two were not
available: a closed union is not closed until the last case lands, and migration v1 is atomic because
the schema-lock hash pins what v1 produces. Splitting either would have locked a state that never
existed.

**A flat line across declarative and logic content was the wrong shape.** 250 lines of branching
logic is a lot to review. 250 lines of `CREATE TABLE` is a table — a reader checks it column by
column and the twentieth costs no more attention than the second. The same number cannot serve both,
and pretending it does produced a 3am waiver request on P0-05 rather than a decision made in advance.

Blueprint §16.6 already says this: *"Code may use lines/files. Heavy-native asset tasks may use
assets, files or MB. The budget is a review-burden guardrail, not an arbitrary universal number."*
The repo was not honouring its own rule.

## Decision

**The default is 1250 lines.** Not because 1250 is principled — it is not — but because it is above
the point where the four issues above would have triggered a waiver, and below the point where a
diff stops being reviewable in one sitting. The honest description is a working number, revisable
when evidence says otherwise.

**An issue may set its own, in either direction.** §16.6 makes the budget a review-burden property
rather than a constant, and setting one on an issue is an owner act performed while grooming — which
is the whole point: the size decision moves from 3am to daylight. Six of the six set below are
*wider* than the default, and that is correct for what they are.

What §7.2 constrains is a **Role against its Project**: a Role may tighten a Project's limits and
never widen them. That is a different axis and is unchanged. An earlier draft of this ADR and of
CLAUDE.md §10 conflated the two, stating that an issue could only tighten — while six issues in the
same change widened. `claude[bot]` caught the contradiction.

**Six issues now carry an explicit budget**, each with a one-line reason recorded next to it —
P0-06, P0-07, P0-10, P0-13, P0-15, P0-17. Every one is large because of what it *is*: a capability
matrix, an adapter plus its test double, thirteen SPI methods, a contract suite, golden fixtures, a
retention table. The point is that the size decision happens while the owner is awake.

`lib_backlog.py` renders `change_budget` into the issue body, the same treatment `budget_waiver`
already gets. A budget that renders nowhere is not a budget anyone works to.

**The waiver mechanism is untouched.** §16.2 still says only the owner may waive, and a surprise
still needs sign-off. Raising the default is meant to remove the *routine* waiver, not the
exceptional one.

## Consequences

**Easier:** a task that is large by nature stops costing an owner interruption. Six issues now
declare their size before anyone starts, which is the difference between a decision and a discovery.

**Harder:** a genuinely bloated PR now has more room to hide. 1250 lines of logic would be a bad
change set that this number no longer catches. **The real guardrail is the reviewer** — `claude[bot]`
found a missing `attempted` steer state and a vacuous `UNIQUE` in P0-05, neither of which a line
count would have surfaced. The budget is a prompt to split early, not a ceiling that makes a change
safe by being under it.

**Stale elsewhere:** ADR-0005 §"`synchronize` is NOT gated on a label" says review cost is bounded by
"250 lines per PR". That bound is now 1250, so the per-push review cost rises accordingly. Left as
written — it recorded what was true then — but noted here so the next reader is not misled.

## Reversibility

`revertible` — four documentation edits, one renderer function, six backlog fields. No code path
depends on the number; reverting restores the previous default and the six overrides fall back to it.

## Deferred, and which seam carries it

- **A real Project-level `change_budget`.** The v1 schema already has `project.change_budget`, but
  nothing reads it yet: there is no Project config file, and Appendix B.1's sample lives in the
  blueprint, which agents may not edit. Seam C carries it (Projects are owner/org configuration).
  **Invariant held now:** the default and the per-issue override are both written down and both
  render, so the number a task works to is always visible before work starts.
- **Whether 1250 is right.** It is a working number chosen against four data points, all from one
  phase and one domain. Revisit when a binary-asset task has produced a change set — §16.6 expects
  that domain to use different units entirely.
