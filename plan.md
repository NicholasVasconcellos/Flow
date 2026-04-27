# Flow — Backend Plan

Flow is a local task-orchestration runtime that turns a `plan.md` into a DAG of
tasks and drives Claude Code through a fixed lifecycle for each one. This
document specifies the backend only. The frontend is built separately and
consumes the WebSocket contract in §14.

---

## 1. Goals & non-goals

**Goals**

- Parse a user-authored `plan.md` into `tasks.json`, build a DAG, and execute
  tasks through a fixed stage pipeline (spec → exec → UI check → review → UI
  check → docs → done → merged).
- Run up to N tasks in parallel, each in its own git worktree. No shared
  mutable state between workers.
- One core library, two transports: CLI and WebSocket. Everything the UI
  shows is derivable from the library's event stream.
- Keep state on disk as human-readable JSON / JSONL. Greppable, diffable,
  survives restarts.

**Non-goals (v1)**

- No database, no job queue, no ORM.
- No remote execution, no multi-user auth.
- Not yet agent-agnostic — Claude Code only. `spawnAgent` is the only seam
  that talks to it, so adapters slot in later without touching the orchestrator.
- No frontend code.

---

## 2. Tech stack

- Node.js ≥ 20, TypeScript (strict), ESM.
- `commander` (CLI), `ws` (WebSocket server), `execa` (subprocess),
  `simple-git` (git + worktrees), `zod` (validation), `chokidar`
  (watch `plan.md`), `ulid` (ids), `chalk` + `ora` (CLI rendering).
- Deliberate non-choices: no framework, no database, no React in-tree.

---

## 3. Directory layout

```
<project-root>/
├── plan.md                                  # sole user-authored input
├── .flow/
│   ├── config.json                          # runtime config + price table
│   ├── tasks.json                           # task definitions (produced by get-tasks agent)
│   ├── state.json                           # runtime state, atomic writes
│   ├── skills/
│   │   ├── get-tasks/SKILL.md
│   │   ├── setup/SKILL.md                   # MCP + docs discovery
│   │   ├── spec/SKILL.md
│   │   ├── exec/SKILL.md
│   │   ├── ui-check/SKILL.md
│   │   ├── review/SKILL.md
│   │   ├── docs/SKILL.md
│   │   ├── commit/SKILL.md
│   │   └── merge-resolve/SKILL.md
│   ├── worktrees/<taskId>/                  # git worktrees
│   ├── sessions/<sessionId>.jsonl           # project-level sessions (setup, get-tasks)
│   ├── tasks/<taskId>/
│   │   ├── metadata.json
│   │   ├── sessions/<sessionId>.jsonl       # raw stream-json from Claude Code
│   │   ├── sessions/<sessionId>.meta.json   # tokens, cost, context %
│   │   ├── screenshots/*.png
│   │   └── summary.md
│   ├── learnings/<taskId>.md
│   ├── suggestions/<taskId>.md
│   └── notifications.jsonl                  # append-only user-actionable log
└── <project source files>
```

`config.json`, `tasks.json`, and `skills/` are user-editable. Everything else
is runtime-generated. Deleting `state.json` resets the scheduler; task
artefacts stay preserved by id.

---

## 4. Data model

All types are Zod-validated at I/O boundaries.

```ts
// Task definition — authored by the get-tasks agent, editable by the user
interface TaskDef {
  id: string; // ulid, stable across runs
  title: string; // short one-liner
  description: string; // full goal, requirements, how it fits
  contextFiles: string[]; // paths relative to project root
  requires: string[]; // task ids this depends on
}

type TaskStatus =
  | "pending" // deps unmet
  | "ready" // deps met, not yet picked up
  | "running"
  | "paused" // failure, retries exhausted, user action needed
  | "blocked" // agent signalled human intervention required
  | "done" // pipeline complete, committed in worktree
  | "merged"; // merged into main, worktree removed

type TaskStage =
  | "spec"
  | "exec"
  | "exec_ui_check"
  | "code_review"
  | "code_review_ui_check"
  | "documentation"
  | "done"
  | "merged";

interface TaskRuntime extends TaskDef {
  status: TaskStatus;
  stage: TaskStage;
  retries: number;
  worktreePath?: string;
  branchName?: string;
  currentSessionId?: string;
  sessionIds: string[]; // every session ever spawned for this task
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: { stage: TaskStage; message: string; at: string };
}

interface Session {
  id: string;
  taskId: string | null; // null for project-level sessions (setup, get-tasks)
  stage: TaskStage | "setup" | "get-tasks" | "commit" | "merge-resolve";
  provider: "claude-code"; // extensible later
  model: string;
  thinkingMode?: "off" | "think" | "megathink" | "ultrathink";
  skillName: string;
  prompt: string; // composed prompt (skill body + task context)
  status: "running" | "succeeded" | "failed" | "autocompacted";
  startedAt: string;
  endedAt?: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
    total: number;
  };
  contextPercentage?: number; // from /context probe after run
  autocompacted: boolean;
  costUsd: number;
  parentSessionId?: string; // set when spawned as a subagent
  exitCode?: number;
  error?: string;
}

// One JSONL line from Claude Code's stream-json output
interface SessionEvent {
  sessionId: string;
  ts: string;
  kind:
    | "system"
    | "assistant_text"
    | "assistant_thinking"
    | "tool_use"
    | "tool_result"
    | "usage"
    | "stop";
  payload: unknown; // passed through to frontend untouched
}

interface Notification {
  id: string;
  taskId?: string;
  sessionId?: string;
  severity: "info" | "warn" | "error" | "blocked";
  title: string;
  body: string; // verbose — includes log tail on errors
  createdAt: string;
  acknowledged: boolean;
}

interface Config {
  maxConcurrent: number | "off"; // default 3
  retryCount: number; // default 0
  hasDocs: boolean; // default true
  defaults: {
    model: string; // e.g. 'claude-sonnet-4-5'
    thinkingMode?: "off" | "think" | "megathink" | "ultrathink";
  };
  git: {
    remote?: string; // if set, pushed on init
    mainBranch: string; // default 'main'
    worktreeRoot: string; // default '.flow/worktrees'
  };
  pricing: {
    // per 1M tokens, used for cost calc
    [model: string]: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreate: number;
    };
  };
}

interface ProjectSummary {
  name: string;
  path: string;
  status: "empty" | "uninitialized" | "ready" | "running" | "error";
  numTasks: number;
  lastOpenedAt: string;
}
```

---

## 5. Task state machine

`status` is where a task sits in the scheduler. `stage` is how far the agent
pipeline has progressed. Stage progression on the happy path:

```
spec → exec → exec_ui_check → code_review → code_review_ui_check
     → documentation → done → merged
```

`documentation` is skipped if `config.hasDocs === false`. `merged` happens
after a commit succeeds in the worktree; conflicts trigger a
`merge-resolve` session before retrying the merge.

Transitions:

```
pending        -- deps met              --> ready
ready          -- scheduler picks       --> running (stage=spec)
running        -- stage succeeds        --> running (next stage)
running        -- pipeline done         --> merged
running        -- error, retries left   --> running (same stage, retries++)
running        -- retries exhausted     --> paused
running        -- agent signals block   --> blocked
paused/blocked -- user retry            --> running (same stage, retries=0)
```

---

## 6. Core library API

Single exported `Flow` object, used by both CLI and WS server.

```ts
interface Flow {
  // lifecycle
  init(projectPath: string): Promise<void>;
  loadProject(projectPath: string): Promise<Project>;

  // tasks
  getTasks(): TaskRuntime[];
  getNextTask(): TaskRuntime | null; // oldest ready task
  getReadyTasks(): TaskRuntime[];
  buildDag(): Dag; // re-parses tasks.json, idempotent

  // execution
  runOnce(): Promise<TaskRuntime | null>;
  runAllOnce(opts?: { limit?: number }): Promise<TaskRuntime[]>;
  runAll(opts?: { limit?: number }): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;

  // watching
  watch(): void; // plan.md watcher + self-healing loop
  on<K extends keyof Events>(ev: K, cb: (e: Events[K]) => void): () => void;
}
```

The only function that talks to an agent:

```ts
function spawnAgent(args: {
  taskId: string | null;
  stage: Session["stage"];
  skillName: string;
  model?: string;
  thinkingMode?: ThinkingMode;
  extraPrompt?: string;
  worktreePath: string;
  parentSessionId?: string;
}): Promise<Session>;
```

Adding Codex/Gemini later means adding a provider adapter behind this
signature — no other code changes.

---

## 7. CLI

```
flow init                        scaffold .flow/ in cwd, git init if needed
flow status                      table of tasks, stages, active sessions
flow dag                         print DAG as ascii
flow run-once                    execute one ready task end-to-end
flow run-all-once [--limit N]    execute all currently-ready tasks
flow run-all [--limit N]         drain queue continuously
flow retry <taskId>              resume a paused/blocked task
flow cancel <taskId>             cancel a running task
flow serve [--port 7777]         start WebSocket server for the UI
flow logs <taskId> [--stage X]   tail formatted session events
flow config get|set <key> [v]
```

The CLI subscribes to the same event stream the WS server emits and renders
with `chalk` / `ora`. One renderer, two transports.

---

## 8. Agent spawning (Claude Code v1)

Claude Code runs as a subprocess:

```ts
execa(
  "claude",
  [
    "-p",
    composedPrompt,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(sessionId ? ["--session-id", sessionId] : []),
  ],
  { cwd: worktreePath },
);
```

`--output-format=stream-json` gives one JSON object per line for every
system, assistant, tool, and usage event. We append each line to
`.flow/tasks/<taskId>/sessions/<sessionId>.jsonl` and relay to subscribers
as `session.event` messages.

**Prompt composition:**

```
<body of .flow/skills/<stage>/SKILL.md>

# Task
Title: <title>
Description: <description>

# Context files
- path/to/file1
- path/to/file2

# Prior session summaries
<summary.md excerpts from earlier stages of this task>
```

After process exit: one short follow-up call with `--session-id` and
`/context` to read context %. Tokens come from the final `usage` event.
Cost = `sum(tokens * rate)` using `config.pricing[model]`.

Autocompact detection: if any event in the stream has a
`system.subtype === 'compact_boundary'` (or equivalent), set
`session.autocompacted = true`. The UI shows an asterisk next to the donut.

---

## 9. Git worktree strategy

- `flow init` requires a git repo. If absent, `git init` + initial commit
  containing the `.flow/` scaffolding. If `config.git.remote` is set later,
  we add the remote and push.
- Per task: `git worktree add <worktreeRoot>/<taskId> -b flow/<taskId>` from
  `mainBranch`. All stages run inside that worktree.
- On `done`: commit inside the worktree (see §13).
- On merge: `git checkout main && git merge --no-ff flow/<taskId>` in the
  main checkout. On conflict, spawn a `merge-resolve` session pointed at the
  worktree with the conflict files in `contextFiles`. Retry the merge once
  resolved.
- After successful merge: `git worktree remove` the task's worktree,
  task.status → `merged`.
- New tasks added mid-run always become DAG leaves (enforced by the
  `get-tasks` skill contract); existing worktrees are never rebased.

---

## 10. Orchestration loop

Pseudocode for `runAll`:

```ts
while (!cancelled) {
  reconcileDag(); // re-read tasks.json if changed
  const ready = getReadyTasks();
  const slots =
    (maxConcurrent === "off" ? Infinity : maxConcurrent) - runningCount();
  for (const task of ready.slice(0, slots)) {
    runTask(task); // fire-and-forget, emits events
  }
  if (ready.length === 0 && runningCount() === 0) break;
  await nextEvent(); // wake on task done / fail / dag change
}
```

`runTask` walks the stage list, calling `spawnAgent` per stage, writing state
atomically (`state.json.tmp` → rename) between stages, and emitting events
to subscribers.

---

## 11. Setup / init flow

**`flow init`** on an empty directory:

1. Create `.flow/`, copy default skills from the package.
2. `git init` if missing, create initial commit.
3. Write `config.json` with defaults.

**Opening a project** resolves status:

- No `plan.md` → `empty`. Chokidar watches for it.
- `plan.md` exists but no `.flow/` → `uninitialized`; caller runs `flow init`.
- `plan.md` + `.flow/` but no `tasks.json` → run **setup** session (MCP
  discovery + docs fetch), then **get-tasks** session to produce `tasks.json`,
  then `buildDag()`.
- Everything in place → `ready`.

Setup and get-tasks are project-level sessions (no `taskId`) stored in
`.flow/sessions/`. The UI renders them as a synthetic "Project Setup" row.

---

## 12. Error handling & retries

Every stage runs inside a try/catch. On failure we capture:

- Stage name, task id, session id, exit code
- stderr tail (last ~40 lines)
- Last ~200 lines of the session JSONL

These become `task.lastError` plus a `notification` with
`severity: 'error'` and the full context in `body`. If
`retries < config.retryCount`, we re-spawn the same stage with an addendum
in the prompt summarising what went wrong. Otherwise `status = paused`.

An agent can explicitly request human help by writing a line of the form
`FLOW_BLOCKED: <reason>` to its output. The orchestrator matches this,
terminates the session, sets `status = blocked`, and emits a notification.

Error notifications are deliberately verbose — full stage, task id, session
id, exit code, and log tail — so the user doesn't need to dig.

---

## 13. Commit conventions

On `done`, a final micro-session uses the `commit` skill to produce:

```
<short one-liner describing the feature>

- <plain-English bullet describing change 1>
- <plain-English bullet describing change 2>
- ...
```

The session reads the task's `summary.md` and emits the commit message,
which the orchestrator then uses to run `git commit` inside the worktree.

---

## 14. WebSocket protocol — the frontend contract

Server listens on `ws://localhost:7777` (configurable). One JSON message
per frame, both directions. All timestamps are ISO-8601 UTC.

### Client → Server

```ts
type ClientCommand =
  | { type: "project.list" }
  | { type: "project.open"; path: string }
  | { type: "project.create"; name: string; parentDir: string }
  | { type: "project.close" }
  | { type: "run.once" }
  | { type: "run.allOnce"; limit?: number }
  | { type: "run.all"; limit?: number }
  | { type: "run.cancel" }
  | { type: "task.retry"; taskId: string }
  | { type: "task.cancel"; taskId: string }
  | { type: "task.resume"; taskId: string }
  | { type: "session.replay"; sessionId: string } // re-stream JSONL from disk
  | { type: "notification.ack"; id: string }
  | { type: "config.get" }
  | { type: "config.update"; patch: Partial<Config> };
```

Commands may carry an optional `requestId`; the server echoes it on the
matching response or on `error`.

### Server → Client

```ts
type ServerEvent =
  | { type: "hello"; version: string; project?: Project }
  | { type: "project.list"; projects: ProjectSummary[] }
  | { type: "project.state"; project: Project }
  | { type: "task.upsert"; task: TaskRuntime }
  | { type: "task.removed"; taskId: string }
  | { type: "dag"; nodes: string[]; edges: [string, string][] }
  | { type: "session.started"; session: Session }
  | { type: "session.updated"; session: Session } // tokens / context % / status
  | { type: "session.event"; event: SessionEvent } // one JSONL line
  | { type: "session.ended"; session: Session }
  | { type: "notification"; notification: Notification }
  | { type: "learning"; taskId: string; path: string; markdown: string }
  | { type: "suggestion"; taskId: string; path: string; markdown: string }
  | { type: "config"; config: Config }
  | { type: "error"; requestId?: string; message: string };
```

### Connection protocol

- On connect: server sends `hello`, then `project.state` if one is open.
- All events are broadcast to all connected clients. No per-topic
  subscription in v1.
- On reconnect, the client asks for `project.state` to resync and uses
  `session.replay` for any session it wants to re-hydrate from disk.

### Sample payloads

**`project.state`**

```json
{
  "type": "project.state",
  "project": {
    "name": "munch-metrics",
    "path": "/Users/nico/code/munch-metrics",
    "status": "ready",
    "config": {
      "maxConcurrent": 3,
      "retryCount": 0,
      "hasDocs": true,
      "defaults": { "model": "claude-sonnet-4-5", "thinkingMode": "think" },
      "git": { "mainBranch": "main", "worktreeRoot": ".flow/worktrees" }
    },
    "tasks": [
      {
        "id": "01JAX8K9Z1",
        "title": "Add nutrition comparison chart",
        "description": "Build a bar-chart component that compares macros between two selected foods...",
        "contextFiles": ["src/components/FoodCard.tsx", "src/lib/nutrition.ts"],
        "requires": [],
        "status": "running",
        "stage": "exec",
        "retries": 0,
        "worktreePath": ".flow/worktrees/01JAX8K9Z1",
        "branchName": "flow/01JAX8K9Z1",
        "currentSessionId": "01JAX8MN4P",
        "sessionIds": ["01JAX8KQ2V", "01JAX8MN4P"],
        "createdAt": "2026-04-23T14:02:11Z",
        "updatedAt": "2026-04-23T14:08:22Z",
        "startedAt": "2026-04-23T14:03:00Z"
      }
    ],
    "dag": {
      "nodes": ["01JAX8K9Z1", "01JAX8KAR2"],
      "edges": [["01JAX8K9Z1", "01JAX8KAR2"]]
    }
  }
}
```

**`session.started`**

```json
{
  "type": "session.started",
  "session": {
    "id": "01JAX8MN4P",
    "taskId": "01JAX8K9Z1",
    "stage": "exec",
    "provider": "claude-code",
    "model": "claude-sonnet-4-5",
    "thinkingMode": "think",
    "skillName": "exec",
    "prompt": "<composed prompt, truncated at 2KB for transport>",
    "status": "running",
    "startedAt": "2026-04-23T14:05:00Z",
    "tokens": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheCreate": 0,
      "total": 0
    },
    "autocompacted": false,
    "costUsd": 0
  }
}
```

**`session.event`** (one per JSONL line; `payload` passed through untouched
so the UI can render tool calls / thinking blocks the same way Claude Code
does natively)

```json
{
  "type": "session.event",
  "event": {
    "sessionId": "01JAX8MN4P",
    "ts": "2026-04-23T14:05:03.412Z",
    "kind": "tool_use",
    "payload": {
      "id": "toolu_01Abc",
      "name": "Edit",
      "input": {
        "file_path": "src/components/NutritionChart.tsx",
        "old_string": "...",
        "new_string": "..."
      }
    }
  }
}
```

**`session.updated`** (periodic — usage + context %)

```json
{
  "type": "session.updated",
  "session": {
    "id": "01JAX8MN4P",
    "status": "running",
    "tokens": {
      "input": 42311,
      "output": 5120,
      "cacheRead": 180230,
      "cacheCreate": 12400,
      "total": 240061
    },
    "contextPercentage": 38,
    "autocompacted": false,
    "costUsd": 0.47
  }
}
```

**`session.ended`**

```json
{
  "type": "session.ended",
  "session": {
    "id": "01JAX8MN4P",
    "status": "succeeded",
    "endedAt": "2026-04-23T14:11:42Z",
    "tokens": {
      "input": 58240,
      "output": 9811,
      "cacheRead": 412000,
      "cacheCreate": 18200,
      "total": 498251
    },
    "contextPercentage": 62,
    "autocompacted": false,
    "costUsd": 1.08,
    "exitCode": 0
  }
}
```

**`notification`** (blocking)

```json
{
  "type": "notification",
  "notification": {
    "id": "01JAX8QZ90",
    "taskId": "01JAX8K9Z1",
    "sessionId": "01JAX8MN4P",
    "severity": "blocked",
    "title": "Task 01JAX8K9Z1 blocked at code_review",
    "body": "Agent reported: supabase credentials missing in .env.\n\nSession log tail:\n---\n...",
    "createdAt": "2026-04-23T14:12:05Z",
    "acknowledged": false
  }
}
```

**`learning`**

```json
{
  "type": "learning",
  "taskId": "01JAX8K9Z1",
  "path": ".flow/learnings/01JAX8K9Z1.md",
  "markdown": "## Cache invalidation on macro edits\nInitial approach using SWR mutate() left stale state..."
}
```

### Roll-ups

The frontend computes donut charts and token/cost rows client-side from the
session list. The backend sends raw per-session numbers and never sums
across sessions. Per the requirement, context % is not summed across
subagent sessions. Cost may be summed per task by the UI as needed.

Per-task aggregation = sum over `task.sessionIds` of the corresponding
`session.tokens` / `session.costUsd`. Per-session numbers are the source of
truth; aggregates are derived.

---

## 15. CLI formatting

The CLI subscribes to the same `ServerEvent` stream the library emits and
renders:

- `task.upsert` → update a status line for that task
- `session.event` → tool uses as `⏺ Edit src/foo.ts`, assistant text wrapped
  at terminal width, thinking dimmed
- `session.ended` → compact summary: stage, duration, tokens, cost, context %
- `notification` → red block with log tail, persists until acknowledged

---

## 16. Open decisions & assumptions

I took the following calls to keep moving. Flag anything you want different:

1. **Storage is file-based JSON / JSONL.** No SQLite, no embedded DB. Atomic
   writes via tmp+rename. Full state reconstructible from disk.
2. **Claude Code invoked as a subprocess** with
   `--output-format=stream-json --include-partial-messages`, not via a Node
   SDK. Lowest friction, matches how Claude Code's own UIs consume its output.
3. **Context % is probed post-run** by a short `/context` call reusing
   `--session-id`. If that proves expensive, fallback is to infer from
   cumulative tokens against the model's known window.
4. **Cost** is computed from `config.pricing[model]` so we don't bake
   prices into code.
5. **`plan.md` is the sole user-authored input.** `tasks.json` is always
   produced by the `get-tasks` agent. Hand edits to `tasks.json` are respected
   once present.
6. **Merge conflicts are agent-resolved** via a dedicated `merge-resolve`
   stage between `documentation` and `merged`. If you'd rather
   fail-and-notify on conflict, it's a one-line change.
7. **No per-topic WS subscriptions in v1** — every connected client gets
   every event. Trivial to add channels later if UI ends up filtering hard.
8. **Setup and get-tasks sessions live at project level** (no `taskId`),
   stored under `.flow/sessions/`. Frontend shows them as a "Project" row
   above the task rows.
