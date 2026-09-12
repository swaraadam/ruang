#!/usr/bin/env python3
"""Backlog helpers: render issue bodies, resolve dependency readiness."""
import json, os, subprocess, sys
try:
    import yaml
except ImportError:
    sys.exit("pip3 install pyyaml")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKLOG = os.path.join(ROOT, "docs/backlog/backlog.yaml")
MAPFILE = os.path.join(ROOT, "docs/backlog/.issue-map.json")


def load():
    with open(BACKLOG) as f:
        return yaml.safe_load(f)["issues"]


def body(i):
    lines = [f"**Backlog id:** `{i['id']}` · **Phase:** {i['phase']} · **Agent:** `{i['agent']}` · **Size:** {i.get('size','M')}", ""]
    lines += ["## Goal", i["goal"].strip(), ""]
    lines += ["## Scope"] + [f"- {s}" for s in i.get("scope", [])] + [""]
    lines += ["## Acceptance"] + [f"- [ ] {a}" for a in i.get("acceptance", [])] + [""]
    if i.get("depends_on"):
        lines += ["## Depends on", ", ".join(f"`{d}`" for d in i["depends_on"]), ""]
    if i.get("blocked_gate"):
        lines += ["## Blocked by external gate", f"⛔ {i['blocked_gate']}", "",
                  "Do not start this issue until the owner closes the gate.", ""]
    if i.get("budget_waiver"):
        # Blueprint 16.2: only the owner may waive, and the waiver is durable evidence. A waiver
        # that renders nowhere is not evidence, so it belongs in the issue body, not just the file.
        lines += ["## Change budget waiver (owner)", i["budget_waiver"].strip(), ""]
    lines += ["## Blueprint references", f"Sections {i.get('refs','-')} of `docs/blueprint/v0.7.md`", ""]
    lines += ["## Definition of done",
              "See `CLAUDE.md` §7 and `.claude/skills/issue-workflow/SKILL.md`. Required: `pnpm verify` green, "
              "evidence comment with commands and output, \"what I would verify manually\", reversibility class, "
              "fresh-reviewer verdict, PR opened. **Never merge or push to `main`.**"]
    return "\n".join(lines)


def labels(i):
    ls = [f"phase-{i['phase']}", f"agent:{i['agent']}"]
    if i.get("blocked_gate"):
        ls.append("blocked-gate")
    return ls


def render():
    return [{"id": i["id"], "title": i["title"], "phase": i["phase"], "agent": i["agent"],
             "depends_on": i.get("depends_on", []), "labels": labels(i), "body": body(i)}
            for i in load()]


def issue_map():
    return json.load(open(MAPFILE)) if os.path.exists(MAPFILE) else {}


def gh_state():
    """{backlog_id: {'number': n, 'state': 'OPEN'|'CLOSED', 'labels': [...]}}"""
    m = issue_map()
    if not m:
        return {}
    try:
        out = subprocess.run(
            ["gh", "issue", "list", "--state", "all", "--limit", "300",
             "--json", "number,state,labels,title"],
            capture_output=True, text=True, check=True).stdout
        rows = {r["number"]: r for r in json.loads(out)}
    except Exception:
        return {}
    res = {}
    for bid, num in m.items():
        r = rows.get(num)
        if r:
            res[bid] = {"number": num, "state": r["state"],
                        "labels": [l["name"] for l in r["labels"]]}
    return res


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "render":
        print(json.dumps(render(), indent=2))
    else:
        print(__doc__)
