---
name: setup
description: Prepare a project bed — install / configure declared tools, fetch library docs, write `.env`, `.gitignore`, `Map.md`, `AGENTS.md`, and `.flow/SetupNotes.md`. No runtime tool testing.
disable-model-invocation: true
---

# setup

You prepare the project so every downstream stage has the tools, docs, env
file, and orientation files it needs. **You do not test or verify tools at
runtime.** End-to-end verification is the first task emitted by `get-tasks`.

## Inputs

`plan.md` is loaded into your prompt as a context file. Read it first and
extract:

- **MCPs** the project intends to use
- **Plugins** the project depends on
- **Skills** referenced in the plan
- **CLI tools** the project requires
- **External libraries / services** the project uses (databases, auth,
  storage, payments, third-party APIs, frameworks, language libraries)

**Do not skip any tool the plan declares**, especially anything used for
UI Review or interactive testing (Playwright, claude-in-chrome, simulator
skills, screenshot tooling, engine drivers). Downstream UI-Review
iterations fail open if the tool is missing.

## Step 1 — Install / configure tools

For each tool extracted in Inputs:

| Kind | Action |
| --- | --- |
| **MCP** | Add an entry to `.mcp.json`. Do **not** call the MCP. |
| **Plugin** | Install in the agreed location. |
| **Skill** | Prefer the global skill at `~/.claude/skills/<tool>/SKILL.md`. If none exists, write one at `<projectRoot>/.claude/skills/<tool>/SKILL.md`. Never edit global skills. |
| **CLI** | Confirm `which <tool>` resolves; install if absent. |
| **Library** | Add to the project manifest and run the language's install command. |

If a tool cannot be installed locally, record the install command in
`.flow/SetupNotes.md` (Step 7) and continue. Do not emit `FLOW_BLOCKED`
for an installable-but-not-yet-installed tool.

## Step 2 — Fetch library documentation

For every library/framework, use Context7 to fetch documentation and
write it under `docs/<lib>/...` at the project root. One folder per
library, grouped by use case, current syntax, and the references the
downstream agents will need. Do not duplicate the library's full
website — fetch what the plan's features actually use.

## Step 3 — Write `.env`

For every service requiring a human-issued credential, write
`<projectRoot>/.env` with an empty placeholder for each variable and a
short numbered retrieval guide above it as inline comments (where to log
in, which page, which key to copy). Print the same retrieval steps in
your final stdout message.

**Do not block on missing keys.** Flow blocks at runtime when a missing
key is actually hit. If `.env` already exists with real values, do not
overwrite — only add missing keys.

## Step 4 — Write `.gitignore`

Tailor `<projectRoot>/.gitignore` to the project's stack. Cover:

- Build artifacts (`dist/`, `build/`, `target/`, language-specific)
- Dependency directories (`node_modules/`, `vendor/`, `.venv/`)
- Environment files (`.env`, `.env.*` — except `.env.example` if used)
- Editor and OS files (`.DS_Store`, `.idea/`, `.vscode/` if not committed)
- Local caches and logs (`*.log`, `.cache/`, `.next/`, `.turbo/`)
- Anything project-specific the plan mentions

If `.gitignore` already exists, merge — do not clobber existing rules.

## Step 5 — Write `Map.md`

Create `<projectRoot>/Map.md` mirroring the actual filesystem.
**Hierarchical, annotated, scannable, accurate.** No prose paragraphs.
One line per entry. Walk the real filesystem to populate it; do not
invent files.

Format:

```
src/
  server/
    index.ts          — Express entry point, registers all routes
    middleware/
      auth.ts         — JWT verification middleware
  db/
    schema.ts         — Drizzle ORM schema definitions
    migrations/       — Migration files (auto-generated, do not edit)
tests/
  server/
    auth.test.ts      — Auth route integration tests
```

Skip `.git/`, `node_modules/`, `dist/`, `.flow/`, and other ignored
directories. Top-level only at first; sub-trees that don't yet exist
get added by later sessions when they appear.

## Step 6 — Write `AGENTS.md`

Create `<projectRoot>/AGENTS.md`. **Lean.** Only what every agent
needs to know — no architecture essays, no per-module deep-dives.

Include:

1. **Coding conventions** — language, formatter, lint rules,
   indentation, naming, import style, error-handling style. Pull these
   from the plan, the project manifest, and any existing config files
   (`.eslintrc`, `pyproject.toml`, etc.).
2. **Library list** — one line per library: `<name> — <what it's used
   for in this project>`.
3. **Hard rules every agent follows:**
   - "To find a file or content, consult `Map.md` first, then read only
     the targeted file. Do not grep or scan random directories."
   - "Before using any library, consult `docs/<lib>/`."
4. **Project-specific gotchas** declared in the plan (env-var gotchas,
   hidden invariants, naming conventions specific to this codebase).
5. **Flow runtime rules** — append the following block verbatim:

   ```
   ## Flow runtime rules

   - Edit only files inside cwd. Exceptions: `learnings-draft.md` and the stage signal live outside the worktree.
   - Wherever a skill mentions `<taskId>`, substitute the actual task id from the Workspace block.
   - Each stage's SKILL.md owns its Done-when steps (commit, signal emit, escape hatches). Follow them exactly.
   - Halt: emit `FLOW_BLOCKED: <reason>` on stdout to stop the queue.
   - Warn: emit `FLOW_REVIEW_REQUESTED: <reason>` on stdout to flag without stopping.
   - Stage signal format: `{"stage":"<stage>","status":"done"}` written to the `stage signal` path.
   ```

Keep the whole file short — every agent loads it on every spawn.

## Step 7 — Write `.flow/SetupNotes.md`

Summarise what you installed and where things live. The first
`get-tasks` task verifies the pipeline against this file, so include
these sections:

- **Tools installed** — MCPs, plugins, skills (with paths), CLIs (with versions).
- **Libraries** — `<name> <version> — purpose`, one per line.
- **Services with credentials** — service, env var name(s), pointer to `.env` retrieval steps.
- **How to run the project locally** — exact commands (install, dev server, build, test). **Mandatory.**
- **UI Review tooling** — detected surface(s), tool to use, skill path, where sample data lives. **Mandatory.**
- **Gaps** — anything you could not install, with the install command for the next session.

## Allowed write paths

- `Map.md`
- `AGENTS.md`
- `docs/...`
- `.gitignore`
- `.env`
- `.mcp.json`
- `.flow/SetupNotes.md`
- `<projectRoot>/.claude/skills/<tool>/SKILL.md` — only when no global
  skill exists for that tool
- Project manifest files (`package.json`, etc.) when adding library
  declarations

## What NOT to do

- Do not run any MCP or service ping / health-check call — runtime
  verification belongs to the first `get-tasks` task.
- Do not skip a UI / interactive-testing tool because it "looks optional."
- Do not edit `~/.claude/skills/` (the global skills directory).
- Do not block the session waiting for human-issued credentials.

## Done when

`Map.md`, `AGENTS.md`, `.gitignore`, `.env`, and
`.flow/SetupNotes.md` exist, `docs/<lib>/` is populated for every
declared library, and every declared MCP/plugin/skill/CLI is installed
or has its install command recorded in SetupNotes. Reserve
`FLOW_BLOCKED:` for the genuinely unrecoverable case.
