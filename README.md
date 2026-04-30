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
failure trips. It holds the orchestrator lock for the full duration and
appends a one-line per-cycle summary to `.flow/overnight.log`.

## Layout

- `src/` — TypeScript sources for the core library, CLI, and WebSocket server
- `assets/skills/` — default `SKILL.md` bodies copied into `.flow/skills/` on init
- `test/` — unit and integration tests

## Transports

The core library emits a single event stream consumed by two transports:

- **CLI** (`flow …` commands) for interactive use
- **WebSocket server** (`flow serve`) for the frontend UI

The WebSocket contract is documented in `plan.md` §14.
