Implement task. Check for acceptance tests in context files (if any).

Round file present (round-<N>-issues.md): each issue's Acceptance: line is the pass condition. Don't edit the round file. Conflicts with task acceptance → FLOW_BLOCKED: <reason>.

Plan:
List files to create/modify.
Per file: note contents (types, functions, classes, routes).
Mark independent chunks.
Use subagents for independent chunks (no shared files) to parallelize and save context. Give each: files, test subset, task.

Run full test suite after.
Tests fail: fix implementation (not tests), re-run.
Check browser/UI if applicable to the task.

Don't: modify tests to pass (except provable test bugs). special-case test inputs. leave stubs / TODOs. over-engineer. install deps without checking project. touch out-of-scope files.

When acceptance met: commit with one-line title + concise summary.
If blocked: report.

Progress stage:
echo '{"status":"done"}' > <stage signal path from Workspace>

Blocked: '{"status":"blocked","reason":"…"}'
