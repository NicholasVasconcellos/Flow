---
name: spec
description: Write tests for a task from its acceptance criteria. Tests only — no implementation. Reuse the project's existing test framework.
disable-model-invocation: true
---

# spec

Write tests for the assigned task. You are in the spec phase — implementation does not exist yet. Your job is to define what correct behavior looks like, in code.

## Inputs

You will receive:

- The task title and description (including acceptance criteria)
- The project codebase (via `Map.md` and direct file reads)

Read both before writing a single line of test code.

## Step 1 — Understand the acceptance criteria

From the task criteria. Extract every acceptance criterion as a discrete, verifiable statement. If a criterion is ambiguous, resolve it by reading the surrounding code (existing types, interfaces, related modules) — do not ask unless truly unresolvable.

## Step 2 — Detect the test framework

Detect the runner from the project's manifest / config. Reuse it; do not
add a new test dependency. Identify the import style, assertion library
(if separate), where test files live, and the naming convention.

## Step 3 — Plan test cases

For each acceptance criterion, plan test cases across three categories:

**Happy path** — the criterion is met under normal conditions with valid inputs.

**Edge cases** — boundary values, empty inputs, minimum/maximum sizes, off-by-one scenarios, concurrent access if relevant.

**Error conditions** — invalid inputs, missing required data, dependency failures (network down, DB error, auth failure), and expected error messages or status codes.

Do not skip error conditions. Untested error paths are where production bugs live.

## Step 4 — Write the test files

Write tests only. Do not create source files, implementation stubs, or mock modules for code that does not exist yet. If a dependency does not exist, import it anyway — the test is supposed to fail right now.

Each test must:

- Have a description that reads as a plain-English statement of what it verifies (e.g., `"returns 401 when token is expired"`, not `"test auth"`)
- Be independent — no test should rely on state set by another test
- Clean up after itself if it creates files, DB rows, or network resources

Group tests with `describe` blocks (or the framework equivalent) following
the project's existing test convention. Place files and use the naming
convention detected in Step 2.

## Step 5 — Verify the tests fail for the right reason

Run the tests. They should fail with `cannot find module`, `is not a function`, or similar "not implemented" errors — not with syntax errors or import errors in the test file itself.

If a test fails due to a bug in the test code (bad assertion, wrong import path, syntax error), fix the test. Fix only the test — not the production code.

Report: list each test file created and confirm the failure mode is "implementation missing" and not "test broken".

## What NOT to do

- Do not write any implementation code, even a one-line stub.
- Do not create `__mocks__` directories or manual mock files for unimplemented modules.
- Do not modify existing source files.
- Do not add new test framework dependencies.
- Do not write tests that always pass regardless of implementation (vacuous tests).
- Do not write tests that are impossible to satisfy (testing internal implementation details that may change).
- Do not add comments explaining what the code "should" do — the test description is the documentation.

## Done when

Every acceptance criterion has a test, the test files are in place, and
those tests fail with "implementation missing" rather than syntax/import
errors. Then:

1. `git add -A && git commit -m "<imperative subject ≤72 chars>"` to capture the new tests.
2. Write the stage signal:
   `echo '{"stage":"spec","status":"done"}' > <stage signal path from Workspace>`
   (use `"status":"blocked","reason":"…"` if you cannot proceed).
