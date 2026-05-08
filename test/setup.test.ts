import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import { EventBus } from "../src/events.js";
import { StateStore } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import {
  ensureTasksLoaded,
  initProject,
  resolveBundledAssetsDir,
  resolveProjectStatus,
  runGetTasksSession,
  scaffoldFlowDir,
  watchPlan,
} from "../src/setup.js";
import type { AgentRunner, SpawnArgs } from "../src/agent.js";
import type { GitManager } from "../src/git.js";
import type { Notification, Session, TaskDef, TasksFile } from "../src/types.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "flow-setup-"));
}

const ASSETS_DIR = resolveBundledAssetsDir();

// ---------------------------------------------------------------------------
// Fake git
// ---------------------------------------------------------------------------

interface FakeGit {
  git: GitManager;
  calls: { method: string; args: unknown[] }[];
}

function makeFakeGit(): FakeGit {
  const calls: FakeGit["calls"] = [];
  const fake = {
    async ensureRepo(): Promise<boolean> {
      calls.push({ method: "ensureRepo", args: [] });
      return true;
    },
  } as unknown as GitManager;
  return { git: fake, calls };
}

// ---------------------------------------------------------------------------
// Fake agent
// ---------------------------------------------------------------------------

interface FakeAgent {
  agent: AgentRunner;
  calls: SpawnArgs[];
  /** Optional hook called per spawn before the session is returned. */
  onSpawn?: (args: SpawnArgs) => Promise<void> | void;
}

function makeFakeAgent(opts: {
  tasksToWrite?: TasksFile | string | null;
  paths: Paths;
  onSpawn?: (args: SpawnArgs) => Promise<void> | void;
}): FakeAgent {
  const calls: SpawnArgs[] = [];
  const fake = {
    async spawnAgent(args: SpawnArgs): Promise<Session> {
      calls.push(args);

      if (opts.onSpawn) {
        await opts.onSpawn(args);
      }

      if (args.skillName === "get-tasks" && opts.tasksToWrite !== undefined) {
        await fs.mkdir(path.dirname(opts.paths.tasksJson), { recursive: true });
        const body =
          typeof opts.tasksToWrite === "string"
            ? opts.tasksToWrite
            : JSON.stringify(opts.tasksToWrite);
        if (opts.tasksToWrite !== null) {
          await fs.writeFile(opts.paths.tasksJson, body, "utf8");
        }
      }

      const now = new Date().toISOString();
      return {
        id: `fake-${calls.length}`,
        taskId: args.taskId,
        stage: args.stage,
        provider: "claude-code",
        model: args.model ?? "fake-model",
        skillName: args.skillName,
        prompt: "<fake>",
        status: "succeeded",
        startedAt: now,
        endedAt: now,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        autocompacted: false,
        costUsd: 0,
        exitCode: 0,
      };
    },
  } as unknown as AgentRunner;

  const handle: FakeAgent = { agent: fake, calls };
  if (opts.onSpawn) handle.onSpawn = opts.onSpawn;
  return handle;
}

// ---------------------------------------------------------------------------
// resolveProjectStatus
// ---------------------------------------------------------------------------

test("resolveProjectStatus: empty when no plan.md", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  assert.equal(await resolveProjectStatus(paths), "empty");
});

test("resolveProjectStatus: uninitialized when plan.md only", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await fs.writeFile(paths.planMd, "# Plan\nhello\n", "utf8");
  assert.equal(await resolveProjectStatus(paths), "uninitialized");
});

test("resolveProjectStatus: uninitialized when plan.md + config.json but no tasks.json", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await fs.writeFile(paths.planMd, "# Plan\n", "utf8");
  await fs.mkdir(paths.flowDir, { recursive: true });
  await fs.writeFile(paths.configJson, JSON.stringify(defaultConfig()), "utf8");
  assert.equal(await resolveProjectStatus(paths), "uninitialized");
});

test("resolveProjectStatus: ready when plan.md + config.json + tasks.json all present", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await fs.writeFile(paths.planMd, "# Plan\n", "utf8");
  await fs.mkdir(paths.flowDir, { recursive: true });
  await fs.writeFile(paths.configJson, JSON.stringify(defaultConfig()), "utf8");
  await fs.writeFile(
    paths.tasksJson,
    JSON.stringify({ tasks: [] } satisfies TasksFile),
    "utf8",
  );
  assert.equal(await resolveProjectStatus(paths), "ready");
});

// ---------------------------------------------------------------------------
// scaffoldFlowDir
// ---------------------------------------------------------------------------

test("scaffoldFlowDir: copies prompts, writes default config, idempotent", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);

  await scaffoldFlowDir(paths, ASSETS_DIR);

  // Config written with defaults.
  const cfgRaw = await fs.readFile(paths.configJson, "utf8");
  const cfg = JSON.parse(cfgRaw);
  assert.equal(cfg.maxConcurrent, 3);
  assert.equal(cfg.defaults.model, "sonnet");

  // State file written.
  const stRaw = await fs.readFile(paths.stateJson, "utf8");
  const st = JSON.parse(stRaw);
  assert.deepEqual(st.tasks, []);
  assert.deepEqual(st.sessions, []);

  // Stage prompts copied — verify a subset.
  for (const name of [
    "get-tasks",
    "setup",
    "spec",
    "exec",
    "ui-check",
    "review",
    "docs",
    "commit",
    "merge-resolve",
  ]) {
    const body = await fs.readFile(paths.promptFile(name), "utf8");
    assert.ok(body.length > 0, `prompt ${name} has content`);
  }

  // Bundled prompts self-heal: edits to bundled prompt files are overwritten
  // back to bundled content on the next scaffold. User-added prompts
  // (filenames not present in the bundle) are preserved. config.json
  // is untouched once it exists.
  const bundledExec = await fs.readFile(paths.promptFile("exec"), "utf8");
  await fs.writeFile(paths.promptFile("exec"), "MY CUSTOM PROMPT\n", "utf8");
  await fs.writeFile(paths.promptFile("project-only"), "PROJECT-ONLY PROMPT\n", "utf8");
  await fs.writeFile(paths.configJson, '{"custom":true}', "utf8");
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const execAfter = await fs.readFile(paths.promptFile("exec"), "utf8");
  assert.equal(execAfter, bundledExec);
  const projectOnlyAfter = await fs.readFile(paths.promptFile("project-only"), "utf8");
  assert.equal(projectOnlyAfter, "PROJECT-ONLY PROMPT\n");
  const cfgAfter = await fs.readFile(paths.configJson, "utf8");
  assert.equal(cfgAfter, '{"custom":true}');
});

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------

test("initProject: scaffolds + calls git.ensureRepo", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const { git, calls } = makeFakeGit();

  await initProject(paths, { assetsDir: ASSETS_DIR, git });

  assert.ok(await fileExists(paths.configJson));
  assert.ok(await fileExists(paths.promptFile("exec")));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "ensureRepo");
});

// ---------------------------------------------------------------------------
// ensureTasksLoaded — happy path
// ---------------------------------------------------------------------------

test("ensureTasksLoaded: no tasks.json → agent writes one, defs returned and synced", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);
  await fs.writeFile(paths.planMd, "# test plan\n", "utf8");

  const eventBus = new EventBus();
  const state = new StateStore(paths);
  await state.load();

  const tasksFile: TasksFile = {
    tasks: [
      { id: "A", title: "Task A", description: "Do A", contextFiles: [], requires: [], hasUI: false, hasSpec: true, hasCodeReview: true },
      { id: "B", title: "Task B", description: "Do B", contextFiles: [], requires: ["A"], hasUI: false, hasSpec: true, hasCodeReview: true },
    ],
  };

  const { agent, calls } = makeFakeAgent({ tasksToWrite: tasksFile, paths });
  const { git } = makeFakeGit();

  const defs = await ensureTasksLoaded({
    paths,
    config: defaultConfig(),
    state,
    git,
    agent,
    eventBus,
  });

  assert.equal(defs.length, 2);
  assert.deepEqual(defs.map((d) => d.id), ["A", "B"]);

  // Both setup + get-tasks sessions were spawned in order.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.skillName, "setup");
  assert.equal(calls[1]!.skillName, "get-tasks");

  // State was synced: tasks present, A ready (no deps), B pending.
  const tasks = state.getTasks();
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((t) => t.id === "A")!.status, "ready");
  assert.equal(tasks.find((t) => t.id === "B")!.status, "pending");

  // State file on disk.
  assert.ok(await fileExists(paths.stateJson));
});

test("ensureTasksLoaded: existing valid tasks.json skips agent and returns defs", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const tasksFile: TasksFile = {
    tasks: [{ id: "X", title: "X", description: "", contextFiles: [], requires: [], hasUI: false, hasSpec: true, hasCodeReview: true }],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(tasksFile), "utf8");

  const state = new StateStore(paths);
  await state.load();

  const { agent, calls } = makeFakeAgent({ paths });
  const { git } = makeFakeGit();

  const defs = await ensureTasksLoaded({
    paths,
    config: defaultConfig(),
    state,
    git,
    agent,
    eventBus: new EventBus(),
  });

  assert.equal(defs.length, 1);
  assert.equal(calls.length, 0, "agent should not run when tasks.json already exists");
});

test("ensureTasksLoaded: hasDocs=false still runs setup (gatekeeper)", async () => {
  // Setup is the environment gatekeeper and runs unconditionally;
  // `hasDocs=false` only suppresses the per-task `documentation` stage,
  // not setup itself.
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);
  await fs.writeFile(paths.planMd, "# test plan\n", "utf8");

  const state = new StateStore(paths);
  await state.load();

  const tasksFile: TasksFile = {
    tasks: [{ id: "A", title: "A", description: "", contextFiles: [], requires: [], hasUI: false, hasSpec: true, hasCodeReview: true }],
  };
  const { agent, calls } = makeFakeAgent({ tasksToWrite: tasksFile, paths });
  const { git } = makeFakeGit();

  const cfg = { ...defaultConfig(), hasDocs: false };
  await ensureTasksLoaded({
    paths,
    config: cfg,
    state,
    git,
    agent,
    eventBus: new EventBus(),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.skillName, "setup");
  assert.equal(calls[1]!.skillName, "get-tasks");
});

// ---------------------------------------------------------------------------
// ensureTasksLoaded — invalid tasks.json (cycle)
// ---------------------------------------------------------------------------

test("ensureTasksLoaded: existing tasks.json with a cycle throws with CYCLE + emits notification", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const cycle: TasksFile = {
    tasks: [
      { id: "A", title: "A", description: "", contextFiles: [], requires: ["B"], hasUI: false, hasSpec: true, hasCodeReview: true },
      { id: "B", title: "B", description: "", contextFiles: [], requires: ["A"], hasUI: false, hasSpec: true, hasCodeReview: true },
    ],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(cycle), "utf8");

  const state = new StateStore(paths);
  await state.load();
  const eventBus = new EventBus();

  const notifs: Notification[] = [];
  eventBus.on("notification", ({ notification }) => notifs.push(notification));

  const { agent } = makeFakeAgent({ paths });
  const { git } = makeFakeGit();

  await assert.rejects(
    ensureTasksLoaded({
      paths,
      config: defaultConfig(),
      state,
      git,
      agent,
      eventBus,
    }),
    (err: Error) => /CYCLE/.test(err.message),
  );

  assert.equal(notifs.length, 1);
  assert.equal(notifs[0]!.severity, "error");
  assert.match(notifs[0]!.body, /CYCLE/);
});

// ---------------------------------------------------------------------------
// ensureTasksLoaded — id derivation
// ---------------------------------------------------------------------------

test("ensureTasksLoaded: tasks.json with omitted ids loads via title-derived slugs", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  // Raw on-disk shape — omits `id` on every task. `requires` references the
  // canonical slug of the first title (matches what the get-tasks skill tells
  // the agent to do).
  const onDisk = {
    tasks: [
      { title: "Hello world", description: "first", contextFiles: [], requires: [] },
      { title: "Use it", description: "second", contextFiles: [], requires: ["hello-world"] },
    ],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(onDisk), "utf8");

  const state = new StateStore(paths);
  await state.load();
  const { agent, calls } = makeFakeAgent({ paths });
  const { git } = makeFakeGit();

  const defs = await ensureTasksLoaded({
    paths,
    config: defaultConfig(),
    state,
    git,
    agent,
    eventBus: new EventBus(),
  });

  assert.deepEqual(
    defs.map((d) => d.id),
    ["hello-world", "use-it"],
  );
  assert.equal(calls.length, 0, "no agent run — file was already on disk");
  // Dependent state synced via canonical ids.
  const tasks = state.getTasks();
  assert.equal(tasks.find((t) => t.id === "hello-world")!.status, "ready");
  assert.equal(tasks.find((t) => t.id === "use-it")!.status, "pending");
});

test("ensureTasksLoaded: title collision auto-suffixes -2 without notification", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const onDisk = {
    tasks: [
      { title: "Setup", description: "", requires: [] },
      { title: "setup!", description: "", requires: [] },
    ],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(onDisk), "utf8");

  const state = new StateStore(paths);
  await state.load();
  const eventBus = new EventBus();
  const notifs: Notification[] = [];
  eventBus.on("notification", ({ notification }) => notifs.push(notification));
  const { agent } = makeFakeAgent({ paths });
  const { git } = makeFakeGit();

  const defs = await ensureTasksLoaded({
    paths,
    config: defaultConfig(),
    state,
    git,
    agent,
    eventBus,
  });

  assert.deepEqual(
    defs.map((d) => d.id),
    ["setup", "setup-2"],
  );
  assert.equal(notifs.length, 0);
});

test("ensureTasksLoaded: explicit duplicate ids surface as Invalid tasks.json notification", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const onDisk = {
    tasks: [
      { id: "foo", title: "First", description: "", requires: [] },
      { id: "foo", title: "Second", description: "", requires: [] },
    ],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(onDisk), "utf8");

  const state = new StateStore(paths);
  await state.load();
  const eventBus = new EventBus();
  const notifs: Notification[] = [];
  eventBus.on("notification", ({ notification }) => notifs.push(notification));
  const { agent } = makeFakeAgent({ paths });
  const { git } = makeFakeGit();

  await assert.rejects(
    ensureTasksLoaded({
      paths,
      config: defaultConfig(),
      state,
      git,
      agent,
      eventBus,
    }),
    (err: Error) => /Invalid tasks\.json/i.test(err.message) && /Duplicate explicit id .*foo/.test(err.message),
  );
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0]!.severity, "error");
  assert.match(notifs[0]!.body, /Duplicate explicit id .*foo/);
});

// ---------------------------------------------------------------------------
// runGetTasksSession — validation runs independently
// ---------------------------------------------------------------------------

test("runGetTasksSession: surfaces schema failure clearly", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);
  await fs.writeFile(paths.planMd, "# test plan\n", "utf8");

  const state = new StateStore(paths);
  await state.load();
  const eventBus = new EventBus();
  const errors: string[] = [];
  eventBus.on("error", ({ message }) => errors.push(message));

  const { agent } = makeFakeAgent({
    tasksToWrite: "not-json-at-all",
    paths,
  });
  const { git } = makeFakeGit();

  await assert.rejects(
    runGetTasksSession({
      paths,
      config: defaultConfig(),
      state,
      git,
      agent,
      eventBus,
    }),
    (err: Error) => /Invalid tasks.json|JSON/i.test(err.message),
  );
  assert.ok(errors.length >= 1, "error event emitted");
});

// ---------------------------------------------------------------------------
// watchPlan
// ---------------------------------------------------------------------------

test("watchPlan: callback fires on plan.md change within 2s", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  // Initial content, so watcher has something to "watch" for changes.
  await fs.writeFile(paths.planMd, "# initial\n", "utf8");

  let fired = 0;
  let firedResolve!: () => void;
  const firedPromise = new Promise<void>((r) => {
    firedResolve = r;
  });
  const dispose = watchPlan(paths, () => {
    fired++;
    firedResolve();
  });

  // chokidar needs a moment to start watching before we write.
  await sleep(150);
  await fs.writeFile(paths.planMd, "# changed\n", "utf8");

  const timeout = sleep(2000).then(() => "timeout");
  const result = await Promise.race([firedPromise.then(() => "fired"), timeout]);

  dispose();
  assert.equal(result, "fired", `callback did not fire within 2s (count=${fired})`);
  assert.ok(fired >= 1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
