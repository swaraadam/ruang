# Proposed configuration

Files here are **not live**. They replace something under `.github/workflows/`, a path agents are
denied `Edit` on — a deny that held when these were written. Routing around it with a shell write
is the behaviour `docs/adr/0003-agent-landing-authority.md` exists to forbid, so the change is
staged here for the owner to apply instead.

**Apply them on this PR's own branch**, so the whole change is one PR and costs one label:

```sh
cp docs/proposals/guardrails.yml    .github/workflows/guardrails.yml
cp docs/proposals/claude-review.yml .github/workflows/claude-review.yml
rm -r docs/proposals
git add -A && git commit -m "ci: apply the guardrails and reviewer changes" && git push
```

Then label the PR `owner-approved` — it touches workflows, so it needs it, and this is the last
time a `CLAUDE.md` change will. Merge it.

They are a matched pair and must land together:

- `claude-review.yml` narrows marker-withholding to the **owner-only** paths, so `CLAUDE.md` and
  `scripts/audit-*.sh` start receiving a `claude-review: pass @ <sha>` marker.
- `guardrails.yml` gates those two paths on that marker — **not** on the `review-passed` label,
  which carries no commit identity and would survive a push that changed the code it judged.

Applying only the second refuses every `CLAUDE.md` change, because no marker would ever be emitted
for one. Applying only the first emits a marker nothing reads.
