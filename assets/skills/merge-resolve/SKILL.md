---
name: merge-resolve
description: Resolve merge conflicts in the listed files — pick the semantically correct resolution, stage the results, then stop.
---

# merge-resolve

You are running in the **main checkout** (not a task worktree) mid
`git merge`. Conflict markers live in the listed files relative to your
current working directory. Do not `cd` anywhere. Do not run `git commit`
— the orchestrator runs `git commit --no-edit` after you exit. Just
resolve markers, stage the files, and stop.

The orchestrator started a merge that hit conflicts. Your prompt's
`extraPrompt` lists the conflicting paths and the resolution rule.

For each conflicting path:

1. Open the file. Locate every `<<<<<<<` / `=======` / `>>>>>>>` block.
2. Combine both sides where they're independent. Where intent genuinely
   conflicts, prefer this task's branch and note the choice in a comment.
3. Remove every conflict marker. The file must contain none when you save.
4. `git add <path>`.

Touch only the listed files. Do not commit — the orchestrator runs
`git commit --no-edit` after you exit.

## Termination

When every listed file is staged and conflict-marker-free, **stop**. Do
not run tests, reformat untouched code, or fix unrelated issues.

If you cannot resolve a conflict safely, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
