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
  # NO `|| true` ON THIS PIPELINE, AND THE EXIT STATUS IS READ. An earlier version ended it with
  # `|| true` to keep `set -e` from firing on grep's empty-match exit 1. That masked every other
  # failure too -- malformed JSON, a missing "reproducible" key, or no python3 on the host, none of
  # which §5's stack guarantees. Each produced EMPTY STDOUT, which is indistinguishable from
  # "nothing unreproducible found": UNREPRO_N read 0, inspect said safe_to_close: true, and close
  # walked past the gate into an irreversible `git worktree remove`.
  #
  # That is #103's own defect one layer down -- a teardown check reporting "safe" when it does not
  # know -- reintroduced inside the fix for it. A check that failed must never be read as a check
  # that passed.
  #
  # AND EXIT STATUS ALONE CANNOT SAY SO. The first attempt at this fix read the pipeline status and
  # tolerated 1 as "grep found no matches" -- but an unhandled Python exception also exits 1, so a
  # malformed config was still indistinguishable from a clean tree, and inspect still said
  # safe_to_close: true. Measured, not reasoned: it reproduced on the very repro written for it.
  #
  # So the check now CONFIRMS ITSELF POSITIVELY. python prints a sentinel as its last line only on
  # a completed pass. No sentinel means the check did not finish -- crash, malformed JSON, missing
  # python3, truncated pipe -- and teardown refuses. Absence of evidence is not evidence here.
  local out rc
  out=$(
    set -o pipefail
    git status --porcelain --ignored=matching | grep '^!! ' | sed 's/^!! //' \
      | python3 -c '
import json, sys, fnmatch
cfg = json.load(open(sys.argv[1]))
spec = [e["path"] for e in cfg["reproducible"]] + [e["path"] for e in cfg.get("disposable", [])]
def reproducible(p):
    # A declared path matches AT ANY DEPTH, not only at the repository root. This is a pnpm
    # workspace: dist/ and node_modules/ exist under every package, so a root-anchored match left
    # apps/gateway/dist and packages/attention/dist looking unreproducible and made all six live
    # sandboxes read as unsafe -- the "inspect nobody reads" failure this issue is about, produced
    # by the fix for it. Caught by running the check against the real sandboxes, not by the tests.
    p = p.rstrip("/")
    for s in spec:
        if s.startswith("*"):                       # a glob: match the basename at any depth
            if fnmatch.fnmatch(p.rsplit("/", 1)[-1], s):
                return True
            continue
        if p == s or p.startswith(s + "/"):         # at the root
            return True
        if ("/" + p).endswith("/" + s) or ("/" + p + "/").find("/" + s + "/") >= 0:
            return True                             # nested: apps/gateway/dist, x/node_modules/y
    return False
for line in sys.stdin:
    p = line.strip()
    if p and not reproducible(p):
        print(p)
print("__UNREPRO_CHECK_COMPLETED__")
' "$REPRO_JSON"
  ) || true
  if [[ "$(printf '%s' "$out" | tail -n 1)" != "__UNREPRO_CHECK_COMPLETED__" ]]; then
    echo "REFUSING: the unreproducible-content check did not complete." >&2
    echo "  It prints a sentinel on a finished pass; there is none, so it crashed, could not read" >&2
    echo "  $REPRO_JSON, or found no python3. Teardown will not treat a check that did not run" >&2
    echo "  as a check that found nothing." >&2
    exit 2
  fi
  printf '%s' "$out" | sed '$d'
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
    if [[ -n "$UNREPRO" ]]; then
      echo "  ignored, and not declared reproducible:"
      # Read line-by-line and quoted: a path with a space or a glob character would otherwise be
      # word-split or pathname-expanded, and this list is the evidence the owner acts on.
      while IFS= read -r f; do [[ -n "$f" ]] && printf '  !! %s\n' "$f"; done <<< "$UNREPRO"
    fi
    # #103 asked for the judgement to be visible rather than silent: say what was discounted.
    echo "  discounted as reproducible: $(python3 -c '
import json,sys
c=json.load(open(sys.argv[1]));print(" ".join(e["path"] for e in c["reproducible"]+c.get("disposable",[])))' "$REPRO_JSON" 2>/dev/null)"
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
      while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        [[ -e "$f" ]] || continue
        mkdir -p "$RESCUE/$(dirname "$f")"; cp -R "$f" "$RESCUE/$f"
      done <<< "$UNREPRO"
      echo "rescued $UNREPRO_N ignored-unreproducible path(s) to:"
      echo "  $RESCUE"
    fi
    if [[ "$DIRTY" -ne 0 || "$UNPUSHED" -ne 0 || "$UNREPRO_N" -ne 0 ]]; then
      echo "REFUSING to close: dirty, unlanded, or unreproducible work present"
      echo "  (dirty=$DIRTY unlanded=$UNPUSHED unreproducible_ignored=$UNREPRO_N)."
      while IFS= read -r f; do [[ -n "$f" ]] && printf '  !! %s\n' "$f"; done <<< "$UNREPRO"
      echo "Record a policy outcome on the issue and get an owner decision first."
      exit 1
    fi
    cd "$ROOT"
    git worktree remove "$DIR"
    echo "sandbox closed: $ID"
    ;;
  *) echo "unknown command: $CMD"; exit 2;;
esac
