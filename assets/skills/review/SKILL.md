---
name: review
description: Review and clean up changes from the execute phase. Quality gate covering tests, security (OWASP), performance, and dead code. Outputs PASSED/FAILED.
disable-model-invocation: true
---

# review

Review and clean up the changes made during the execute phase. This is a quality gate, not a rewrite.

## Inputs

You will receive:
- The task title and description (including acceptance criteria)
- The diff of all changes made during the execute phase (or the list of modified files)
- The project codebase

Read the diff in full before doing anything else.

## Step 1 — Run the full test suite

Run all unit and integration tests for the project. Do not skip or scope this — run everything.

If any test fails:
1. Determine whether the failure is in code touched by this task or pre-existing.
2. If caused by this task: fix the implementation, then re-run the full suite.
3. If pre-existing: note it in the review report but do not fix it — that is out of scope.

Do not proceed to cleanup until all tests that were passing before this task are still passing.

## Step 2 — Code quality review

Read every changed file. Fix anything you find. Make the minimum change
necessary per issue.

- **Consistency** — naming, import ordering, indentation, and formatting
  match the surrounding code or the project's formatter config.
- **Security (OWASP)** — user-controlled input never reaches SQL/shell/path/HTML
  sinks unsanitized; no hardcoded or logged secrets; authn/authz at every
  entry point that needs it; no `eval` / `innerHTML` on tainted input;
  no known-vulnerable dependency versions added.
- **Error handling** — system boundaries (network, I/O, DB, external APIs)
  handle errors; errors aren't swallowed; messages don't leak stack traces.
- **Performance** — no N+1 query patterns introduced.
- **Dead code & artifacts** — no debug `console.log` / `print` / etc., no
  commented-out blocks, no unused imports/vars, no TODO/FIXME left behind,
  no `if NODE_ENV === 'test'` in production paths.

## Step 3 — Browser/UI tests if applicable

If any changed file is a UI component, page, stylesheet, or frontend route handler, run browser tests.

Pick the tool that `.flow/SetupNotes.md` lists as installed for the
relevant surface (SetupNotes points to a global skill at
`~/.claude/skills/<tool>/` or a project-level skill at
`.claude/skills/<tool>/`). Load that skill and follow its tips. Do not
hardcode a specific MCP — the installed tool may differ between
projects. If SetupNotes doesn't list a tool for the surface,
log it under `issues/<short-kebab-name>.md` and skip the UI portion.

If a browser test fails, fix the implementation and re-run both unit and browser tests.

## Step 4 — Review report

Output a plain-text report with these sections:

**Tests**: pass count, fail count, any pre-existing failures noted separately.

**Issues fixed**: a bullet list of every problem found and fixed (one line each). If nothing was found, write "None."

**Issues not fixed**: a bullet list of any pre-existing problems or out-of-scope issues observed. If none, write "None."

**Status**: one of `PASSED` or `FAILED`. Use `FAILED` only if tests are still failing due to this task's code after your fixes, or if a security issue was found that you could not resolve.

## What NOT to do

- Do not rewrite working code because you would have structured it differently.
- Do not add docstrings, JSDoc, or type annotations to code you did not touch.
- Do not add new abstraction layers or refactor for "cleanliness" beyond what is listed above.
- Do not change test files unless a test is provably wrong (wrong expected value that contradicts the spec).
- Do not add new features or handle edge cases not covered by the task's acceptance criteria.
- Do not change code outside the files modified during the execute phase, except to fix a test failure directly caused by this task.

## Done when

The review report's status is PASSED and any cleanup commits are in place.
