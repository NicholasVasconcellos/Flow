# Flow — How the code works

Flow is a local task-orchestration runtime. It reads a human-authored
`plan.md`, materialises it into a DAG of tasks, and drives Claude Code
subprocesses through a fixed per-task lifecycle. Output flows over a single
typed event bus consumed by two transports: an interactive CLI and a
WebSocket server that powers the React UI in `web/`.

## Top-level shape

```
plan.md ──▶ tasks.json ──▶ DAG ──▶ Scheduler ──▶ Agent (claude subprocess)
                                       │              │
                                       ▼              ▼
                                  state.json     session JSONL + artifacts
                                       │              │
                                       └──▶ EventBus ─┘
                                                │
                                       ┌────────┴─────────┐
                                       ▼                  ▼
                                      CLI               WS server ──▶ React UI
```

## Core (`src/`)

- **`flow.ts`** is the facade. `createFlow()` wires together `Paths`,
  `EventBus`, `StateStore`, `GitManager`, `AgentRunner`, `Scheduler`, and
  `setup.ts` (init + plan watcher). Everything else builds on these.
- **`setup.ts`** owns project initialisation: it creates `.flow/`, copies
  bundled skills from `assets/skills/` into `.flow/skills/`, parses the
  task list out of `plan.md`, validates the resulting DAG, and watches
  `plan.md` via `chokidar` for live edits.
- **`dag.ts`** builds the DAG from task `requires` arrays, validates against
  `CYCLE` / `UNKNOWN_DEP` / `NON_LEAF_NEW` errors, topo-sorts, and exposes
  `readyTasks()` — tasks whose dependencies are merged.
- **`state.ts`** is the durable store (`.flow/state.json`) for tasks +
  sessions, written atomically through `atomic.ts` (tmp-file + rename for
  JSON, append-only for JSONL).
- **`scheduler.ts`** is the heart of the lifecycle. For each ready task it
  walks the stages — `spec → exec → exec_ui_check → code_review →
code_review_ui_check → documentation → update-learning → done → merged`
  — spawning the right agent per stage and reacting to its events.
- **`agent.ts`** spawns `claude` with the right `--session-id`, skill,
  thinking mode, and effort budget; streams stdout JSONL back into
  `SessionEvent`s; surfaces token usage, cost, and cache stats; detects
  blocked-tool loops and missing-skill conditions.
- **`git.ts`** wraps `simple-git` for per-task worktrees and branches,
  commit message formatting, and merge-resolve flows.
- **`orchestratorLock.ts`** enforces single-writer access to `.flow/` via a
  PID + heartbeat lock with a 30s staleness threshold, so a crashed
  orchestrator can be reclaimed without manual cleanup.
- **`events.ts`** is a tiny typed pub/sub bus. Every state change, session
  event, notification, and artifact-stream chunk is published here exactly
  once; transports subscribe.

## Long-running mode

- **`overnight.ts`** runs the overnight loop: `runAll` → if any session
  pauses on a 5-hour window, sleep until `resetsAt + 30s` → `resumeAll`,
  repeating until the DAG is fully merged or a fatal error trips. Exit
  codes (`EXIT_DONE` / `EXIT_FATAL` / `EXIT_LOCK_CONFLICT`) are
  sysexits-style so wrappers can distinguish outcomes.
- **`overnightSupervisor.ts`** is the parent process. It spawns the worker,
  watches for unexpected exits (OOM, crash, hook failure) and respawns
  with exponential backoff (1s → 60s). Five crashes within 30s of spawn
  trip a circuit breaker. The most recent terminal outcome is written to
  `.flow/overnight.last-result.json` and per-cycle history to
  `.flow/overnight.log`. State durability + lock-reclaim on the worker
  side make restarts idempotent.

## Transports

- **CLI (`src/cli.ts`)** — `commander`-based. Commands: `init`, `run`,
  `run-all`, `resume-all`, `serve`, `overnight`, plus inspection helpers
  (`status`, `tasks`, `tail`, etc.). Acquires the orchestrator lock,
  subscribes to the event bus, and renders progress with `chalk` + `ora`.
- **WebSocket server (`src/ws.ts` + `src/wsProtocol.ts`)** — `flow serve`
  binds a `ws` server (default `127.0.0.1:7777`) to a Flow instance.
  `wsProtocol.ts` defines zod-validated `ClientCommand` and `ServerEvent`
  schemas: project listing/open, task lifecycle frames, session
  streaming, and `artifact.fetch` / `artifact.chunk` / `artifact.end` /
  `artifact.error` for on-disk file streaming.
- **`artifacts.ts`** is the disk reader behind that protocol — it knows
  where every kind of artifact lives (session events, project
  notifications, learnings drafts, screenshots, plan.md, setup notes…)
  and streams them back chunked.

## Frontend (`web/`)

A Vite + React app. `main.jsx` boots either a live WS client
(`wsClient.js`, with reconnect backoff) or a fixture replay
(`fixtureReplay.js`, reading `flow-ui-payload.snapshot.json`).
`FlowDataContext.jsx` wraps a `useReducer` over `store.js`, the same
pure `(state, frame) → state` accumulator that's also reducer-tested in
`web/test/store.test.js` against the recorded snapshot. The UI itself is
a recursive split-tree of draggable panes (`layout_tree.jsx` +
`project_screen.jsx`); leaf panes include the DAG view, the per-session
log column, the task details panel, and side panels for context charts,
learnings, and notifications. Large artifacts (full session histories,
screenshots) are fetched on demand via the `useArtifact` hook, which
deduplicates inflight requests at module scope to survive React 18
StrictMode double-effects.

## Skills

`assets/skills/<stage>/SKILL.md` files are the prompt bodies the agent
runs at each lifecycle stage. They are copied into `.flow/skills/` on
init and re-synced on subsequent boots — the bundled copy is the source
of truth, and projects can override locally per .flow.

## Tests

`test/*.test.ts` runs under `node --test` with `tsx`. Coverage spans
each module plus an `integration.test.ts` that boots a real Flow on a
real git repo and a `uiPayloadFixture.test.ts` that asserts the recorded
snapshot still validates against the current zod schemas — protecting
the wire contract from drift.

## Conventions

- All `.flow/` writes go through `atomic.ts` (tmp+rename or
  append-only); no in-place mutation.
- IDs are ULIDs (`ids.ts`) for everything Flow owns; Claude session IDs
  are UUIDv4 because the `claude` CLI rejects anything else.
- Issues live as one file per problem under `issues/` and are deleted
  when verifiably fixed. Learnings under `learnings/` are kept
  permanently as reference material.
