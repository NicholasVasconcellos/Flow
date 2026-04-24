import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import { EventBus } from "../src/events.js";
import { StateStore } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { newId } from "../src/ids.js";
import { Scheduler, parseCommitMessage } from "../src/scheduler.js";
import type {
  Config,
  Notification,
  Session,
  TaskDef,
  TaskRuntime,
} from "../src/types.js";
import type { AgentRunner, SpawnArgs } from "../src/agent.js";
import type { GitManager, CommitMessage } from "../src/git.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-sched-"));
  return fs.realpath(dir);
}

function mkTaskDef(
  id: string,
  overrides: Partial<TaskDef> = {},
): TaskDef {
  return {
    id,
    title: `Task ${id}`,
    description: `desc ${id}`,
    contextFiles: [],
    requires: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake AgentRunner
// ---------------------------------------------------------------------------

interface FakeAgentCall {
  taskId: string | null;
  stage: Session["stage"];
  skillName: string;
  contextFiles: string[];
  extraPrompt?: string | undefined;
}

type AgentScript = (
  call: FakeAgentCall,
  context: FakeAgentContext,
) => Partial<Session> | Promise<Partial<Session>>;

interface FakeAgentContext {
  callsForTask: (taskId: string) => FakeAgentCall[];
  allCalls: FakeAgentCall[];
}

interface FakeAgentHandle {
  runner: AgentRunner;
  calls: FakeAgentCall[];
  inFlight: Set<string>; // taskIds whose sessions are currently running
  maxInFlight: number;
  setScript(script: AgentScript): void;
}

function makeFakeAgent(initialScript?: AgentScript): FakeAgentHandle {
  const calls: FakeAgentCall[] = [];
  const inFlight = new Set<string>();
  let maxInFlight = 0;
  let script: AgentScript = initialScript ?? (() => ({}));

  const ctx: FakeAgentContext = {
    callsForTask: (taskId) => calls.filter((c) => c.taskId === taskId),
    allCalls: calls,
  };

  const runner: Partial<AgentRunner> = {
    async spawnAgent(args: SpawnArgs): Promise<Session> {
      const call: FakeAgentCall = {
        taskId: args.taskId,
        stage: args.stage,
        skillName: args.skillName,
        contextFiles: args.contextFiles ?? [],
        extraPrompt: args.extraPrompt,
      };
      calls.push(call);
      if (args.taskId) {
        inFlight.add(args.taskId);
        maxInFlight = Math.max(maxInFlight, inFlight.size);
      }
      try {
        // Small async boundary to allow parallel tasks to overlap.
        await Promise.resolve();
        const override = await script(call, ctx);

        const now = new Date().toISOString();
        const base: Session = {
          id: newId(),
          taskId: args.taskId,
          stage: args.stage,
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          skillName: args.skillName,
          prompt: "<fake prompt>",
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
        return { ...base, ...override };
      } finally {
        if (args.taskId) inFlight.delete(args.taskId);
      }
    },
  };

  return {
    runner: runner as AgentRunner,
    calls,
    inFlight,
    get maxInFlight() {
      return maxInFlight;
    },
    setScript(next: AgentScript) {
      script = next;
    },
  } as FakeAgentHandle;
}

// ---------------------------------------------------------------------------
// Fake GitManager
// ---------------------------------------------------------------------------

interface FakeGitOptions {
  /** If set, `mergeTaskIntoMain` returns this result the first time it runs
   *  for a given taskId, then a clean success thereafter. */
  initialMergeResult?: Record<
    string,
    { ok: false; conflictPaths: string[] } | { ok: true; sha: string }
  >;
  /** If true, first call to `completeMerge` throws before succeeding. */
  completeMergeThrowsFirst?: boolean;
  /** Paths (subset of conflictPaths) that `scanForConflictMarkers` should
   *  report as still containing conflict markers. Defaults to none. */
  markerScanReturns?: string[];
}

interface FakeGitHandle {
  git: GitManager;
  worktrees: Map<string, { worktreePath: string; branchName: string }>;
  commits: Array<{ taskId: string; message: CommitMessage }>;
  merges: string[];
  removed: string[];
  completeMergeCalls: number;
  mergeCalls: Record<string, number>;
}

function makeFakeGit(
  root: string,
  opts: FakeGitOptions = {},
): FakeGitHandle {
  const worktrees = new Map<
    string,
    { worktreePath: string; branchName: string }
  >();
  const commits: Array<{ taskId: string; message: CommitMessage }> = [];
  const merges: string[] = [];
  const removed: string[] = [];
  const mergeCalls: Record<string, number> = {};
  let completeMergeCalls = 0;

  const git: Partial<GitManager> = {
    async createWorktree(taskId: string) {
      const branchName = `flow/${taskId}`;
      const worktreePath = path.join(root, ".flow", "worktrees", taskId);
      await fs.mkdir(worktreePath, { recursive: true });
      worktrees.set(taskId, { worktreePath, branchName });
      return { worktreePath, branchName };
    },

    async removeWorktree(taskId: string) {
      worktrees.delete(taskId);
      removed.push(taskId);
    },

    async commitAllInWorktree(taskId: string, message: CommitMessage) {
      commits.push({ taskId, message });
      return "deadbeefcafe";
    },

    async mergeTaskIntoMain(taskId: string) {
      const n = (mergeCalls[taskId] ?? 0) + 1;
      mergeCalls[taskId] = n;
      const first = opts.initialMergeResult?.[taskId];
      if (n === 1 && first) {
        return first;
      }
      merges.push(taskId);
      return { ok: true, sha: "feedface" };
    },

    async completeMerge() {
      completeMergeCalls++;
      if (opts.completeMergeThrowsFirst && completeMergeCalls === 1) {
        throw new Error("nothing staged");
      }
      return "aaaa1111";
    },

    async abortMerge() {
      /* no-op */
    },

    async scanForConflictMarkers(_relPaths: readonly string[]) {
      return opts.markerScanReturns ? [...opts.markerScanReturns] : [];
    },
  };

  const handle: FakeGitHandle = {
    git: git as GitManager,
    worktrees,
    commits,
    merges,
    removed,
    get completeMergeCalls() {
      return completeMergeCalls;
    },
    mergeCalls,
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

interface Harness {
  root: string;
  paths: Paths;
  state: StateStore;
  bus: EventBus;
  config: Config;
  agent: FakeAgentHandle;
  git: FakeGitHandle;
  scheduler: Scheduler;
  upserts: TaskRuntime[];
  notifications: Notification[];
}

async function makeHarness(
  opts: {
    taskDefs?: TaskDef[];
    config?: Partial<Config>;
    agentScript?: AgentScript;
    gitOpts?: FakeGitOptions;
  } = {},
): Promise<Harness> {
  const root = await mkTmp();
  const paths = new Paths(root);
  const state = new StateStore(paths);
  await state.load();
  const bus = new EventBus();
  const base = defaultConfig();
  const config: Config = {
    ...base,
    ...opts.config,
    defaults: { ...base.defaults, ...(opts.config?.defaults ?? {}) },
    git: { ...base.git, ...(opts.config?.git ?? {}) },
    ws: { ...base.ws, ...(opts.config?.ws ?? {}) },
    pricing: { ...base.pricing, ...(opts.config?.pricing ?? {}) },
  };

  const defs =
    opts.taskDefs ?? [mkTaskDef("A")];
  state.syncFromTaskDefs(defs);
  state.recomputeReadiness();
  await state.save();

  const agent = makeFakeAgent(opts.agentScript);
  const git = makeFakeGit(root, opts.gitOpts);
  const scheduler = new Scheduler({
    paths,
    config,
    state,
    git: git.git,
    agent: agent.runner,
    eventBus: bus,
  });

  const upserts: TaskRuntime[] = [];
  const notifications: Notification[] = [];
  bus.on("task.upsert", ({ task }) => upserts.push(task));
  bus.on("notification", ({ notification }) => notifications.push(notification));

  return {
    root,
    paths,
    state,
    bus,
    config,
    agent,
    git,
    scheduler,
    upserts,
    notifications,
  };
}

// ---------------------------------------------------------------------------
// parseCommitMessage basic
// ---------------------------------------------------------------------------

test("parseCommitMessage pulls subject + bullets", () => {
  const parsed = parseCommitMessage(
    "Add widget\n\n- first bullet\n- second bullet\n",
  );
  assert.ok(parsed);
  assert.equal(parsed.subject, "Add widget");
  assert.deepEqual(parsed.bullets, ["first bullet", "second bullet"]);
});

test("parseCommitMessage returns null on empty string", () => {
  assert.equal(parseCommitMessage(""), null);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test(
  "happy path: 1 task reaches merged with ordered stage transitions",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
    });

    const result = await h.scheduler.runTask("A");
    assert.equal(result.status, "merged");
    assert.equal(result.stage, "merged");
    assert.ok(result.completedAt, "completedAt should be set");

    // Check stage progression recorded in upserts. We expect spec → exec →
    // exec_ui_check → code_review → code_review_ui_check → documentation →
    // done → merged to all appear in order.
    const stageSeq = h.upserts.map((t) => `${t.stage}:${t.status}`);
    const firstIndexOf = (needle: string) =>
      stageSeq.findIndex((s) => s === needle);

    const expected = [
      "spec:running",
      "exec:running",
      "exec_ui_check:running",
      "code_review:running",
      "code_review_ui_check:running",
      "documentation:running",
      "done:running",
      "merged:merged",
    ];
    let last = -1;
    for (const e of expected) {
      const idx = firstIndexOf(e);
      assert.ok(idx >= 0, `expected upsert ${e} in stream`);
      assert.ok(idx > last, `upsert ${e} should come after previous`);
      last = idx;
    }

    // Git interactions.
    assert.equal(h.git.commits.length, 1);
    assert.equal(h.git.commits[0]!.taskId, "A");
    assert.equal(h.git.merges.length, 1);
    assert.deepEqual(h.git.removed, ["A"]);

    // The agent saw all pipeline stages.
    const stagesSeen = h.agent.calls.map((c) => c.stage);
    assert.deepEqual(stagesSeen, [
      "spec",
      "exec",
      "exec_ui_check",
      "code_review",
      "code_review_ui_check",
      "documentation",
      "commit",
    ]);
  },
);

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test(
  "runAllOnce with maxConcurrent=2 caps in-flight agent calls",
  { timeout: 15000 },
  async () => {
    // 3 independent tasks. Track maxInFlight across the run.
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A"), mkTaskDef("B"), mkTaskDef("C")],
      config: { maxConcurrent: 2 },
      agentScript: async (_call) => {
        // Yield a couple of times so that when multiple tasks are running
        // concurrently, their sessions overlap.
        await new Promise((r) => setTimeout(r, 5));
        return {};
      },
    });

    const results = await h.scheduler.runAllOnce();
    const byId = new Map(results.map((r) => [r.id, r]));
    assert.equal(byId.size, 3);
    for (const id of ["A", "B", "C"]) {
      assert.equal(byId.get(id)!.status, "merged");
    }
    assert.ok(
      h.agent.maxInFlight <= 2,
      `maxInFlight=${h.agent.maxInFlight} should be <= 2`,
    );
    // And we should have actually exercised concurrency at some point.
    assert.ok(
      h.agent.maxInFlight >= 2,
      `maxInFlight=${h.agent.maxInFlight} should reach 2`,
    );
  },
);

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

test(
  "retryCount=1: spec fails once, retries, succeeds → merged",
  { timeout: 10000 },
  async () => {
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 1 },
      agentScript: (call) => {
        if (call.stage === "spec") {
          specCalls++;
          if (specCalls === 1) {
            return {
              status: "failed",
              error: "spec blew up on attempt 1",
              exitCode: 1,
            };
          }
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");
    assert.equal(specCalls, 2, "spec should have been retried once");

    // retries counter reset to 0 on success advance? Not required — what we
    // care about is that the task is merged and no extra error was set.
    assert.equal(t.lastError, undefined);

    // The retry should have included an error-addendum prompt.
    const specCallsLog = h.agent.calls.filter((c) => c.stage === "spec");
    assert.equal(specCallsLog.length, 2);
    assert.ok(
      specCallsLog[1]!.extraPrompt &&
        /spec blew up/.test(specCallsLog[1]!.extraPrompt),
      "retry should carry error addendum",
    );
  },
);

// ---------------------------------------------------------------------------
// Failure with retryCount=0 → paused
// ---------------------------------------------------------------------------

test(
  "retryCount=0: stage failure pauses the task and emits error notification",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: (call) => {
        if (call.stage === "exec") {
          return {
            status: "failed",
            error: "exec crashed",
            exitCode: 5,
          };
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "paused");
    assert.equal(t.stage, "exec");
    assert.ok(t.lastError);
    assert.equal(t.lastError!.stage, "exec");
    assert.match(t.lastError!.message, /exec crashed/);

    // Notification emitted with severity error.
    const errs = h.notifications.filter((n) => n.severity === "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.body, /exec crashed/);
  },
);

// ---------------------------------------------------------------------------
// FLOW_BLOCKED → blocked (no retry)
// ---------------------------------------------------------------------------

test(
  "FLOW_BLOCKED: task moves to blocked with no retry, notification severity=blocked",
  { timeout: 10000 },
  async () => {
    let execCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 5 }, // blocked should still skip retries
      agentScript: (call) => {
        if (call.stage === "exec") {
          execCalls++;
          return {
            status: "failed",
            error: "FLOW_BLOCKED: need creds",
            exitCode: 0,
          };
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "blocked");
    assert.equal(t.stage, "exec");
    assert.equal(execCalls, 1, "blocked stops immediately — no retries");

    const n = h.notifications.filter((x) => x.severity === "blocked");
    assert.equal(n.length, 1);
    assert.match(n[0]!.body, /need creds/);
  },
);

// ---------------------------------------------------------------------------
// Merge conflict → mergeResolve session → completeMerge → merged
// ---------------------------------------------------------------------------

test(
  "merge conflict triggers mergeResolve session then completeMerge",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      gitOpts: {
        initialMergeResult: {
          A: { ok: false, conflictPaths: ["a.ts", "b.ts"] },
        },
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");

    // The agent should have been asked to do a mergeResolve session with the
    // conflict paths as contextFiles.
    const mr = h.agent.calls.find((c) => c.stage === "mergeResolve");
    assert.ok(mr, "mergeResolve session should be spawned on conflict");
    assert.deepEqual(mr.contextFiles, ["a.ts", "b.ts"]);
    assert.equal(h.git.completeMergeCalls, 1);
    assert.equal(h.git.mergeCalls.A, 1, "merge is not retried after resolve");
  },
);

test(
  "mergeResolve that leaves conflict markers pauses the task and aborts the merge",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      gitOpts: {
        initialMergeResult: {
          A: { ok: false, conflictPaths: ["a.ts", "b.ts"] },
        },
        markerScanReturns: ["a.ts"],
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "paused");
    assert.equal(h.git.completeMergeCalls, 0, "completeMerge must not run");
    assert.ok(t.lastError, "lastError should be populated");
    assert.match(t.lastError!.message, /conflict markers/);
    assert.match(t.lastError!.message, /a\.ts/);
    const notif = h.notifications.find((n) => n.title.includes("merge"));
    assert.ok(notif, "a merge-paused notification should be emitted");
  },
);

test(
  "recoverStaleTasks resets status=running tasks to paused with an error",
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A"), mkTaskDef("B"), mkTaskDef("C")],
    });
    // Simulate a previous orchestrator crash mid-run.
    const a = h.state.getTask("A")!;
    a.status = "running";
    a.stage = "exec";
    h.state.upsertTask(a);
    const b = h.state.getTask("B")!;
    b.status = "ready";
    h.state.upsertTask(b);
    const c = h.state.getTask("C")!;
    c.status = "running";
    c.stage = "code_review";
    h.state.upsertTask(c);
    await h.state.save();

    // Drain upserts emitted by makeHarness's initial sync.
    h.upserts.length = 0;

    const recovered = await h.scheduler.recoverStaleTasks();
    assert.equal(recovered.length, 2);
    const ids = recovered.map((t) => t.id).sort();
    assert.deepEqual(ids, ["A", "C"]);

    assert.equal(h.state.getTask("A")!.status, "paused");
    assert.equal(h.state.getTask("B")!.status, "ready", "non-running untouched");
    assert.equal(h.state.getTask("C")!.status, "paused");

    const aErr = h.state.getTask("A")!.lastError!;
    assert.equal(aErr.stage, "exec");
    assert.match(aErr.message, /Orchestrator/);
    const cErr = h.state.getTask("C")!.lastError!;
    assert.equal(cErr.stage, "code_review");

    // Both recovered tasks should have emitted task.upsert events.
    const upsertIds = new Set(h.upserts.map((t) => t.id));
    assert.ok(upsertIds.has("A"));
    assert.ok(upsertIds.has("C"));
  },
);

test("recoverStaleTasks is a no-op when nothing is running", async () => {
  const h = await makeHarness({ taskDefs: [mkTaskDef("A")] });
  h.upserts.length = 0;
  const recovered = await h.scheduler.recoverStaleTasks();
  assert.deepEqual(recovered, []);
  assert.equal(h.upserts.length, 0);
});

// ---------------------------------------------------------------------------
// hasDocs=false
// ---------------------------------------------------------------------------

test(
  "hasDocs=false skips documentation stage",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { hasDocs: false },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");

    const stages = h.agent.calls.map((c) => c.stage);
    assert.ok(!stages.includes("documentation"), "documentation stage skipped");
    // But all the other agent stages should have run.
    for (const s of [
      "spec",
      "exec",
      "exec_ui_check",
      "code_review",
      "code_review_ui_check",
      "commit",
    ] as const) {
      assert.ok(stages.includes(s), `expected stage ${s} to run`);
    }
  },
);

// ---------------------------------------------------------------------------
// retryTask resumes paused task
// ---------------------------------------------------------------------------

test(
  "retryTask resumes a paused task at the failed stage with retries=0",
  { timeout: 10000 },
  async () => {
    let execFails = true;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: (call) => {
        if (call.stage === "exec" && execFails) {
          return {
            status: "failed",
            error: "exec boom",
            exitCode: 1,
          };
        }
        return {};
      },
    });

    // First run — pauses at exec.
    const paused = await h.scheduler.runTask("A");
    assert.equal(paused.status, "paused");
    assert.equal(paused.stage, "exec");

    // Flip the script to succeed, then retry.
    execFails = false;
    await h.scheduler.retryTask("A");

    const final = h.state.getTask("A")!;
    assert.equal(final.status, "merged");
    assert.equal(final.retries, 0);
    assert.equal(final.lastError, undefined);

    // Exec was retried exactly once after the retry (so 2 total exec calls).
    const execCalls = h.agent.calls.filter((c) => c.stage === "exec");
    assert.equal(execCalls.length, 2);
  },
);

// ---------------------------------------------------------------------------
// Dependency chain
// ---------------------------------------------------------------------------

test(
  "dependency chain: b waits for a.merged before running",
  { timeout: 15000 },
  async () => {
    const order: string[] = [];
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A"), mkTaskDef("B", { requires: ["A"] })],
      config: { maxConcurrent: 2 },
      agentScript: async (call) => {
        if (call.stage === "spec" && call.taskId) {
          order.push(`start:${call.taskId}`);
        }
        await new Promise((r) => setTimeout(r, 2));
        return {};
      },
    });

    // Before any run, B should be pending (A is ready).
    assert.equal(h.state.getTask("A")!.status, "ready");
    assert.equal(h.state.getTask("B")!.status, "pending");

    await h.scheduler.runAll();

    // Both merged by the end.
    assert.equal(h.state.getTask("A")!.status, "merged");
    assert.equal(h.state.getTask("B")!.status, "merged");

    // A should have started first.
    const idxA = order.indexOf("start:A");
    const idxB = order.indexOf("start:B");
    assert.ok(idxA >= 0 && idxB >= 0);
    assert.ok(idxA < idxB, "A should start before B");
  },
);
