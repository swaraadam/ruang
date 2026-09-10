#!/usr/bin/env bash
# Phase exit-condition check. Prints PASS / FAIL / UNPROVEN per condition.
# UNPROVEN is not PASS.
set -uo pipefail
cd "$(dirname "$0")/.."
PHASE="${1:-0}"

pass(){ echo "  PASS      $1"; }
fail(){ echo "  FAIL      $1"; RC=1; }
unproven(){ echo "  UNPROVEN  $1 -> $2"; RC=1; }
RC=0

echo "Gate check: phase $PHASE"
echo

case "$PHASE" in
  -1)
    echo "Phase -1 conditions are external. See docs/gates/phase-minus-1.md"
    grep -n '^- \[' docs/gates/phase-minus-1.md 2>/dev/null || true
    echo
    echo "No agent can close these. Owner action required."
    exit 1
    ;;
  0)
    echo "0.1 vocabulary + identity audits"
    # Both audits guard every check with [[ -d ]] over these roots, so on a tree without them they
    # print PASS having scanned nothing. A check that did not run is UNPROVEN, never PASS.
    # A directory existing is not a scan: `mkdir packages` alone previously produced PASS with
    # zero files examined. Require at least one regular file under the roots that exist.
    roots=(); for d in packages apps adapters; do [[ -d "$d" ]] && roots+=("$d"); done
    scanned=0
    if [[ ${#roots[@]} -gt 0 ]] && [[ -n "$(find "${roots[@]}" -type f -print -quit 2>/dev/null)" ]]; then
      scanned=1
    fi
    if ! ./scripts/audit-seams.sh >/dev/null 2>&1 || ! ./scripts/audit-identity.sh >/dev/null 2>&1; then
      fail "audits failing (run ./scripts/audit-seams.sh)"
    elif [[ $scanned -eq 0 ]]; then
      unproven "audits" "green but vacuous — no packages/, apps/ or adapters/ to scan (P0-01)"
    else
      pass "audits green over $(ls -d packages apps adapters 2>/dev/null | tr '\n' ' ')"
    fi

    echo "0.2 verify gate"
    # `pnpm -s` is rejected by pnpm >=12 (`unexpected argument '-s'`), which made this report FAIL
    # unconditionally regardless of the real result. Use the long form.
    if [[ -f package.json ]] && grep -q '"verify"' package.json 2>/dev/null; then
      if pnpm --silent run verify >/dev/null 2>&1; then pass "pnpm verify green"; else fail "pnpm verify failing"; fi
    else unproven "pnpm verify" "no verify script yet (P0-01)"; fi

    echo "0.3 gateway restart while live session survives"
    if ls adapters/host/darwin/**/*session*restart* >/dev/null 2>&1 || \
       grep -rlq "session survives gateway restart" --include='*.ts' . 2>/dev/null; then
      pass "restart-survival test present (inspect its output before trusting it)"
    else unproven "restart survival" "no test found (P0-08)"; fi

    echo "0.4 Phase 0 contract tests"
    if [[ -d packages/domain ]] && grep -rlq "contract" --include='*.test.ts' . 2>/dev/null; then
      pass "contract suite present"; else unproven "contract suite" "not found (P0-13)"; fi
    ;;
  1)
    echo "1.1 useful from phone on real work — owner judgement, not a script."
    unproven "phone usefulness" "owner must confirm after real use"
    echo "1.2 canonical origin over both paths"
    unproven "canonical origin" "external gate: docs/gates/phase-minus-1.md"
    echo "1.3 STOP & USE clock"
    if grep -q "STOP_AND_USE_START" docs/gates/*.md 2>/dev/null; then pass "clock recorded"; else unproven "stop-and-use clock" "record the start date (P1-09)"; fi
    ;;
  *)
    echo "Phase $PHASE exit conditions are in .claude/skills/phase-gates/SKILL.md."
    echo "Do not advance a phase unattended."
    exit 1
    ;;
esac

echo
[[ $RC -eq 0 ]] && echo "GATE $PHASE: all conditions PASS — record an ADR before advancing." \
               || echo "GATE $PHASE: not met. UNPROVEN is not PASS."
exit $RC
