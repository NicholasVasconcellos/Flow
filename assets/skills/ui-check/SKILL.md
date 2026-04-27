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
| **Web** | `package.json` includes `react`/`vue`/`svelte`/`next`/`vite`, or changed files include `*.html`, `*.jsx`, `*.tsx`, `*.css`, `*.vue`, `*.svelte` |
| **iOS** | Repo contains `*.xcodeproj` / `*.xcworkspace`, `Package.swift`, or `Podfile`; changed files include `*.swift` / `*.m` / `*.mm` |
| **Other desktop app** (Godot, Unity, native) | Engine markers like `project.godot`, `Assets/` + `ProjectSettings/`, or other engine-specific layouts |
| **No UI surface** | Backend, library, infra, or pure config changes only |

If the surface is **No UI surface**, append `No UI surface; skipped.`
to `summary.md` under a `## UI check` heading and stop. Do not launch
any tool.

Otherwise, **read `.flow/setup-report.md`** and pick the tool the
project's setup verified for this surface. The report lists every
verified tool with a path to its authoritative skill — either a global
skill at `~/.claude/skills/<tool>/` or a project-level skill at
`<projectRoot>/.claude/skills/<tool>/`. Load that skill and follow its
tips and entry points.

Do not hardcode tool names — the verified tool may differ between
projects (claude-in-chrome, Playwright, Godot MCP, the iOS simulator
skill, or anything else). If `.flow/setup-report.md` lists no verified
tool for the detected surface, treat it as a harness gap (Step 3-A)
and stop the affected interactions.

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

### B. Project-side UI issues → `summary.md` punch-list

Append a single, structured section to `summary.md`. The next stage's
implementing agent gets `summary.md` auto-loaded into its prompt, so
this is the channel that reaches them. Use this exact format so the
table is easy to scan and consume:

```markdown
## UI check — Issues for implementing agent

| # | Surface | Severity | Description | Evidence |
| - | ------- | -------- | ----------- | -------- |
| 1 | /settings | HIGH | Save button disabled after first click, never re-enables | screenshots/settings-save.png; console: TypeError at app.js:412 |
| 2 | LoginScreen | MED | Email field accepts whitespace-only input | screenshots/login-empty.png |
```

Then a one-line verdict immediately below the table:

```
**Verdict:** Needs fixes (see table above).
```

…or `**Verdict:** Clean.` if the table is empty.

Project-side issues never go to `issues/` — that directory is reserved
for harness bugs. Harness bugs never go in the punch-list — the
implementing agent can't fix Flow.

## Rules

- **Do not edit application code.** ui-check is observational. Record
  regressions; the next stage proposes fixes.
- Never commit screenshots to git — `.flow/tasks/` is untracked.
- If a single tool call fails, retry once; if it keeps failing, treat as
  a harness gap (Step 3-A) and continue with what you can verify.
- Prefer the accessibility tree (iOS) and structured DOM/console reads
  (web) over screenshots — capture pixels only as evidence for a
  flagged regression.

## Progress notes

Read `progress.txt` (mentioned via `@progress.txt` in your prompt) at
the start. Append a one-line note when you finish: surface checked,
verdict, and the count of issues in the punch-list (e.g.
`ui-check: web — Needs fixes (3 issues); harness OK`).

## Termination

When every affected route/screen has been exercised, evidence is saved,
the punch-list (or `Clean` verdict) is in `summary.md`, and any
harness gap is filed under `issues/`, **stop**. Do not edit
application code or pursue regressions yourself — that's the next
stage's job.

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

After any commit, write the stage signal exactly once. The stage name in
the signal must match the stage you were spawned for (`exec_ui_check` or
`code_review_ui_check` — see your prompt's Runtime paths block):

```
echo '{"stage":"<this stage>","status":"done"}' > <stage signal path>
```

If you cannot proceed safely, write `{"stage":"<this stage>","status":"blocked","reason":"…"}`
instead and exit.
