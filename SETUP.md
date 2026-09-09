# Setup — do this before you go to bed

## 0. Read this first

I can't work while you sleep. This scaffold makes **Claude Code on your Mac Mini** do it. Nothing
runs until you start it, and the commands below are what start it.

## 1. Put the files in the repo

```bash
mkdir -p ~/code/agent-workspace && cd ~/code/agent-workspace
git init && git branch -M main
# unzip the delivered archive into this directory
git add -A && git commit -m "chore: agent workspace scaffold (CLAUDE.md, .claude, backlog)"
gh repo create <name> --private --source=. --push   # private, and the name is a placeholder
```

Then drop the blueprint in as the input agents read:

```bash
# export Technical Blueprint v0.7 to markdown and save as:
docs/blueprint/v0.7.md
```

**Do this.** Everything references section numbers in that file. Without it the agents will work
from `CLAUDE.md` alone, which is a summary, not the source.

## 2. Prerequisites

```bash
node -v          # >= 22
pnpm -v
gh auth status
python3 -c "import yaml" || pip3 install pyyaml
tmux -V
claude --version
```

## 3. Create the issues

```bash
claude              # in the repo
/bootstrap
```

28 issues (19 Phase 0, 9 Phase 1), dependency-labelled. Two are `blocked-gate` and will be skipped
until you close the external gates.

## 4. Sanity-run one issue while you're awake

```bash
/next P0-01
```

Watch it: claim → sandbox worktree → implement → `pnpm verify` → evidence comment → PR. If that
one issue behaves, the rest of the night is the same loop. If it doesn't, you've lost 15 minutes
instead of 8 hours.

## 5. Start the overnight run

Interactive (better — you see the first dispatch, then walk away):

```bash
claude --dangerously-skip-permissions
/run-night 3
```

Or fully headless, one fresh session per issue, capped:

```bash
./scripts/night-run.sh 20 480    # max 20 issues, max 8 hours
```

`--dangerously-skip-permissions` is what makes unattended work possible. What bounds it: the deny
list in `.claude/settings.json` (no push, no merge, no secrets, no launchctl, no publish, no
external writes) and `CLAUDE.md` §8. Read both before you rely on them. Agents open PRs; landing
is always yours.

## 6. In the morning

```bash
cat docs/runs/$(date +%F).md      # landed / needs your decision / unknown / next
gh pr list
python3 scripts/next-ready.py --all
./scripts/gate-check.sh 0
```

Expect parked issues with questions. That's the design — a sharp question beats a guess.

## What you have to decide yourself

`docs/gates/phase-minus-1.md` — three gates no agent can close:

1. **Naming clearance** (product/repo/CLI/hostname/WebAuthn RP ID). Placeholders live in
   `config/naming.ts`. The RP ID is the expensive one: it's baked into every credential you enrol.
2. **Canonical-origin proof** — one origin over both Tailscale and Cloudflare, on a throwaway
   hostname, *before* any passkey.
3. **Real cost ceilings** — monthly/hourly/task/run. Placeholders aren't configuration; P1-08 stays
   blocked until you fill them in.

Plus Gate 4, the orchestrator-delegation ADR, which needs two weeks of real use — that's what
Phase 1's stop-and-use period is for.

## Layout

```
CLAUDE.md                    project constitution — read by every session
.claude/agents/*.md          11 specialists (orchestrator, spine, protocol, adapters, reviewers)
.claude/skills/*/SKILL.md    7 skills: seams, events, fail-closed, persistence, tests, gates, workflow
.claude/commands/*.md        /bootstrap /next /run-night /audit /gate /park
.claude/settings.json        permission allow+deny list, post-edit seam-audit hook
docs/backlog/backlog.yaml    the only source of scope
docs/gates/                  external Phase -1 gates, friction log
docs/adr/                    ADR-0000 (naming), template
scripts/                     audits, sandboxes, gate check, issue bootstrap, night run
config/naming.ts             every placeholder identifier, one file
```
