---
name: get-tasks
description: Decompose a verified plan into self-contained tasks with dependencies and per-task stage flags. Outputs `.flow/tasks.json`.
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
- `Map.md` — the project map (already current; mirrors the filesystem)
- `instructions.md` — coding conventions and library-purpose summary
- `docs/<lib>/...` — library documentation fetched during setup
- `.flow/SetupNotes.md` — installed tools, services, libraries, and skill paths

If any of these are missing, emit
`FLOW_BLOCKED: setup output missing — re-run /setup` and stop.

## Step 0 — Runtime verification mandate

Setup installed and configured the tools but **did not test them**.
Runtime verification is your responsibility, expressed as tasks the
implementing agent runs end-to-end.

### A. The first task you emit MUST be the pipeline-verification sentinel

`tasks[0]` is fixed:

```json
{
  "id": "verify-pipeline-end-to-end",
  "title": "Verify UI-check pipeline end-to-end against SetupNotes",
  "description": "Read .flow/SetupNotes.md. For every tool, library, and service listed, exercise it end-to-end with realistic sample data (real shapes, real edge cases — not minimal stubs) and capture observable evidence under .flow/tasks/<taskId>/screenshots/. Acceptance: every entry in SetupNotes runs against a real surface with passing evidence; failures are logged to issues/ as harness gaps. This task gates the whole pipeline.",
  "contextFiles": [".flow/SetupNotes.md", "instructions.md", "Map.md"],
  "requires": [],
  "hasUI": true,
  "hasSpec": false,
  "hasCodeReview": false
}
```

This sentinel is verification, not feature work — `hasSpec: false`,
`hasCodeReview: false`, `hasUI: true`.

### B. Every other task that touches a tool must verify it end-to-end

When a feature task uses an MCP, CLI, library, or service, its
`description` must:

1. Enumerate exactly which tools/libraries/services the task invokes.
2. Specify **realistic** sample data (real shapes, real edge cases —
   not minimal stubs).
3. Spell out the observable output that proves success (the response
   payload shape, the rendered DOM, the file written, the row inserted,
   the screenshot evidence path).

No mocking, no stubbing for tools the plan declares — those calls go
through to the real tool. Stub only for upstream services the plan
explicitly marks as "mocked in dev."

### C. Make `tasks[0]` blocking for everything else

Every other task in `requires` must transitively depend on
`verify-pipeline-end-to-end` so the pipeline cannot ship feature work
on broken tools. The simplest pattern: every task whose `requires` is
otherwise empty lists `["verify-pipeline-end-to-end"]` instead.

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

### `hasUI` — default `false`

Set `true` only when acceptance criteria require visual confirmation or
UI interaction. Pure backend / data / infra → `false`.

### `hasSpec` — default `true`

Set `false` for trivially simple tasks: single-file changes, config
tweaks, dependency bumps, boilerplate scaffolds. Otherwise `true` —
simple tasks must be explicitly marked simple.

### `hasCodeReview` — default `true`

Set `false` only when the task touches ≤2 files **and** has no
architectural decisions. Otherwise `true`.

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
- `contextFiles`: existing-file paths auto-loaded as `@path` mentions
  into the implementing agent. Use `Map.md` as the source-of-truth when
  picking paths. Be deliberate, not exhaustive — every extra file
  consumes context. Empty `[]` is correct for greenfield tasks.
  - **Include**: files the task will edit; files whose types/APIs the
    task imports; one or two exemplar files showing the pattern to
    mirror; the parent module's barrel if symbols are re-exported;
    `docs/<lib>/...` files for libraries the task touches.
  - **Exclude**: `Map.md`, `package.json`, `tsconfig.json`, lockfiles,
    anything in `node_modules`/`dist`/generated dirs; >1k-line files
    unless essential; tangentially-related files.
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
- Do not generate or refresh `Map.md` — setup owns it.
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
