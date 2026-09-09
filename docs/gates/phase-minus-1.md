# Phase -1 external gates

These are not document decisions. No agent can close them. Issues that depend on them carry the
`blocked-gate` label and must not be started.

## Gate 1 — Naming clearance

- [ ] Product / descriptive name checked for collision (the earlier "DevHQ" direction collided)
- [ ] Repo name chosen
- [ ] CLI binary name chosen and checked against Homebrew / npm collisions
- [ ] Hostname chosen
- [ ] WebAuthn RP ID decided (this is the expensive one — it is baked into every credential)
- [ ] ADR written recording all five, and `config/naming.ts` updated in one commit

**Blocks:** persistent identifiers, repo initialization under a real name, passkey enrolment.
**Until closed:** everything uses the placeholders in `config/naming.ts`.

## Gate 2 — Canonical browser origin proof

- [ ] One origin resolves over the private path (Tailscale)
- [ ] The same origin resolves over the fallback path (Cloudflare)
- [ ] Proven on a **throwaway** hostname, before any passkey is enrolled
- [ ] TLS terminates correctly on both paths, with identical origin string
- [ ] Passkey bootstrap/recovery procedure decided: first enrolment only from local physical console
      or a one-time locally-shown setup token; adding authenticators requires an existing fresh
      assertion; a second authenticator exists; lost-device recovery requires local reset and
      invalidates old credentials

**Blocks:** WebAuthn step-up, mobile apply, anything in Phase 3.

## Gate 3 — Real cost ceilings

- [ ] Monthly ceiling: ______
- [ ] Daily/hourly ceiling: ______
- [ ] Per-task ceiling: ______
- [ ] Per-run ceiling: ______
- [ ] Retry circuit-breaker thresholds: ______

Placeholders are not executable configuration. Automation stays disabled until real values exist.

**Blocks:** P1-08, any unattended spend.

## Gate 4 — Orchestrator delegation ADR (decidable at the desk)

- [ ] Two weeks driving one existing code orchestrator on real work, with a log of every place its
      data model cannot express a non-code unit of work
- [ ] One real Unity/asset task run manually but instrumented: basis, sandbox, change set, checks,
      evidence, ownership, reversibility identified
- [ ] ADR decides: thin-spine scope · whether the code adapter delegates lifecycle · whether the
      asset adapter is one adapter with capability probes or a family

**Note:** if the trial shows an existing orchestrator plus a thin mobile/review layer already
solves the daily workflow, and the asset requirement is not real, the correct outcome is to **stop
before generalizing**. That is a win, not a failure.

## STOP & USE clock

`STOP_AND_USE_START:` ______ (set at the end of Phase 1; two weeks of daily use before Phase 2)
