---
name: docs
description: >
  Update or create project documentation after a task is implemented.
  Produces clear explanations, logic flow, API reference, and usage examples.
  Trigger on: /docs
disable-model-invocation: true
---

# docs

After implementation and review, update the project documentation to reflect changes made by this task.

## Step 1 — Identify what changed

Read the task description and the files that were modified. Understand:
- What new functionality was added or changed
- What APIs, functions, or components were introduced or modified
- What configuration or setup changed

## Step 2 — Find existing documentation

Check for:
- `DOCS.md` or `docs/` directory at the project root
- README.md sections relevant to the changes
- Inline documentation patterns already in use
- Any existing API reference files

If no documentation structure exists, create `DOCS.md` at the project root.

## Step 3 — Update documentation

For each significant change, document:

**API Reference** — For every new or modified public function, class, or endpoint:
- Signature with parameter types and return type
- One-line description of what it does
- Usage example (minimal, working code)
- Edge cases or important constraints

**Logic Flow** — For non-trivial workflows:
- Step-by-step description of what happens
- Bullet List with nested bullets for logic flow
- Decision points and their outcomes
- Data flow between components

**Configuration** — For any new config, env vars, or setup:
- What the option does
- Default value
- Example usage

## Formatting Rules

- Use clear, concise language — optimize for both human readers and LLM context
- Prefer tables for parameter lists and option references
- Use code blocks with language annotations for all examples
- Keep explanations under 3 sentences per concept — link to code for details
- Use h2 for major sections, h3 for subsections within
- Do not duplicate information — reference other sections instead

## Step 4 — Verify accuracy

- Confirm every code example compiles/runs conceptually
- Confirm function signatures match the actual code
- Remove documentation for anything that was deleted

## What NOT to do

- Do not document internal/private implementation details unless they affect public behavior
- Do not add generic boilerplate ("This module provides...")
- Do not document things that are self-evident from well-named code
- Do not create separate doc files per task — consolidate into the project's existing doc structure
- Do not modify source code — only documentation files

## Progress notes

Read `progress.txt` (provided via `@progress.txt` in your prompt) at the
start. Append a one-line note when you finish that captures any docs file
created or surface area that newly has documentation. Keep it terse.

## Termination

When the docs reflect what changed and your commit is in place, **stop**.
Do not document unrelated areas, add API references for code you did not
touch, or restructure existing docs. Any extra work is out of scope.

## Stage signal

After your final commit, write the stage signal exactly once:

```
echo '{"stage":"documentation","status":"done"}' > <stage signal path from prompt>
```

If you cannot proceed safely, write `{"stage":"documentation","status":"blocked","reason":"…"}`
instead and exit.
