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
import { Scheduler } from "../src/scheduler.js";
import type {
  Config,
  Notification,
  Session,
  TaskDef,
  TaskRuntime,
  TaskStage,
} from "../src/types.js";
import type { AgentRunner, SpawnArgs } from "../src/agent.js";
import { MissingPromptError } from "../src/agent.js";
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
    hasUI: false,
    hasSpec: true,
    hasCodeReview: true,
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
  worktreePath: string;
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
  inFlight: Set<string>;
  maxInFlight: number;
  setScript(script: AgentScript): void;
  setWriteDefaultSignal(write: boolean): void;
  setHeadBumpFn(fn: ((taskId: string) => void) | null): void;
}

function makeFakeAgent(
  paths: Paths,
  initialScript?: AgentScript,
): FakeAgentHandle {
  const calls: FakeAgentCall[] = [];
  const inFlight = new Set<string>();
  let maxInFlight = 0;
  let script: AgentScript = initialScript ?? (() => ({}));
  let writeDefaultSignal = true;
  let headBumpFn: ((taskId: string) => void) | null = null;

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
        worktreePath: args.worktreePath,
      };
      calls.push(call);
      if (args.taskId) {
        inFlight.add(args.taskId);
        maxInFlight = Math.max(maxInFlight, inFlight.size);
      }
      try {
        await Promise.resolve();
        const override = await script(call, ctx);

        // Default behavior: write a stage signal file claiming success and
        // simulate a HEAD-moving commit so the scheduler advances. Skip if
        // the script flagged failure or already wrote its own signal.
        const willFail =
          override.status === "failed" || override.status === "autocompacted";
        if (!willFail && args.taskId) {
          if (writeDefaultSignal) {
            const file = paths.taskStageSignal(args.taskId);
            let exists = false;
            try {
              await fs.access(file);
              exists = true;
            } catch {
              /* missing — will write default */
            }
            if (!exists) {
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(
                file,
                JSON.stringify({ stage: args.stage, status: "done" }),
                "utf8",
              );
            }
          }
          headBumpFn?.(args.taskId);
        }

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
    setWriteDefaultSignal(write: boolean) {
      writeDefaultSignal = write;
    },
    setHeadBumpFn(fn: ((taskId: string) => void) | null) {
      headBumpFn = fn;
    },
  } as FakeAgentHandle;
}

// ---------------------------------------------------------------------------
// Fake GitManager
// ---------------------------------------------------------------------------

interface FakeGitOptions {
  initialMergeResult?: Record<
    string,
    { ok: false; conflictPaths: string[] } | { ok: true }
  >;
  finalizeMergeThrowsFirst?: boolean;
  markerScanReturns?: string[];
  /** Static result for hasUncommittedChanges. Defaults to false (clean). */
  hasUncommittedChanges?: boolean;
  /** Override for the rev-list rescue probe used by the scheduler when
   *  headBefore===headAfter. When set, replaces the default approximation
   *  (1 if the worktree has any HEAD recorded, 0 otherwise). */
  commitsAheadFn?: (taskId: string) => number;
}

interface FakeGitHandle {
  git: GitManager;
  worktrees: Map<string, { worktreePath: string; branchName: string }>;
  commits: Array<{ taskId: string; message: CommitMessage }>;
  merges: string[];
  removed: string[];
  /** Count of finalizeMerge() calls — exposed under the legacy name
   *  `completeMergeCalls` for backwards-compatible test assertions. */
  completeMergeCalls: number;
  finalizeMergeCalls: Array<{
    strategy: "squash" | "merge";
    message: string | undefined;
  }>;
  mergeCalls: Record<string, number>;
  mergeStrategies: string[];
  abortStrategies: string[];
  bumpHead(taskId: string): string;
  getHead(taskId: string): string | null;
}

function makeFakeGit(
  root: string,
  paths: Paths,
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
  const mergeStrategies: string[] = [];
  const abortStrategies: string[] = [];
  const finalizeMergeCalls: Array<{
    strategy: "squash" | "merge";
    message: string | undefined;
  }> = [];
  const heads = new Map<string, string>();
  let headCounter = 0;
  let finalizeMergeCount = 0;

  const bumpHead = (taskId: string): string => {
    headCounter += 1;
    const sha = `sha-${taskId}-${headCounter}`;
    heads.set(taskId, sha);
    return sha;
  };

  const git: Partial<GitManager> = {
    async createWorktree(taskId: string) {
      const branchName = `flow/${taskId}`;
      const worktreePath = path.join(root, ".flow", "worktrees", taskId);
      await fs.mkdir(worktreePath, { recursive: true });
      worktrees.set(taskId, { worktreePath, branchName });
      // Also seed progress.txt the way the real GitManager does.
      const progressPath = paths.taskProgressTxt(taskId);
      await fs.mkdir(path.dirname(progressPath), { recursive: true });
      try {
        await fs.writeFile(progressPath, "", { flag: "wx" });
      } catch {
        /* exists */
      }
      return { worktreePath, branchName };
    },

    async removeWorktree(taskId: string) {
      worktrees.delete(taskId);
      removed.push(taskId);
    },

    async hasUncommittedChanges(_taskId: string) {
      return opts.hasUncommittedChanges === true;
    },

    async getWorktreeHeadSha(taskId: string) {
      return heads.get(taskId) ?? null;
    },

    async commitsAheadOfBase(taskId: string) {
      // Approximation: in this fake we don't track main-vs-branch divergence
      // explicitly; treat any bumped HEAD as "1 commit ahead" so the
      // scheduler's rev-list rescue can be exercised. Tests that need the
      // race-rescue path stub commitsAheadFn directly via opts.commitsAheadFn.
      if (opts.commitsAheadFn) return opts.commitsAheadFn(taskId);
      return heads.has(taskId) ? 1 : 0;
    },

    async commitAllInWorktree(taskId: string, message: CommitMessage) {
      commits.push({ taskId, message });
      return "deadbeefcafe";
    },

    async getBranchShortSha(_branch: string) {
      return "abcdef0";
    },

    async mergeTaskIntoMain(taskId: string, strategy: "squash" | "merge") {
      const n = (mergeCalls[taskId] ?? 0) + 1;
      mergeCalls[taskId] = n;
      mergeStrategies.push(strategy);
      const first = opts.initialMergeResult?.[taskId];
      if (n === 1 && first) {
        return first;
      }
      merges.push(taskId);
      return { ok: true } as const;
    },

    async finalizeMerge(strategy: "squash" | "merge", message?: string) {
      finalizeMergeCount++;
      finalizeMergeCalls.push({ strategy, message });
      if (opts.finalizeMergeThrowsFirst && finalizeMergeCount === 1) {
        throw new Error("nothing staged");
      }
      return "aaaa1111";
    },

    async abortMerge(strategy: "squash" | "merge") {
      abortStrategies.push(strategy);
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
      return finalizeMergeCount;
    },
    finalizeMergeCalls,
    mergeCalls,
    mergeStrategies,
    abortStrategies,
    bumpHead,
    getHead: (taskId: string) => heads.get(taskId) ?? null,
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
    stages: { ...base.stages, ...(opts.config?.stages ?? {}) },
    git: { ...base.git, ...(opts.config?.git ?? {}) },
    ws: { ...base.ws, ...(opts.config?.ws ?? {}) },
    pricing: { ...base.pricing, ...(opts.config?.pricing ?? {}) },
  };

  const defs = opts.taskDefs ?? [mkTaskDef("A")];
  state.syncFromTaskDefs(defs);
  state.recomputeReadiness();
  await state.save();

  const agent = makeFakeAgent(paths, opts.agentScript);
  const git = makeFakeGit(root, paths, opts.gitOpts);
  // Wire HEAD-bump default: a "successful" agent run means the agent
  // committed, so the fake git's HEAD advances. Tests that want to simulate
  // "agent claimed done but didn't commit" can override via setHeadBumpFn(null).
  agent.setHeadBumpFn((taskId) => git.bumpHead(taskId));
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
// Happy path
// ---------------------------------------------------------------------------

test(
  "happy path: 1 task reaches merged with ordered stage transitions (no separate commit stage)",
  { timeout: 10000 },
  async () => {
    // Enable hasUI so the full canonical pipeline runs (UI-check stages
    // are the ones gated by per-task flags).
    const h = await makeHarness({ taskDefs: [mkTaskDef("A", { hasUI: true })] });

    const result = await h.scheduler.runTask("A");
    assert.equal(result.status, "merged");
    assert.equal(result.stage, "merged");
    assert.ok(result.completedAt);

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
      "update-learning:running",
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

    assert.equal(h.git.merges.length, 1);
    assert.deepEqual(h.git.removed, ["A"]);

    const stagesSeen = h.agent.calls.map((c) => c.stage);
    // merge-verify runs after the merge commit lands as a read-only audit.
    assert.deepEqual(stagesSeen, [
      "spec",
      "exec",
      "exec_ui_check",
      "code_review",
      "code_review_ui_check",
      "documentation",
      "update-learning",
      "merge-verify",
    ]);

    // No "commit" stage in the pipeline anymore.
    assert.ok(!stagesSeen.includes("commit"));
  },
);

// ---------------------------------------------------------------------------
// Stage signal — blocked
// ---------------------------------------------------------------------------

test(
  "stage signal blocked moves the task to blocked",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      agentScript: async (call) => {
        if (call.stage === "exec" && call.taskId) {
          // Override the default success signal: write blocked instead.
          const paths = new Paths(path.dirname(path.dirname(call.worktreePath)));
          // Easier: we know the harness path from the test side. Write the
          // signal directly using fs once we know the artefact path.
          await fs.mkdir(path.join(call.worktreePath, "..", "..", "tasks", call.taskId), {
            recursive: true,
          });
          // Use the absolute task signal path through Paths:
        }
        return {};
      },
    });

    // Set a script that writes a blocked signal for exec.
    h.agent.setScript(async (call) => {
      if (call.stage === "exec" && call.taskId) {
        const file = h.paths.taskStageSignal(call.taskId);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify({
            stage: "exec",
            status: "blocked",
            reason: "missing dep",
          }),
          "utf8",
        );
        return {};
      }
      // Default success signal for other stages.
      if (call.taskId) {
        const file = h.paths.taskStageSignal(call.taskId);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify({ stage: call.stage, status: "done" }),
          "utf8",
        );
      }
      return {};
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "blocked");
    assert.equal(t.stage, "exec");
    assert.match(t.lastError?.message ?? "", /missing dep/);
  },
);

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test(
  "runAllOnce with maxConcurrent=2 caps in-flight agent calls",
  { timeout: 15000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A"), mkTaskDef("B"), mkTaskDef("C")],
      config: { maxConcurrent: 2 },
      agentScript: async (_call) => {
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
    assert.ok(h.agent.maxInFlight <= 2);
    assert.ok(h.agent.maxInFlight >= 2);
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
    assert.equal(specCalls, 2);
    assert.equal(t.lastError, undefined);

    const specCallsLog = h.agent.calls.filter((c) => c.stage === "spec");
    assert.equal(specCallsLog.length, 2);
    assert.ok(
      specCallsLog[1]!.extraPrompt &&
        /spec blew up/.test(specCallsLog[1]!.extraPrompt),
    );
  },
);

test(
  "retryCount=0: stage failure pauses the task and emits error notification",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: (call) => {
        if (call.stage === "exec") {
          return { status: "failed", error: "exec crashed", exitCode: 5 };
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "paused");
    assert.equal(t.stage, "exec");
    assert.match(t.lastError!.message, /exec crashed/);

    const errs = h.notifications.filter((n) => n.severity === "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.body, /exec crashed/);
  },
);

test(
  "FLOW_BLOCKED: task moves to blocked with no retry",
  { timeout: 10000 },
  async () => {
    let execCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 5 },
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
    assert.equal(execCalls, 1);

    const n = h.notifications.filter((x) => x.severity === "blocked");
    assert.equal(n.length, 1);
    assert.match(n[0]!.body, /need creds/);
  },
);

// ---------------------------------------------------------------------------
// Merge conflict
// ---------------------------------------------------------------------------

test(
  "merge conflict triggers merge-resolve with inline extraPrompt then completeMerge",
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

    const mr = h.agent.calls.find((c) => c.stage === "merge-resolve");
    assert.ok(mr);
    assert.deepEqual(mr.contextFiles, ["a.ts", "b.ts"]);
    assert.match(mr.extraPrompt ?? "", /Conflicting files/);
    assert.equal(h.git.completeMergeCalls, 1);
    assert.equal(h.git.mergeCalls.A, 1);
  },
);

test(
  "merge-resolve that leaves conflict markers pauses the task",
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
    assert.equal(h.git.completeMergeCalls, 0);
    assert.match(t.lastError!.message, /conflict markers/);
    assert.match(t.lastError!.message, /a\.ts/);
  },
);

// ---------------------------------------------------------------------------
// commit_recovery
// ---------------------------------------------------------------------------

test(
  "commit_recovery runs in the legacy fallback (no signal) when stage finishes dirty",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      gitOpts: { hasUncommittedChanges: true },
    });

    // Disable the default stage-signal write so the scheduler enters the
    // legacy fallback path: succeeded session + HEAD moved + no signal →
    // dirty-check + commit_recovery + advance.
    h.agent.setWriteDefaultSignal(false);

    await h.scheduler.runTask("A");
    const recoveries = h.agent.calls.filter(
      (c) => c.stage === "commit_recovery",
    );
    assert.ok(recoveries.length >= 1);
    assert.equal(recoveries[0]!.skillName, "commit");
  },
);

test(
  "signal=done is sufficient to advance — commit is not required",
  { timeout: 10000 },
  async () => {
    // Simplified contract: trust the agent's done signal. An exec-only
    // task whose agent writes done without committing should advance,
    // regardless of HEAD movement or worktree cleanliness. No
    // commit_recovery, no no_commit pause.
    const h = await makeHarness({
      taskDefs: [
        mkTaskDef("A", {
          hasSpec: false,
          hasUI: false,
          hasCodeReview: false,
        }),
      ],
      config: { hasDocs: false },
      gitOpts: {
        hasUncommittedChanges: false,
        // Force the rev-list rescue to also report no commits.
        commitsAheadFn: () => 0,
      },
    });

    // Default agent writes the done signal but we disable the HEAD bump
    // to simulate "agent forgot the git commit step entirely".
    h.agent.setHeadBumpFn(null);

    const t = await h.scheduler.runTask("A");

    assert.notEqual(
      t.status,
      "paused",
      "task must advance on a done signal alone",
    );
    const recoveries = h.agent.calls.filter(
      (c) => c.stage === "commit_recovery",
    );
    assert.equal(
      recoveries.length,
      0,
      "no commit_recovery should run when signal=done — trust the signal",
    );
  },
);

// ---------------------------------------------------------------------------
// recoverStaleTasks (unchanged behaviour)
// ---------------------------------------------------------------------------

test(
  "recoverStaleTasks resets status=running tasks to paused with an error",
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A"), mkTaskDef("B"), mkTaskDef("C")],
    });
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

    h.upserts.length = 0;

    const recovered = await h.scheduler.recoverStaleTasks();
    assert.equal(recovered.length, 2);
    const ids = recovered.map((t) => t.id).sort();
    assert.deepEqual(ids, ["A", "C"]);

    assert.equal(h.state.getTask("A")!.status, "paused");
    assert.equal(h.state.getTask("B")!.status, "ready");
    assert.equal(h.state.getTask("C")!.status, "paused");
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
      taskDefs: [mkTaskDef("A", { hasUI: true })],
      config: { hasDocs: false },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");

    const stages = h.agent.calls.map((c) => c.stage);
    assert.ok(!stages.includes("documentation"));
    for (const s of [
      "spec",
      "exec",
      "exec_ui_check",
      "code_review",
      "code_review_ui_check",
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
          return { status: "failed", error: "exec boom", exitCode: 1 };
        }
        return {};
      },
    });

    const paused = await h.scheduler.runTask("A");
    assert.equal(paused.status, "paused");
    assert.equal(paused.stage, "exec");

    execFails = false;
    await h.scheduler.retryTask("A");

    const final = h.state.getTask("A")!;
    assert.equal(final.status, "merged");
    assert.equal(final.retries, 0);
    assert.equal(final.lastError, undefined);

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

    assert.equal(h.state.getTask("A")!.status, "ready");
    assert.equal(h.state.getTask("B")!.status, "pending");

    await h.scheduler.runAll();

    assert.equal(h.state.getTask("A")!.status, "merged");
    assert.equal(h.state.getTask("B")!.status, "merged");

    const idxA = order.indexOf("start:A");
    const idxB = order.indexOf("start:B");
    assert.ok(idxA >= 0 && idxB >= 0);
    assert.ok(idxA < idxB);
  },
);

// ---------------------------------------------------------------------------
// Issue 1: Symmetric signal+HEAD advance rule
// ---------------------------------------------------------------------------

test(
  "done signal advances stage even when session ended in failure (signal trumps trailing crash)",
  { timeout: 10000 },
  async () => {
    // Agent wrote the done signal, then the wrapper process stalled on a
    // trailing tool call and got SIGTERMed. The signal indicates the work
    // was finished before the crash — trust it and advance, regardless of
    // HEAD movement.
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: async (call) => {
        if (call.stage === "spec" && call.taskId) {
          specCalls += 1;
          const file = h.paths.taskStageSignal(call.taskId);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(
            file,
            JSON.stringify({ stage: "spec", status: "done" }),
            "utf8",
          );
          // Deliberately do NOT bump HEAD — the new contract advances
          // on signal alone, no commit required.
          return {
            status: "failed",
            error: "Stall: no assistant progress for 180000ms",
            exitCode: 1,
          };
        }
        return {};
      },
    });
    h.agent.setHeadBumpFn(null);

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");
    assert.equal(specCalls, 1);
    assert.equal(t.retries, 0);
  },
);

test(
  "happy path still advances on success when signal + HEAD both present",
  { timeout: 10000 },
  async () => {
    // Default fake agent writes the signal AND the harness wires bumpHead on
    // every successful spawn — this is the regression check that the new
    // symmetric rule doesn't break the existing happy path.
    const h = await makeHarness({ taskDefs: [mkTaskDef("A")] });
    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");
  },
);

// ---------------------------------------------------------------------------
// Issue 2: Transient API errors don't consume the retry budget
// ---------------------------------------------------------------------------

test(
  "transient API errors increment transientRetries, not retries",
  { timeout: 10000 },
  async () => {
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: (call) => {
        if (call.stage === "spec") {
          specCalls += 1;
          if (specCalls === 1) {
            return {
              status: "failed",
              error: "Stream error: idle timeout",
              exitCode: 1,
              transientError: true,
            };
          }
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");
    // retryCount=0 — a non-transient failure would have paused. The transient
    // retry succeeded without consuming retries.
    assert.equal(t.retries, 0);
    assert.equal(specCalls, 2);
  },
);

test(
  "commit detection: rev-list rescue advances stage when headBefore===headAfter but commits exist",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      // Race fixture: the agent committed but the ref-update hadn't
      // landed when the scheduler read HEAD. Suppress the default
      // bumpHead so headBefore === headAfter.
      gitOpts: {
        commitsAheadFn: (taskId) => (taskId === "A" ? 1 : 0),
      },
    });
    h.agent.setHeadBumpFn(null);

    const t = await h.scheduler.runTask("A");
    // Without the rev-list rescue, every stage would loop on
    // bumpRetryOrPause("no_commit") and the task would pause. With the
    // rescue, the pipeline drains to merged.
    assert.equal(t.status, "merged");
  },
);

test(
  "no-retry kinds (api_stream_idle) bypass transient retry and pause for review",
  { timeout: 10000 },
  async () => {
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: (call) => {
        if (call.stage === "spec") {
          specCalls += 1;
          return {
            status: "failed",
            error: "API Error: Stream idle timeout",
            exitCode: 1,
            transientError: false,
            errorKind: "api_stream_idle",
          };
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "paused");
    assert.equal(t.lastError?.kind, "api_stream_idle");
    assert.equal(t.transientRetries, 0);
    // Single attempt — no retry was issued on the no-retry kind.
    assert.equal(specCalls, 1);
  },
);

test(
  "escalation (pause_for_review): consecutive transient retries pause the task with warn-class notification",
  { timeout: 10000 },
  async () => {
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: {
        retryCount: 0,
        escalation: {
          afterTransientRetries: 2,
          policy: "pause_for_review",
          model: "opus[1m]",
        },
      },
      agentScript: (call) => {
        if (call.stage === "spec") {
          specCalls += 1;
          return {
            status: "failed",
            error: "Stream error: idle timeout",
            exitCode: 1,
            transientError: true,
            errorKind: "agent_error",
          };
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "paused");
    // 2 transient retries consumed before escalation fires on the 3rd attempt.
    assert.equal(specCalls, 3);
  },
);

test(
  "escalation (escalate_model): after threshold, next spawn carries the override model and clears on success",
  { timeout: 10000 },
  async () => {
    const calls: Array<{ stage: string; model?: string }> = [];
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: {
        retryCount: 0,
        escalation: {
          afterTransientRetries: 1,
          policy: "escalate_model",
          model: "opus[1m]",
        },
      },
      agentScript: (call, _ctx) => {
        if (call.stage === "spec") {
          specCalls += 1;
          if (specCalls <= 2) {
            return {
              status: "failed",
              error: "Stream error: idle timeout",
              exitCode: 1,
              transientError: true,
              errorKind: "agent_error",
            };
          }
        }
        return {};
      },
    });
    // Capture the model arg per call by wrapping spawnAgent. The Scheduler
    // holds a reference to the runner object so the live wrap is observed.
    const real = h.agent.runner.spawnAgent.bind(h.agent.runner);
    (h.agent.runner as { spawnAgent: typeof real }).spawnAgent = async (
      args,
    ) => {
      calls.push({ stage: String(args.stage), model: args.model });
      return real(args);
    };

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");
    // 3 spec spawns: attempt 1 (transient fail), attempt 2 (transient
    // fail, gates escalation), attempt 3 (escalated model — succeeds).
    const specSpawns = calls.filter((c) => c.stage === "spec");
    assert.equal(specSpawns.length, 3);
    assert.equal(specSpawns[0]?.model, undefined);
    assert.equal(specSpawns[1]?.model, undefined);
    assert.equal(specSpawns[2]?.model, "opus[1m]");
    // After the successful stage, escalatedModel is cleared.
    assert.equal(t.escalatedModel, undefined);
  },
);

test(
  "transientRetries resets to 0 after a successful stage advance",
  { timeout: 10000 },
  async () => {
    let specCalls = 0;
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 0 },
      agentScript: (call) => {
        if (call.stage === "spec") {
          specCalls += 1;
          if (specCalls === 1) {
            return {
              status: "failed",
              error: "Stream error: idle timeout",
              exitCode: 1,
              transientError: true,
            };
          }
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "merged");
    assert.equal(t.transientRetries, 0);
  },
);

// ---------------------------------------------------------------------------
// Resume from a stage that was filtered out by a flag change
// ---------------------------------------------------------------------------

test(
  "resume: paused at a now-filtered-out stage advances to next valid stage, not stage 0",
  { timeout: 10000 },
  async () => {
    // hasUI=false drops both UI-check stages. Persist a paused state at
    // exec_ui_check — a stage that no longer exists in this task's filtered
    // list — and verify resume jumps to code_review (the successor) rather
    // than rewinding to spec.
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A", { hasUI: false })],
    });
    const a = h.state.getTask("A")!;
    a.status = "paused";
    a.stage = "exec_ui_check";
    a.startedAt = nowIsoLocal();
    h.state.upsertTask(a);
    await h.state.save();

    h.notifications.length = 0;
    h.agent.calls.length = 0;

    await h.scheduler.retryTask("A");

    const stagesSeen = h.agent.calls.map((c) => c.stage);
    assert.equal(
      stagesSeen[0],
      "code_review",
      `expected first stage after resume to be code_review, got ${stagesSeen[0]}`,
    );
    assert.ok(!stagesSeen.includes("spec"), "must not rewind to spec");
    assert.ok(
      !stagesSeen.includes("exec"),
      "must not rewind to exec either",
    );

    const warnNotifs = h.notifications.filter((n) => n.severity === "warn");
    assert.equal(
      warnNotifs.length,
      0,
      "filtered-out is a clean case, no warn expected",
    );
  },
);

test(
  "resume: paused at an unknown stage emits warn notification and restarts from first stage",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({ taskDefs: [mkTaskDef("A")] });
    const a = h.state.getTask("A")!;
    a.status = "paused";
    a.stage = "totally-not-a-real-stage" as TaskStage;
    a.startedAt = nowIsoLocal();
    h.state.upsertTask(a);
    await h.state.save();

    h.notifications.length = 0;
    h.agent.calls.length = 0;

    await h.scheduler.retryTask("A");

    const stagesSeen = h.agent.calls.map((c) => c.stage);
    assert.equal(stagesSeen[0], "spec", "unknown stage should restart from spec");

    const warnNotifs = h.notifications.filter(
      (n) => n.severity === "warn" && n.title === "Resume: unknown stage",
    );
    assert.equal(warnNotifs.length, 1, "expected exactly one unknown-stage warn");
    assert.match(warnNotifs[0]!.body, /totally-not-a-real-stage/);
  },
);

test(
  "missing prompt: stage pauses with actionable message on first attempt (no retries)",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      config: { retryCount: 5 },
      agentScript: (call) => {
        if (call.stage === "spec") {
          throw new MissingPromptError(
            "spec",
            "/fake/.flow/prompts/prompt-spec.md",
          );
        }
        return {};
      },
    });

    const t = await h.scheduler.runTask("A");
    assert.equal(t.status, "paused");
    assert.equal(t.stage, "spec");
    assert.match(t.lastError!.message, /Prompt "spec" missing/);
    assert.match(t.lastError!.message, /flow init/);

    const specCalls = h.agent.calls.filter((c) => c.stage === "spec");
    assert.equal(
      specCalls.length,
      1,
      "missing-prompt is non-retryable — should not consume retry budget",
    );

    const errs = h.notifications.filter((n) => n.severity === "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.body, /Prompt "spec" missing/);
  },
);

test(
  "runAll drain survives a per-task throw: peer task still completes",
  { timeout: 10000 },
  async () => {
    const h = await makeHarness({
      taskDefs: [mkTaskDef("A"), mkTaskDef("B")],
      config: { retryCount: 0, maxConcurrent: 2 },
      agentScript: (call) => {
        if (call.taskId === "A" && call.stage === "spec") {
          throw new MissingPromptError(
            "spec",
            "/fake/.flow/prompts/prompt-spec.md",
          );
        }
        return {};
      },
    });

    await h.scheduler.runAll();

    const a = h.state.getTask("A")!;
    const b = h.state.getTask("B")!;
    assert.equal(a.status, "paused", "broken task should be paused, not running");
    assert.match(a.lastError!.message, /Prompt "spec" missing/);
    assert.equal(
      b.status,
      "merged",
      "healthy peer should reach merged despite A's failure",
    );
  },
);

function nowIsoLocal(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// pauseAllRunning — SIGINT checkpoint helper
// ---------------------------------------------------------------------------

test(
  "pauseAllRunning checkpoints in-flight tasks to paused with the given message",
  { timeout: 10000 },
  async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });

    const h = await makeHarness({
      taskDefs: [mkTaskDef("A")],
      agentScript: async () => {
        await blocker;
        return {};
      },
    });

    // Kick off runTask without awaiting. runTask synchronously registers A in
    // its `running` map before its first await, so by the next microtask
    // pauseAllRunning can observe A as in-flight.
    const inFlight = h.scheduler.runTask("A");

    // Poll briefly until runAgentStage flips status to "running" (it sets
    // status before spawning the agent, so this happens early).
    for (let i = 0; i < 100; i++) {
      if (h.state.getTask("A")?.status === "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(h.state.getTask("A")!.status, "running");

    await h.scheduler.pauseAllRunning("Cancelled by SIGINT");

    const a = h.state.getTask("A")!;
    assert.equal(a.status, "paused");
    assert.equal(a.lastError?.message, "Cancelled by SIGINT");
    assert.ok(a.lastError?.stage, "lastError must record the stage");

    // Release the blocked agent so runTask can settle and the test cleans up.
    release();
    await inFlight.catch(() => {
      /* the pipeline keeps going past our pause; outcome doesn't matter */
    });
  },
);

test("pauseAllRunning is a no-op when nothing is in-flight", async () => {
  const h = await makeHarness({ taskDefs: [mkTaskDef("A")] });
  h.upserts.length = 0;
  await h.scheduler.pauseAllRunning("Cancelled by SIGINT");
  assert.equal(h.upserts.length, 0);
  assert.equal(h.state.getTask("A")!.status, "ready");
});
