import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import { EventBus } from "../src/events.js";
import { defaultConfig } from "../src/config.js";
import {
  AgentRunner,
  composePrompt,
  type ProcessSpawner,
  type SpawnedProcess,
} from "../src/agent.js";
import type {
  Notification,
  Session,
  SessionEvent,
  TaskDef,
} from "../src/types.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "flow-agent-"));
}

async function writeSkill(paths: Paths, name: string, body: string): Promise<void> {
  const file = paths.skillFile(name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
}

interface Script {
  stdout: string[];
  exitCode: number;
  stderr?: string[];
  delayMs?: number;
}

interface FakeCall {
  bin: string;
  args: string[];
  cwd: string;
  killed: boolean;
  killSignal?: NodeJS.Signals;
}

interface FakeSpawnerHandle {
  spawner: ProcessSpawner;
  calls: FakeCall[];
  /** Queue one script per invocation. If none remain, the call yields no stdout and exits 0. */
  queue: Script[];
}

function makeFakeSpawner(): FakeSpawnerHandle {
  const calls: FakeCall[] = [];
  const queue: Script[] = [];
  const spawner: ProcessSpawner = ({ bin, args, cwd }) => {
    const script: Script = queue.shift() ?? { stdout: [], exitCode: 0 };
    const call: FakeCall = { bin, args, cwd, killed: false };
    calls.push(call);

    let exitResolve!: (n: number) => void;
    const exit = new Promise<number>((r) => {
      exitResolve = r;
    });

    let stopped = false;

    async function* stdoutGen(): AsyncIterable<string> {
      try {
        for (const line of script.stdout) {
          if (stopped) return;
          yield line;
        }
      } finally {
        // When stdout iteration completes (or is broken out of), resolve
        // exit on the next tick so any lingering kill() wins the race.
        setImmediate(() => exitResolve(script.exitCode));
      }
    }

    async function* stderrGen(): AsyncIterable<string> {
      for (const line of script.stderr ?? []) {
        if (stopped) return;
        yield line;
      }
    }

    const proc: SpawnedProcess = {
      stdout: stdoutGen(),
      stderr: stderrGen(),
      exit,
      kill(signal?: NodeJS.Signals) {
        call.killed = true;
        call.killSignal = signal;
        stopped = true;
        exitResolve(script.exitCode);
      },
    };

    return proc;
  };
  return { spawner, calls, queue };
}

function makeRunner(
  root: string,
  spawnerHandle: FakeSpawnerHandle,
): { runner: AgentRunner; paths: Paths; bus: EventBus } {
  const paths = new Paths(root);
  const bus = new EventBus();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner: spawnerHandle.spawner,
    now: () => new Date(),
  });
  return { runner, paths, bus };
}

// ---------------------------------------------------------------------------
// composePrompt
// ---------------------------------------------------------------------------

test("composePrompt references skill via @path and includes task + context files", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "SKILL BODY");

  const task: TaskDef = {
    id: "T1",
    title: "Build widget",
    description: "Creates a new widget component",
    contextFiles: [],
    requires: [],
  };

  const prompt = await composePrompt(
    { paths },
    {
      taskId: "T1",
      stage: "exec",
      skillName: "exec",
      worktreePath: root,
      task,
      contextFiles: ["src/a.ts", "src/b.ts"],
      extraPrompt: "Prev stage notes go here.",
    },
  );

  assert.ok(
    prompt.startsWith(`@${paths.skillFile("exec")}`),
    "prompt must begin with @<skill-path>",
  );
  assert.match(prompt, /# Task\nBuild widget/);
  assert.match(prompt, /Creates a new widget component/);
  // Old framing labels are gone.
  assert.doesNotMatch(prompt, /Title:/);
  assert.doesNotMatch(prompt, /Description:/);
  assert.match(prompt, /# Runtime paths/);
  assert.match(prompt, /progress\.txt:/);
  assert.match(prompt, /stage signal:/);
  assert.match(prompt, /# Progress notes/);
  assert.match(prompt, /# Context files/);
  assert.match(prompt, /@src\/a\.ts/);
  assert.match(prompt, /@src\/b\.ts/);
  assert.match(prompt, /Prior session summaries/);
  assert.match(prompt, /Prev stage notes/);
  assert.match(prompt, /# Stage protocol/);
});

test("composePrompt omits sections with no content", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "SKILL BODY");

  const prompt = await composePrompt(
    { paths },
    {
      taskId: null,
      stage: "exec",
      skillName: "exec",
      worktreePath: root,
    },
  );
  assert.ok(prompt.startsWith(`@${paths.skillFile("exec")}`));
  assert.doesNotMatch(prompt, /# Task/);
  assert.doesNotMatch(prompt, /# Context files/);
  assert.doesNotMatch(prompt, /Prior session/);
});

test("composePrompt throws with skill name when skill file missing", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await assert.rejects(
    composePrompt(
      { paths },
      {
        taskId: null,
        stage: "exec",
        skillName: "noSuchSkill",
        worktreePath: root,
      },
    ),
    (err: Error) => /noSuchSkill/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// spawnAgent — happy path
// ---------------------------------------------------------------------------

test("spawnAgent happy path: emits events, writes JSONL, computes cost", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths, bus } = makeRunner(root, spawnerHandle);

  await writeSkill(paths, "exec", "do the thing");

  const usageLine = JSON.stringify({
    type: "result",
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 100,
    },
  });

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello world" }] },
      }),
      usageLine,
    ],
    exitCode: 0,
  });
  // Context probe — return a line with "42%"
  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Context: 42%" }] } })],
    exitCode: 0,
  });

  const started: Session[] = [];
  const events: SessionEvent[] = [];
  const ended: Session[] = [];
  bus.on("session.started", ({ session }) => started.push(session));
  bus.on("session.event", ({ event }) => events.push(event));
  bus.on("session.ended", ({ session }) => ended.push(session));

  const taskId = "T1";
  const session = await runner.spawnAgent({
    taskId,
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
    task: {
      id: taskId,
      title: "t",
      description: "d",
      contextFiles: [],
      requires: [],
    },
  });

  assert.equal(session.status, "succeeded");
  assert.equal(session.exitCode, 0);
  assert.equal(session.tokens.input, 1000);
  assert.equal(session.tokens.output, 500);
  assert.equal(session.tokens.cacheRead, 2000);
  assert.equal(session.tokens.cacheCreate, 100);
  assert.equal(session.tokens.total, 3600);
  assert.ok(session.costUsd > 0, "cost should be computed");
  assert.equal(started.length, 1);
  assert.ok(events.length >= 3, `expected >=3 events, got ${events.length}`);
  assert.equal(ended.length, 1);

  // JSONL has 3 lines.
  const raw = await fs.readFile(paths.sessionJsonl(taskId, session.id), "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 3);

  // Meta file persisted.
  const meta = JSON.parse(
    await fs.readFile(paths.sessionMeta(taskId, session.id), "utf8"),
  );
  assert.equal(meta.status, "succeeded");

  // Context probe fired as second spawner call.
  assert.equal(spawnerHandle.calls.length, 2);
  assert.ok(spawnerHandle.calls[1]!.args.includes("/context"));
  assert.equal(session.contextPercentage, 42);
});

// ---------------------------------------------------------------------------
// FLOW_BLOCKED
// ---------------------------------------------------------------------------

test("FLOW_BLOCKED marker kills process, emits notification, marks failed", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths, bus } = makeRunner(root, spawnerHandle);

  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "FLOW_BLOCKED: creds missing" }],
        },
      }),
      // These lines should not matter — we kill after the marker.
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "more" }] } }),
    ],
    exitCode: 0,
  });

  const notifs: Notification[] = [];
  bus.on("notification", ({ notification }) => notifs.push(notification));

  const session = await runner.spawnAgent({
    taskId: "T2",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /FLOW_BLOCKED: creds missing/);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0]!.severity, "blocked");
  assert.match(notifs[0]!.body, /creds missing/);
  assert.equal(spawnerHandle.calls[0]!.killed, true);
  // No context probe should fire for failed session.
  assert.equal(spawnerHandle.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Autocompact
// ---------------------------------------------------------------------------

test("autocompact: compact_boundary line + exit 0 yields status=autocompacted", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, bus } = makeRunner(root, spawnerHandle);
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    ],
    exitCode: 0,
  });
  // Context probe
  spawnerHandle.queue.push({ stdout: [], exitCode: 0 });

  const updated: Session[] = [];
  bus.on("session.updated", ({ session }) => updated.push(session));

  const session = await runner.spawnAgent({
    taskId: "T3",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "autocompacted");
  assert.equal(session.autocompacted, true);
  assert.equal(session.exitCode, 0);
});

// ---------------------------------------------------------------------------
// Nonzero exit
// ---------------------------------------------------------------------------

test("nonzero exit code yields status=failed with error string", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner } = makeRunner(root, spawnerHandle);
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 17,
  });

  const session = await runner.spawnAgent({
    taskId: "T4",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.equal(session.exitCode, 17);
  assert.match(session.error ?? "", /17/);
});

// ---------------------------------------------------------------------------
// Context probe is best-effort when not scripted
// ---------------------------------------------------------------------------

test("context probe no-op when spawner has no further script; doesn't throw", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner } = makeRunner(root, spawnerHandle);
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 0,
  });
  // No context probe script queued — the fake spawner returns empty/exit 0.

  const session = await runner.spawnAgent({
    taskId: "T5",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "succeeded");
  assert.equal(session.contextPercentage, undefined);
});

// ---------------------------------------------------------------------------
// Skill missing → throws
// ---------------------------------------------------------------------------

test("spawnAgent throws clear error when skill missing", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner } = makeRunner(root, spawnerHandle);

  await assert.rejects(
    runner.spawnAgent({
      taskId: null,
      stage: "setup",
      skillName: "missingSkill",
      worktreePath: root,
    }),
    (err: Error) => /missingSkill/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Issue 4: partial .meta.json visible while session runs
// ---------------------------------------------------------------------------

test("partial .meta.json contains id, taskId, stage, startedAt before session ends", async () => {
  // This exercises the partial-write code path by intercepting the spawner
  // and reading the meta file from inside the spawner factory — a moment
  // strictly between the partial write (just before spawn) and the final
  // write (just before session.ended).
  const root = await mkTmp();
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  const taskId = "T-partial-2";
  let snapshot: string | null = null;

  const spawner: ProcessSpawner = ({ bin: _b, args: _a, cwd: _c }) => {
    // At this point, the partial meta should already be on disk.
    // We can't await here (sync factory), so kick off a read in the
    // background and await it shortly after.
    // Use a sync path resolver: the meta dir is the per-task sessions dir.
    // Find any file under it and read it.
    return {
      stdout: (async function* () {
        // Read all meta files under task sessions dir.
        try {
          const dir = paths.taskSessionsDir(taskId);
          const entries = await fs.readdir(dir);
          const meta = entries.find((f) => f.endsWith(".meta.json"));
          if (meta) {
            snapshot = await fs.readFile(path.join(dir, meta), "utf8");
          }
        } catch {
          /* ignore */
        }
        yield JSON.stringify({ type: "system", subtype: "init" });
      })(),
      stderr: (async function* () {
        /* none */
      })(),
      exit: Promise.resolve(0),
      kill() {
        /* no-op */
      },
    };
  };

  const bus = new EventBus();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner,
    now: () => new Date(),
  });

  const session = await runner.spawnAgent({
    taskId,
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.ok(snapshot, "partial meta should be on disk during the session");
  const partial = JSON.parse(snapshot!);
  assert.equal(partial.id, session.id);
  assert.equal(partial.taskId, taskId);
  assert.equal(partial.stage, "exec");
  assert.equal(typeof partial.startedAt, "string");
  assert.ok(partial.startedAt.length > 0);
  // The partial write happens before exit, so status is still "running".
  assert.equal(partial.status, "running");
});

// ---------------------------------------------------------------------------
// Issue 5: project-level (taskId: null) meta has populated id
// ---------------------------------------------------------------------------

test("project-level session meta has non-null id matching the session ULID", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "setup", "skill");

  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 0,
  });
  // Context probe (only fires for non-failed sessions; this one will succeed).
  spawnerHandle.queue.push({ stdout: [], exitCode: 0 });

  const session = await runner.spawnAgent({
    taskId: null,
    stage: "setup",
    skillName: "setup",
    worktreePath: root,
  });

  assert.equal(session.taskId, null);
  assert.ok(session.id);

  const metaPath = paths.sessionMeta(null, session.id);
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(meta.id, session.id);
  assert.notEqual(meta.id, null);
});

// ---------------------------------------------------------------------------
// Stall watchdog: Task subagent activity + rate-limit reclassification
// ---------------------------------------------------------------------------

interface StallScriptFrame {
  /** JSON line to emit, or `null` to just sleep. */
  line: string | null;
  /** Sleep AFTER yielding this line (or just sleep, if line is null). */
  delayMs: number;
}

function makeStallSpawner(frames: StallScriptFrame[]): {
  spawner: ProcessSpawner;
  call: { value: FakeCall | null };
} {
  const ref: { value: FakeCall | null } = { value: null };
  const spawner: ProcessSpawner = ({ bin, args, cwd }) => {
    const call: FakeCall = { bin, args, cwd, killed: false };
    ref.value = call;

    let exitResolve!: (n: number) => void;
    const exit = new Promise<number>((r) => {
      exitResolve = r;
    });
    let stopped = false;

    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => setTimeout(r, ms).unref?.());

    async function* stdoutGen(): AsyncIterable<string> {
      try {
        for (const frame of frames) {
          if (stopped) return;
          if (frame.line !== null) yield frame.line;
          if (stopped) return;
          if (frame.delayMs > 0) await sleep(frame.delayMs);
        }
      } finally {
        setImmediate(() => exitResolve(0));
      }
    }

    async function* stderrGen(): AsyncIterable<string> {
      // none
      if (stopped) return;
    }

    return {
      stdout: stdoutGen(),
      stderr: stderrGen(),
      exit,
      kill(signal?: NodeJS.Signals) {
        call.killed = true;
        call.killSignal = signal;
        stopped = true;
        exitResolve(0);
      },
    };
  };
  return { spawner, call: ref };
}

function makeStallRunner(
  root: string,
  spawner: ProcessSpawner,
  stallTimeoutMs: number,
): { runner: AgentRunner; paths: Paths; bus: EventBus } {
  const paths = new Paths(root);
  const bus = new EventBus();
  const config = { ...defaultConfig(), stallTimeoutMs };
  const runner = new AgentRunner({
    paths,
    config,
    eventBus: bus,
    spawner,
    now: () => new Date(),
  });
  return { runner, paths, bus };
}

test("task_progress refreshes the stall watchdog", async () => {
  const root = await mkTmp();
  const STALL_MS = 200;
  const STEP_MS = 100;

  const frames: StallScriptFrame[] = [
    { line: JSON.stringify({ type: "system", subtype: "init" }), delayMs: 0 },
    {
      line: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "starting" }] },
      }),
      delayMs: STEP_MS,
    },
  ];
  // 6 task_progress frames spaced just under STALL_MS apart — total wall time
  // (~600ms) is longer than STALL_MS, proving the watchdog stayed armed only
  // because each task_progress frame refreshed it.
  for (let i = 0; i < 6; i++) {
    frames.push({
      line: JSON.stringify({
        type: "system",
        subtype: "task_progress",
        task_id: "tk1",
        tool_use_id: "tu1",
        description: `step ${i}`,
      }),
      delayMs: STEP_MS,
    });
  }

  const { spawner } = makeStallSpawner(frames);
  const { runner, paths } = makeStallRunner(root, spawner, STALL_MS);
  await writeSkill(paths, "exec", "skill");

  const session = await runner.spawnAgent({
    taskId: "T-stall-1",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "succeeded", `error: ${session.error}`);
  assert.doesNotMatch(session.error ?? "", /Stall:/);
  assert.equal(session.transientError, undefined);
});

test("stall after rate_limit_event marks session as transientError", async () => {
  const root = await mkTmp();
  const STALL_MS = 150;

  const frames: StallScriptFrame[] = [
    { line: JSON.stringify({ type: "system", subtype: "init" }), delayMs: 0 },
    {
      line: JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", overageStatus: "rejected" },
      }),
      delayMs: 0,
    },
    // Long silence — past STALL_MS — with no progress frames.
    { line: null, delayMs: STALL_MS * 4 },
  ];

  const { spawner } = makeStallSpawner(frames);
  const { runner, paths } = makeStallRunner(root, spawner, STALL_MS);
  await writeSkill(paths, "exec", "skill");

  const session = await runner.spawnAgent({
    taskId: "T-stall-2",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /^Stall:/);
  assert.equal(session.transientError, true);
});

test("stall without rate_limit_event leaves transientError unset", async () => {
  const root = await mkTmp();
  const STALL_MS = 150;

  const frames: StallScriptFrame[] = [
    { line: JSON.stringify({ type: "system", subtype: "init" }), delayMs: 0 },
    { line: null, delayMs: STALL_MS * 4 },
  ];

  const { spawner } = makeStallSpawner(frames);
  const { runner, paths } = makeStallRunner(root, spawner, STALL_MS);
  await writeSkill(paths, "exec", "skill");

  const session = await runner.spawnAgent({
    taskId: "T-stall-3",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /^Stall:/);
  assert.equal(session.transientError, undefined);
});
