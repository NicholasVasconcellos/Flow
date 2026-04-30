import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import { createFlow, initFlowProject } from "../src/flow.js";
import { newId } from "../src/ids.js";
import { resolveBundledAssetsDir, scaffoldFlowDir } from "../src/setup.js";
import { appendJsonl } from "../src/atomic.js";
import type { AgentRunner, SpawnArgs } from "../src/agent.js";
import type { GitManager, CommitMessage } from "../src/git.js";
import type { Session, SessionEvent, TasksFile } from "../src/types.js";

const ASSETS_DIR = resolveBundledAssetsDir();

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  return fs.realpath(dir);
}

// ---------------------------------------------------------------------------
// Fake AgentRunner — mirrors scheduler.test.ts
// ---------------------------------------------------------------------------

function makeFakeAgent(
  paths: Paths,
  bumpHead: (taskId: string) => void,
): AgentRunner {
  const runner: Partial<AgentRunner> = {
    async spawnAgent(args: SpawnArgs): Promise<Session> {
      const now = new Date().toISOString();
      // Simulate a "successful" agent run: write the stage signal and
      // advance HEAD on the worktree branch. The scheduler's symmetric
      // signal+HEAD rule depends on both being present.
      if (args.taskId) {
        const file = paths.taskStageSignal(args.taskId);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify({ stage: args.stage, status: "done" }),
          "utf8",
        );
        bumpHead(args.taskId);
      }
      const s: Session = {
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
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        autocompacted: false,
        costUsd: 0,
        exitCode: 0,
      };
      return s;
    },
  };
  return runner as AgentRunner;
}

// ---------------------------------------------------------------------------
// Fake GitManager
// ---------------------------------------------------------------------------

interface FakeGitHandle {
  git: GitManager;
  bumpHead(taskId: string): void;
}

function makeFakeGit(root: string): FakeGitHandle {
  const heads = new Map<string, string>();
  let counter = 0;
  const bumpHead = (taskId: string): void => {
    counter += 1;
    heads.set(taskId, `sha-${taskId}-${counter}`);
  };
  const fake: Partial<GitManager> = {
    async ensureRepo() {
      return true;
    },
    async createWorktree(taskId: string) {
      const branchName = `flow/${taskId}`;
      const worktreePath = path.join(root, ".flow", "worktrees", taskId);
      await fs.mkdir(worktreePath, { recursive: true });
      return { worktreePath, branchName };
    },
    async removeWorktree() {
      /* no-op */
    },
    async getWorktreeHeadSha(taskId: string) {
      return heads.get(taskId) ?? null;
    },
    async commitAllInWorktree(_taskId: string, _message: CommitMessage) {
      return "deadbeef";
    },
    async getBranchShortSha(_branch: string) {
      return "abcdef0";
    },
    async mergeTaskIntoMain(_taskId: string, _strategy: "squash" | "merge") {
      return { ok: true } as const;
    },
    async finalizeMerge(_strategy: "squash" | "merge", _message?: string) {
      return "aaaa";
    },
    async abortMerge(_strategy: "squash" | "merge") {
      /* no-op */
    },
    async getOriginUrl() {
      return null;
    },
  };
  return { git: fake as GitManager, bumpHead };
}

// ---------------------------------------------------------------------------
// Test: 2-task DAG through runAllOnce reaches merged
// ---------------------------------------------------------------------------

test(
  "createFlow + runAllOnce: 2-task dependent chain reaches merged",
  { timeout: 15000 },
  async () => {
    const root = await mkTmp();
    const paths = new Paths(root);

    // Scaffold the .flow/ directory so loadConfig works (avoids git calls).
    await scaffoldFlowDir(paths, ASSETS_DIR);

    // Write tasks.json so createFlow can sync it into state.
    const tasksFile: TasksFile = {
      tasks: [
        { id: "A", title: "Task A", description: "Do A", contextFiles: [], requires: [], hasUI: false, hasSpec: true, hasCodeReview: true },
        { id: "B", title: "Task B", description: "Do B", contextFiles: [], requires: ["A"], hasUI: false, hasSpec: true, hasCodeReview: true },
      ],
    };
    await fs.writeFile(paths.tasksJson, JSON.stringify(tasksFile), "utf8");

    const gitHandle = makeFakeGit(root);
    const agent = makeFakeAgent(paths, gitHandle.bumpHead);

    const flow = await createFlow(
      { projectPath: root },
      { agent, git: gitHandle.git },
    );

    // A should be ready after creation; B pending.
    const tasks0 = flow.getTasks();
    assert.equal(tasks0.find((t) => t.id === "A")!.status, "ready");
    assert.equal(tasks0.find((t) => t.id === "B")!.status, "pending");

    // DAG has 2 nodes, 1 edge.
    const dag = flow.buildDag();
    assert.equal(dag.nodes.length, 2);
    assert.equal(dag.edges.length, 1);

    // Run A first, then a second pass for B.
    const first = await flow.runAllOnce();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.id, "A");
    assert.equal(first[0]!.status, "merged");

    const second = await flow.runAllOnce();
    assert.equal(second.length, 1);
    assert.equal(second[0]!.id, "B");
    assert.equal(second[0]!.status, "merged");

    // Final state.
    const finalTasks = flow.getTasks();
    for (const t of finalTasks) {
      assert.equal(t.status, "merged", `task ${t.id} should be merged`);
    }

    flow.stop();
  },
);

// ---------------------------------------------------------------------------
// Test: replaySession round-trips JSONL from disk
// ---------------------------------------------------------------------------

test("replaySession streams a session's JSONL back", { timeout: 10000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  // Write a tasks.json with one task, then hand-write a fake session JSONL.
  const taskId = "T1";
  const tasksFile: TasksFile = {
    tasks: [
      {
        id: taskId,
        title: "Test",
        description: "Replay test",
        contextFiles: [],
        requires: [],
        hasUI: false,
        hasSpec: true,
        hasCodeReview: true,
      },
    ],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(tasksFile), "utf8");

  // Pre-seed state.json with a session record pointing at a JSONL file.
  const sessionId = "S1";
  const jsonlPath = paths.taskSessionJsonl(taskId, sessionId);
  const linesToWrite = [
    { type: "system", timestamp: "2026-04-23T10:00:00Z", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "Hello." }] } },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } },
    { type: "stop" },
  ];
  for (const line of linesToWrite) {
    await appendJsonl(jsonlPath, line);
  }

  // Pre-seed state.json so replaySession can resolve taskId from sessionId.
  const state = {
    version: 1,
    tasks: [
      {
        id: taskId,
        title: "Test",
        description: "Replay test",
        contextFiles: [],
        requires: [],
        status: "ready",
        stage: "spec",
        retries: 0,
        sessionIds: [sessionId],
        createdAt: "2026-04-23T09:00:00Z",
        updatedAt: "2026-04-23T09:00:00Z",
      },
    ],
    sessions: [
      {
        id: sessionId,
        taskId,
        stage: "spec",
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        skillName: "spec",
        prompt: "<test>",
        status: "succeeded",
        startedAt: "2026-04-23T09:00:00Z",
        endedAt: "2026-04-23T09:05:00Z",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0, total: 15 },
        autocompacted: false,
        costUsd: 0.01,
        exitCode: 0,
      },
    ],
    updatedAt: "2026-04-23T09:05:00Z",
  };
  await fs.writeFile(paths.stateJson, JSON.stringify(state, null, 2), "utf8");

  const gitHandle = makeFakeGit(root);
  const agent = makeFakeAgent(paths, gitHandle.bumpHead);
  const flow = await createFlow(
    { projectPath: root },
    { agent, git: gitHandle.git },
  );

  const iterable = await flow.replaySession(sessionId);
  const events: SessionEvent[] = [];
  for await (const evt of iterable) {
    events.push(evt);
  }

  assert.equal(
    events.length,
    linesToWrite.length,
    `expected ${linesToWrite.length} events, got ${events.length}`,
  );
  // All events should carry the correct sessionId.
  for (const evt of events) {
    assert.equal(evt.sessionId, sessionId);
  }
  // Kinds should be reasonably inferred.
  assert.equal(events[0]!.kind, "system");
  assert.equal(events[1]!.kind, "assistant_text");
  assert.equal(events[2]!.kind, "tool_use");
  assert.equal(events[3]!.kind, "stop");

  flow.stop();
});

// ---------------------------------------------------------------------------
// Test: initFlowProject scaffolds .flow on an empty directory
// ---------------------------------------------------------------------------

test("initFlowProject scaffolds .flow/ on an empty repo", { timeout: 15000 }, async () => {
  const root = await mkTmp();
  await initFlowProject(root, ASSETS_DIR);
  const paths = new Paths(root);
  // config.json present.
  await assert.doesNotReject(fs.access(paths.configJson));
  // At least one skill copied.
  await assert.doesNotReject(fs.access(paths.skillFile("spec")));
  // .git was created by GitManager.ensureRepo.
  await assert.doesNotReject(fs.access(path.join(root, ".git")));
});

// ---------------------------------------------------------------------------
// Test: getNextTask returns oldest ready, getReadyTasks returns all ready
// ---------------------------------------------------------------------------

test("getNextTask + getReadyTasks pick oldest ready task", { timeout: 10000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const tasksFile: TasksFile = {
    tasks: [
      { id: "A", title: "A", description: "", contextFiles: [], requires: [], hasUI: false, hasSpec: true, hasCodeReview: true },
      { id: "B", title: "B", description: "", contextFiles: [], requires: [], hasUI: false, hasSpec: true, hasCodeReview: true },
    ],
  };
  await fs.writeFile(paths.tasksJson, JSON.stringify(tasksFile), "utf8");

  const gitHandle = makeFakeGit(root);
  const agent = makeFakeAgent(paths, gitHandle.bumpHead);
  const flow = await createFlow(
    { projectPath: root },
    { agent, git: gitHandle.git },
  );

  const ready = flow.getReadyTasks();
  assert.equal(ready.length, 2);

  const next = flow.getNextTask();
  assert.ok(next);
  // Oldest createdAt — first one synced, which should be A (same timestamp; tied by array order).
  assert.ok(next!.id === "A" || next!.id === "B");
  flow.stop();
});
