Prepare project bed. Don't test/verify tools at runtime — first get-tasks task does that.

plan.md is in context. Extract: MCPs, plugins, skills, CLIs, libraries/services.
Don't skip UI / interactive-testing tools (Playwright, claude-in-chrome, simulator skills, screenshot tooling, engine drivers). UI Review fails open without them.

Per tool:
MCP → entry in .mcp.json. Don't call.
Plugin → install in agreed location.
Skill → prefer global ~/.claude/skills/<tool>/SKILL.md. None → write project-level <projectRoot>/.claude/skills/<tool>/SKILL.md. Never edit globals.
CLI → which <tool>. Install if absent.
Library → add to manifest, run install.
Can't install locally → record install command in SetupNotes (Step 7), continue. Don't FLOW_BLOCKED on installable.

Library docs: Context7 → docs/<lib>/... per library, grouped by use case + current syntax. Fetch what plan features actually use; not the full website.

.env: per credentialed service, empty placeholder + numbered retrieval guide as inline comments above. Print same steps in stdout. Don't block on missing keys. Existing .env with values → don't overwrite, only add missing keys.

.gitignore: tailor to stack. Build artifacts, deps, env files (except .env.example), editor/OS files, caches/logs, project-specific. Existing → merge, don't clobber.

Map.md: mirror filesystem. Hierarchical, annotated, scannable, accurate. One line per entry. Walk real fs — don't invent files. Skip .git/, node_modules/, dist/, .flow/.

AGENTS.md (lean — every agent loads it):
1. Coding conventions (lang, formatter, lint, indent, naming, imports, errors) — from plan/manifest/configs.
2. Library list: <name> — <use>.
3. Hard rules:
   - "Find files via Map.md first, then read targeted file. No grep / random scan."
   - "Before using any library, consult docs/<lib>/."
4. Project-specific gotchas from plan.
5. Append verbatim:
   ## Flow runtime rules
   - Edit only files inside cwd. Exceptions: learnings-draft.md and stage signal live outside the worktree.
   - Wherever a prompt mentions <taskId>, substitute the actual task id from Workspace block.
   - Each stage prompt owns its Done-when steps (commit, signal emit, escape hatches). Follow exactly.
   - Halt: emit FLOW_BLOCKED: <reason> on stdout to stop the queue.
   - Warn: emit FLOW_REVIEW_REQUESTED: <reason> on stdout to flag without stopping.
   - Stage signal: {"status":"done"} written to the stage signal path.

.flow/SetupNotes.md:
Tools installed — MCPs, plugins, skills (with paths), CLIs (with versions).
Libraries — <name> <version> — purpose.
Services with credentials — service, env var name(s), pointer to .env steps.
How to run locally — exact commands (install, dev, build, test). Mandatory.
UI Review tooling — surface(s), tool, skill path, sample data location. Mandatory.
Gaps — anything uninstalled, with install command for next session.

Allowed writes: Map.md, AGENTS.md, docs/, .gitignore, .env, .mcp.json, .flow/SetupNotes.md, <projectRoot>/.claude/skills/<tool>/SKILL.md (only if no global), project manifest (for libs).

Don't: ping/health-check MCPs/services. skip "optional"-looking UI tools. edit ~/.claude/skills/. block on credentials.

Done:
Map.md + AGENTS.md + .gitignore + .env + .flow/SetupNotes.md exist. docs/<lib>/ populated per declared lib. Every MCP/plugin/skill/CLI installed or install command in SetupNotes. FLOW_BLOCKED only for genuinely unrecoverable.
