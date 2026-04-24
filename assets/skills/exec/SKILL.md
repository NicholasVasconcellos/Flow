---
name: exec
description: >
  Implement a task. Tests already exist from the spec phase — make them pass.
  Uses subagents for parallel independent chunks when appropriate.
  Trigger on: /exec
disable-model-invocation: true
---

# exec

Implement the assigned task. Tests already exist from the spec phase. Your job is to make them pass.

## Inputs

You will receive:
- The task title and description (including acceptance criteria)
- The spec (test files written in the spec phase)
- The project codebase (via CODEBASE.md and direct file reads)

Read all three before writing any code.

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

### Code standards

- Follow the existing code conventions in the project (indentation, naming, import style, error handling patterns).
- Write concise, clean code. Do not add comments that describe what the code does — the code should be self-explanatory.
- Do not add docstrings, JSDoc, or inline documentation unless the project already uses them consistently.
- Handle errors at system boundaries (network calls, file I/O, DB queries, external APIs). Do not swallow errors silently.
- Do not add logging beyond what already exists in the project's logging pattern.

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

## Step 6 — Self-improvement log

After all tests pass, append a brief entry to `.claude/learnings.md` (create it if it does not exist):

```
## <task title> — <date>
- <error encountered and what fixed it>
- <non-obvious implementation decision and why>
```

Only log things that were actually non-obvious. Do not log "wrote the function" — log "discovered that the SDK batches requests and requires a flush call, added flush() before assertions".

## What NOT to do

- Do not modify tests to make them pass (except genuine test bugs identified in Step 1).
- Do not write code that special-cases test inputs (e.g., `if (process.env.NODE_ENV === 'test') return mockValue`).
- Do not leave implementation stubs, TODO comments, or placeholder returns.
- Do not over-engineer: no extra abstraction layers, no premature generalization.
- Do not install new dependencies without checking if the functionality already exists in the project.
- Do not modify files outside the scope of this task.

If you cannot proceed safely or need human judgment, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
