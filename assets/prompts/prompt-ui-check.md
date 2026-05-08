Verify UI changes on appropriate surface. Observational — never edit app code.

Detect surface from summary.md + changed files:
Web: package.json has react/vue/svelte/next/vite, or *.html/jsx/tsx/css/vue/svelte changed.
iOS: *.xcodeproj/*.xcworkspace/Package.swift/Podfile present, or *.swift/m/mm changed.
Native/engine: project.godot, Assets/+ProjectSettings/, etc.
None: backend/lib/infra/config only.

No UI surface → append "No UI surface; skipped." to summary.md under "## UI check". Stop.

Tool: read .flow/SetupNotes.md, pick tool listed for surface, load its skill.
No tool listed → harness gap (see routing). Skip affected interactions.

Start app via tool's skill. Tool errors before app starts → harness gap.

Per affected screen:
1. Navigate.
2. Exercise the primary interaction the task added/modified — not just load.
3. Capture: console, 4xx/5xx requests on changed paths, crashes, errors.
4. Save evidence under .flow/tasks/<taskId>/screenshots/ (round-<N>/ subfolder for exec_ui_check).

Prefer DOM/console reads (web) and accessibility tree (iOS) over screenshots. Pixels only as evidence for flagged regression.

Route findings:
A. Harness gaps → issues/<short-kebab>.md with: **Severity:** HIGH|MED|LOW, symptom + root cause, repro pointer (downstream task id + session ULID), fix direction. Note in summary.md: "> Flow harness gap logged: issues/<name>.md". Harness gap alone is not a blocker — finish what you can verify.
B. exec_ui_check: write fresh round file at "round issues file:" path from Workspace.
C. code_review_ui_check: append observations to summary.md. No round file.

Round file format:
# UI Review — Round <N>
**Task:** <taskId>
**Date:** <ISO 8601>
**Surfaces tested:** <list>
**Tools used:** <list>
**Outcome:** <count> issues — <H> HIGH, <M> MED, <L> LOW

| # | Severity | Surface | Summary |
|---|----------|---------|---------|

---

## Issue <N> — <SEV> — <surface>
**Symptom:** ...
**Repro:** numbered steps
**Evidence:** screenshots/round-<N>/...
**Acceptance:** <pass condition>
**Suspected cause:** ...

Zero issues → still write file with header + "Outcome: 0 issues" + empty table.

Don't: edit app code. commit screenshots (.flow/tasks/ untracked). retry a failing tool call more than once.

Done:
In-worktree changes (round file etc.) → git add -A && git commit -m "<imperative ≤72 chars>". Else skip.
echo '{"stage":"<stage>","status":"done"}' > <stage signal path from Workspace>
Use Workspace stage: value (exec_ui_check or code_review_ui_check).
Blocked only if every interaction unverifiable.
