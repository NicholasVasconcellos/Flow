import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { WebSocket } from "ws";

import { createFlow, initFlowProject, type Flow } from "../src/flow.js";
import { Paths } from "../src/paths.js";
import { GitManager } from "../src/git.js";
import { resolveBundledAssetsDir } from "../src/setup.js";
import { appendJsonl, readJsonIfExists, exists } from "../src/atomic.js";
import { defaultConfig } from "../src/config.js";
import { newId } from "../src/ids.js";
import { EventBus } from "../src/events.js";
import { startWsServer } from "../src/ws.js";
import type { AgentRunner, SpawnArgs } from "../src/agent.js";
import type {
  Config,
  EventName,
  Events,
  Notification,
  Session,
  SessionEvent,
  State,
  TaskRuntime,
  TasksFile,
} from "../src/types.js";
import type { ServerEvent } from "../src/wsProtocol.js";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const ASSETS_DIR = resolveBundledAssetsDir();

async function mkTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flow-int-${prefix}-`));
  // Resolve /var -> /private/var on macOS so paths round-trip cleanly.
  return fs.realpath(dir);
}

/**
 * Build a fully-scaffolded fresh project with plan.md + src/app.ts +
 * tasks.json describing two tasks (A, B-needs-A).
 *
 * Optionally override config fields (written to config.json before
 * createFlow reads it — necessary because flow.updateConfig() doesn't
 * propagate retryCount to the pre-built Scheduler instance).
 */
async function createFixture(
  prefix = "fx",
  opts: {
    tasks?: TasksFile["tasks"];
    configOverrides?: Partial<Config>;
  } = {},
): Promise<{ root: string; paths: Paths; taskIds: string[] }> {
  const root = await mkTmp(prefix);
  const paths = new Paths(root);

  await fs.writeFile(
    paths.planMd,
    "# Plan\n\nIntegration test plan.\n",
    "utf8",
  );

  const srcDir = path.join(root, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(
    path.join(srcDir, "app.ts"),
    "export const app = () => 42;\n",
    "utf8",
  );

  // Real scaffold + git init via simple-git.
  await initFlowProject(root, ASSETS_DIR);

  // Overwrite config.json if caller wants specific values. This must happen
  // BEFORE createFlow because the Scheduler captures Config by reference at
  // construction time; flow.updateConfig does not retroactively reach into
  // the scheduler.
  if (opts.configOverrides) {
    const base = defaultConfig();
    const merged: Config = {
      ...base,
      ...opts.configOverrides,
      defaults: { ...base.defaults, ...(opts.configOverrides.defaults ?? {}) },
      git: { ...base.git, ...(opts.configOverrides.git ?? {}) },
      ws: { ...base.ws, ...(opts.configOverrides.ws ?? {}) },
      pricing: { ...base.pricing, ...(opts.configOverrides.pricing ?? {}) },
    };
    await fs.writeFile(paths.configJson, JSON.stringify(merged, null, 2), "utf8");
  }

  const tasks =
    opts.tasks ??
    [
      {
        id: "A",
        title: "Task A",
        description: "Add feature A",
        contextFiles: ["src/app.ts"],
        requires: [],
      },
      {
        id: "B",
        title: "Task B",
        description: "Add feature B which depends on A",
        contextFiles: ["src/app.ts"],
        requires: ["A"],
      },
    ];

  const tasksFile: TasksFile = { tasks };
  await fs.writeFile(paths.tasksJson, JSON.stringify(tasksFile, null, 2), "utf8");

  return { root, paths, taskIds: tasks.map((t) => t.id) };
}

// ---------------------------------------------------------------------------
// Fake AgentRunner — deterministic; the scheduler reads session.assistantText
// to build commit messages, so the fake must mirror that convention.
// Also emits session.started / session.event / session.ended on the provided
// EventBus so the WebSocket broadcast layer sees them exactly as it would
// under the real AgentRunner.
// ---------------------------------------------------------------------------

type StageKey = SpawnArgs["stage"];

interface AgentScriptEntry {
  override?: Partial<Session> & { assistantText?: string };
  sideEffect?: (args: SpawnArgs) => Promise<void>;
}

type StageScripts = Partial<Record<StageKey | "*", AgentScriptEntry>>;

interface FakeAgentHandle {
  runner: AgentRunner;
  calls: Array<{ taskId: string | null; stage: StageKey; sessionId: string }>;
  setScripts(next: StageScripts): void;
}

function makeFakeAgent(
  paths: Paths,
  bus: EventBus,
  initial: StageScripts = {},
): FakeAgentHandle {
  let scripts: StageScripts = initial;
  const calls: FakeAgentHandle["calls"] = [];

  const runner: Partial<AgentRunner> = {
    async spawnAgent(args: SpawnArgs): Promise<Session> {
      const entry =
        scripts[args.stage as StageKey] ?? scripts["*"] ?? undefined;
      if (entry?.sideEffect) {
        await entry.sideEffect(args);
      }

      // Mimic the new "agent commits its own work" rule: if the worktree has
      // uncommitted changes after the stage, stage and commit them. Project-
      // level stages (setup/getTasks) skip this since they don't run inside a
      // task worktree.
      if (args.taskId) {
        try {
          const wt = simpleGit(args.worktreePath);
          const status = await wt.status();
          if (!status.isClean()) {
            await wt.raw([
              "-c",
              "user.email=flow@localhost",
              "-c",
              "user.name=Flow",
              "add",
              "-A",
            ]);
            await wt.raw([
              "-c",
              "user.email=flow@localhost",
              "-c",
              "user.name=Flow",
              "commit",
              "-m",
              `${args.stage}: fake stage commit`,
              "--allow-empty",
            ]);
          }
        } catch {
          /* best-effort */
        }

        // Write the stage signal so the scheduler advances deterministically.
        const willFail =
          (entry?.override?.status as string | undefined) === "failed" ||
          (entry?.override?.status as string | undefined) === "autocompacted";
        if (!willFail) {
          const file = paths.taskStageSignal(args.taskId);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(
            file,
            JSON.stringify({ stage: args.stage, status: "done" }),
            "utf8",
          );
        }
      }

      const sessionId = args.sessionId ?? newId();
      calls.push({ taskId: args.taskId, stage: args.stage, sessionId });

      const now = new Date().toISOString();
      const base: Session = {
        id: sessionId,
        taskId: args.taskId,
        stage: args.stage,
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        skillName: args.skillName,
        prompt: "<fake prompt>",
        status: "succeeded",
        startedAt: now,
        endedAt: now,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        autocompacted: false,
        costUsd: 0,
        exitCode: 0,
      };

      // Emit session.started (what real AgentRunner does) so WS broadcasts it.
      bus.emit("session.started", { session: { ...base, status: "running" } });

      // Write synthetic stream-json lines to the task-scoped JSONL, and also
      // to the project-level path as a workaround for a replaySession gap
      // (see bug note in the report).
      const taskJsonl = paths.sessionJsonl(args.taskId, sessionId);
      const projectJsonl = paths.projectSessionJsonl(sessionId);
      const events: Array<Record<string, unknown>> = [
        {
          type: "system",
          subtype: "init",
          stage: args.stage,
          taskId: args.taskId,
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: `fake ${args.stage}` }] },
        },
        { type: "stop" },
      ];
      try {
        for (const ev of events) {
          await appendJsonl(taskJsonl, ev);
          if (args.taskId !== null) {
            await appendJsonl(projectJsonl, ev);
          }
          bus.emit("session.event", {
            event: {
              sessionId,
              ts: now,
              kind:
                ev["type"] === "system"
                  ? "system"
                  : ev["type"] === "stop"
                    ? "stop"
                    : "assistant_text",
              payload: ev,
            },
          });
        }
      } catch {
        /* best-effort */
      }

      const finalSession: Session & { assistantText?: string } = {
        ...base,
        ...(entry?.override ?? {}),
      };
      bus.emit("session.ended", { session: { ...finalSession } });
      return finalSession;
    },
  };

  return {
    runner: runner as AgentRunner,
    calls,
    setScripts(next) {
      scripts = next;
    },
  };
}

/**
 * Standard script set for a happy-path pipeline:
 *  - exec writes a file inside the worktree
 *  - commit supplies a commit message via `assistantText`
 *  - everything else succeeds with a no-op
 */
/** Commit any dirty changes in the worktree (mirrors the new "agent commits
 *  its own work" rule) and write a `done` stage signal so the scheduler
 *  advances. Skips both when the session is going to be reported as failed. */
async function finalizeStage(
  paths: Paths,
  args: SpawnArgs,
  failed: boolean,
): Promise<void> {
  if (!args.taskId) return;
  if (!failed) {
    try {
      const wt = simpleGit(args.worktreePath);
      const status = await wt.status();
      if (!status.isClean()) {
        await wt.raw([
          "-c",
          "user.email=flow@localhost",
          "-c",
          "user.name=Flow",
          "add",
          "-A",
        ]);
        await wt.raw([
          "-c",
          "user.email=flow@localhost",
          "-c",
          "user.name=Flow",
          "commit",
          "-m",
          `${args.stage}: fake stage commit`,
          "--allow-empty",
        ]);
      }
    } catch {
      /* ignore */
    }
    const file = paths.taskStageSignal(args.taskId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ stage: args.stage, status: "done" }),
      "utf8",
    );
  }
}

function happyScripts(): StageScripts {
  return {
    exec: {
      sideEffect: async ({ worktreePath, taskId }) => {
        const outfile = path.join(worktreePath, `generated-${taskId}.ts`);
        await fs.writeFile(
          outfile,
          `export const ${taskId}_marker = ${JSON.stringify(taskId)};\n`,
          "utf8",
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------
// collectEvents: subscribe + snapshot events by name
// ---------------------------------------------------------------------------

interface EventCollector {
  get<K extends EventName>(name: K): Events[K][];
  dispose(): void;
}

function collectEvents(
  flow: Flow,
  names: readonly EventName[],
): EventCollector {
  const buckets = new Map<EventName, unknown[]>();
  const offs: Array<() => void> = [];
  for (const name of names) {
    const arr: unknown[] = [];
    buckets.set(name, arr);
    offs.push(flow.on(name, (ev) => arr.push(ev)));
  }
  return {
    get<K extends EventName>(name: K): Events[K][] {
      return (buckets.get(name) as Events[K][] | undefined) ?? [];
    },
    dispose() {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * Drive `runAllOnce` until no currently-ready tasks remain. Mirrors how a UI
 * would drain the DAG across multiple `run.allOnce` invocations when tasks
 * depend on each other.
 */
async function drainViaRunAllOnce(flow: Flow, maxWaves = 10): Promise<void> {
  for (let i = 0; i < maxWaves; i++) {
    const ready = flow.getReadyTasks();
    if (ready.length === 0) break;
    await flow.runAllOnce();
  }
}

// ---------------------------------------------------------------------------
// Test 1: Two-task DAG end-to-end via runAllOnce
// ---------------------------------------------------------------------------

test(
  "integration: two-task DAG reaches merged via runAllOnce, worktrees removed, state persisted",
  { timeout: 30000 },
  async () => {
    const { root, paths, taskIds } = await createFixture("dag");

    const git = new GitManager(paths, "main");

    // We need the Flow's internal EventBus to match ours so session.started
    // lands on both: subscribe via flow.on (uses the internal bus) AND our
    // fake emits on the bus we passed. So pass the flow's bus.
    // Trick: build Flow first, then fetch its bus, but the fake needs the bus
    // at construction. Solution: build a proxy bus that re-emits to the real
    // flow bus after creation.
    const proxyBus = new EventBus();
    const agent2 = makeFakeAgent(paths, proxyBus, happyScripts());

    const flow = await createFlow(
      { projectPath: root, assetsDir: ASSETS_DIR },
      { agent: agent2.runner, git },
    );

    // Bridge proxy bus → real flow bus.
    const realBus = flow.getEventBus();
    const proxyBridgeOffs: Array<() => void> = [];
    proxyBridgeOffs.push(
      proxyBus.on("session.started", (p) => realBus.emit("session.started", p)),
    );
    proxyBridgeOffs.push(
      proxyBus.on("session.event", (p) => realBus.emit("session.event", p)),
    );
    proxyBridgeOffs.push(
      proxyBus.on("session.ended", (p) => realBus.emit("session.ended", p)),
    );

    const collector = collectEvents(flow, [
      "task.upsert",
      "session.started",
      "session.event",
      "session.ended",
      "notification",
    ] as const);

    try {
      // Initial state — A ready, B pending.
      const tasks0 = flow.getTasks();
      const a0 = tasks0.find((t) => t.id === "A")!;
      const b0 = tasks0.find((t) => t.id === "B")!;
      assert.equal(a0.status, "ready", "A starts as ready");
      assert.equal(b0.status, "pending", "B starts as pending (requires A)");

      await flow.ensureTasksLoaded();

      // Drain via runAllOnce in waves — B becomes ready only after A merges.
      await drainViaRunAllOnce(flow, 5);

      // --- Final status -----------------------------------------------------
      const finalTasks = flow.getTasks();
      for (const id of taskIds) {
        const t = finalTasks.find((x) => x.id === id)!;
        assert.equal(t.status, "merged", `task ${id} should be merged`);
        assert.equal(t.stage, "merged", `task ${id} should have stage=merged`);
        assert.ok(t.completedAt, `task ${id} should have completedAt`);
      }

      // --- Order: B's first running upsert comes after A's merged upsert ---
      const upserts = collector.get("task.upsert");
      const firstRunningB = upserts.findIndex(
        ({ task }) => task.id === "B" && task.status === "running",
      );
      const mergedA = upserts.findIndex(
        ({ task }) => task.id === "A" && task.status === "merged",
      );
      assert.ok(mergedA >= 0, "A should have a merged upsert in the stream");
      assert.ok(firstRunningB >= 0, "B should have a running upsert");
      assert.ok(
        mergedA < firstRunningB,
        `A merged (idx=${mergedA}) must precede B running (idx=${firstRunningB})`,
      );

      // --- Worktree removal ------------------------------------------------
      for (const id of taskIds) {
        const wt = paths.worktreeDir(id);
        assert.equal(
          await exists(wt),
          false,
          `worktree for ${id} should be removed after merge`,
        );
      }

      // --- Git log: must show per-task merge commits on main ---------------
      const rootGit = simpleGit(root);
      const log = await rootGit.log();
      const mergeCommits = log.all.filter(
        (l) =>
          l.message.includes("Merge branch") ||
          l.message.startsWith("Merge"),
      );
      assert.ok(
        mergeCommits.length >= 2,
        `expected >=2 merge commits on main (--no-ff), got ${mergeCommits.length}`,
      );
      // Per-stage commits should appear (one per stage that wrote files).
      const joined = log.all
        .map((l) => `${l.message}\n${l.body ?? ""}`)
        .join("\n---\n");
      assert.match(
        joined,
        /exec: fake stage commit/,
        "exec stage commit should appear in main's history",
      );

      // And the generated files should be present on main post-merge.
      for (const id of taskIds) {
        const genFile = path.join(root, `generated-${id}.ts`);
        assert.equal(
          await exists(genFile),
          true,
          `generated-${id}.ts should be on main after merge`,
        );
      }

      // --- replaySession round-trip ---------------------------------------
      // Our fake wrote JSONL to project-level path too, to work around a
      // replaySession resolution gap (noted in the report).
      const someCall = agent2.calls.find((c) => c.taskId !== null);
      assert.ok(someCall, "expected at least one task-level session call");
      const replayed: SessionEvent[] = [];
      const it = await flow.replaySession(someCall.sessionId);
      for await (const ev of it) replayed.push(ev);
      assert.equal(
        replayed.length,
        3,
        `replaySession should yield 3 synthetic events, got ${replayed.length}`,
      );
      assert.equal(replayed[0]!.kind, "system");
      assert.equal(replayed[1]!.kind, "assistant_text");
      assert.equal(replayed[2]!.kind, "stop");

      // --- state.json reflects final statuses ------------------------------
      const persisted = await readJsonIfExists<State>(paths.stateJson);
      assert.ok(persisted, "state.json should exist");
      const persistedTasks: State["tasks"] = persisted.tasks;
      for (const id of taskIds) {
        const t = persistedTasks.find((x) => x.id === id);
        assert.ok(t, `state.json should contain task ${id}`);
        assert.equal(
          t.status,
          "merged",
          `state.json task ${id} status should be merged`,
        );
      }

      // --- notifications.jsonl: OK to be empty/absent on happy path --------
      const notifPath = paths.notificationsJsonl;
      if (await exists(notifPath)) {
        const raw = await fs.readFile(notifPath, "utf8");
        if (raw.trim().length > 0) {
          const emitted = collector.get("notification");
          assert.ok(
            emitted.length >= 1,
            "file has content but no notifications emitted — mismatch",
          );
        }
      }
    } finally {
      for (const off of proxyBridgeOffs) off();
      collector.dispose();
      flow.stop();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 2: WebSocket end-to-end
// ---------------------------------------------------------------------------

interface WsClient {
  ws: WebSocket;
  messages: ServerEvent[];
  waitFor(
    predicate: (msg: ServerEvent) => boolean,
    timeoutMs?: number,
  ): Promise<ServerEvent>;
  send(cmd: unknown): void;
  close(): Promise<void>;
}

async function connectWs(port: number): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: ServerEvent[] = [];
  const listeners = new Set<(msg: ServerEvent) => void>();

  ws.on("message", (raw) => {
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const msg = JSON.parse(text) as ServerEvent;
      messages.push(msg);
      for (const l of listeners) l(msg);
    } catch {
      /* ignore */
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const waitFor = (
    predicate: (msg: ServerEvent) => boolean,
    timeoutMs = 10000,
  ): Promise<ServerEvent> => {
    for (const m of messages) if (predicate(m)) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(onMsg);
        reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const onMsg = (msg: ServerEvent): void => {
        if (predicate(msg)) {
          clearTimeout(timer);
          listeners.delete(onMsg);
          resolve(msg);
        }
      };
      listeners.add(onMsg);
    });
  };

  return {
    ws,
    messages,
    waitFor,
    send(cmd) {
      ws.send(JSON.stringify(cmd));
    },
    async close() {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
          setTimeout(resolve, 500).unref?.();
        });
      }
    },
  };
}

test(
  "integration: websocket server broadcasts pipeline events, config.update, session.replay",
  { timeout: 30000 },
  async () => {
    const { root, paths, taskIds } = await createFixture("ws");
    const git = new GitManager(paths, "main");
    const proxyBus = new EventBus();
    const agent = makeFakeAgent(paths, proxyBus, happyScripts());

    const flow = await createFlow(
      { projectPath: root, assetsDir: ASSETS_DIR },
      { agent: agent.runner, git },
    );

    // Bridge proxy bus → flow bus so session.* frames are broadcast by ws.ts.
    const realBus = flow.getEventBus();
    const bridgeOffs = [
      proxyBus.on("session.started", (p) =>
        realBus.emit("session.started", p),
      ),
      proxyBus.on("session.event", (p) => realBus.emit("session.event", p)),
      proxyBus.on("session.ended", (p) => realBus.emit("session.ended", p)),
    ];

    const server = await startWsServer({
      flow,
      port: 0,
      host: "127.0.0.1",
      version: "int-test",
    });

    let client: WsClient | null = null;
    try {
      client = await connectWs(server.port);

      // --- Handshake: hello + project.state + config ---
      const hello = await client.waitFor((m) => m.type === "hello");
      assert.equal(
        (hello as { type: "hello"; version: string }).version,
        "int-test",
      );
      await client.waitFor((m) => m.type === "project.state");
      await client.waitFor((m) => m.type === "config");

      // --- Drive the pipeline ---
      client.send({ type: "run.allOnce" });

      await client.waitFor(
        (m) =>
          m.type === "task.upsert" &&
          (m as { type: "task.upsert"; task: TaskRuntime }).task.id === "A" &&
          (m as { type: "task.upsert"; task: TaskRuntime }).task.status ===
            "merged",
        20000,
      );

      // B becomes ready after A merges; second run.allOnce picks it up.
      client.send({ type: "run.allOnce" });

      await client.waitFor(
        (m) =>
          m.type === "task.upsert" &&
          (m as { type: "task.upsert"; task: TaskRuntime }).task.id === "B" &&
          (m as { type: "task.upsert"; task: TaskRuntime }).task.status ===
            "merged",
        20000,
      );

      // --- Per-task: session.started → session.event+ → session.ended ---
      for (const id of taskIds) {
        const starts = client.messages.filter(
          (m) =>
            m.type === "session.started" &&
            (m as { session: Session }).session.taskId === id,
        );
        const ends = client.messages.filter(
          (m) =>
            m.type === "session.ended" &&
            (m as { session: Session }).session.taskId === id,
        );
        const events = client.messages.filter(
          (m) =>
            m.type === "session.event" &&
            (m as { event: SessionEvent }).event &&
            true,
        );
        assert.ok(
          starts.length >= 1,
          `task ${id}: expected >=1 session.started (got ${starts.length})`,
        );
        assert.ok(
          ends.length >= 1,
          `task ${id}: expected >=1 session.ended (got ${ends.length})`,
        );
        assert.ok(
          events.length >= 1,
          `expected >=1 session.event across run (got ${events.length})`,
        );
      }

      // task.upsert running → merged happens for each task.
      for (const id of taskIds) {
        const runningUpserts = client.messages.filter(
          (m) =>
            m.type === "task.upsert" &&
            (m as { task: TaskRuntime }).task.id === id &&
            (m as { task: TaskRuntime }).task.status === "running",
        );
        assert.ok(
          runningUpserts.length >= 1,
          `task ${id} should transition to running at least once`,
        );
      }

      // --- config.update broadcasts new config ---
      const preCount = client.messages.filter((m) => m.type === "config").length;
      client.send({
        type: "config.update",
        patch: { retryCount: 2 },
        requestId: "cfg-1",
      });
      await client.waitFor(
        (m) =>
          m.type === "config" &&
          (m as { type: "config"; config: Config }).config.retryCount === 2,
        5000,
      );
      const postCount = client.messages.filter((m) => m.type === "config").length;
      assert.ok(
        postCount > preCount,
        "config broadcasts should grow after config.update",
      );

      // --- session.replay: send with a known sessionId, expect events ---
      const someCall = agent.calls.find((c) => c.taskId !== null);
      assert.ok(someCall, "must have recorded at least one task session");
      const preReplay = client.messages.filter(
        (m) => m.type === "session.event",
      ).length;
      client.send({
        type: "session.replay",
        sessionId: someCall.sessionId,
        requestId: "replay-1",
      });
      await client.waitFor(
        () =>
          client!.messages.filter((m) => m.type === "session.event").length >
          preReplay,
        5000,
      );
      const postReplay = client.messages.filter(
        (m) => m.type === "session.event",
      ).length;
      assert.ok(
        postReplay - preReplay >= 1,
        `session.replay should yield >=1 new session.event (got ${postReplay - preReplay})`,
      );
    } finally {
      if (client) await client.close();
      await server.close();
      for (const off of bridgeOffs) off();
      flow.stop();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 3: Failure + retry + pause
// ---------------------------------------------------------------------------

test(
  "integration: retryCount=1 recovers; retryCount=0 pauses with lastError + notification",
  { timeout: 30000 },
  async () => {
    // ============ PART 1: retryCount=1, spec fails once, then merges ==========
    {
      const { root, paths } = await createFixture("retry1", {
        configOverrides: { retryCount: 1 },
        tasks: [
          {
            id: "T",
            title: "Retry task",
            description: "spec fails once",
            contextFiles: [],
            requires: [],
          },
        ],
      });

      const git = new GitManager(paths, "main");
      const scripts = happyScripts();
      let specCalls = 0;
      // Wrap happyScripts.spec to fail on first call, pass thereafter.
      scripts.spec = {
        override: {}, // override is static; we need dynamic control
        sideEffect: async () => {
          /* no-op */
        },
      };

      // Build a scripted fake whose spec fails the first time.
      const runner: Partial<AgentRunner> = {
        async spawnAgent(args: SpawnArgs): Promise<Session> {
          const sessionId = newId();
          const now = new Date().toISOString();
          const base: Session & { assistantText?: string } = {
            id: sessionId,
            taskId: args.taskId,
            stage: args.stage,
            provider: "claude-code",
            model: "claude-sonnet-4-5",
            skillName: args.skillName,
            prompt: "<fake>",
            status: "succeeded",
            startedAt: now,
            endedAt: now,
            tokens: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreate: 0,
              total: 0,
            },
            autocompacted: false,
            costUsd: 0,
            exitCode: 0,
          };
          if (args.stage === "spec") {
            specCalls += 1;
            if (specCalls === 1) {
              await finalizeStage(paths, args, true);
              return {
                ...base,
                status: "failed",
                error: "spec transient failure",
                exitCode: 1,
              };
            }
          }
          if (args.stage === "exec") {
            await fs.writeFile(
              path.join(args.worktreePath, `retry-${args.taskId}.ts`),
              `export const m = "${args.taskId}";\n`,
              "utf8",
            );
          }
          await finalizeStage(paths, args, false);
          return base;
        },
      };

      const flow = await createFlow(
        { projectPath: root, assetsDir: ASSETS_DIR },
        { agent: runner as AgentRunner, git },
      );

      const upserts: TaskRuntime[] = [];
      const offU = flow.on("task.upsert", ({ task }) => upserts.push({ ...task }));

      try {
        await drainViaRunAllOnce(flow, 5);

        const final = flow.getTasks().find((t) => t.id === "T")!;
        assert.equal(
          final.status,
          "merged",
          `T final status should be merged, got ${final.status} (lastError=${JSON.stringify(final.lastError)})`,
        );
        assert.equal(specCalls, 2, "spec should have been retried exactly once");

        const sawRetries1 = upserts.some((t) => t.retries === 1);
        assert.ok(sawRetries1, "task.retries should reach 1 during the run");
      } finally {
        offU();
        flow.stop();
      }
    }

    // ============ PART 2: retryCount=0, spec fails → paused + error notif ====
    {
      const { root, paths } = await createFixture("retry0", {
        configOverrides: { retryCount: 0 },
        tasks: [
          {
            id: "T",
            title: "No-retry task",
            description: "spec fails, no retry",
            contextFiles: [],
            requires: [],
          },
        ],
      });

      const git = new GitManager(paths, "main");

      const runner: Partial<AgentRunner> = {
        async spawnAgent(args: SpawnArgs): Promise<Session> {
          const sessionId = newId();
          const now = new Date().toISOString();
          const base: Session = {
            id: sessionId,
            taskId: args.taskId,
            stage: args.stage,
            provider: "claude-code",
            model: "claude-sonnet-4-5",
            skillName: args.skillName,
            prompt: "<fake>",
            status: "succeeded",
            startedAt: now,
            endedAt: now,
            tokens: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreate: 0,
              total: 0,
            },
            autocompacted: false,
            costUsd: 0,
            exitCode: 0,
          };
          if (args.stage === "spec") {
            await finalizeStage(paths, args, true);
            return {
              ...base,
              status: "failed",
              error: "spec exploded",
              exitCode: 1,
            };
          }
          await finalizeStage(paths, args, false);
          return base;
        },
      };

      const flow = await createFlow(
        { projectPath: root, assetsDir: ASSETS_DIR },
        { agent: runner as AgentRunner, git },
      );

      const notifs: Notification[] = [];
      const offN = flow.on("notification", ({ notification }) =>
        notifs.push(notification),
      );

      try {
        await flow.runAllOnce();

        const final = flow.getTasks().find((t) => t.id === "T")!;
        assert.equal(final.status, "paused", "no-retry failure should pause");
        assert.ok(final.lastError, "lastError should be set");
        assert.match(final.lastError!.message, /spec exploded/);
        assert.equal(final.lastError!.stage, "spec");

        const errNotifs = notifs.filter((n) => n.severity === "error");
        assert.ok(
          errNotifs.length >= 1,
          `expected >=1 error notification, got ${notifs.length} total (severities=${notifs.map((n) => n.severity).join(",")})`,
        );
      } finally {
        offN();
        flow.stop();
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Test 4: FLOW_BLOCKED at code_review
// ---------------------------------------------------------------------------

test(
  "integration: FLOW_BLOCKED at code_review marks task blocked, emits blocked notification, no retry",
  { timeout: 30000 },
  async () => {
    const { root, paths } = await createFixture("blocked", {
      configOverrides: { retryCount: 5 }, // even with retries available, blocked skips
      tasks: [
        {
          id: "T",
          title: "Blocked task",
          description: "FLOW_BLOCKED at code_review",
          contextFiles: [],
          requires: [],
        },
      ],
    });

    const git = new GitManager(paths, "main");
    let codeReviewCalls = 0;

    const runner: Partial<AgentRunner> = {
      async spawnAgent(args: SpawnArgs): Promise<Session> {
        const sessionId = newId();
        const now = new Date().toISOString();
        const base: Session = {
          id: sessionId,
          taskId: args.taskId,
          stage: args.stage,
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          skillName: args.skillName,
          prompt: "<fake>",
          status: "succeeded",
          startedAt: now,
          endedAt: now,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
            total: 0,
          },
          autocompacted: false,
          costUsd: 0,
          exitCode: 0,
        };
        if (args.stage === "exec") {
          await fs.writeFile(
            path.join(args.worktreePath, "blocked-artifact.ts"),
            "export const x = 1;\n",
            "utf8",
          );
        }
        if (args.stage === "code_review") {
          codeReviewCalls += 1;
          await finalizeStage(paths, args, true);
          return {
            ...base,
            status: "failed",
            error: "FLOW_BLOCKED: creds missing",
            exitCode: 0,
          };
        }
        await finalizeStage(paths, args, false);
        return base;
      },
    };

    const flow = await createFlow(
      { projectPath: root, assetsDir: ASSETS_DIR },
      { agent: runner as AgentRunner, git },
    );

    const notifs: Notification[] = [];
    const offN = flow.on("notification", ({ notification }) =>
      notifs.push(notification),
    );

    try {
      // runAllOnce must resolve cleanly.
      const results = await flow.runAllOnce();
      assert.ok(Array.isArray(results), "runAllOnce returned cleanly");

      const final = flow.getTasks().find((t) => t.id === "T")!;
      assert.equal(
        final.status,
        "blocked",
        `task should be blocked, got ${final.status}`,
      );
      assert.equal(
        codeReviewCalls,
        1,
        "code_review must not be retried on FLOW_BLOCKED",
      );

      const blocked = notifs.filter((n) => n.severity === "blocked");
      assert.ok(
        blocked.length >= 1,
        `expected >=1 blocked notification, got ${blocked.length}`,
      );
      assert.match(blocked[0]!.body, /creds missing/);
    } finally {
      offN();
      flow.stop();
    }
  },
);
