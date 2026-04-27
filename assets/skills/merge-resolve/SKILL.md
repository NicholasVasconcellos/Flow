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
2. **Combine independent changes only** — different files, or non-overlapping
   hunks within the same file. The branches' changes must not contradict
   each other.
3. **If both sides modified the same logical block**, do *not* guess a
   merge. The "main" side may carry a security fix, an earlier sibling
   task's deliberate change, or a refactor whose intent isn't visible from
   the diff alone. In that case, stop and emit:
   ```
   FLOW_BLOCKED: overlapping change in <path> — <one-sentence reason>
   ```
   Do not stage anything in that file. The task pauses for human review.
4. **If your resolution is plausible but you are not certain** (e.g. you
   combined imports but the resulting symbol set is novel; you preserved
   one signature over another based on the description), stage the
   resolution and emit:
   ```
   FLOW_REVIEW_REQUESTED: <one-sentence reason>
   ```
   The merge proceeds, but a warn-level notification surfaces the concern
   so a human can audit without halting the queue.
5. Remove every conflict marker. The file must contain none when you save.
6. `git add <path>`.

Touch only the listed files. Do not run tests, reformat untouched code, or
fix unrelated issues. Do not commit — the orchestrator runs the final
commit after you exit.

## Termination

When every listed file is staged and conflict-marker-free, **stop**. The
orchestrator will scan for residual markers and run a verification gate
before finalizing the commit; if either step fails, the merge is aborted
and the task pauses regardless of what you reported here.
