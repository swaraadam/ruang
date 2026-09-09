#!/usr/bin/env bash
# Identity audit (CLAUDE.md invariant 8): no isMe/isOwner authorization,
# owner_id + org_node_id mandatory on durable tables.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

SCAN=()
for d in packages apps adapters; do [[ -d "$d" ]] && SCAN+=("$d"); done
if [[ ${#SCAN[@]} -gt 0 ]]; then
  hits=$(grep -rnE '\b(isMe|isOwner)\b' "${SCAN[@]}" 2>/dev/null | grep -v -e '\.test\.' -e '\.spec\.' || true)
  if [[ -n "$hits" ]]; then
    echo "IDENTITY AUDIT FAIL: isMe/isOwner authorization branch found"
    printf '  %s\n' "$hits"
    echo "  Authorization is always a capability-table lookup. The one-owner case is data."
    fail=1
  fi
fi

# Durable tables must carry both identity columns.
shopt -s nullglob
for f in packages/persistence/migrations/*.sql packages/persistence/**/*.sql; do
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
done

[[ $fail -eq 0 ]] && echo "IDENTITY AUDIT PASS"
exit $fail
