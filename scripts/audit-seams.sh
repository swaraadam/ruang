#!/usr/bin/env bash
# Seam vocabulary audit (CLAUDE.md invariants 9 and 10).
# Exit 0 = clean. Exit 1 = violation. Safe to run on an empty repo.
set -uo pipefail
cd "$(dirname "$0")/.."

QUIET=0
[[ "${1:-}" == "--quiet-on-pass" ]] && QUIET=1

if command -v rg >/dev/null 2>&1; then
  SEARCH() { rg -n --no-heading -i -e "$1" "${@:2}" 2>/dev/null; }
else
  SEARCH() { local pat="$1"; shift; grep -rniE "$pat" "$@" 2>/dev/null; }
fi

fail=0
report() { echo "SEAM AUDIT FAIL: $1"; shift; printf '  %s\n' "$@"; fail=1; }

# --- Invariant 9: no git vocabulary in the core ---------------------------------
GIT_PAT='\b(git|commit|branch|merge|worktree|diff|hunk)\b'
CORE_DIRS=()
for d in packages/domain packages/protocol; do [[ -d "$d" ]] && CORE_DIRS+=("$d"); done
if [[ ${#CORE_DIRS[@]} -gt 0 ]]; then
  hits=$(SEARCH "$GIT_PAT" "${CORE_DIRS[@]}" | grep -v -e '_test\.' -e '\.test\.' -e '\.spec\.' || true)
  [[ -n "$hits" ]] && report "git vocabulary in core packages" "$hits"
fi
if [[ -d packages/persistence ]]; then
  hits=$(SEARCH "$GIT_PAT" packages/persistence --glob '*.sql' 2>/dev/null || grep -rniE "$GIT_PAT" --include='*.sql' packages/persistence 2>/dev/null || true)
  [[ -n "$hits" ]] && report "git vocabulary in database schema" "$hits"
fi

# --- Invariant 10: no macOS vocabulary outside the darwin host adapter ----------
MAC_PAT='(launchd|LaunchAgent|pmset|\btmux\b|\bTCC\b|FileVault|~/Library)'
SCAN=()
for d in packages apps adapters config; do [[ -d "$d" ]] && SCAN+=("$d"); done
if [[ ${#SCAN[@]} -gt 0 ]]; then
  hits=$(SEARCH "$MAC_PAT" "${SCAN[@]}" | grep -v '^adapters/host/darwin/' || true)
  [[ -n "$hits" ]] && report "host vocabulary outside adapters/host/darwin" "$hits"
fi

if [[ $fail -eq 0 ]]; then
  [[ $QUIET -eq 1 ]] || echo "SEAM AUDIT PASS"
  exit 0
fi
echo
echo "Fix by (in order): rename the concept · move the code behind the adapter · extend the contract with an ADR."
echo "See .claude/skills/seam-discipline/SKILL.md. Do NOT add an audit exception."
exit 1
