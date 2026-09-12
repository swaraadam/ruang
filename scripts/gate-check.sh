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
# Shared literals and the probe state. RUNNER_* are initialised HERE and not read from the
# environment: while they were only set inside the function, `RUNNER_PROBED=1` from a caller made
# the probe skip itself, `set -u` then aborted 0.2 mid-condition, and the run ended with no
# `GATE 0:` line at all - bypassing the count assertion that exists to catch a skipped condition.
REFUSED='gate-check: refused to run -'
NO_SUCH_SCRIPT='gate-check-control-no-such-script'
RUNNER_PROBED=''
RUNNER_PROBLEM=''

# Re-entrancy guard. 0.2 shells out to `pnpm run verify` -> vitest -> tests/gate-check.test.ts ->
# this script. Re-entering on the SAME tree is recursion and is refused however shallow, since a
# bounded recursion still re-enters. Re-entering on a DIFFERENT tree (a fixture) is a separate
# subject and terminates, so the guard keys on the resolved root, not on depth or elapsed time.
case ":${GATE_CHECK_ROOTS:-}:" in
  *":$ROOT:"*)
    refusal_line="$REFUSED re-entrant invocation on $ROOT"
    echo "$refusal_line" >&2
    echo "A gate condition must not run the gate. Run a single named test instead." >&2
    # Also report on the channel the caller named, if it named one. Stdout is not that channel:
    # a failing test's diff can quote this message, and the caller cannot tell the two apart.
    [[ -n "${GATE_CHECK_REFUSAL_FILE:-}" ]] && echo "$refusal_line" >>"$GATE_CHECK_REFUSAL_FILE"
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

# Every condition below hands its subject to an external runner, and the runner is not the subject.
# A `pnpm` that is absent, or that rejects a flag in the position this gate uses it, exits non-zero
# having never run the subject - and a check that did not run is UNPROVEN, never FAIL (#41).
# (M-01, stated precisely: `-s` is an option of `run`/`exec`, not a global flag, so `pnpm -s verify`
# exits 2 where `pnpm --silent verify` exits 0.) Two controls, because a probe with one possible
# answer measures nothing - and each demands a SPECIFIC answer, because "any zero" plus "any
# non-zero" is satisfied by a shim that runs nothing: the runner must execute code and hand back
# its exact exit code, and must still report failure for a script that does not exist. Probed once
# per process into a global; PATH does not change mid-run, and `$(...)` is a subshell that could
# keep nothing.
runner_problem(){
  local v c
  [[ -n "$RUNNER_PROBED" ]] && return
  RUNNER_PROBED=1; RUNNER_PROBLEM=''
  if ! command -v pnpm >/dev/null 2>&1; then RUNNER_PROBLEM="runner 'pnpm' is not on PATH"; return; fi
  if ! command -v node >/dev/null 2>&1; then RUNNER_PROBLEM="runner 'node' is not on PATH"; return; fi
  v="$(pnpm --version 2>/dev/null)"
  pnpm --silent exec node -e 'process.exit(7)' >/dev/null 2>&1; c=$?
  # Deliberately not "rejects --silent": a broken store, a missing node and a rejected flag all
  # arrive here, and naming one of them would be a guess dressed as a finding.
  if [[ $c -ne 7 ]]; then
    RUNNER_PROBLEM="pnpm ${v:-?}: control invocation 'exec node -e process.exit(7)' returned $c, not 7"
  elif pnpm --silent run "$NO_SUCH_SCRIPT" >/dev/null 2>&1; then
    RUNNER_PROBLEM="pnpm ${v:-?} reports success for the script '$NO_SUCH_SCRIPT', which does not exist"
  fi
}

# 0.2. `pnpm --silent run verify` also returns non-zero when pnpm is missing, when a flag was
# rejected, when there is no verify script at all, and when the run refused itself; the old code
# called every one of those "pnpm verify failing" and discarded the explanation with `2>&1`.
# Prove the runner, prove the subject exists, and only then read the exit code.
check_verify(){
  local cmd rc sig refusal
  proof "pnpm --silent exec node -e 'process.exit(7)' (control), then pnpm --silent run verify"
  runner_problem
  [[ -n "$RUNNER_PROBLEM" ]] && { unproven "pnpm verify" "$RUNNER_PROBLEM; the check did not run"; return; }
  # A package.json that CONTAINS the text "verify" is not a verify script. `grep -q '"verify"'`
  # matched a `verify` key anywhere in the file and matched `"verify": ""`; pnpm rejects both as a
  # missing script, and the gate reported that non-zero exit as a failing verify. Read the value.
  cmd="$(node -e 'const v=(JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts||{}).verify;
process.stdout.write(typeof v === "string" ? v.trim() : "")' 2>/dev/null)"
  [[ -n "$cmd" ]] || { unproven "pnpm verify" "no verify script readable in package.json (P0-01)"; return; }
  # A refusal is "did not run", so it is UNPROVEN and carries its own reason - but the evidence
  # for it is a file this process created and named, never the child's stdout, which a failing
  # test's diff can fill with the same words. Exit 2 is required as well: a genuine refusal inside
  # a run that then fails for its own reasons (vitest carries on and exits 1) is a FAIL.
  sig="$(mktemp "${TMPDIR:-/tmp}/gate-refusal.XXXXXX" 2>/dev/null)" ||
    { unproven "pnpm verify" "cannot allocate a refusal channel; the check did not run"; return; }
  GATE_CHECK_REFUSAL_FILE="$sig" pnpm --silent run verify >/dev/null 2>&1; rc=$?
  refusal=''; [[ -s "$sig" ]] && read -r refusal <"$sig"
  rm -f "$sig"
  if [[ $rc -eq 0 ]]; then pass "pnpm verify green"
  elif [[ $rc -eq 2 && -n "$refusal" ]]; then unproven "pnpm verify" "$refusal"
  else fail "pnpm verify failing (exit $rc)"; fi
}

# Execute the declared test selector and report the runner's own machine-readable result. PASS
# demands all of: a result was produced, no failures, at least one test actually executed, none
# skipped, exit 0. "Nothing ran" and "all skipped" are green-but-vacuous - the same defect as an
# audit that scanned no files. `owner` names the issue that must write the test, so an UNPROVEN
# line says what to do next.
check_by_running(){
  local label="$1" owner="$2"; shift 2
  local out rc counts p f s
  proof "pnpm --silent exec vitest run --reporter=json $*"
  runner_problem
  [[ -n "$RUNNER_PROBLEM" ]] && { unproven "$label" "$RUNNER_PROBLEM; the check did not run; $owner"; return; }
  out="$(mktemp "${TMPDIR:-/tmp}/gate-result.XXXXXX")" ||
    { unproven "$label" "cannot allocate a result file; $owner"; return; }
  pnpm --silent exec vitest run --reporter=json --outputFile="$out" "$@" >/dev/null 2>&1
  rc=$?
  counts="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
process.stdout.write([j.numPassedTests|0,j.numFailedTests|0,(j.numPendingTests|0)+(j.numTodoTests|0)+(j.numPendingTestSuites|0)].join(" "))' \
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
    # The audits are external commands too, and a mode bit is not a result (#41). `[[ -x ]]` is
    # true for a bad shebang and for a directory - both exit >=126, which was reported as "audits
    # failing" - and true for a zero-byte file, which exits 0 and was reported as PASS. So run
    # each audit and read two things it cannot fake by existing: its exit code, and the verdict
    # line it prints for itself. Exiting 0 while announcing nothing is not a pass. Still out of
    # reach: a file that prints the line while scanning nothing. Closing that needs the audits to
    # report what they scanned, which is a change to files this issue may not touch.
    proof "./scripts/audit-seams.sh && ./scripts/audit-identity.sh"
    aproblem=; afail=0
    for a in seams:SEAM identity:IDENTITY; do
      aout="$(./scripts/audit-${a%%:*}.sh 2>&1)"; arc=$?
      if [[ $arc -ge 126 ]]; then aproblem="./scripts/audit-${a%%:*}.sh could not be run (exit $arc)"
      elif [[ $arc -ne 0 ]]; then afail=1
      elif [[ "$aout" != *"${a##*:} AUDIT PASS"* ]]; then
        aproblem="./scripts/audit-${a%%:*}.sh exited 0 without reporting a result"
      fi
    done
    if [[ -n "$aproblem" ]]; then
      unproven "audits" "$aproblem; the check did not run"
    elif [[ $afail -ne 0 ]]; then
      fail "audits failing (run ./scripts/audit-seams.sh)"
    elif [[ $scanned -eq 0 ]]; then
      unproven "audits" "green but vacuous — no packages/, apps/ or adapters/ to scan (P0-01)"
    else
      pass "audits green over $(ls -d packages apps adapters 2>/dev/null | tr '\n' ' ')"
    fi

    echo "0.2 verify gate"
    check_verify

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
