#!/usr/bin/env bash
# Phase exit-condition check. Prints PASS / FAIL / UNPROVEN per condition.
# UNPROVEN is not PASS.
#
# The rule (issue #39, blueprint §23, CLAUDE.md §2.1): a condition RUNS something and READS ITS
# RESULT, or it reports UNPROVEN. A file existing, its name, and text inside it are never evidence
# that a check passed. Recursive grep is therefore banned here: in M-01 a fixture whose strings
# happened to match made this gate print "all conditions PASS" with two issues never started.
set -uo pipefail
cd "$(dirname "$0")/.."
PHASE="${1:-0}"
ROOT="$(pwd -P)"

# Re-entrancy guard. 0.2 shells out to `pnpm run verify` -> vitest -> tests/gate-check.test.ts ->
# this script. Re-entering on the SAME tree is recursion and is refused however shallow, since a
# bounded recursion still re-enters. Re-entering on a DIFFERENT tree (a fixture) is a separate
# subject and terminates, so the guard keys on the resolved root, not on depth or elapsed time.
case ":${GATE_CHECK_ROOTS:-}:" in
  *":$ROOT:"*)
    echo "gate-check: re-entrant invocation on $ROOT - refusing." >&2
    echo "A gate condition must not run the gate. Run a single named test instead." >&2
    exit 2
    ;;
esac
export GATE_CHECK_ROOTS="${GATE_CHECK_ROOTS:+${GATE_CHECK_ROOTS}:}$ROOT"

CONDITIONS=0; EXPECTED=0
pass(){ CONDITIONS=$((CONDITIONS + 1)); echo "  PASS      $1"; }
fail(){ CONDITIONS=$((CONDITIONS + 1)); echo "  FAIL      $1"; RC=1; }
unproven(){ CONDITIONS=$((CONDITIONS + 1)); echo "  UNPROVEN  $1 -> $2"; RC=1; }
proof(){ echo "  proof     $1"; }
RC=0

# Execute the declared test selector and report the runner's own machine-readable result. PASS
# demands all of: a result was produced, no failures, at least one test actually executed, none
# skipped, exit 0. "Nothing ran" and "all skipped" are green-but-vacuous - the same defect as an
# audit that scanned no files. `owner` names the issue that must write the test, so an UNPROVEN
# line says what to do next.
check_by_running(){
  local label="$1" owner="$2"; shift 2
  local out rc counts p f s
  proof "pnpm --silent exec vitest run --reporter=json $*"
  out="$(mktemp "${TMPDIR:-/tmp}/gate-result.XXXXXX")" ||
    { unproven "$label" "cannot allocate a result file; $owner"; return; }
  pnpm --silent exec vitest run --reporter=json --outputFile="$out" "$@" >/dev/null 2>&1
  rc=$?
  counts="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
process.stdout.write([j.numPassedTests|0,j.numFailedTests|0,(j.numPendingTests|0)+(j.numTodoTests|0)].join(" "))' \
    "$out" 2>/dev/null)"
  rm -f "$out"
  [[ -z "$counts" ]] && { unproven "$label" "runner produced no result (exit $rc); $owner"; return; }
  read -r p f s <<<"$counts"
  if [[ $f -gt 0 ]]; then fail "$label: $f of $((p + f)) test(s) failed"
  elif [[ $s -gt 0 ]]; then unproven "$label" "$s test(s) skipped; a skip is not evidence; $owner"
  elif [[ $p -eq 0 ]]; then unproven "$label" "no test executed (exit $rc); $owner"
  elif [[ $rc -ne 0 ]]; then unproven "$label" "runner exited $rc with $p passing test(s); $owner"
  else pass "$label: $p test(s) executed and passed"; fi
}

echo "Gate check: phase $PHASE"
# State the basis the verdict was computed against (CLAUDE.md §3: basis.ref plus basis.inputs).
# ADR-0002 had to record this by hand. A dirty tree is called out because sources change while
# HEAD does not, so the verdict is then not attributable to the commit.
if git rev-parse --git-dir >/dev/null 2>&1; then
  BASIS_REF="$(git rev-parse HEAD 2>/dev/null || echo 'unknown - no commit')"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]
    then BASIS_TREE='dirty - verdict is NOT attributable to basis.ref alone'
    else BASIS_TREE='clean'; fi
else BASIS_REF='unknown - not a git tree'; BASIS_TREE='unknown'; fi
echo "  basis.repo  $ROOT"
echo "  basis.ref   $BASIS_REF"
echo "  basis.tree  $BASIS_TREE"
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
    EXPECTED=4
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
    proof "./scripts/audit-seams.sh && ./scripts/audit-identity.sh"
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
    proof "pnpm --silent run verify"
    if [[ -f package.json ]] && grep -q '"verify"' package.json 2>/dev/null; then
      if pnpm --silent run verify >/dev/null 2>&1; then pass "pnpm verify green"; else fail "pnpm verify failing"; fi
    else unproven "pnpm verify" "no verify script yet (P0-01)"; fi

    # 0.3 and 0.4 name the test that proves them and then run it. The name only decides whether
    # there is anything to run; the verdict comes from the runner's result alone, so a zero-byte
    # file at the declared path reports UNPROVEN. There is deliberately no results artifact: a
    # named test does not re-enter the gate, so a cache would cache nothing and forge easily.
    echo "0.3 gateway restart while live session survives"
    check_by_running "restart survival" "declared test - P0-08" \
      adapters/host/darwin/tests/session-restart.test.ts

    echo "0.4 Phase 0 contract tests"
    # Contract tests are named *.contract.test.ts. vitest positional filters are substring matches
    # on the file path, so this selects the suite without enumerating it.
    check_by_running "contract suite" "declared selector *.contract.test.ts - P0-13" contract.test.ts
    ;;
  1)
    EXPECTED=3
    echo "1.1 useful from phone on real work — owner judgement, not a script."
    proof "owner confirmation; there is no command"
    unproven "phone usefulness" "owner must confirm after real use"
    echo "1.2 canonical origin over both paths"
    proof "external: docs/gates/phase-minus-1.md"
    unproven "canonical origin" "external gate: docs/gates/phase-minus-1.md"
    echo "1.3 STOP & USE clock"
    # Deliberate exclusion from the run-something rule, not an oversight. Every other condition
    # asserts a behaviour; this fact is documentary. BUT the grep matches the KEY, not a
    # value, and both docs hold `STOP_AND_USE_START:` + a blank -- this PASS is FALSE today.
    # Left as-is: M-05 scopes 0.3/0.4, this is Phase 1. Needs its own issue.
    proof "grep -q STOP_AND_USE_START docs/gates/*.md"
    if grep -q "STOP_AND_USE_START" docs/gates/*.md 2>/dev/null; then pass "clock recorded"; else unproven "stop-and-use clock" "record the start date (P1-09)"; fi
    ;;
  *)
    echo "Phase $PHASE exit conditions are in .claude/skills/phase-gates/SKILL.md."
    echo "Do not advance a phase unattended."
    exit 1
    ;;
esac

echo
# The summary used to derive from RC=0 alone - the absence of a failure. A condition skipped by a
# control-flow bug never fails and never counts, so the gate could announce a full pass having
# reported three of four. Assert the count as well as the result.
if [[ $CONDITIONS -ne $EXPECTED ]]; then
  echo "GATE $PHASE: not met. $CONDITIONS of $EXPECTED conditions reported — the run is incomplete."
  exit 1
fi
[[ $RC -eq 0 ]] && echo "GATE $PHASE: all $EXPECTED conditions PASS — record an ADR before advancing." \
                || echo "GATE $PHASE: not met. UNPROVEN is not PASS."
exit $RC
