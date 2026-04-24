---
name: commit
description: Emit a plain-text commit message — concise one-liner subject describing the change.
---

# commit

Commit the worktree changes with a clear, concise message in plain text. The subject line is a one-liner that captures what changed — imperative mood, no trailing period, ≤ 72 characters.

Read `.flow/tasks/<taskId>/summary.md` and `git diff --cached` / `git diff` to ground the message in what was actually committed.

Output only the commit message. No preamble, no code fences, no trailing commentary.

If you cannot proceed safely or need human judgment, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
