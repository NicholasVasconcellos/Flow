---
name: docs
description: Update or create project documentation after a task is implemented. API reference, configuration, and usage examples.
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

- **API reference** — for every new or modified public function, class, or
  endpoint: signature with types, one-line description, minimal working
  usage example, and any edge-case constraints.
- **Configuration** — for any new config, env var, or setup: what it
  does, default value, example usage.

Follow the project's existing doc structure. Prefer tables for parameter
lists and code blocks (with language annotations) for examples. Remove
documentation for anything that was deleted.

## What NOT to do

- Do not document internal implementation details unless they affect public behavior.
- Do not add generic boilerplate ("This module provides...").
- Do not document things that are self-evident from well-named code.
- Do not create separate doc files per task — consolidate into the existing structure.

## Done when

Documentation reflects what changed in this task and the commit is in place.
