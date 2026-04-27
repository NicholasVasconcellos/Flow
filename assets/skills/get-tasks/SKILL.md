---
name: get-tasks
description: >
  Decompose a verified plan into self-contained tasks with dependencies
  and per-task stage flags. Outputs `.flow/tasks.json`.
  Trigger on: /get-tasks
disable-model-invocation: true
---

# get-tasks

Decompose the plan into self-contained tasks. Setup has already run —
trust that the environment is verified, libraries are documented under
`docs/`, and MCPs/services are reachable. Your only job is to produce
the task graph.

## Inputs

Read all provided inputs before doing anything else:

- `plan.md` — the project's plan or PRD
- `CODEBASE.md` — the project map (already current)
- `docs/<lib>/...` — library documentation fetched during setup
- `.flow/setup-report.md` — verified tools, services, and skills

If any of these are missing, emit
`FLOW_BLOCKED: setup output missing — re-run /setup` and stop.

## Step 1 — Decompose into tasks

Decompose the work into a flat list of tasks. Each task should read as
if a project manager is handing it off to a lead senior engineer. A
task must be:

- **Self-contained** — full context about what to build and how it fits
  into the overall project. A fresh engineer reading only this
  description should know exactly what's needed.
- **Concrete** — specific about the expected outcome. What it looks
  like when done, what it produces, what changes in the codebase.
- **Scoped** — one logical unit of work, implementable in a single
  session.

Walk down every branch of the design tree. Do not stop early because a
list feels long. Do not merge distinct concerns into one task to keep
the list short. There is no upper or lower limit on task count —
decompose until every task is a single coherent unit of work and the
tasks fulfill the scope of the project, no matter how large or small.

For each task, list which other tasks (by id) must complete directly
before this one so that it can start.

## Step 2 — Set stage flags per task

Each task carries three boolean flags that tell the harness which
stages to skip. Pick them per the rubric below.

### `hasUI` (default `false`)

`true` if acceptance criteria require visual confirmation or
user-interface interaction.

Default `false`. Trivially false for pure backend, data, or infra
tasks.

### `hasSpec` (default `true`)

`true` when the task is complex or lengthy enough to benefit from a
separate spec-author agent writing acceptance tests before
implementation.

Trivially `false` for:
- single-file changes
- config tweaks
- dependency bumps
- boilerplate scaffolds

Default `true`

— simple tasks must be explicitly marked simple.

### `hasCodeReview` (default `true`)

`true` when the task touches many files or involves architectural
choices that benefit from a post-implementation cleanup pass for best
practice / scalability / readability.

Set `false` when task touches **≤2 files with or no
architectural decisions**. Default `true`.

## Step 3 — Output

**Write `.flow/tasks.json` (relative to the project root). Do not also
paste the JSON into your final message.**

Schema:

```json
{
  "tasks": [
    {
      "id": "string — stable slug, unique across all tasks",
      "title": "string — human-readable label",
      "description": "string — what to build, how it fits into the project, and what the expected outcome looks like",
      "contextFiles": ["path/to/file1", "path/to/file2"],
      "requires": ["task-id-1", "task-id-2"],
      "hasUI": false,
      "hasSpec": true,
      "hasCodeReview": true
    }
  ]
}
```

Rules for the JSON output:

- `id`: stable slug derived from the title — lowercase, non-alphanumeric
  runs replaced with `-`, trimmed of leading/trailing `-`, max 64 chars.
  Must be **unique** across all tasks; on collision, append `-2`, `-3`,
  etc. This id is what other tasks reference in `requires` and what
  Flow uses throughout the task's lifecycle.
- `title`: human-readable label for the task. Keep titles distinct so
  the derived ids stay unique.
- `description`: full, detailed, self-contained, written as a PM
  handoff to a senior engineer — full context about the feature, how
  it fits into the project, and what done looks like.
- `contextFiles`: existing-file paths that will be auto-loaded into the
  implementing agent's prompt as `@path` mentions. Goal: give the agent
  everything it needs so it never has to grep, glob, or open-ended
  explore. Use `CODEBASE.md` as the source-of-truth when picking paths.
  - **Include**: files the task will edit; files whose types/APIs/exports
    the task imports or calls; one or two exemplar files showing the
    pattern to mirror (e.g. a sibling component, a similar route handler,
    an existing test of the same shape); the parent module's index/barrel
    if symbols are re-exported.
  - **Exclude**: `CODEBASE.md`, `package.json`, `tsconfig.json`,
    lockfiles, anything in `node_modules`/`dist`/generated dirs; very
    large files (>1k lines) unless essential — prefer a smaller
    adjacent file; files that are only tangentially related ("might be
    useful").
  - Be deliberate, not exhaustive. Every extra file consumes the
    executing agent's context. Empty `[]` is correct for greenfield
    tasks creating brand-new files with no existing analogues.
  - List `docs/<lib>/...` files when the task touches that library.
- `requires`: references `id` strings exactly (not titles); use `[]` if
  there are no dependencies. Only list direct dependencies — they
  should follow naturally from the logical flow of the task list.
  Every entry must resolve to an `id` defined elsewhere in this file.
- `hasUI`, `hasSpec`, `hasCodeReview`: per the rubric in Step 2. The
  fields are optional in the schema (defaults apply), but be explicit
  — write the value you intend so the harness's behavior is
  predictable.

After writing the file, validate it parses as JSON before finishing
your turn.

## What NOT to do

- Do not write any code.
- Do not generate or refresh `CODEBASE.md` — setup owns it.
- Do not fetch library documentation — setup owns `docs/`.
- Do not append a "missing MCPs / manual steps" checklist — setup
  already verified the environment and blocked if anything was missing.
- Do not create any files other than `.flow/tasks.json`.
- Do not ask clarifying questions unless there are blocking unknowns.
- Do not pad the task list with generic tasks like "write tests" or
  "add logging" — testing is handled by the spec stage when `hasSpec`
  is true; logging is part of implementation.
- Do not invent constraints that are not in the inputs.
- Do not paste the tasks JSON into your final message — write
  `.flow/tasks.json` and reference it.

## Termination

When `.flow/tasks.json` has been written and validated as JSON,
**stop**. Do not continue to refine the task list, scaffold code, or
run tests.

If you cannot proceed safely or need human judgment, output a single
line:

```
FLOW_BLOCKED: <one-sentence reason>
```
