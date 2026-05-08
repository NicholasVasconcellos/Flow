Decompose plan into self-contained tasks. Setup ran — env verified. Just produce the task graph.

tasks[0] verbatim. Every other task transitively depends on it (otherwise-empty requires → ["verify-pipeline-end-to-end"]):

{
  "id": "verify-pipeline-end-to-end",
  "title": "Verify UI-check pipeline end-to-end against SetupNotes",
  "description": "Read .flow/SetupNotes.md. For every tool, library, and service listed, exercise it end-to-end with realistic sample data and capture observable evidence under .flow/tasks/<taskId>/screenshots/. Acceptance: every entry runs against a real surface with passing evidence; failures logged to issues/ as harness gaps.",
  "contextFiles": [".flow/SetupNotes.md", "AGENTS.md", "Map.md"],
  "requires": [],
  "hasUI": true,
  "hasSpec": false,
  "hasCodeReview": false
}

Read first: plan.md, Map.md, AGENTS.md, docs/<lib>/..., .flow/SetupNotes.md.
Missing → FLOW_BLOCKED: setup output missing — re-run /setup.

Decompose:
Flat list. Each task = PM handoff to senior engineer.
Self-contained — full context (what to build, how it fits).
Concrete — specific outcome, what's in the codebase when done.
Scoped — one logical unit, single session.

Walk every branch. Don't stop early. Don't merge concerns. No upper/lower task count.

Per task: list direct dependencies only.

Stage flags:
hasUI (default false) — true only when acceptance needs visual confirmation / UI interaction.
hasSpec (default true) — false only for trivially simple: single-file change, config tweak, dep bump, boilerplate scaffold.
hasCodeReview (default true) — false only when ≤2 files AND no architectural decisions.

Output: write .flow/tasks.json. Don't paste JSON in final message.

{
  "tasks": [
    { "id": "...", "title": "...", "description": "...", "contextFiles": [...], "requires": [...], "hasUI": ..., "hasSpec": ..., "hasCodeReview": ... }
  ]
}

id: stable slug from title — lowercase, non-alphanumeric → -, trim, ≤64 chars. Unique. Collision → -2, -3.
title: distinct (slug uniqueness depends on it).
description: full PM handoff. If task uses tool/MCP/library/service → name it, realistic sample data (not stubs), define observable success.
contextFiles:
- Include: files task edits; files whose types/APIs task imports; 1–2 exemplar files for the pattern; parent module barrel if symbols are re-exported; docs/<lib>/... per touched lib.
- Exclude: Map.md, package.json, tsconfig.json, lockfiles, node_modules/, dist/, generated; >1k-line files unless essential; tangential.
requires: id strings exactly; [] if none. Direct deps only. Every entry resolves to a defined id.
hasUI / hasSpec / hasCodeReview: per rubric. Be explicit.

Validate JSON parses before finishing.

Don't: write code. regen Map.md (setup owns). fetch lib docs (setup owns). append "missing MCPs" checklist (setup verified). create files other than .flow/tasks.json. ask clarifying questions unless blocking. pad with generic "write tests" / "add logging". invent constraints.

Stop when .flow/tasks.json written + JSON-validated. Don't refine, scaffold, or run tests.

Blocked: FLOW_BLOCKED: <one-sentence reason>.
