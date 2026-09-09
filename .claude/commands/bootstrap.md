---
description: One-time setup — create labels and GitHub issues from docs/backlog/backlog.yaml
allowed-tools: Bash(gh *), Bash(python3 *), Bash(./scripts/*), Read, Write
---

Bootstrap the issue tracker for this repo. Run once, on a fresh repo.

1. Verify prerequisites and report anything missing before changing state:
   `gh auth status`, `git remote -v`, `pnpm --version`, `python3 -c "import yaml"`.
   If `pyyaml` is missing: `pip3 install pyyaml`.
2. `./scripts/bootstrap-issues.sh --dry-run` and show me the counts per phase and per agent.
3. If it looks right, `./scripts/bootstrap-issues.sh` for real. It creates labels, creates one
   issue per backlog entry, applies `phase-*`, `agent:*`, `blocked-dep` and `blocked-gate` labels,
   and writes `docs/backlog/.issue-map.json`.
4. Print: total issues created, how many are immediately ready (`python3 scripts/next-ready.py`),
   how many are `blocked-gate`, and the three external gates from `docs/gates/phase-minus-1.md`
   that I have to close myself.
5. Do not start any implementation work in this command.
