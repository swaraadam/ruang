---
description: Check a phase exit condition and record the result
argument-hint: "[phase number, default current]"
---

Evaluate the exit conditions for phase $1 using `.claude/skills/phase-gates/SKILL.md`.

For each condition print: the condition, the command or test that proves it, its output, and
`PASS | FAIL | UNPROVEN`. `UNPROVEN` is never `PASS` — say so plainly.

For Phase 0 specifically, the load-bearing proof is: **the gateway restarts while a live agent
session survives**, plus green vocabulary/identity audits and green Phase-0 contract tests.

Then have the `adr-scribe` agent write a dated gate record in `docs/adr/`, stating the evidence
rather than the intention. If any condition is FAIL or UNPROVEN, list the specific issues that
would close it, and do not recommend advancing.
