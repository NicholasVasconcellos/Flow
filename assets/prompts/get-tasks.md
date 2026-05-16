Decompose plan.md into self-contained tasks. Setup ran — env verified, AGENTS.md/Map.md/docs/ in place.

Read first: plan.md, Map.md, AGENTS.md, .flow/SetupNotes.md, docs/<lib>/...
Missing → FLOW_BLOCKED: setup output missing — re-run /setup.

Decompose:
- Flat list. Each task = PM handoff to senior engineer.
- Self-contained — full context (what to build, how it fits).
- Concrete — specific outcome, observable result.
- Roughly equal scope per task: similar acceptance-criteria count, similar module surface area, one senior-engineer session.
- Not so small it's a subtask; not so large it's a project. The number of tasks and DAG shape don't matter — task scope is what matters.
- Walk every branch of the plan. Don't merge concerns.

Per task, list direct dependencies only (transitive deps come from the graph).

Target files: identify the core files the task owns (module/feature boundary). Don't over-engineer — the executing agent may expand the list at runtime.

Flags:
- hasUI (default false) — true only when acceptance needs visual confirmation / UI interaction.
- hasTests (default true) — false only when the task is a trivial config/docs change.
- hasReview (default false) — true when complexity warrants a separate review pass.

Output: write `.flow/tasks.json`. Don't paste JSON in final message.

```json
{
  "tasks": [
    {
      "id": "...",
      "title": "...",
      "description": "...",
      "goal": "...",
      "acceptanceCriteria": ["...", "..."],
      "targetFiles": ["src/foo.ts"],
      "contextFiles": ["src/bar.ts", "docs/lib/x.md"],
      "requires": [],
      "hasUI": false,
      "hasTests": true,
      "hasReview": false
    }
  ]
}
```

Field rules:
- id: stable slug from title — lowercase, non-alnum → `-`, trim, ≤64 chars. Unique. Collision → `-2`, `-3`.
- title: distinct (slug uniqueness depends on it).
- description: PM handoff. Realistic sample data, not stubs. Define observable success.
- goal: one sentence — the concrete outcome.
- acceptanceCriteria: bullet list of pass conditions.
- targetFiles: files the task owns. Recommendation, executor may extend.
- contextFiles: files whose APIs/types the task imports + 1–2 exemplar files + docs/<lib>/...
  - Exclude Map.md, package.json, tsconfig.json, lockfiles, node_modules/, dist/.
- requires: id strings only. Direct deps. Every entry resolves to a defined id.

Validate JSON parses before finishing.

Don't: write code, regen Map.md (setup owns), fetch lib docs (setup owns), invent constraints, pad with generic "add logging".

Stop when .flow/tasks.json written + JSON-validated.

Blocked: FLOW_BLOCKED: <one-sentence reason>.
