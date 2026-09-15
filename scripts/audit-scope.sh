#!/usr/bin/env bash
# Shared scan scope for the seam and identity audits. Sourced, never executed.
#
# WHY THIS FILE EXISTS. Issues #98 and #104 are the same bug on three files: the enforcer
# ENUMERATES WHAT TO CHECK, so it fails open, silently, on whatever nobody named.
#
#   guardrails.yml  stated `scripts/audit-*.sh`     enforced two filenames        (#98)
#   audit-seams.sh  stated invariant 10, everywhere enforced four directories     (#104)
#   audit-identity  stated invariant 8,  everywhere enforced three directories    (#104)
#
# In every case the check reported success while having decided less than it claimed. #104's
# measurement is the sharpest: a contract test with 13 `tmux` matches sat under `tests/`, which was
# not in SCAN, and `SEAM AUDIT PASS` was true and uninformative about it for three review rounds.
# An engineer ran `pnpm verify`, read PASS, and reasonably concluded the seam was clean.
#
# THE DEFAULT IS NOW INVERTED. Scan everything; enumerate only what is excluded, here, once, with a
# reason per entry. A new directory is IN SCOPE the moment it exists -- which is the property the
# old form could not have. Both audits source this file so the two lists cannot drift apart.
#
# The exclusions are not a convenience list. Each is either not source, or is the rule's own text.

# Not source. Build output, dependencies, runtime state, and other agents' working trees.
AUDIT_EXCLUDE_NOT_SOURCE=(
  '.git' 'node_modules' 'dist' '.turbo' 'coverage'
  '.sandboxes'        # other agents' worktrees; each is audited on its own branch
  'state'             # runtime artifacts and debug output, not committed source
  'pnpm-lock.yaml'
)

# PROSE. Documentation, agent and skill definitions, the backlog, run reports, root READMEs.
#
# THE LINE IS EXECUTABILITY, NOT TIDINESS. Invariants 9 and 10 exist so the core does not DEPEND on
# git or on macOS -- so the host adapter can be swapped without touching anything above it. A file
# that describes the system creates no such dependency. `.claude/agents/host-darwin-engineer.md`
# must say "tmux": it defines the agent that owns the tmux adapter. `docs/backlog/backlog.yaml`
# states "no isMe/isOwner branch anywhere" as an acceptance criterion FOR the invariant. A run
# report describes a `~/Library/LaunchAgents` traversal that was found and fixed. None of these can
# be rewritten into compliance, and demanding it would only push the next report into euphemism.
#
# This is NOT the scan narrowing to stay quiet, which is what #104 is about. Everything that
# executes or is read at runtime stays in scope, and `tests/` and `config/` in particular: the file
# that started #104 -- tests/contract/host-adapter.contract.test.ts, 13 `tmux` matches -- fails
# under this list, which is the check that this line was drawn in the right place.
#
# ANCHORED WITH A LEADING SLASH. Bare 'docs' and '.claude' are unanchored rg globs and would exempt
# a directory of that name at ANY depth -- a future packages/x/docs/ would be silently out of
# scope with nothing failing. That is this issue's own shape hiding in its own exclusion list.
# '*.md' stays unanchored on purpose: prose is prose wherever it sits.
AUDIT_EXCLUDE_PROSE=(
  '/docs'           # blueprint (input, uneditable per §8), backlog (plan), runs (history of record)
  '/.claude'        # agent and skill definitions; several scope themselves BY naming the vocabulary
  '*.md'            # CLAUDE.md, SETUP.md, READMEs -- prose wherever it sits
)

# THE RULE'S OWN TEXT, in files that DO execute. These hold the forbidden patterns as literals in
# order to enforce them, so a match is the audit reading itself back. Narrow by construction: four
# named files, never a directory, and printed on every run by `audit_scope_banner`. An exemption
# nobody can see is how #104 happened in the first place.
AUDIT_EXCLUDE_SELF=(
  'scripts/audit-seams.sh'
  'scripts/audit-identity.sh'
  'scripts/audit-scope.sh'
  'scripts/audit-path-identity.sh'
  'packages/domain/test/vocabulary.test.ts'   # asserts invariant 9, stricter than this audit
  'packages/domain/test/spi.test.ts'          # same, for the SPI surface
  'packages/policy/test/capability.test.ts'   # asserts invariant 8 by matching /isMe|isOwner/
  'tests/audit-scope.test.ts'                 # feeds this audit its own banned words as probes
)

# That last entry is the self-reference trap closing on itself, and it is worth saying how it was
# found. tests/audit-scope.test.ts exists to prove `tests/` is in scope -- so it necessarily
# contains 'tmux' and 'launchd' as probe strings, and the first run of the very audit it tests
# flagged it. The exemption is correct, but note what it costs: this file can now hold a real leak
# invisibly. It is named, printed on every run, and it is the ONLY test file here that is not
# asserting a vocabulary rule, which is the line to hold if the list ever grows again.

audit_excludes_all() {
  printf '%s\n' "${AUDIT_EXCLUDE_NOT_SOURCE[@]}" "${AUDIT_EXCLUDE_PROSE[@]}" "${AUDIT_EXCLUDE_SELF[@]}"
}

# Build rg's -g '!x' flags for every exclusion into AUDIT_GLOBS.
#
# NO `mapfile` HERE. macOS ships bash 3.2, which does not have it. The first draft of this file used
# it, and on the owner's own machine `audit_search` expanded to an unbound variable, matched nothing
# and let the audit report PASS having scanned ZERO FILES. That is this issue's bug, reintroduced
# inside its own fix, which is why `audit_search` now refuses to run on an empty corpus below.
audit_build_globs() {
  AUDIT_GLOBS=()
  local e
  for e in "${AUDIT_EXCLUDE_NOT_SOURCE[@]}" "${AUDIT_EXCLUDE_PROSE[@]}" "${AUDIT_EXCLUDE_SELF[@]}"; do
    AUDIT_GLOBS+=( -g "!$e" -g "!$e/**" )
  done
}

# Search the whole tree minus the exclusions. $1 = ERE pattern; remaining args = extra rg flags.
# --hidden so `.claude/` and other dotted trees are in scope; they were invisible before.
audit_search() {
  local pat="$1"; shift
  audit_build_globs
  rg -n --no-heading --hidden -i "${AUDIT_GLOBS[@]}" "$@" -e "$pat" . 2>/dev/null | sed 's|^\./||'
}

# A CHECK THAT SCANNED NOTHING MUST NOT REPORT SUCCESS. #98 and #104 are both a silent empty set
# reported as a pass; the mapfile slip above made it three. Every audit calls this before drawing
# any conclusion, so "no violations" can never again mean "no files looked at".
audit_assert_corpus() {
  audit_build_globs
  local n
  n=$(rg --files --hidden "${AUDIT_GLOBS[@]}" . 2>/dev/null | wc -l | tr -d ' ')
  # ZERO, not an arbitrary floor. A first draft used 20 and broke the gate-check fixtures, which
  # build deliberately tiny trees -- a small corpus is a legitimate answer, an EMPTY one is not.
  if [[ "${n:-0}" -eq 0 ]]; then
    echo "AUDIT ABORT: scan corpus is empty."
    echo "  The audit refuses to report a verdict it did not earn. Check rg, the exclusion"
    echo "  globs, and that this is being run from the repository root."
    exit 2
  fi
  AUDIT_CORPUS_N="$n"
}

# #104's core complaint: a check that decided less than it claims must not report a bare success.
# Every run states its scope, so PASS is never uninformative again.
audit_scope_banner() {
  echo "  scope: ${AUDIT_CORPUS_N:-?} files scanned, whole tree minus $(audit_excludes_all | wc -l | tr -d ' ') exclusions"
  echo "  not source: ${AUDIT_EXCLUDE_NOT_SOURCE[*]}"
  echo "  prose:      ${AUDIT_EXCLUDE_PROSE[*]}"
  echo "  rule text:  ${AUDIT_EXCLUDE_SELF[*]}"
}
