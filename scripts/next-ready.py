#!/usr/bin/env python3
"""List backlog issues that are ready to start: open, unclaimed, all dependencies closed,
not blocked by an external gate. Usage: next-ready.py [--json] [--all]"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_backlog as lb

rendered = {i["id"]: i for i in lb.render()}
state = lb.gh_state()
show_all = "--all" in sys.argv

ready, blocked, done, unmapped = [], [], [], []
for bid, i in rendered.items():
    st = state.get(bid)
    if st is None:
        unmapped.append(bid)
        continue
    if st["state"] == "CLOSED":
        done.append(bid)
        continue
    lab = set(st["labels"])
    if "blocked-gate" in lab:
        blocked.append((bid, "external gate"))
        continue
    if "needs-owner" in lab:
        blocked.append((bid, "needs owner decision"))
        continue
    if "in-progress" in lab:
        blocked.append((bid, "claimed"))
        continue
    if "awaiting-owner-apply" in lab:
        blocked.append((bid, "PR awaiting owner apply"))
        continue
    open_deps = [d for d in i["depends_on"]
                 if state.get(d, {}).get("state", "OPEN") != "CLOSED"]
    if open_deps:
        blocked.append((bid, "deps open: " + ",".join(open_deps)))
        continue
    ready.append(bid)

ready.sort()
if "--json" in sys.argv:
    print(json.dumps([{k: rendered[b][k] for k in ("id", "title", "phase", "agent", "labels")}
                      | {"number": state[b]["number"]} for b in ready], indent=2))
else:
    if not state:
        print("No issue map yet. Run /bootstrap (scripts/bootstrap-issues.sh) first.")
        sys.exit(0)
    print(f"READY ({len(ready)}):")
    for b in ready:
        print(f"  #{state[b]['number']:<4} {b}  [{rendered[b]['agent']}]  {rendered[b]['title']}")
    print(f"\nclosed: {len(done)} | blocked: {len(blocked)} | unmapped: {len(unmapped)}")
    if show_all:
        print("\nBLOCKED:")
        for b, why in sorted(blocked):
            print(f"  {b}: {why}")
