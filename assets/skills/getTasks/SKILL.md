---
name: getTasks
description: >
  Break a PRD, issue, or user description into self-contained tasks
  with dependencies. Outputs structured JSON task plan.
  Trigger on: /getTasks
disable-model-invocation: true
---

# getTasks

Analyze the plan and decompose it into self-contained tasks.

## Inputs

Read all provided inputs before doing anything else.

## Step 1 — Generate or update CODEBASE.md (subagent)

Spawn a subagent to generate or update `CODEBASE.md`. Instruct the subagent to:

- Create `CODEBASE.md` if it does not exist.
- Serve as a map file for agents, reducing the need to scan the whole codebase. Hierarchical overall structure, derived from the plan document.
- Contain coding style, guidelines, and conventions consistent throughout the codebase, based on the plan and the libraries / stack used.
- Include any additional high-level information that should be available project-wide for subsequent agents working on new features.
- Be as concise as possible — only meaningful information, kept brief to minimize context consumption.

CODEBASE.md must be:
- Hierarchical: reflect the actual directory tree
- Scannable: use concise annotations, not prose
- Accurate: based on the real filesystem

Format example:
```
src/
  server/
    index.ts          — Express entry point, registers all routes
    middleware/
      auth.ts         — JWT verification middleware
  db/
    schema.ts         — Drizzle ORM schema definitions
    migrations/       — Migration files (auto-generated)
tests/
  server/
    auth.test.ts      — Auth route integration tests
```

## Step 2 — Fetch relevant documentation (subagent)

Spawn a subagent to use Context7 to fetch documentation for every library, framework, or SDK that the project will use based on the plan. The subagent should confirm the version pinned in package.json (or equivalent) matches a current, widely-supported release, and note any version concerns. 

Subagent will create a `docs` directory in the root (append to it if existing), and place instructions grouped by the library and use case in their own folders, with updated function syntax and references for it to be used or any other relevant context gathered from fetching the online documentations.

> **Steps 1 and 2 run in parallel as independent subagents.** Move on to step 3 after these are done



## Step 3 — Decompose into tasks

Decompose the work into a flat list of tasks. Each task should read as if a project manager is handing it off to a lead senior engineer. A task must be:
- **Self-contained**: full context about what to build and how it fits into the overall project — a fresh engineer reading only this description should know exactly what's needed
- **Concrete**: specific about the expected outcome — what it looks like when done, what it produces, what changes in the codebase
- **Scoped**: one logical unit of work, implementable in a single session

Walk down every branch of the design tree. Do not stop early because a list feels long. Do not merge distinct concerns into one task to keep the list short. There is no upper or lower limit on task count — decompose until every task is a single coherent unit of work and the tasks fulfill the scope of the project, no matter how large or small.

For each task, list which other tasks (by id) must complete directly before this one so that it can start.

## Step 4 — Output

**Write `.flow/tasks.json` (relative to the project root). Do not also paste the JSON into your final message.**

Schema:
```json
{
  "tasks": [
    {
      "id": "string — stable slug, unique across all tasks",
      "title": "string — human-readable label",
      "description": "string — what to build, how it fits into the project, and what the expected outcome looks like",
      "contextFiles": ["path/to/file1", "path/to/file2"],
      "requires": ["task-id-1", "task-id-2"]
    }
  ]
}
```

Rules for the JSON output:
- `id`: stable slug derived from the title — lowercase, non-alphanumeric runs replaced with `-`, trimmed of leading/trailing `-`, max 64 chars. Must be **unique** across all tasks; on collision, append `-2`, `-3`, etc. This id is what other tasks reference in `requires` and what Flow uses throughout the task's lifecycle.
- `title`: human-readable label for the task. Keep titles distinct so the derived ids stay unique.
- `description`: full, detailed, self-contained, written as a PM handoff to a senior engineer — full context about the feature, how it fits into the project, and what done looks like
- `contextFiles`: existing-file paths that will be auto-loaded into the implementing agent's prompt as `@path` mentions. Goal: give the agent everything it needs so it never has to grep, glob, or open-ended explore. Use `CODEBASE.md` as the source-of-truth when picking paths.
  - **Include**: files the task will edit; files whose types/APIs/exports the task imports or calls; one or two exemplar files showing the pattern to mirror (e.g. a sibling component, a similar route handler, an existing test of the same shape); the parent module's index/barrel if symbols are re-exported.
  - **Exclude**: `CODEBASE.md`, `package.json`, `tsconfig.json`, lockfiles, anything in `node_modules`/`dist`/generated dirs; very large files (>1k lines) unless essential — prefer a smaller adjacent file; files that are only tangentially related ("might be useful").
  - Be deliberate, not exhaustive. Every extra file consumes the executing agent's context. Empty `[]` is correct for greenfield tasks creating brand-new files with no existing analogues.
  - `docs/<lib>/...` files generated in Step 2 should be listed here when the task touches that library.
- `requires`: references `id` strings exactly (not titles); use `[]` if there are no dependencies. Only list direct dependencies — they should follow naturally from the logical flow of the task list. Every entry must resolve to an `id` defined elsewhere in this file.

After writing the file, validate it parses as JSON before finishing your turn.


## Step 5 — Post-output checklist

After outputting the JSON, append a plain-text section with these items:

**Missing or recommended MCP tools**
List any MCP servers or CLI tools that would help execute these tasks but are not confirmed available (e.g., a database MCP if tasks touch a database, Playwright MCP if tasks touch UI). For each, include the install or setup command.

**Manual steps required**
List every action the user must take manually before execution can begin — API key setup, OAuth app creation, environment variable configuration, cloud resource provisioning, etc. Be specific: include where to get the credential and what env var or config file it goes into.

## What NOT to do

- Do not write any code.
- Do not create any files other than `CODEBASE.md`, the `docs/` directory, and `.flow/tasks.json`.
- Do not ask clarifying questions unless there are blocking unknowns.
- Do not pad the task list with generic tasks like "write tests" or "add logging" — testing is handled by a dedicated spec phase; logging is part of implementation.
- Do not invent constraints that are not in the inputs.
- Do not paste the tasks JSON into your final message — write `.flow/tasks.json` and reference it.

If you cannot proceed safely or need human judgment, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
