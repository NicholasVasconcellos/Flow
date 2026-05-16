Execute one task. Project rules (AGENTS.md), codebase map (Map.md), and task data (id, title, description, goal, acceptance criteria, target files, context files, flags) are provided above.

Use targetFiles as primary scope. If an elegant implementation requires unlisted files, edit them — and append the newly-touched paths to that task's `targetFiles` array in `.flow/tasks.json`.

Plan (write a concise outline, sequential):
- List files to create/modify.
- Per file: contents (types, functions, classes, routes).
- Mark independent chunks. (Sequential execution for now — don't fork subagents.)

Implement.
- If hasTests=true: create or extend unit tests verifying the acceptance criteria.
- Test incrementally as you build, not only at the end.
- Run the full test suite after.
- Tests fail: fix implementation (not tests), re-run.

If hasUI=true: do a UI check using the tools listed in SetupNotes (browser MCP, simulator skills, screenshot tooling, etc.). Capture observable evidence.

Completion:
- Prefer a working complete solution over incremental perfection.
- After acceptance criteria pass: stop iterating. Finalize. Don't refactor, don't expand scope.

When done:
- Success → write `<summary path from Workspace>`. Tiny, high signal only.
  - completed: what's done
  - gotchas: surprises a future task could trip on
  - public surface: types/functions/files added or changed
- Blocked → write `<block path from Workspace>`. Include:
  - what failed
  - why
  - attempted fixes
  - exact blocker
  Then stop. Emit `FLOW_BLOCKED: <one-sentence reason>` on stdout.

Commit changes (one-line title + concise summary in plain terms).

Don't: modify tests to pass (except provable test bugs), leave stubs/TODOs, over-engineer, install deps without checking project, touch tangential files, go over scope.
