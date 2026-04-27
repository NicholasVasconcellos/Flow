---
name: review
description: >
  Review and clean up changes from the execute phase. Quality gate covering
  tests, security (OWASP), performance, and dead code. Outputs PASSED/FAILED.
  Trigger on: /review
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

Read every changed file. Check for each of the following. Fix anything you find.

**Consistency**
- Naming follows the same conventions as surrounding code (variable names, function names, file names).
- Import ordering matches the project style.
- Indentation and formatting match the file's existing style (or the project formatter config).

**Security (OWASP Top 10 focus)**
- No user-controlled input is used in SQL queries, shell commands, file paths, or HTML output without sanitization.
- No secrets, API keys, tokens, or passwords are hardcoded or logged.
- Authentication and authorization checks are present at every entry point that requires them.
- No use of `eval`, `exec`, `innerHTML`, or similar dangerous sinks with unsanitized input.
- Dependencies added during execute are not known-vulnerable versions (check against the installed version, not latest).

**Error handling**
- System boundaries have error handling: network calls, file I/O, database queries, external API calls.
- Errors are propagated or logged appropriately — not swallowed silently.
- Error messages do not leak internal stack traces or sensitive data to external callers.

**Performance**
- No N+1 query patterns (loop that issues a query per iteration when a batch query would work).
- No synchronous I/O in async contexts.
- No unnecessary re-computation in hot paths.

**Dead code and artifacts**
- No `console.log`, `print`, `fmt.Println`, or equivalent debug output left in production paths.
- No commented-out code blocks.
- No unused imports, variables, or functions introduced by this task.
- No TODO or FIXME comments left by the implementation.
- No test-only environment checks in production code (e.g., `if NODE_ENV === 'test'`).

Fix everything found above. Make the minimum change necessary to fix each issue.

## Step 3 — Browser/UI tests if applicable

If any changed file is a UI component, page, stylesheet, or frontend route handler, run browser tests.

Pick the tool that `.flow/setup-report.md` lists as verified for the
relevant surface (the report points to a global skill at
`~/.claude/skills/<tool>/` or a project-level skill at
`.claude/skills/<tool>/`). Load that skill and follow its tips. Do not
hardcode a specific MCP — the verified tool may differ between
projects. If the report doesn't list a verified tool for the surface,
log it under `issues/<short-kebab-name>.md` and skip the UI portion.

If a browser test fails, fix the implementation and re-run both unit and browser tests.

## Step 4 — Final test run

After all fixes, run the full test suite one more time. All tests must pass before you declare the review complete.

## Step 5 — Review report

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

## Progress notes

Read `progress.txt` (provided via `@progress.txt` in your prompt) at the
start to see what spec/exec already decided. Append one line when you
finish: the verdict plus any cleanup you applied that a later stage should
know about. One line, not a journal.

## Termination

When the review report says PASSED and any cleanup commits are in place,
**stop**. Do not refactor working code, add tests, or polish files you did
not touch during exec. Any extra work is out of scope.

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
~~~

**Example:**
​~~~
## Playwright MCP
- Headless mode silently drops file downloads: When running Playwright MCP in headless mode, `page.download()` returns success but the file never lands on disk. Use `headless: false` or switch to direct HTTP fetch for downloads.
~~~

## Stage signal

After your final commit, write the stage signal exactly once:

```
echo '{"stage":"code_review","status":"done"}' > <stage signal path from prompt>
```

If you cannot proceed safely, write `{"stage":"code_review","status":"blocked","reason":"…"}`
instead and exit.
