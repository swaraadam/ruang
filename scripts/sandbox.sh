#!/usr/bin/env bash
# Per-issue sandbox (a git worktree). Parallel agents must never share a working tree.
# Usage: sandbox.sh open|inspect|close <ISSUE-ID> [slug]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CMD="${1:-}"; ID="${2:-}"; SLUG="${3:-}"
[[ -z "$CMD" || -z "$ID" ]] && { echo "usage: sandbox.sh open|inspect|close <ISSUE-ID> [slug]"; exit 2; }
BRANCH="$(echo "${ID}${SLUG:+-$SLUG}" | tr '[:upper:] ' '[:lower:]-')"
DIR="$ROOT/.sandboxes/$ID"

case "$CMD" in
  open)
    mkdir -p "$ROOT/.sandboxes"
    if [[ -d "$DIR" ]]; then echo "sandbox exists: $DIR"; exit 0; fi
    git worktree add -b "$BRANCH" "$DIR" HEAD
    echo "sandbox opened: $DIR (branch $BRANCH)"
    ;;
  inspect)
    # Non-mutating. Mirrors inspect_sandbox(): dirty, summary, safe_to_close.
    [[ -d "$DIR" ]] || { echo "no sandbox for $ID"; exit 0; }
    cd "$DIR"
    DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
    UNPUSHED=$(git log --oneline HEAD --not main 2>/dev/null | wc -l | tr -d ' ')
    echo "sandbox: $DIR"
    echo "dirty_files: $DIRTY"
    echo "unlanded_commits: $UNPUSHED"
    git status --short
    if [[ "$DIRTY" -eq 0 && "$UNPUSHED" -eq 0 ]]; then echo "safe_to_close: true"; else echo "safe_to_close: false"; fi
    ;;
  close)
    [[ -d "$DIR" ]] || { echo "no sandbox for $ID"; exit 0; }
    cd "$DIR"
    DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
    UNPUSHED=$(git log --oneline HEAD --not main 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$DIRTY" -ne 0 || "$UNPUSHED" -ne 0 ]]; then
      echo "REFUSING to close: dirty or unlanded work present (dirty=$DIRTY unlanded=$UNPUSHED)."
      echo "Record a policy outcome on the issue and get an owner decision first."
      exit 1
    fi
    cd "$ROOT"
    git worktree remove "$DIR"
    echo "sandbox closed: $ID"
    ;;
  *) echo "unknown command: $CMD"; exit 2;;
esac
