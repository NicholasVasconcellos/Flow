# Flow

Local task-orchestration runtime that turns a `plan.md` into a DAG of tasks and
drives Claude Code through a fixed lifecycle for each one.

See `plan.md` for the full specification.

## Quick start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js run-all
```

### Run overnight, auto-restart through 5-hour session limits

```bash
node dist/cli.js overnight                # start now, run til done
node dist/cli.js overnight --at 23:00     # defer start until 11pm local
```

`overnight` loops `run-all → sleep until the next `resetsAt` reported by
Claude → `resume-all`, until the DAG is fully merged or a non-transient
failure trips. It appends a one-line per-cycle summary to `.flow/overnight.log`.

The command runs as a small parent supervisor that spawns the actual worker
as a child. If the worker dies unexpectedly (OOM, segfault, hook crash) the
supervisor respawns it with exponential backoff (1s → 2s → 4s … capped at
60s) — `.flow/state.json` is durable and `runAll` is idempotent on restart,
so a fresh worker reclaims the orchestrator lock and resumes where the dead
one left off. Five consecutive crashes within 30s of spawn trip a circuit
breaker that exits 1 instead of busy-looping. `[supervisor]` lines in
`.flow/overnight.log` show spawn/restart history; the most recent terminal
outcome is written atomically to `.flow/overnight.last-result.json`.

Restarts cannot survive *parent* death (machine sleep without `caffeinate`,
SIGHUP from the terminal, SIGKILL of the parent). For unattended runs:

```bash
caffeinate -i nohup node dist/cli.js overnight > .flow/overnight.stdout.log 2>&1 &
```

## Layout

- `src/` — TypeScript sources for the core library, CLI, and WebSocket server
- `assets/skills/` — default `SKILL.md` bodies copied into `.flow/skills/` on init
- `test/` — unit and integration tests

## Transports

The core library emits a single event stream consumed by two transports:

- **CLI** (`flow …` commands) for interactive use
- **WebSocket server** (`flow serve`) for the frontend UI

The WebSocket contract is documented in `plan.md` §14.
