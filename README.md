# Flow

Minimal sequential orchestrator driving Claude Code through three phases per project:

1. **Setup** — read `plan.md`, install + smoke-test tools, write `AGENTS.md` / `Map.md` / `docs/<lib>/` / `.flow/SetupNotes.md`.
2. **Get-tasks** — decompose `plan.md` into `.flow/tasks.json` (roughly equal-scope tasks with `requires` deps).
3. **Exec** — for each runnable task (deps satisfied), spawn one Claude session. Agent writes `tasks/<id>/summary.md` (success) or `tasks/<id>/block.md` (blocked).

Always sequential, always on `main`. No worktrees, no UI, no overnight loop.

## Install

```bash
npm install
npm run build
```

## Use

```bash
# In a project root containing plan.md
flow init
flow run
```

`flow init` creates `.flow/{prompts,tasks}` and writes `.flow/config.json` with default model/effort. `flow run` drives setup → get-tasks → exec until the queue is exhausted or stuck.

## Config

`.flow/config.json`:

```json
{
  "defaults": { "model": "opus", "effort": "high" },
  "phases": {
    "exec": { "model": "sonnet", "effort": "med" }
  }
}
```

`phases` overrides are optional. Defaults apply otherwise.

## Status — derived from disk

| File | Meaning |
|---|---|
| `tasks/<id>/summary.md` | task done |
| `tasks/<id>/block.md` | task blocked |
| neither | task pending |

A task is **ready** when every `requires` entry is done. `flow run` picks the first ready task each loop.
