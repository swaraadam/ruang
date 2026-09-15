#!/usr/bin/env bash
# Per-issue sandbox (a git worktree). Parallel agents must never share a working tree.
# Usage: sandbox.sh open|inspect|close <ISSUE-ID> [slug]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# --- Unreproducible content (#103) -------------------------------------------------------------
# `git status --porcelain` OMITS IGNORED FILES. A sandbox whose only copy of some work sat under an
# ordinary .gitignore therefore reported dirty_files: 0 and safe_to_close: true -- and §7.6 tells
# every agent to trust that signal before teardown. The 2026-09-13 run nearly lost 1400 authored
# lines to a sandbox believed empty; only `dirty_files: 21` saved it.
#
# Teardown asks a different question from a change set: not "what may be applied" but "does
# anything here exist ONLY here". The answer is not tracked-ness -- it is reproducibility. An
# ignored dist/ can be rebuilt; an ignored notes/ cannot.
#
# The reproducible list is DECLARED ONCE in config/reproducible-paths.json and read by both this
# script and the adapter's inspect_sandbox/close_sandbox. The script used to say it "mirrors
# inspect_sandbox()" and mirrored its bug instead; a rule kept in two places drifts, and #103 is
# what that drift looked like.
REPRO_JSON="$ROOT/config/reproducible-paths.json"

# Ignored paths that are NOT declared reproducible.
#
# Filtering happens HERE, on git's output, rather than by handing git `:(exclude)` pathspecs. That
# was the first attempt and it silently did nothing: `--ignored=matching` still collapses a wholly
# ignored directory to `node_modules/`, and an exclude pathspec written for the files inside does
# not match the collapsed directory entry. The result flagged every build directory as precious --
# which #103 names as the failure that makes an inspect nobody reads.
#
# Filtering the output also keeps this identical to what the adapter must do in TypeScript: read
# the same JSON, apply the same match. Neither side invents its own rule.
unreproducible() {
  if [[ ! -r "$REPRO_JSON" ]]; then
    echo "REFUSING: $REPRO_JSON is missing. Teardown cannot decide what is safe to destroy." >&2
    exit 2
  fi
  git status --porcelain --ignored=matching 2>/dev/null | grep '^!! ' | sed 's/^!! //' \
    | python3 -c '
import json, sys, fnmatch
spec = [e["path"] for e in json.load(open(sys.argv[1]))["reproducible"]]
def reproducible(p):
    p = p.rstrip("/")
    for s in spec:
        # A declared path matches itself, anything beneath it, and as a glob (e.g. *.sqlite).
        if p == s or p.startswith(s + "/") or fnmatch.fnmatch(p, s) or fnmatch.fnmatch(p, s + "/*"):
            return True
    return False
for line in sys.stdin:
    p = line.strip()
    if p and not reproducible(p):
        print(p)
' "$REPRO_JSON" || true
}

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
    UNREPRO="$(unreproducible)"
    UNREPRO_N=$(printf '%s' "$UNREPRO" | grep -c . || true)
    echo "sandbox: $DIR"
    echo "dirty_files: $DIRTY"
    echo "unlanded_commits: $UNPUSHED"
    echo "unreproducible_ignored: $UNREPRO_N"
    git status --short
    [[ -n "$UNREPRO" ]] && { echo "  ignored, and not declared reproducible:"; printf '  !! %s\n' $UNREPRO; }
    # #103 asked for the judgement to be visible rather than silent: say what was discounted.
    echo "  discounted as reproducible: $(python3 -c '
import json,sys
print(" ".join(e["path"] for e in json.load(open(sys.argv[1]))["reproducible"]))' "$REPRO_JSON" 2>/dev/null)"
    if [[ "$DIRTY" -eq 0 && "$UNPUSHED" -eq 0 && "$UNREPRO_N" -eq 0 ]]; then echo "safe_to_close: true"; else echo "safe_to_close: false"; fi
    ;;
  close)
    [[ -d "$DIR" ]] || { echo "no sandbox for $ID"; exit 0; }
    cd "$DIR"
    DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
    UNPUSHED=$(git log --oneline HEAD --not main 2>/dev/null | wc -l | tr -d ' ')
    UNREPRO="$(unreproducible)"
    UNREPRO_N=$(printf '%s' "$UNREPRO" | grep -c . || true)
    # RESCUE FIRST, AND NOT GATED ON `dirty`. In the adapter, `force: true` still lost the file
    # because the rescue was gated on the same predicate that was blind to it (#103, #74 round 4).
    # Copying costs nothing when there is nothing to copy, so it runs before any decision.
    if [[ -n "$UNREPRO" ]]; then
      RESCUE="$ROOT/state/debug/sandbox-rescue/$ID-$(date +%Y%m%dT%H%M%S)"
      mkdir -p "$RESCUE"
      printf '%s\n' $UNREPRO | while IFS= read -r f; do
        [[ -e "$f" ]] || continue
        mkdir -p "$RESCUE/$(dirname "$f")"; cp -R "$f" "$RESCUE/$f"
      done
      echo "rescued $UNREPRO_N ignored-unreproducible path(s) to:"
      echo "  $RESCUE"
    fi
    if [[ "$DIRTY" -ne 0 || "$UNPUSHED" -ne 0 || "$UNREPRO_N" -ne 0 ]]; then
      echo "REFUSING to close: dirty, unlanded, or unreproducible work present"
      echo "  (dirty=$DIRTY unlanded=$UNPUSHED unreproducible_ignored=$UNREPRO_N)."
      [[ -n "$UNREPRO" ]] && printf '  !! %s\n' $UNREPRO
      echo "Record a policy outcome on the issue and get an owner decision first."
      exit 1
    fi
    cd "$ROOT"
    git worktree remove "$DIR"
    echo "sandbox closed: $ID"
    ;;
  *) echo "unknown command: $CMD"; exit 2;;
esac
