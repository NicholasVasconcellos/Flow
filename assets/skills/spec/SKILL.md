---
name: spec
description: >
  Write tests for a task based on its acceptance criteria. Tests only — no
  implementation code. Detects the existing test framework and follows project
  conventions. Trigger on: /spec
disable-model-invocation: true
---

# spec

Write tests for the assigned task. You are in the spec phase — implementation does not exist yet. Your job is to define what correct behavior looks like, in code.

## Inputs

You will receive:

- The task title and description (including acceptance criteria)
- The project codebase (via CODEBASE.md and direct file reads)

Read both before writing a single line of test code.

## Step 1 — Understand the acceptance criteria

From the task criteria. Extract every acceptance criterion as a discrete, verifiable statement. If a criterion is ambiguous, resolve it by reading the surrounding code (existing types, interfaces, related modules) — do not ask unless truly unresolvable.

## Step 2 — Detect the test framework

Check `package.json`, `jest.config.*`, `vitest.config.*`, `pytest.ini`, `go.mod`, or whatever is relevant to the project language. Use the framework that is already installed. Do not introduce a new test dependency.

Identify:

- Test runner and its import style
- Assertion library (if separate)
- Where test files live (co-located with source, or in a `tests/` / `__tests__/` directory)
- Naming convention (`*.test.ts`, `*.spec.ts`, `_test.go`, `test_*.py`, etc.)

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

Group tests logically using `describe` blocks (or the framework equivalent). Structure:

```
describe("<module or feature name>", () => {
  describe("<sub-feature or method>", () => {
    it("<plain English criterion>", () => { ... })
  })
})
```

Place test files according to the convention detected in Step 2. File names must follow the same naming convention as existing test files in the project.

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

## Progress notes

Read `progress.txt` (mentioned via `@progress.txt` in your prompt) at the
start. Append a note when you finish that captures anything a later stage
needs to know — file paths added, frameworks chosen, blockers worked around.
Be extremely concise.

## Termination

When every acceptance criterion has a test, the test files are in place, and
those tests fail with "implementation missing" rather than syntax/import
errors, **stop immediately**. Do not write implementation, polish unrelated
files, or add tangential tests. Any extra work is out of scope.

## Learnings

After completing the task, append an entry to `learnings-draft.md` (path provided in the prompt's **Runtime paths** block) **only if** this session surfaced something a future agent on this codebase would benefit from knowing. Create the file if it doesn't exist.

**Append when:**

- You hit an error or surprising failure a future agent should avoid
- You discovered a tool quirk, flag, path, or version constraint that wasn't documented
- You deviated from the obvious approach and the reason isn't visible in the diff
- You learned a project invariant or convention not in CLAUDE.md

**Do NOT write:**

- Lists of doc files updated or "docs updated" sentences
- Restatements of the task description
- Anything already visible in the diff or git history
- Session logs (progress.txt and summary.md handle those)

An empty draft is the correct outcome when nothing surprising came up.

**Format each entry as:**
​~~~

## <tool or topic>

- <one-sentence lesson title>: <2-3 sentence explanation covering what, when, why, and what to do differently. Plain terms, only relevant information.>

```

**Example:**
​~~~
## Playwright MCP
- Headless mode silently drops file downloads: When running Playwright MCP in headless mode, `page.download()` returns success but the file never lands on disk. Use `headless: false` or switch to direct HTTP fetch for downloads.
```

## Stage signal

After your final commit, write the stage signal exactly once:

```
echo '{"stage":"spec","status":"done"}' > <stage signal path from prompt>
```

If you cannot proceed safely, write `{"stage":"spec","status":"blocked","reason":"…"}`
to the same file instead and exit. The orchestrator only advances when this
file is present, so do not skip it.
