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

## Layout

- `src/` — TypeScript sources for the core library, CLI, and WebSocket server
- `assets/skills/` — default `SKILL.md` bodies copied into `.flow/skills/` on init
- `test/` — unit and integration tests

## Transports

The core library emits a single event stream consumed by two transports:

- **CLI** (`flow …` commands) for interactive use
- **WebSocket server** (`flow serve`) for the frontend UI

The WebSocket contract is documented in `plan.md` §14.
