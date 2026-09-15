#!/usr/bin/env bash
# Identity audit (CLAUDE.md invariant 8): no isMe/isOwner authorization,
# owner_id + org_node_id mandatory on durable tables.
#
# SCOPE IS INVERTED (#104), for the same reason as audit-seams.sh: the old form enumerated three
# directories (packages apps adapters), so `tests/`, `config/` and `scripts/` were never read and
# `IDENTITY AUDIT PASS` said nothing about them. Invariant 8 has no directory qualifier -- it is
# "no if (isOwner) / if (isMe)", everywhere -- so the scan now matches the rule's own breadth.
set -uo pipefail
cd "$(dirname "$0")/.."
# A MISSING DEPENDENCY MUST NOT PRODUCE A PASS. Without this guard, a tree that lacks
# audit-scope.sh gets an unreadable `.` , then undefined `audit_search`, then zero hits, then
# "IDENTITY AUDIT PASS". tests/gate-check.test.ts caught exactly that while this change was being written --
# the fail-open of #98 and #104, reproduced a third time inside their own fix.
[ -r scripts/audit-scope.sh ] || {
  echo "IDENTITY AUDIT ABORT: scripts/audit-scope.sh is missing or unreadable."
  echo "  The audit refuses to report a verdict it did not earn."
  exit 2
}
# shellcheck source=scripts/audit-scope.sh
. scripts/audit-scope.sh
command -v rg >/dev/null 2>&1 || { echo "IDENTITY AUDIT FAIL: ripgrep (rg) is required"; exit 1; }
audit_assert_corpus
fail=0

# Test files are NO LONGER EXEMPT. The old form skipped *.test.* and *.spec.* without argument, and
# a capability check faked in a fixture is precisely where the one-owner shortcut gets normalised --
# the test then passes for a reason the production path does not share.
hits=$(audit_search '\b(isMe|isOwner)\b' || true)
if [[ -n "$hits" ]]; then
  echo "IDENTITY AUDIT FAIL: isMe/isOwner authorization branch found"
  printf '  %s\n' "$hits"
  echo "  Authorization is always a capability-table lookup. The one-owner case is data."
  fail=1
fi

# Durable tables must carry both identity columns.
# Every .sql in scope, not only the two globs under packages/persistence the old form knew about.
# A migration added anywhere else was previously unchecked for the mandatory identity columns.
audit_build_globs
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  python3 - "$f" <<'PY' || fail=1
import re, sys
path = sys.argv[1]
sql = open(path).read()
# crude but sufficient: each CREATE TABLE block up to the closing ");"
for m in re.finditer(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\((.*?)\n\s*\)\s*;', sql, re.S | re.I):
    name, body = m.group(1), m.group(2)
    if name.startswith(('_', 'sqlite_')) or name in {'schema_migrations', 'migrations'}:
        continue
    missing = [c for c in ('owner_id', 'org_node_id') if c not in body]
    if missing:
        print(f"IDENTITY AUDIT FAIL: {path}: table '{name}' missing {', '.join(missing)}")
        sys.exit(1)
PY
done < <(rg --files --hidden "${AUDIT_GLOBS[@]}" -g '*.sql' . 2>/dev/null | sed 's|^\./||')

if [[ $fail -eq 0 ]]; then
  echo "IDENTITY AUDIT PASS"
  audit_scope_banner
fi
exit $fail
