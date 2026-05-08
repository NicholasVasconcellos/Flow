Review and clean changes from exec. Quality gate, not rewrite.

Read full diff first.

Run full test suite. No skipping, no scoping.
Failure from this task → fix implementation, re-run.
Pre-existing failure → note, don't fix.
Don't proceed to cleanup until tests passing before this task still pass.

Read every changed file. Fix what you find. Minimum change per issue.
- Consistency: naming, imports, format match neighbors / formatter config.
- Security (OWASP): no unsanitized input to SQL/shell/path/HTML; no hardcoded or logged secrets; authn/authz at every entry; no eval / innerHTML on tainted input; no vulnerable deps.
- Errors: handled at boundaries (network, I/O, DB, external APIs). Not swallowed. No leaked stack traces.
- Perf: no N+1.
- Dead code: no debug prints, commented blocks, unused imports/vars, leftover TODO/FIXME, NODE_ENV==='test' in prod paths.

UI changed: run browser tests via tool from .flow/SetupNotes.md. Failure → fix impl, re-run unit + browser.

Report:
Tests: pass/fail counts; pre-existing separately.
Issues fixed: bullets (or "None.")
Issues not fixed: bullets (or "None.")
Status: PASSED | FAILED. FAILED only if tests still fail from this task or unresolved security issue.

Don't: rewrite working code. add docstrings to untouched code. refactor for cleanliness. change tests unless provably wrong. add features. touch files outside exec scope.

Done (status PASSED):
Edits made → git add -A && git commit -m "<imperative ≤72 chars>". Else skip commit.
echo '{"status":"done"}' > <stage signal path from Workspace>
Blocked: '{"status":"blocked","reason":"…"}'
