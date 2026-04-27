---
name: ui-check
description: Verify UI changes in a browser, capture screenshots, check for regressions and console errors.
---

# ui-check

Verify the task's UI changes in a real browser and flag any visible
regressions.

## First: decide if there is UI work

Read `.flow/tasks/<taskId>/summary.md` and look at the files changed in this
worktree. If none of the changed files are UI code (React/Vue/Svelte
components, templates, stylesheets, page routes, client-side logic), this
task has no UI surface.

- **No UI work** → append a short note to `summary.md` under a
  `## UI check` heading stating "No UI surface; skipped." Then stop. Do not
  launch a browser.
- **UI work exists** → proceed below.

## Goal

Exercise the affected UI in a browser, capture screenshots as evidence, and
flag regressions (broken layout, console errors, network failures, blocked
interactions).

## How to work

1. Start the project's dev server if it is not already running. Use the
   command documented in the README or `package.json` scripts (commonly
   `npm run dev`). If starting a server is not possible in this environment,
   note that in `summary.md` and stop.
2. Use the Playwright MCP tools (`mcp__playwright__*`) or the
   `claude-in-chrome` MCP as available. Prefer Playwright when both are
   present.
3. Navigate to each affected page/route. For each:
   - Take a screenshot to `.flow/tasks/<taskId>/screenshots/<slug>.png`.
   - Read the browser console (`browser_console_messages`) and record any
     errors or warnings introduced by the change.
   - Check the network panel for 4xx/5xx responses on requests the change
     touches.
   - Exercise the primary interaction the task added or modified (click,
     type, submit) — do not just load the page.
4. Append a `## UI check` section to `summary.md` with:
   - The routes/pages visited.
   - The screenshot paths.
   - Any console errors, network failures, or visual regressions spotted.
   - A one-line verdict: "Clean" / "Needs fixes (see above)".

## Rules

- **Do not edit application code.** ui-check is observational. If you find a
  regression, record it; the review stage will propose fixes.
- Never commit screenshots to git — they live under `.flow/tasks/` which is
  not part of the worktree's tracked files.
- If screenshot capture fails repeatedly, note it and continue; do not spin.

## Progress notes

Read `progress.txt` (mentioned via `@progress.txt` in your prompt) at the
start. Append a one-line note when you finish — the verdict (clean / fixes
needed) plus a pointer to the most relevant screenshot or console error.

## Termination

When every affected route has a screenshot, the verdict is recorded in
`summary.md`, and any commit you produced is in place, **stop**. Do not
edit application code or pursue regressions yourself — leave that to the
review stage.

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
