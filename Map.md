CLAUDE.md            — Project guidance for Claude (issues/, learnings/ workflow)
README.md            — Quick-start: install, init, run + UI, CLI ref, overnight
plan.md              — Full Flow specification (DAG, lifecycle, WS contract §14)
package.json         — Node package manifest; `flow` CLI bin → dist/cli.js
tsconfig.json        — TS config for typecheck (lint)
tsconfig.build.json  — TS config used by `npm run build` to emit dist/
flow-ui-formats.json         — Wire-format reference for UI payload shapes
flow-ui-payload.snapshot.json — Recorded WS frame stream used by web fixture replay
src/
  agent.ts             — Spawns/streams Claude Code subprocesses; parses session JSONL
  artifacts.ts         — On-disk artifact reader (sessions, notifications, summaries)
  atomic.ts            — Atomic JSON / JSONL file helpers (tmp+rename, append-only)
  cli.ts               — Commander CLI: init, run, run-all, serve, overnight, etc.
  config.ts            — Config schema, defaults, model pricing tables, patch/merge
  dag.ts               — Build/validate task DAG; topo sort; readyTasks selector
  events.ts            — Typed in-process EventBus (on/off/emit)
  flow.ts              — Flow facade wiring state+git+agent+scheduler+setup+events
  git.ts               — GitManager: worktrees, branches, commits, merge ops
  ids.ts               — ULID/UUID generators; nowIso timestamp
  index.ts             — Public package entry; re-exports types and Flow API
  orchestratorLock.ts  — Single-writer lock on .flow/orchestrator.lock w/ heartbeat
  overnight.ts         — `overnight` loop: run-all → sleep until resetsAt → resume
  overnightSupervisor.ts — Parent supervisor that respawns dead overnight workers
  paths.ts             — Centralised .flow/* path resolution
  scheduler.ts         — Drives ready tasks through the per-stage lifecycle
  sessionTail.ts       — Per-session JSONL tail (chokidar) for read-only Flow
  setup.ts             — `init` flow; bundled-skill sync; plan.md watcher
  state.ts             — StateStore for .flow/state.json (tasks + sessions)
  types.ts             — Zod schemas + types: Task, Session, Config, Events, etc.
  ws.ts                — WebSocket server bound to a Flow (frontend transport)
  wsProtocol.ts        — ClientCommand / ServerEvent zod schemas (plan.md §14)
test/
  agent.test.ts                — AgentRunner spawn/parse tests
  artifacts.test.ts            — On-disk artifact reader tests
  config.test.ts               — Config load/save/patch/pricing
  dag.test.ts                  — DAG build / validate / cycle / topo
  flow.test.ts                  — Flow facade orchestration
  git.test.ts                   — Worktree, branch, commit, merge
  integration.test.ts           — End-to-end CLI + WS over a real repo
  overnight.test.ts             — Overnight loop sleep/resume logic
  overnightSupervisor.test.ts   — Supervisor restart/backoff/circuit-breaker
  scheduler.test.ts             — Stage lifecycle transitions
  setup.test.ts                 — init / skill sync / plan watcher
  state.test.ts                 — StateStore persistence
  taskFlags.test.ts             — Task schema flags (ui_check, etc.)
  uiPayloadFixture.test.ts      — Snapshot validation against wsProtocol schemas
  ws.test.ts                    — WebSocket server protocol tests
web/
  index.html             — Vite entry HTML
  package.json           — Frontend deps (React + Vite)
  vite.config.js         — Vite config
  public/
    flow-ui-payload.snapshot.json — Snapshot served to fixture-mode UI
  src/
    main.jsx              — React root + WS/fixture bootstrap, ErrorBoundary
    FlowDataContext.jsx   — Context provider; wraps store reducer + sendCommand
    store.js              — Pure (state, frame) → state reducer; artifactKey
    wsClient.js           — WebSocket client w/ reconnect backoff
    fixtureReplay.js      — Loads snapshot.json and dispatches frames offline
    project_screen.jsx    — Top-level project view; pane layout tree
    dag_view.jsx          — Hierarchical DAG node graph (depth-based layout)
    log_column.jsx        — Session event log column with type filters
    task_details.jsx      — Right-pane task details panel
    side_panels.jsx       — Context charts, learnings, notifications panels
    layout_tree.jsx       — Recursive split tree primitives for draggable panes
    primitives.jsx        — Panel, StagePill, StatusBadge, ContextDonut, etc.
    icons.jsx             — Stroke-based SVG icon set
    displayMeta.js        — STAGES/STATUS_META frontend display metadata
    useArtifact.js        — Hook: fetch artifact via WS w/ inflight dedup
    styles.css            — Global stylesheet
  test/
    store.test.js         — Reducer replay test against snapshot fixture
assets/
  skills/                 — Bundled SKILL.md bodies copied to .flow/skills on init
    spec/SKILL.md
    exec/SKILL.md
    ui-check/SKILL.md
    review/SKILL.md
    commit/SKILL.md
    merge-resolve/SKILL.md
    merge-verify/SKILL.md
    docs/SKILL.md
    update-learning/SKILL.md
    get-tasks/SKILL.md
    setup/SKILL.md
docs/
  superpowers/
    plans/2026-04-30-overnight-needs-review-classifier.md — Plan doc (in-flight)
examples/
  flow-ui-payload.js      — Script that builds flow-ui-payload.snapshot.json
explanations/
  backend-to-ui-flow.md   — Walkthrough of artifact fetch/hydration design
  summary.md              — High-level architecture summary (this directory)
issues/                   — One file per known issue (kebab-name.md, gitignored)
learnings/                — Hard-won gotchas; not deleted on resolution
  react-onwheel-passive-listener.md
  react-rendering-objects-as-children.md
  react-shorthand-vs-longhand-style-props.md
