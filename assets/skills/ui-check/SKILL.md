---
name: ui-check
description: Verify UI changes on the right surface (web, iOS, or other desktop app), capture evidence, and route findings to either Flow issues or the implementing agent.
---

# ui-check

Verify the task's UI changes on the appropriate surface and route findings to
the right channel. Observational only — never edit application code.

## Step 0 — Pick the surface and the tool

Read `.flow/tasks/<taskId>/summary.md` and look at the files changed in this
worktree. Detect which surface the task targets:

| Surface | How to detect |
| --- | --- |
| **Web** | `package.json` includes `react`/`vue`/`svelte`/`next`/`vite`, or changed files include `*.html`/`*.jsx`/`*.tsx`/`*.css`/`*.vue`/`*.svelte` |
| **iOS** | Repo contains `*.xcodeproj`/`*.xcworkspace`/`Package.swift`/`Podfile`; changed files include `*.swift`/`*.m`/`*.mm` |
| **Native / engine** | Engine markers (e.g. `project.godot`, `Assets/` + `ProjectSettings/`) |
| **No UI surface** | Backend, library, infra, or pure config changes only |

If the surface is **No UI surface**, append `No UI surface; skipped.`
to `summary.md` under a `## UI check` heading and stop. Do not launch
any tool.

Otherwise, **read `.flow/SetupNotes.md`** and pick the tool the
project's setup installed for this surface. SetupNotes lists every
installed tool with a path to its authoritative skill
if `.flow/SetupNotes.md` lists no installed
tool for the detected surface, treat it as a harness gap (Step 3-A) and stop the affected interactions.

## Step 1 — Start the app

Use the verified tool's skill (loaded in Step 0) to launch the app for
the detected surface. Web typically means a dev server (`npm run dev`
or the README's command); iOS / other desktop apps boot through their
respective tooling. If you cannot start the app in this environment,
note it in `summary.md` and stop.

If the verified tool itself errors before the app starts, that's a
harness gap — see Step 3-A.

## Step 2 — Exercise the affected screens

For each route/screen/view the task touches, use the verified tool's
skill to:

1. Navigate to or open the screen.
2. Exercise the primary interaction the task added or modified (click,
   type, submit, tap).
3. Capture the relevant signals — console output, network requests
   (4xx/5xx on requests the change touches), crash logs, error events.
4. Save evidence (screenshots, accessibility-tree dumps, log excerpts)
   under `.flow/tasks/<taskId>/screenshots/`.

Prefer cheap structured signals (DOM/console reads on web, accessibility
trees on iOS) over screenshots — capture pixels only as evidence for a
flagged regression, a visual diff, or a bug-report attachment.

Do not just load a view — always exercise the primary interaction the
task added or modified.

## Step 3 — Route every finding to exactly one channel

### A. Flow-harness issues → `issues/<short-kebab-name>.md`

Log to the Flow repo's `issues/` directory when the failure is the
harness's problem, not the project's:

- Required MCP for the detected surface is missing or unconfigured
- MCP tool errors not caused by the project (auth failure, transport
  crash, malformed payload from the tool itself)
- Rendering errors that originate in the tool (claude-in-chrome
  extension crash, simulator boot failure unrelated to the app under
  test)

The file must follow the convention in this repo's CLAUDE.md:

- `**Severity:** HIGH | MED | LOW`
- Symptom and root cause if known
- Repro pointer: downstream task ID and session ULID(s)
- Suggested fix direction if you have one

Then nudge the user from `summary.md` with one line so it's not buried:

```
> Flow harness gap logged: issues/<name>.md — please review.
```

A harness gap on its own is not a blocker — keep going on the
interactions you can verify and end with `status:"done"`. Only emit
`status:"blocked"` if every interaction was unverifiable.

### B. Project-side UI issues → `round-<N>-issues.md`

For the `exec_ui_check` stage, write a fresh round file at the path
shown as `round issues file:` in your **Workspace** block. This is
`.flow/tasks/<taskId>/issues/round-<N>-issues.md`, where `<N>` is the
`ui-review round:` value also in the Workspace block.

`code_review_ui_check` skips this step — it does not produce a round
file. Append observations to `summary.md` instead, since by then the
exec ↔ ui-check loop has already converged.

The round file is a fresh snapshot every round — do not edit prior
round files, do not carry forward statuses. If round (N+1) is run, the
next ui-check pass writes a new file, and a previously-listed bug only
re-appears if it's still observable.

Use this exact format:

```markdown
# UI Review — Round <N>
**Task:** <taskId>
**Date:** <ISO 8601 timestamp>
**Surfaces tested:** <comma-separated list of routes / screens / views>
**Tools used:** <comma-separated list of MCPs / CLIs you actually invoked>
**Outcome:** <count> issues — <H> HIGH, <M> MED, <L> LOW

| # | Severity | Surface | Summary |
|---|----------|---------|---------|
| 1 | HIGH | /login (mobile) | Sign-In button not tappable |
| 2 | MED  | /signup        | Email field accepts whitespace-only input |

---

## Issue 1 — HIGH — /login (mobile)
**Symptom:** Tapping "Sign In" registers nothing.
**Repro:**
1. Open /login in mobile viewport (≤ 768px).
2. Tap "Sign In".
3. No console error, no nav, no spinner.
**Evidence:** screenshots/round-<N>/issue-1-mobile.png
**Acceptance:** Button responds to tap on viewports ≤ 768px.
**Suspected cause:** Overlay z-index conflict.

## Issue 2 — MED — /signup
...
```

If you found **zero** issues, still write the round file with the
header block and `**Outcome:** 0 issues` plus an empty table — the
scheduler reads the file to decide whether to advance the pipeline or
re-enter exec.

Save evidence under `.flow/tasks/<taskId>/screenshots/round-<N>/` so
each round's artifacts are grouped.

## Rules

- **Do not edit application code.** ui-check is observational. Record
  regressions; the next stage proposes fixes.
- Never commit screenshots to git — `.flow/tasks/` is untracked.
- If a single tool call fails, retry once; if it keeps failing, treat as
  a harness gap (Step 3-A) and continue with what you can verify.
- Prefer the accessibility tree (iOS) and structured DOM/console reads
  (web) over screenshots — capture pixels only as evidence for a
  flagged regression.

## Done when

Every affected route/screen has been exercised, evidence is saved, the
round-N issues file is written (header + outcome line at minimum, even
when zero issues), and any harness gap is filed under `issues/`. The
scheduler routes exec back automatically if the round file is non-empty —
do not edit application code yourself. Then:

1. If the round file or any in-worktree artifact was written, `git add -A && git commit -m "<imperative subject ≤72 chars>"`. If nothing in-worktree changed, skip the commit.
2. Write the stage signal:
   `echo '{"stage":"<stage>","status":"done"}' > <stage signal path from Workspace>`
   (substitute `<stage>` with the value of the Workspace block's `stage:` field — it will be either `exec_ui_check` or `code_review_ui_check`; use `"status":"blocked","reason":"…"` only if every interaction was unverifiable).
