---
name: merge-resolve
description: Resolve merge conflicts in the listed files. Combine independent changes only; emit FLOW_BLOCKED on overlapping edits and FLOW_REVIEW_REQUESTED for low-confidence resolutions.
---

# merge-resolve

You are running in the **main checkout** (not a task worktree) mid `git
merge`. Conflict markers live in the listed files relative to your current
working directory. Do not `cd` anywhere. Do not run `git commit` — the
orchestrator finalizes the merge after you exit. Just resolve markers,
stage the files, and stop.

The orchestrator started a merge that hit conflicts. Your prompt's
`extraPrompt` lists the conflicting paths.

## Resolution policy

For each conflicting path:

1. Open the file. Locate every `<<<<<<<` / `=======` / `>>>>>>>` block.
2. Combine **independent** changes only — different files or non-overlapping
   hunks. Branches' changes must not contradict each other.
3. If **both sides modified the same logical block** → emit
   `FLOW_BLOCKED: overlapping change in <path> — <reason>` and stage
   nothing in that file. The "main" side may carry an earlier task's
   deliberate change you can't see.
4. If your resolution is **plausible but uncertain** → stage it and
   emit `FLOW_REVIEW_REQUESTED: <reason>`.
5. Remove every conflict marker, then `git add <path>`.

Touch only the listed files. Do not run tests, reformat, commit, or
fix unrelated issues — the orchestrator finalizes the merge.

## Termination

When every listed file is staged and conflict-marker-free, **stop**. The
orchestrator will scan for residual markers and run a verification gate
before finalizing the commit; if either step fails, the merge is aborted
and the task pauses regardless of what you reported here.
