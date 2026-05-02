# Flow

Local task-orchestration runtime for Claude Code. Turns a `plan.md` into a
DAG and drives each task through a fixed lifecycle
(spec → exec → review → commit → merge). See `plan.md` for the full spec,
`map.md` for the file index.

## Install

```bash
npm install
npm run build   # emits dist/cli.js (the `flow` bin)
```

Node 20+. Use `node dist/cli.js …`, or `npm link` for a global `flow`.

## Initialize a project

In a git repo containing a `plan.md`:

```bash
node dist/cli.js init   # scaffolds .flow/, syncs bundled skills, git init if needed
```

## Single task + UI

Three terminals, project root:

```bash
# A — WS backend (read-only; default port 7777)
node dist/cli.js serve

# B — frontend (Vite, default http://localhost:5173)
npm run dev:web

# C — drive one ready task
node dist/cli.js run-once
```

`serve` is read-only and does not take the orchestrator lock, so it can run
alongside any driver (`run-once`, `run-all`, `overnight`). UI WS target
defaults to `ws://127.0.0.1:7777`; override with `?ws=ws://host:port`.
Replay the bundled snapshot offline with `?fixture`.

## CLI reference

| Command | Use |
|---|---|
| `init` | scaffold `.flow/` |
| `status` | task table |
| `dag` | ascii DAG |
| `run-once` | run one ready task end-to-end |
| `run-all-once [--limit N]` | drain currently-ready set, then exit |
| `run-all [--limit N]` | drain continuously |
| `retry <taskId>` | resume one paused/blocked task |
| `resume-all [--status paused\|blocked\|all] [--limit N]` | reset paused/blocked → ready, drain |
| `cancel <taskId>` | cancel a running task |
| `overnight [--at HH:MM] [--endless]` | run til done, sleeping through 5h limits |
| `serve [--port N]` | WebSocket server for the UI |
| `logs <taskId> [--stage <s>]` | tail formatted session events |
| `config get [key]` / `config set <key> <val>` | read/write `.flow/config.json` |

## Overnight

```bash
node dist/cli.js overnight                # start now
node dist/cli.js overnight --at 23:00     # defer until 11pm local
node dist/cli.js overnight --endless      # keep cycling through infra/agent errors
                                          #   while runnable work remains
```

Cycle: `run-all` → sleep until the next Claude `resetsAt` → `resume-all`.
One-line per-cycle summaries appended to `.flow/overnight.log`.

A parent supervisor spawns the worker as a child. Crash → exponential
backoff respawn (1s → 2s → 4s … capped 60s). Five crashes within 30s of
spawn trips a circuit breaker (exit 1). State lives in `.flow/state.json`;
`runAll` is idempotent on restart, so a fresh worker reclaims the
orchestrator lock and resumes where the dead one left off. Most recent
terminal outcome → `.flow/overnight.last-result.json`. `[supervisor]` lines
in `.flow/overnight.log` show spawn/restart history.

Restarts cannot survive *parent* death (machine sleep without `caffeinate`,
SIGHUP from the terminal, SIGKILL of the parent). For unattended runs:

```bash
caffeinate -i nohup node dist/cli.js overnight > .flow/overnight.stdout.log 2>&1 &
```

## Layout

- `src/` — TS sources (core, CLI, WS server)
- `web/` — React + Vite UI (`npm run dev:web` / `build:web` / `test:web` from root)
- `assets/skills/` — default `SKILL.md` bodies copied to `.flow/skills/` on init
- `test/` — unit + integration

## Transports

Core emits one event stream; two transports consume it:

- **CLI** — interactive (`flow …`)
- **WS server** (`flow serve`) — the frontend UI

WS contract: `plan.md` §14.
