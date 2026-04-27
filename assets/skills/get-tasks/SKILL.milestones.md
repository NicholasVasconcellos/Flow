---
name: get-tasks
description: >
  Break a PRD, issue, or user description into milestones and atomic tasks
  with dependency ordering. Main agent defines milestones and their
  relationships, then spawns subagents per milestone to decompose tasks.
  Outputs structured JSON task plan. Trigger on: /get-tasks
disable-model-invocation: true
---

# get-tasks

Analyze the project and decompose it into milestones and atomic tasks. The main agent owns milestone-level planning; subagents own task-level decomposition.

## Inputs

You will receive one of: a PRD document, a GitHub issue, a user description, or a combination. Read all provided inputs before doing anything else.

## Step 1 — Generate or update CODEBASE.md

If `CODEBASE.md` does not exist at the project root, create it now. If it exists but is stale (missing files or directories that clearly exist), update it.

CODEBASE.md must be:

- Hierarchical: reflect the actual directory tree
- Scannable: use concise annotations, not prose
- Accurate: walk the real file system, do not guess

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

## Step 2 — Fetch relevant documentation

Use Context7 to fetch documentation for every library, framework, or SDK that the task involves. Do this before forming any plan. Confirm the version pinned in package.json (or equivalent) matches a current, widely-supported release. Note any version concerns in your output.

## Step 3 — Analyze requirements

Read the inputs again. Identify:

- The end goal (what done looks like)
- The domain areas involved (auth, data layer, UI, infra, etc.)
- Constraints (existing conventions, tech stack, deployment target)
- Unknowns that need a decision before work can begin

If critical unknowns exist, list them and stop — ask the user before continuing.

## Step 4 — Define milestones (main agent)

Group work into milestones. A milestone is a coherent, deployable slice of the goal (e.g., "Auth", "Data Layer", "Dashboard UI"). Milestones are not phases like "testing" or "cleanup" — tests and cleanup belong inside the relevant milestone.

For each milestone, define:

- **Name**: short label
- **Goal**: what this milestone delivers when complete
- **Scope**: which domain areas and files it covers
- **Upstream milestones**: which milestones must complete first (ordering)
- **Boundary tasks**: specific task titles from upstream milestones that this milestone's tasks may depend on (these are the cross-milestone dependency anchors)

Order milestones topologically — a milestone's upstream milestones must appear earlier in the list.

## Step 5 — Decompose tasks per milestone (subagents)

For each milestone, spawn a subagent. Pass it concisely:

- The milestone name, goal, and scope from Step 4
- The project constraints and conventions from Step 3
- The **boundary tasks** (exact ids) from upstream milestones that its tasks may reference in `requires`
- Relevant parts of CODEBASE.md (only the files/directories this milestone touches)

Each subagent must return a JSON array of tasks:

```json
[
  {
    "id": "string — stable slug, unique across all tasks",
    "title": "string — human-readable label",
    "description": "string — what to build and the exact acceptance criteria",
    "contextFiles": ["path/to/file1", "path/to/file2"],
    "requires": ["task-id-1", "..."]
  }
]
```

Subagent rules:

- A task must be **atomic** (one agent, one session), **concrete** (self-contained description), and **verifiable** (explicit acceptance criteria)
- `id` must be a stable slug derived from the title — lowercase, non-alphanumeric runs replaced with `-`, trimmed of leading/trailing `-`, max 64 chars. It must be **unique** across every milestone; on collision, append `-2`, `-3`, etc. This id is the global identifier referenced in `requires`.
- `title` is the human-readable label. Keep titles distinct so the derived ids stay unique.
- `requires` may reference ids within the same milestone OR boundary task ids from upstream milestones — nothing else
- `contextFiles`: file paths auto-loaded into the implementing agent's prompt as `@path` mentions. Goal: give the agent everything it needs so it never has to grep, glob, or open-ended explore. Use `CODEBASE.md` as the source-of-truth.
  - Example Include: files the task will edit; files whose types/APIs/exports the task calls; one or two exemplar files showing the pattern to mirror; parent index/barrel files if symbols are re-exported; relevant `docs/<lib>/...` files for libraries this task uses.
  - Exclude: `CODEBASE.md`, `package.json`, `tsconfig.json`, lockfiles, `node_modules`/`dist`/generated dirs; very large files (>1k lines) unless essential; tangentially related files.
  - Be deliberate, not exhaustive. Every extra file costs context. `[]` is correct for greenfield tasks with no existing analogues.
- Walk down every branch of the design tree. Do not stop early because a list feels long. Do not merge distinct concerns into one task. No upper or lower limit on task count — decompose until every task is truly atomic
- Do not write code, create files, no need to ask clarifying questions, the plan is finalized and polished

Spawn subagents for independent milestones in parallel when possible.

## Step 6 — Flatten into a milestone-agnostic DAG (main agent)

Collect task arrays from all subagents. Merge them into a single flat task list. Milestones are now only labels — execution order is determined entirely by explicit `requires` edges.

For every task, review and finalize its `requires`:

1. **Keep** any within-milestone dependencies the subagent set
2. **Keep** any cross-milestone boundary task dependencies the subagent set
3. **Add missing cross-milestone edges**: if a task has no `requires` entries but belongs to a milestone with upstream milestones, it MUST depend on at least one boundary task id from each upstream milestone. Milestone ordering that is not encoded as an explicit `requires` edge is invisible to the runner and will cause parallel execution of tasks that should be sequential
4. **Remove milestone assumptions**: do not rely on milestone order for anything. The flat `requires` list is the sole source of execution order

Then validate:

1. **Id uniqueness**: no duplicate `id` values across milestones. If a collision would occur, either rename the title so the derived slug differs or append a `-2`/`-3` suffix.
2. **Title distinctness**: keep titles distinct enough that derived slugs don't silently collide. If two milestones truly need the same title, prefix the id with the milestone slug.
3. **Dependency integrity**: every `requires` reference resolves to an existing task `id`. Flag and fix any broken references.
4. **No cycles**: the full DAG is acyclic
5. **Completeness**: every boundary task listed in Step 4 actually exists in the output
6. **No orphaned downstream tasks**: no task from a downstream milestone has an empty `requires` unless it genuinely has zero prerequisites across the entire project

Fix any issues found.

## Step 7 — Output

Output the task plan as a single JSON object and nothing else after it. Do not wrap it in a code block — output raw JSON.

Schema:

```json
{
  "milestones": [
    {
      "name": "string",
      "tasks": [
        {
          "id": "string — stable slug, unique across all tasks",
          "title": "string — human-readable label",
          "description": "string — what to build and the exact acceptance criteria",
          "contextFiles": ["path/to/file1", "path/to/file2"],
          "requires": ["task-id-1", "..."]
        }
      ]
    }
  ]
}
```

The `milestones` grouping is retained for readability only. Execution ignores it — only `requires` matters.

Rules for the JSON output:

- `id` is unique across all milestones and derived from the title as a slug (see Step 5)
- `title` is the human-readable label; keep titles distinct enough that derived slugs don't collide
- `description` is self-contained — a fresh agent must be able to read it and know exactly what to implement and how to verify it is done
- `contextFiles` carries forward exactly as the subagent set it. Omit or use `[]` if none — see Step 5 for selection rules
- `requires` references `id` strings exactly (not titles); use `[]` only if the task has zero prerequisites across the entire project

## Step 8 — Post-output checklist

After outputting the JSON, append a plain-text section with these items:

**Missing or recommended MCP tools**
List any MCP servers or CLI tools that would help execute these tasks but are not confirmed available (e.g., a database MCP if tasks touch a database, Playwright MCP if tasks touch UI). For each, include the install or setup command.

**Manual steps required**
List every action the user must take manually before execution can begin — API key setup, OAuth app creation, environment variable configuration, cloud resource provisioning, etc. Be specific: include where to get the credential and what env var or config file it goes into.

## What NOT to do

- Do not write any code.
- Do not create any files other than CODEBASE.md.
- Do not ask clarifying questions unless there are blocking unknowns identified in Step 3.
- Do not pad the task list with generic tasks like "write tests" or "add logging" — tests belong inside each task's acceptance criteria; logging is part of implementation.
- Do not invent constraints that are not in the inputs.

If you cannot proceed safely or need human judgment, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
