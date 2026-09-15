#!/usr/bin/env bash
# Seam vocabulary audit (CLAUDE.md invariants 9 and 10).
# Exit 0 = clean. Exit 1 = violation. Safe to run on an empty repo.
#
# SCOPE IS INVERTED (#104). This audit scans the whole tree and excludes a named list, rather than
# scanning a named list and missing the rest. The old form enumerated four directories, so a
# contract test under `tests/` with 13 `tmux` matches passed three review rounds under a green
# `SEAM AUDIT PASS`. See scripts/audit-scope.sh for the exclusions and why each one is there.
set -uo pipefail
cd "$(dirname "$0")/.."
# A MISSING DEPENDENCY MUST NOT PRODUCE A PASS. Without this guard, a tree that lacks
# audit-scope.sh gets an unreadable `.` , then undefined `audit_search`, then zero hits, then
# "SEAM AUDIT PASS". tests/gate-check.test.ts caught exactly that while this change was being written --
# the fail-open of #98 and #104, reproduced a third time inside their own fix.
[ -r scripts/audit-scope.sh ] || {
  echo "SEAM AUDIT ABORT: scripts/audit-scope.sh is missing or unreadable."
  echo "  The audit refuses to report a verdict it did not earn."
  exit 2
}
# shellcheck source=scripts/audit-scope.sh
. scripts/audit-scope.sh

QUIET=0
[[ "${1:-}" == "--quiet-on-pass" ]] && QUIET=1

command -v rg >/dev/null 2>&1 || { echo "SEAM AUDIT FAIL: ripgrep (rg) is required"; exit 1; }

audit_assert_corpus

fail=0
report() { echo "SEAM AUDIT FAIL: $1"; shift; printf '  %s\n' "$@"; fail=1; }

# --- Invariant 9: no git vocabulary in the core ---------------------------------
# NOTE ON SCOPE. This one is deliberately NOT whole-tree, and that is not the #104 bug wearing a
# different hat. Invariant 9 names three places -- packages/domain, packages/protocol and the DB
# schema -- because git vocabulary is LEGAL and expected in adapters/domain/code. A whole-tree scan
# here would fail on the adapter that is supposed to contain it. The scope matches the rule's own
# words, which is the #98 test: enforce the rule as stated, no wider and no narrower.
GIT_PAT='\b(git|commit|branch|merge|worktree|diff|hunk)\b'
CORE_DIRS=()
for d in packages/domain packages/protocol; do [[ -d "$d" ]] && CORE_DIRS+=("$d"); done
if [[ ${#CORE_DIRS[@]} -gt 0 ]]; then
  # Test files are NO LONGER EXEMPT. The old form skipped *.test.* and *.spec.*, unargued. A test
  # in packages/domain that says "commit" leaks the substrate exactly as production code does --
  # arguably worse, because a fixture is where a core test quietly learns which adapter it is
  # running against. #104: if an exemption is right, it has to be argued.
  # Self-exclusions apply here too: packages/domain/test/vocabulary.test.ts and spi.test.ts hold
  # this exact word list as a regex in order to assert invariant 9, and are stricter than this
  # audit is. Matching them would be the audit reading its own pattern back.
  audit_build_globs
  hits=$(rg -n --no-heading --hidden -i "${AUDIT_GLOBS[@]}" -e "$GIT_PAT" "${CORE_DIRS[@]}" 2>/dev/null || true)
  [[ -n "$hits" ]] && report "git vocabulary in core packages" "$hits"
fi
# The DB schema, wherever it lives -- not only under packages/persistence, which is where the old
# form looked.
sql_hits=$(audit_search "$GIT_PAT" -g '*.sql' || true)
[[ -n "$sql_hits" ]] && report "git vocabulary in database schema" "$sql_hits"

# --- Invariant 10: no macOS vocabulary outside the darwin host adapter ----------
# Whole tree. The rule says "outside the host adapter" and means it; the only allowed home is
# adapters/host/darwin, so that is the only path filtered out of the results.
MAC_PAT='(launchd|LaunchAgent|pmset|\btmux\b|\bTCC\b|FileVault|~/Library)'
mac_hits=$(audit_search "$MAC_PAT" | grep -v '^adapters/host/darwin/' || true)
[[ -n "$mac_hits" ]] && report "host vocabulary outside adapters/host/darwin" "$mac_hits"

if [[ $fail -eq 0 ]]; then
  if [[ $QUIET -eq 0 ]]; then
    echo "SEAM AUDIT PASS"
    audit_scope_banner
  fi
  exit 0
fi
echo
echo "Fix by (in order): rename the concept · move the code behind the adapter · extend the contract with an ADR."
echo "See .claude/skills/seam-discipline/SKILL.md. Do NOT add an audit exception."
audit_scope_banner
exit 1
