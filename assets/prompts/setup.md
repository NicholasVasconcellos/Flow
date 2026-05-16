Prepare project bed.

Read plan.md (provided). Extract: MCPs, plugins, skills, CLIs, libraries, services.

Per tool: install or document install command.
- MCP → entry in .mcp.json. Don't ping.
- Plugin → install in agreed location.
- Skill → prefer ~/.claude/skills/<tool>/SKILL.md. None → write <projectRoot>/.claude/skills/<tool>/SKILL.md. Never edit globals.
- CLI → `which <tool>`. Install if absent.
- Library → add to manifest, run install.
- Can't install → record install command in SetupNotes, continue.

Test each installed tool with a minimal invocation. Capture the smoke test in SetupNotes (one line per tool: tool + invocation + observed result).

Library docs: per library used, write `docs/<lib>/<topic>.md`. First line of each doc = one-sentence description so future agents know if it's relevant before reading. Cover only features the plan actually uses.

.env: per credentialed service, empty placeholder + numbered retrieval guide as inline comments above. Don't block on missing keys. Existing .env → only add missing keys.

.gitignore: tailor to stack. Existing → merge, don't clobber.

Map.md: hierarchical fs mirror. One line per entry. Skip .git/, node_modules/, dist/, .flow/. Walk real fs, don't invent.

AGENTS.md (every agent loads it):
1. Core Principles
   - Simplicity first: make every change as simple as possible. Impact minimal code.
   - Non-trivial changes → pause and ask "is there a more elegant way?"
   - Hacky fix → "Knowing everything I know now, implement the elegant solution."
   - Skip for simple obvious fixes. Don't over-engineer.
   - Stay on task scope; relevant context is provided.
2. Programming Patterns
   - Decoupled patterns. No hard-coded values.
   - One-line plain-language comments; sacrifice grammar for concision.
3. Reference `docs/<lib>/` whenever using a tool.
4. Codebase map: @Map.md
5. Append verbatim:
   ## Flow runtime rules
   - Halt: emit `FLOW_BLOCKED: <reason>` on stdout to stop the queue.
   - When done, write success → tasks/<id>/summary.md; blocked → tasks/<id>/block.md.

.flow/SetupNotes.md:
- Tools installed (MCPs, plugins, skills with paths, CLIs with versions). Include smoke-test result.
- Libraries (name, version, purpose).
- Services with credentials (service, env var(s), pointer to .env steps).
- How to run locally (install, dev, build, test commands).
- Gaps — anything uninstalled, with install command.

Allowed writes: Map.md, AGENTS.md, docs/, .gitignore, .env, .mcp.json, .flow/SetupNotes.md, <projectRoot>/.claude/skills/<tool>/SKILL.md, project manifest.

Don't: ping MCPs, edit ~/.claude/skills/, block on credentials.

Done when: Map.md + AGENTS.md + .gitignore + .env + .flow/SetupNotes.md exist; docs/<lib>/ populated; tools tested or install command recorded.

Blocked: FLOW_BLOCKED: <one-sentence reason>.
