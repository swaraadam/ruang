---
description: Take the next ready issue, implement it end to end, open a PR
argument-hint: "[issue-id, optional]"
---

Work exactly one issue to completion. Issue: $1 (if empty, take the first from
`python3 scripts/next-ready.py`).

Follow `.claude/skills/issue-workflow/SKILL.md` exactly:

1. Claim it (`in-progress` + comment). Never take an issue already claimed, `blocked-gate` or
   `needs-owner`.
2. Read the issue body, then the blueprint sections it references, then the code it touches.
3. `scripts/sandbox.sh open <ISSUE-ID>` and work only in that worktree.
4. Delegate the implementation to the specialist named in the issue's `agent:` label via the Task
   tool. Do not implement outside your specialty.
5. `pnpm verify` must be green.
6. Post the evidence comment, including "what I would verify manually" and the reversibility class.
7. Dispatch `fresh-reviewer`; add `security-reviewer` if the change touches apply, approvals,
   credentials, auth or budgets. Address `request-changes` as a new attempt (max 2).
8. Open the PR, swap labels to `awaiting-owner-apply`. Never merge, never push to `main`.

If you hit anything in `CLAUDE.md` §8, park the issue with a crisp question and stop. Do not guess.
