#!/usr/bin/env bash
# Create labels and one GitHub issue per docs/backlog/backlog.yaml entry.
# Idempotent-ish: skips ids already present in docs/backlog/.issue-map.json.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

command -v gh >/dev/null || { echo "gh CLI required"; exit 1; }
python3 -c "import yaml" 2>/dev/null || { echo "pip3 install pyyaml first"; exit 1; }
[[ $DRY -eq 1 ]] || gh auth status >/dev/null

python3 scripts/lib_backlog.py render > /tmp/backlog-render.json
python3 - "$DRY" <<'PY'
import json, os, subprocess, sys
dry = sys.argv[1] == "1"
data = json.load(open("/tmp/backlog-render.json"))
mapfile = "docs/backlog/.issue-map.json"
existing = json.load(open(mapfile)) if os.path.exists(mapfile) else {}

labels = set()
for i in data:
    labels |= set(i["labels"])
for extra in ("in-progress", "needs-owner", "awaiting-owner-apply", "needs-repair", "blocked-dep", "blocked-gate"):
    labels.add(extra)

def run(args):
    if dry:
        print("DRY:", " ".join(args[:6]), "...")
        return ""
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()

for l in sorted(labels):
    run(["gh", "label", "create", l, "--force"])

created = 0
by_phase, by_agent = {}, {}
for i in data:
    by_phase[i["phase"]] = by_phase.get(i["phase"], 0) + 1
    by_agent[i["agent"]] = by_agent.get(i["agent"], 0) + 1
    if i["id"] in existing:
        continue
    args = ["gh", "issue", "create", "--title", i["title"], "--body", i["body"]]
    for l in i["labels"]:
        args += ["--label", l]
    out = run(args)
    if not dry:
        num = out.rstrip("/").split("/")[-1]
        existing[i["id"]] = int(num) if num.isdigit() else num
        created += 1

if not dry:
    json.dump(existing, open(mapfile, "w"), indent=2, sort_keys=True)

print()
print("backlog entries:", len(data), "| issues created this run:", created)
print("by phase:", dict(sorted(by_phase.items())))
print("by agent:", dict(sorted(by_agent.items())))
print("blocked-gate:", sum(1 for i in data if "blocked-gate" in i["labels"]))
PY

echo
echo "External gates you must close yourself: docs/gates/phase-minus-1.md"
