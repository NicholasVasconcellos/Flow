---
name: mergeResolve
description: Resolve merge conflicts in the listed files — pick the semantically correct resolution, stage the results.
---

# mergeResolve

Resolve the merge conflicts reported when this task's branch was merged
into `main`. The conflicting file paths are in `contextFiles`.

## Goal

For each file in `contextFiles`, produce a single resolved version that
preserves the **semantic intent of both sides** where possible, and stage
the result so the merge can complete. Do not touch files that were not in
conflict.

## How to work

1. For each path in `contextFiles`, open the file and locate the conflict
   markers:

   ```
   <<<<<<< HEAD
   ...their version (main)...
   =======
   ...our version (this task's branch)...
   >>>>>>> flow/<taskId>
   ```

2. For each conflict hunk, choose the resolution:
   - **Both changes apply independently** → include both, in the order that
     makes the file compile/read coherently.
   - **Same construct, both sides changed** → combine them. For example, if
     both sides added an entry to the same array or object, include both
     entries. If both sides renamed the same variable, prefer this task's
     rename (it matches the task's spec) unless `main`'s rename was more
     recent policy.
   - **Genuine conflict of intent** → prefer this task's side (the branch
     the pipeline produced the diff for), and note the fact in a comment
     near the change. If the choice is non-obvious and could silently break
     functionality, emit `FLOW_BLOCKED`.
3. Remove all `<<<<<<<`, `=======`, and `>>>>>>>` markers. Verify no
   markers remain in any listed file.
4. If the resolved file has a known formatter or linter
   (`prettier`/`eslint` via package.json, `rustfmt`, `gofmt`, etc.), run
   it on just the resolved files.
5. Stage the resolved files: `git add <path>` for each. Do not run
   `git commit` — the orchestrator runs `git commit --no-edit` to finalize.

## Rules

- **Only touch files in `contextFiles`.** If resolving one file requires a
  change elsewhere (imports, a moved symbol), flag it in a short summary
  and emit `FLOW_BLOCKED` rather than widening the blast radius silently.
- Do not rewrite or reformat hunks that were not in conflict. Keep the
  resolved file's non-conflict lines byte-identical to the input.
- Never delete code on the losing side of a conflict without noting it.
- Do not add new features or fix pre-existing bugs during a merge.

If you cannot proceed safely or need human judgment, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
