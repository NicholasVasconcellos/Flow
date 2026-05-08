Write tests for task. Tests only — no implementation, no stubs, no mocks for missing modules.

Read first:
Acceptance criteria — extract every criterion as verifiable statement.
Test framework — check docs/testing.md, tests/README.md, TESTING.md, or AGENTS.md Testing section first. Fall back: project manifest + one existing test file.

Per criterion plan: happy path, edges (boundaries, empty, min/max, off-by-one), errors (invalid input, missing data, dependency failure). Don't skip errors.

Write:
Tests in detected framework + naming convention.
Description = plain-English statement of what's verified.
Independent. Self-cleaning if creating files/rows/network resources.
Group with describe (or framework equivalent).
Import deps that don't exist yet — test should fail.

Run tests. Must fail with "cannot find module" / "is not a function" / "not implemented". Syntax or import errors in the test file = fix the test (not production code).

Don't: implement anything. mock unimplemented modules. modify existing source. add new test deps. write vacuous or impossible tests. comment what code "should" do.

Done:
git add -A && git commit -m "<imperative ≤72 chars>"
echo '{"status":"done"}' > <stage signal path from Workspace>
Blocked: '{"status":"blocked","reason":"…"}'
