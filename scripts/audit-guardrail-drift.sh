#!/usr/bin/env bash
# Guardrail drift audit.
#
# WHY THIS EXISTS. Issue #98: guardrails.yml enumerated two audit filenames where CLAUDE.md §8
# states the glob `scripts/audit-*.sh`. scripts/audit-path-identity.sh therefore matched neither
# tier and merged with `guardrails` green -- correctly green, because the regex genuinely did not
# cover it. The enforcement kept a narrower promise than the rule it cites.
#
# The failure mode is SILENCE: a path outside the regex produces "No guardrail path touched", which
# is indistinguishable from a PR that touched nothing. Nothing reports the gap, so nothing will.
# This audit is the thing that reports it.
#
# It compares BEHAVIOUR, not text. Two independent things must agree:
#   1. every glob below still appears verbatim in CLAUDE.md §8 (the rule did not move), and
#   2. the OWNER_ONLY regex in guardrails.yml classifies every probe path the way the rule says
#      (the enforcement did not drift from it).
# Changing either side alone fails. That is the point.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_MD="$ROOT/CLAUDE.md"
WORKFLOW="$ROOT/.github/workflows/guardrails.yml"
fail=0

# The documented rule, as CLAUDE.md §8 states it. Each glob must appear verbatim in that file.
DOCUMENTED_GLOBS=(
  '`.github/workflows/**`'
  '`.claude/settings.json`'
  '`scripts/audit-*.sh`'
)

# Probe paths: what the rule says each tier must contain. `owner` = must match OWNER_ONLY.
# `free` = must NOT match (either bot-reviewable or ungated; the BOT_OK tier is checked separately).
# The audit-*.sh probes deliberately include filenames that do not exist -- that is the set an
# agent adding a new audit script is in, and the set the old enumeration failed open on.
PROBES=(
  "owner:.github/workflows/verify.yml"
  "owner:.github/workflows/guardrails.yml"
  "owner:.claude/settings.json"
  "owner:scripts/audit-seams.sh"
  "owner:scripts/audit-identity.sh"
  "owner:scripts/audit-path-identity.sh"
  "owner:scripts/audit-does-not-exist-yet.sh"
  "free:CLAUDE.md"
  # Not in §8's owner-only list. Probed so that adding it to the regex fails here until
  # §8 is amended to say so -- the rule moves first, then the enforcement follows it.
  "free:.claude/agents/pr-landing-agent.md"
  "free:package.json"
  "free:scripts/sandbox.sh"
  "free:packages/domain/src/task.ts"
)

echo "guardrail drift audit"

# --- 1. the rule has not moved -------------------------------------------------------------
for glob in "${DOCUMENTED_GLOBS[@]}"; do
  if ! grep -Fq "$glob" "$CLAUDE_MD"; then
    echo "  FAIL  CLAUDE.md no longer states $glob"
    echo "        The audit's probe table is bound to §8's wording. If the rule genuinely changed,"
    echo "        update DOCUMENTED_GLOBS and PROBES together -- deliberately, as an owner act."
    fail=1
  fi
done

# --- 2. the enforcement matches the rule ---------------------------------------------------
# Pull the live regex out of the workflow rather than restating it, so this cannot pass by
# agreeing with a copy of itself.
OWNER_RE=$(sed -n 's/.*OWNER_ONLY=\$(echo "\$CHANGED" | grep -E '"'"'\(.*\)'"'"'.*/\1/p' "$WORKFLOW")
if [ -z "$OWNER_RE" ]; then
  echo "  FAIL  could not extract the OWNER_ONLY regex from ${WORKFLOW#"$ROOT"/}"
  echo "        The audit cannot verify a pattern it cannot find. Fix the extraction, never"
  echo "        delete the check."
  exit 1
fi
echo "  regex under test: $OWNER_RE"

for probe in "${PROBES[@]}"; do
  want="${probe%%:*}"; path="${probe#*:}"
  if echo "$path" | grep -Eq "$OWNER_RE"; then got=owner; else got=free; fi
  if [ "$want" != "$got" ]; then
    if [ "$want" = owner ]; then
      echo "  FAIL  $path is owner-only by CLAUDE.md §8 but the regex lets it through"
      echo "        This fails OPEN and silently: such a PR reports 'No guardrail path touched'."
    else
      echo "  FAIL  $path is not owner-only by CLAUDE.md §8 but the regex captures it"
      echo "        This fails CLOSED: it demands owner-approved where the rule delegates."
    fi
    fail=1
  fi
done

# --- 3. CLAUDE.md stays in the bot-reviewable tier, not the owner-only one ------------------
# §8: "CLAUDE.md alone is delegated ... It merges on a claude-review: pass marker for the exact
# head SHA." verdict() returns on OWNER_ONLY before it ever consults the marker, so capturing
# CLAUDE.md above does not tighten the gate -- it makes the entire BOT_OK tier unreachable.
if echo "CLAUDE.md" | grep -Eq "$OWNER_RE"; then
  echo "  FAIL  CLAUDE.md is captured by OWNER_ONLY, which CLAUDE.md §8 says is delegated"
  echo "        Worse than a wrong tier: verdict() returns on OWNER_ONLY before the marker"
  echo "        lookup, so BOT_OK becomes dead code and every CLAUDE.md-only PR polls 10"
  echo "        minutes and ends red."
  fail=1
fi
if ! grep -q "BOT_OK=\$(echo \"\$CHANGED\" | grep -E '\^CLAUDE" "$WORKFLOW"; then
  echo "  FAIL  the BOT_OK tier no longer selects CLAUDE.md"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "  ok    enforcement matches CLAUDE.md §8" && exit 0
echo "  guardrail drift audit FAILED"
exit 1
