---
name: exec
description: Implement a task. Tests already exist from the spec phase — make them pass. Use subagents for independent chunks when appropriate.
disable-model-invocation: true
---

# exec

Implement the assigned task. Tests already exist from the spec phase. Your job is to make them pass.

## Inputs

You will receive:

- The task title and description (including acceptance criteria)
- The spec (test files written in the spec phase)
- The project codebase (via `Map.md` and direct file reads)

Read all three before writing any code.

## Step 0 — UI Review remediation (when present)

If your context files include a `round-<N>-issues.md`, the previous
`exec_ui_check` pass found problems and routed back to you. Treat it
as the primary objective: each issue's `Acceptance:` line is the pass
condition. Do not edit the round file — the next `exec_ui_check` pass
overwrites it.

If a round-file `Acceptance:` conflicts with the task's original
acceptance criteria, do not guess — emit
`FLOW_BLOCKED: round-<N> issue conflicts with task acceptance — <one-sentence summary>`
and stop.

## Project test framework (read before touching tests)

If this task involves writing, modifying, or verifying tests:

1. Check the project root for a testing reference. Typical paths:
   `docs/testing.md`, `tests/README.md`, `TESTING.md`.
2. Read it before opening test files. It covers framework invocation,
   file naming, assertion API, and fixture patterns — do not re-derive
   these by grepping the test directory or scanning addons.
3. If no dedicated reference exists, read `AGENTS.md` for a Testing
   section. If neither exists, proceed to Step 1 and rely on the test
   files themselves.

## Step 1 — Read the tests

Open every test file for this task. Read each test case. Understand exactly what the tests expect: inputs, outputs, side effects, error conditions. The tests are the source of truth for what "done" means.

If you find a genuine bug in a test (wrong expected value, incorrect assertion logic, bad import path), fix it and note the fix. Do not silently work around a broken test by writing code that special-cases it.

## Step 2 — Create an execution plan

Before writing any code, write a short execution plan:

- List the files you will create or modify
- For each file, note what it will contain (types, functions, classes, routes, etc.)
- Identify which parts are independent of each other

If two or more independent chunks exist (e.g., a data layer and an API layer with no shared code to write), use subagents for parallel implementation. See Step 3.

## Step 3 — Implement (with subagents when appropriate)

### When to use subagents

Use subagents when the execution plan has independent chunks that do not share files being written. Examples:

- Implementing multiple unrelated API routes
- Writing a parser and a formatter that have no shared new code
- Building two separate UI components

Do not use subagents when chunks share a file being written — concurrent writes cause conflicts.

### Subagent protocol

1. Spawn one subagent per independent chunk.
2. Give each subagent: its specific files to create/modify, the relevant test subset, and the task description.
3. Each subagent runs its own test subset and must not proceed if tests fail.
4. After all subagents complete, run the full test suite in the main agent to verify nothing conflicts.

### Single-agent implementation

If the work is sequential or shares files, implement it yourself without subagents. Follow the execution plan in order.

## Step 4 — Run tests and fix failures

After implementation, run the full test suite for this task.

If tests fail:

1. Read the failure output carefully.
2. Identify the root cause in the implementation — not the test.
3. Fix the implementation.
4. Re-run tests.
5. Repeat until all tests pass.

Do not modify tests to make them pass unless you identified a genuine bug in the test in Step 1. Do not add code that special-cases test inputs.

## Step 5 — Run browser/UI tests if applicable

If the task involves any UI change (web or mobile), run browser tests after unit tests pass.

- For web UI: use the Playwright MCP to open the relevant page, interact with the changed elements, and verify behavior matches acceptance criteria.
- For iOS/Android: use the simulator tool to verify the UI renders and behaves correctly.

If browser tests reveal a bug, fix the implementation and re-run both unit and browser tests.

## What NOT to do

- Do not modify tests to make them pass (except genuine test bugs identified in Step 1).
- Do not write code that special-cases test inputs (e.g., `if (process.env.NODE_ENV === 'test') return mockValue`).
- Do not leave implementation stubs, TODO comments, or placeholder returns.
- Do not over-engineer: no extra abstraction layers, no premature generalization.
- Do not install new dependencies without checking if the functionality already exists in the project.
- Do not modify files outside the scope of this task.

## Done when

All tests for this task pass (unit, plus browser/UI if applicable). Then:

1. `git add -A && git commit -m "<imperative subject ≤72 chars>"` (body bullets per meaningful change encouraged; skip the commit if no files actually changed).
2. Write the stage signal:
   `echo '{"stage":"<stage>","status":"done"}' > <stage signal path from Workspace>`
   (substitute `<stage>` with the value of the Workspace block's `stage:` field; use `"status":"blocked","reason":"…"` if you cannot proceed).
