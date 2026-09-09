---
description: Park the current issue for owner decision with a crisp question
argument-hint: "<issue-id> <what is blocked>"
---

Park issue $1 correctly:

1. Comment on the issue with: what you were doing, exactly what is blocked, the specific decision
   or action needed from the owner, the options you can see with their trade-offs, and your
   recommendation with reasoning.
2. Add `needs-owner`, remove `in-progress`.
3. `scripts/sandbox.sh inspect $1` and record the dirtiness/retained artifacts in the comment.
   Never destroy a dirty sandbox.
4. Append the question to today's `docs/runs/<today>.md` under "Needs your decision".
5. Move on to the next ready issue.

One sharp question is worth more than a workaround. Do not soften the blocker to look productive.
