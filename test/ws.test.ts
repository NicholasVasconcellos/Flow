import test from "node:test";
import assert from "node:assert/strict";

import { WebSocket } from "ws";

import { EventBus } from "../src/events.js";
import { startWsServer } from "../src/ws.js";
import type { Flow } from "../src/flow.js";
import type {
  Config,
  Dag,
  Notification,
  Project,
  Session,
  SessionEvent,
  TaskRuntime,
} from "../src/types.js";
import type { ServerEvent } from "../src/wsProtocol.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(): Config {
  return {
    maxConcurrent: 3,
    retryCount: 0,
    hasDocs: true,
    defaults: { model: "claude-sonnet-4-5" },
    git: { mainBranch: "main", worktreeRoot: ".flow/worktrees" },
    ws: { port: 7777 },
    pricing: {},
  };
}

function makeProject(config: Config): Project {
  const dag: Dag = { nodes: [], edges: [] };
  return {
    name: "test-project",
    path: "/tmp/test-project",
    status: "ready",
    config,
    tasks: [],
    dag,
  };
}

interface FakeFlowState {
  config: Config;
  project: Project;
  bus: EventBus;
  replayEvents: SessionEvent[];
  lastUpdatedPatch?: Partial<Config>;
  stopped: boolean;
  ackCalls: string[];
  runOnceCalls: number;
  runAllOnceCalls: Array<{ limit?: number } | undefined>;
  retryCalls: string[];
  cancelCalls: string[];
}

function makeFakeFlow(): { flow: Flow; ctx: FakeFlowState } {
  const bus = new EventBus();
  const config = makeConfig();
  const ctx: FakeFlowState = {
    config,
    project: makeProject(config),
    bus,
    replayEvents: [],
    stopped: false,
    ackCalls: [],
    runOnceCalls: 0,
    runAllOnceCalls: [],
    retryCalls: [],
    cancelCalls: [],
  };

  const flow: Flow = {
    async init() {
      /* no-op */
    },
    async loadProject() {
      return ctx.project;
    },
    getTasks() {
      return [];
    },
    getNextTask() {
      return null;
    },
    getReadyTasks() {
      return [];
    },
    buildDag() {
      return { nodes: [], edges: [] };
    },
    async runOnce() {
      ctx.runOnceCalls += 1;
      return null;
    },
    async runAllOnce(opts) {
      ctx.runAllOnceCalls.push(opts);
      return [];
    },
    async runAll() {
      /* no-op */
    },
    async retryTask(id) {
      ctx.retryCalls.push(id);
    },
    async cancelTask(id) {
      ctx.cancelCalls.push(id);
    },
    watch() {
      /* no-op */
    },
    on(ev, cb) {
      return bus.on(ev, cb);
    },
    getConfig() {
      return ctx.config;
    },
    async updateConfig(patch) {
      ctx.lastUpdatedPatch = patch;
      ctx.config = { ...ctx.config, ...patch } as Config;
      ctx.project = { ...ctx.project, config: ctx.config };
      bus.emit("config", { config: ctx.config });
      return ctx.config;
    },
    async ensureTasksLoaded() {
      /* no-op */
    },
    stop() {
      ctx.stopped = true;
    },
    getProject() {
      return ctx.project;
    },
    getEventBus() {
      return bus;
    },
    async replaySession(_sessionId) {
      const events = ctx.replayEvents;
      async function* iter(): AsyncIterable<SessionEvent> {
        for (const e of events) yield e;
      }
      return iter();
    },
    async listNotifications(): Promise<Notification[]> {
      return [];
    },
    async ackNotification(id) {
      ctx.ackCalls.push(id);
    },
  };

  return { flow, ctx };
}

interface OpenClient {
  ws: WebSocket;
  messages: ServerEvent[];
  waitFor(
    predicate: (msg: ServerEvent) => boolean,
    timeoutMs?: number,
  ): Promise<ServerEvent>;
  sendRaw(frame: string): void;
  send(cmd: unknown): void;
  close(): Promise<void>;
}

async function connect(port: number): Promise<OpenClient> {
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
    timeoutMs = 2000,
  ): Promise<ServerEvent> => {
    // Already received?
    for (const m of messages) {
      if (predicate(m)) return Promise.resolve(m);
    }
    return new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(onMsg);
        reject(new Error(`waitForMessage timeout after ${timeoutMs}ms`));
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
    sendRaw(frame) {
      ws.send(frame);
    },
    send(cmd) {
      ws.send(JSON.stringify(cmd));
    },
    async close() {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
          // safety timeout
          setTimeout(resolve, 500).unref?.();
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("on connect, client receives hello, project.state, config", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      const hello = await c.waitFor((m) => m.type === "hello");
      assert.equal((hello as { type: "hello"; version: string }).version, "0.1.0");

      const ps = await c.waitFor((m) => m.type === "project.state");
      assert.equal((ps as { type: "project.state"; project: Project }).project.name, "test-project");

      const cfg = await c.waitFor((m) => m.type === "config");
      assert.equal((cfg as { type: "config"; config: Config }).config.retryCount, 0);
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("config.get returns config", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config"); // initial
      const initialCount = c.messages.filter((m) => m.type === "config").length;
      c.send({ type: "config.get" });
      // Wait for a second `config` frame
      await c.waitFor(
        () => c.messages.filter((m) => m.type === "config").length > initialCount,
      );
      const cfgs = c.messages.filter((m) => m.type === "config");
      assert.ok(cfgs.length >= 2);
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("config.update broadcasts patched config", async () => {
  const { flow, ctx } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      const initialCount = c.messages.filter((m) => m.type === "config").length;
      c.send({ type: "config.update", patch: { retryCount: 2 } });
      await c.waitFor(
        () =>
          c.messages.filter(
            (m) =>
              m.type === "config" &&
              (m as { type: "config"; config: Config }).config.retryCount === 2,
          ).length > 0,
      );
      assert.equal(ctx.lastUpdatedPatch?.retryCount, 2);
      assert.equal(
        c.messages.filter((m) => m.type === "config").length > initialCount,
        true,
      );
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("bus task.upsert is broadcast to connected clients", async () => {
  const { flow, ctx } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");

      const now = new Date().toISOString();
      const task: TaskRuntime = {
        id: "T1",
        title: "Test",
        description: "",
        contextFiles: [],
        requires: [],
        status: "ready",
        stage: "spec",
        retries: 0,
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      ctx.bus.emit("task.upsert", { task });

      const received = await c.waitFor((m) => m.type === "task.upsert");
      assert.equal(
        (received as { type: "task.upsert"; task: TaskRuntime }).task.id,
        "T1",
      );
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("bad JSON returns error", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.sendRaw("{not valid json");
      const err = await c.waitFor((m) => m.type === "error");
      assert.equal(err.type, "error");
      assert.ok(typeof (err as { message: string }).message === "string");
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("invalid schema (unknown command type) returns error with requestId", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.send({ type: "does.not.exist", requestId: "req-1" });
      const err = await c.waitFor((m) => m.type === "error");
      assert.equal(
        (err as { type: "error"; requestId?: string }).requestId,
        "req-1",
      );
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("session.replay streams session.events from flow.replaySession", async () => {
  const { flow, ctx } = makeFakeFlow();
  const now = new Date().toISOString();
  ctx.replayEvents = [
    { sessionId: "S1", ts: now, kind: "system", payload: { a: 1 } },
    { sessionId: "S1", ts: now, kind: "assistant_text", payload: { a: 2 } },
    { sessionId: "S1", ts: now, kind: "stop", payload: { a: 3 } },
  ];

  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.send({ type: "session.replay", sessionId: "S1" });
      await c.waitFor(
        () =>
          c.messages.filter(
            (m) =>
              m.type === "session.event" &&
              (m as { event: SessionEvent }).event.kind === "stop",
          ).length > 0,
      );
      const events = c.messages.filter((m) => m.type === "session.event");
      assert.equal(events.length, 3);
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("close() terminates clients", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  const c = await connect(server.port);
  try {
    await c.waitFor((m) => m.type === "config");

    const closed = new Promise<void>((resolve) => {
      c.ws.once("close", () => resolve());
    });
    await server.close();
    await closed;
    assert.ok(
      c.ws.readyState === c.ws.CLOSED || c.ws.readyState === c.ws.CLOSING,
    );
  } finally {
    await c.close();
  }
});

test("notification.ack forwards to flow.ackNotification", async () => {
  const { flow, ctx } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.send({ type: "notification.ack", id: "N1" });
      // Poll briefly for side-effect
      const deadline = Date.now() + 1000;
      while (ctx.ackCalls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.deepEqual(ctx.ackCalls, ["N1"]);
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("task.retry and task.resume both forward to retryTask", async () => {
  const { flow, ctx } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.send({ type: "task.retry", taskId: "T-retry" });
      c.send({ type: "task.resume", taskId: "T-resume" });
      const deadline = Date.now() + 1000;
      while (ctx.retryCalls.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.deepEqual(ctx.retryCalls.sort(), ["T-resume", "T-retry"]);
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("project.open with different path returns error", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.send({ type: "project.open", path: "/different/path", requestId: "po-1" });
      const err = await c.waitFor((m) => m.type === "error");
      assert.equal(
        (err as { type: "error"; requestId?: string }).requestId,
        "po-1",
      );
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("project.list returns empty projects list (v1 stub)", async () => {
  const { flow } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");
      c.send({ type: "project.list" });
      const lst = await c.waitFor((m) => m.type === "project.list");
      assert.deepEqual(
        (lst as { type: "project.list"; projects: unknown[] }).projects,
        [],
      );
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});

test("session.started broadcast passes through", async () => {
  const { flow, ctx } = makeFakeFlow();
  const server = await startWsServer({ flow, port: 0, version: "0.1.0" });
  try {
    const c = await connect(server.port);
    try {
      await c.waitFor((m) => m.type === "config");

      const now = new Date().toISOString();
      const session: Session = {
        id: "SESS1",
        taskId: "T1",
        stage: "spec",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        skillName: "spec",
        prompt: "...",
        status: "running",
        startedAt: now,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        autocompacted: false,
        costUsd: 0,
      };
      ctx.bus.emit("session.started", { session });

      const msg = await c.waitFor((m) => m.type === "session.started");
      assert.equal(
        (msg as { type: "session.started"; session: Session }).session.id,
        "SESS1",
      );
    } finally {
      await c.close();
    }
  } finally {
    await server.close();
  }
});
