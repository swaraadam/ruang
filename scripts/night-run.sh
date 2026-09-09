#!/usr/bin/env bash
# Unattended backlog run. Each iteration is a fresh headless Claude Code session working one issue,
# so a stuck session cannot consume the whole night.
#
#   ./scripts/night-run.sh [max-issues] [max-minutes]
#
# Prefer the interactive orchestrator (`claude` then `/run-night 3`) when you can watch the first
# issue land. Use this when you cannot.
set -uo pipefail
cd "$(dirname "$0")/.."

MAX_ISSUES="${1:-20}"
MAX_MIN="${2:-480}"
DAY="$(date +%F)"
LOG_DIR="logs/night/$DAY"
mkdir -p "$LOG_DIR" docs/runs
START=$(date +%s)
n=0

command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }
command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }

echo "night run start $(date -Iseconds) | max_issues=$MAX_ISSUES max_minutes=$MAX_MIN" | tee -a "$LOG_DIR/run.log"

while :; do
  ELAPSED=$(( ($(date +%s) - START) / 60 ))
  [[ $ELAPSED -ge $MAX_MIN ]] && { echo "time budget reached" | tee -a "$LOG_DIR/run.log"; break; }
  [[ $n -ge $MAX_ISSUES ]] && { echo "issue budget reached" | tee -a "$LOG_DIR/run.log"; break; }

  READY=$(python3 scripts/next-ready.py --json 2>/dev/null || echo '[]')
  ID=$(printf '%s' "$READY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["id"] if d else "")' 2>/dev/null)
  [[ -z "$ID" ]] && { echo "no ready issues" | tee -a "$LOG_DIR/run.log"; break; }

  n=$((n+1))
  echo "[$n] $ID starting $(date -Iseconds)" | tee -a "$LOG_DIR/run.log"

  # --dangerously-skip-permissions is required for unattended runs. The deny list in
  # .claude/settings.json plus CLAUDE.md §8 are what keep this bounded: no push, no merge,
  # no secrets, no external writes. Read both before you rely on this.
  claude -p "/next $ID" \
    --dangerously-skip-permissions \
    > "$LOG_DIR/$ID.log" 2>&1
  RC=$?
  echo "[$n] $ID exited rc=$RC $(date -Iseconds)" | tee -a "$LOG_DIR/run.log"

  if [[ $RC -ne 0 ]]; then
    FAILS=$((${FAILS:-0}+1))
    if [[ ${FAILS} -ge 3 ]]; then
      echo "three consecutive failures — stopping, something systemic is wrong" | tee -a "$LOG_DIR/run.log"
      break
    fi
  else
    FAILS=0
  fi
done

echo "night run end $(date -Iseconds)" | tee -a "$LOG_DIR/run.log"
claude -p "Read logs/night/$DAY/*.log and the current issue state, then write docs/runs/$DAY.md following docs/runs/README.md. Be honest and brief." \
  --dangerously-skip-permissions >> "$LOG_DIR/report.log" 2>&1
echo "report: docs/runs/$DAY.md"
