---
name: setup
description: >
  Prepare the project bed: install / configure every tool the plan declares,
  fetch library docs, write `.env` placeholders + retrieval guides, write
  `.gitignore`, `Map.md`, `instructions.md`, and `.flow/SetupNotes.md`.
  Pure preparation — no runtime tool testing.
  Trigger on: /setup
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
| **MCP** | Add an entry to `.mcp.json` with the correct server / args. Do **not** call the MCP. |
| **Plugin** | Install in the agreed location. |
| **Skill** | Confirm a skill is reachable. Prefer the global skill at `~/.claude/skills/<tool>/SKILL.md`. If none exists, write a short project-level skill at `<projectRoot>/.claude/skills/<tool>/SKILL.md` with the basic entry points the plan implies. Never edit global skills. |
| **CLI** | Confirm `which <tool>` resolves. If absent, install it (Homebrew, package manager, or the project's documented method). |
| **Library** | Add to the project manifest (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, etc.) and run the install command for the language. |

If a tool cannot be installed locally and no offline workaround exists,
record the gap in `.flow/SetupNotes.md` (Step 6) and continue. Do not
emit `FLOW_BLOCKED` for an installable-but-not-yet-installed tool —
write the install command into SetupNotes so the human or the next
session can complete it.

## Step 2 — Fetch library documentation

For every library/framework, use Context7 to fetch documentation and
write it under `docs/<lib>/...` at the project root. One folder per
library, grouped by use case, current syntax, and the references the
downstream agents will need. Do not duplicate the library's full
website — fetch what the plan's features actually use.

## Step 3 — Write `.env`

For every service that requires a human-issued credential, write
`<projectRoot>/.env` with placeholder values and a numbered retrieval
guide as inline comments. Example:

```
# STRIPE
# 1. Visit https://dashboard.stripe.com/apikeys
# 2. Click "Reveal test key" under Standard keys
# 3. Copy the key starting with `sk_test_...` into the value below
STRIPE_SECRET_KEY=

# RESEND
# 1. Sign in at https://resend.com
# 2. API Keys → Create API Key → name it for this project
# 3. Copy the key starting with `re_...` into the value below
RESEND_API_KEY=
```

Also print the same retrieval steps in your final stdout message so the
human can pick them up without opening `.env`.

**Do not block the session waiting for keys.** Flow blocks at run time
when a missing key is actually hit; setup's job is to leave the
placeholders and the instructions in place.

If a `.env` already exists with real values, do not overwrite — only
add missing keys with their retrieval guide.

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

## Step 6 — Write `instructions.md`

Create `<projectRoot>/instructions.md`. **Lean.** Only what every agent
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

Keep the whole file short — every agent loads it on every spawn.

## Step 7 — Write `.flow/SetupNotes.md`

Output `.flow/SetupNotes.md` summarising what you installed and where
things live. Downstream agents (especially the first `get-tasks` task,
which verifies the pipeline end-to-end) read this file. Sections:

```markdown
## Tools installed

MCPs:        <name> — `.mcp.json` entry, skill at <path>
Plugins:     <name> — installed at <path>
Skills:      <name> — global at ~/.claude/skills/<name>/  OR  project at .claude/skills/<name>/
CLIs:        <name> <version>, ...

## Libraries

<name> <version>  — purpose

## Services with credentials

<service>          env var(s): <name>           retrieval steps in `.env`

## How to run the project locally

<exact commands — install, dev server, build, test>

## UI Review tooling

Detected surfaces: <web | iOS | Android | desktop-engine | none>
Tool to use:       <name>, skill at <path>
Sample data:       <where realistic test inputs live, or "none yet — first task seeds them">

## Gaps

<anything you could not install + the install command for the human or
the first task to run>
```

The `UI Review tooling` and `How to run the project locally` blocks
are mandatory — the first task that `get-tasks` emits will use them
to drive end-to-end verification.

## Allowed write paths

- `Map.md`
- `instructions.md`
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

- Do not run any MCP or service ping/health-check call. Installation
  presence is enough; runtime verification belongs to the first
  `get-tasks` task.
- Do not write `CODEBASE.md` (retired in favor of `Map.md` +
  `instructions.md`).
- Do not write `.env.example`. Use `.env` with placeholders.
- Do not extract or write learnings — that's `update-learning`'s job.
- Do not skip a UI / interactive-testing tool because it "looks
  optional."
- Do not edit `~/.claude/skills/` (the global skills directory).
- Do not block the session waiting for human-issued credentials.

## Termination

When `Map.md`, `instructions.md`, `.gitignore`, `.env`,
`.flow/SetupNotes.md` exist, `docs/<lib>/` is populated for every
declared library, every declared MCP/plugin/skill/CLI is installed and
configured (or its install command is recorded in SetupNotes), **stop**.

Reserve `FLOW_BLOCKED:` for the genuinely unrecoverable case — a
required tool that cannot be installed in any way and has no human
workaround. Most "missing key" or "missing tool" cases should leave a
note in SetupNotes and proceed.
