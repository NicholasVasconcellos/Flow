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
  state?: StateStore,
): { runner: AgentRunner; paths: Paths; bus: EventBus } {
  const paths = new Paths(root);
  const bus = new EventBus();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner: spawnerHandle.spawner,
    now: () => new Date(),
    ...(state ? { state } : {}),
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
    hasUI: false,
    hasSpec: true,
    hasCodeReview: true,
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
  assert.match(prompt, /# Workspace/);
  assert.match(prompt, /progress\.txt:/);
  assert.match(prompt, /stage signal:/);
  assert.match(prompt, /# Context\n@/);
  assert.match(prompt, /@src\/a\.ts/);
  assert.match(prompt, /@src\/b\.ts/);
  assert.match(prompt, /# Prior session notes/);
  assert.match(prompt, /Prev stage notes/);
  // Stage protocol prose moved into per-stage SKILL.md bodies.
  assert.doesNotMatch(prompt, /# Stage protocol/);
  // Runtime paths block was renamed to Workspace.
  assert.doesNotMatch(prompt, /# Runtime paths/);
  // Progress notes is now folded into the Context section as the first @path.
  assert.doesNotMatch(prompt, /# Progress notes/);
  // Learnings block is now lean (3 bullets, no "Learnings draft" header).
  assert.match(prompt, /# Learnings\n- Append to learnings-draft\.md/);
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
  assert.doesNotMatch(prompt, /# Context/);
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

test("composePrompt does not inline a stage-protocol block (each SKILL.md owns its Done-when)", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  for (const name of ["merge-resolve", "update-learning", "exec"]) {
    await writeSkill(paths, name, "SKILL BODY");
  }

  for (const stage of ["merge-resolve", "update-learning", "exec"] as const) {
    const prompt = await composePrompt(
      { paths },
      {
        taskId: "T1",
        stage,
        skillName: stage,
        worktreePath: root,
      },
    );

    assert.doesNotMatch(prompt, /# Stage protocol/, `${stage}: protocol block should be gone`);
    assert.doesNotMatch(prompt, /git add -A && git commit/, `${stage}: commit instruction lives in skill body, not prompt`);
    assert.doesNotMatch(prompt, /Write the stage signal and stop/, `${stage}: signal-emit text lives in skill body, not prompt`);
  }
});

test("composePrompt only emits Learnings block for LEARNINGS_DRAFT stages", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  for (const name of ["exec", "merge-resolve", "update-learning"]) {
    await writeSkill(paths, name, "SKILL BODY");
  }

  const execPrompt = await composePrompt(
    { paths },
    {
      taskId: "T1",
      stage: "exec",
      skillName: "exec",
      worktreePath: root,
    },
  );
  assert.match(execPrompt, /# Learnings\n- Append to learnings-draft\.md/);

  const mergePrompt = await composePrompt(
    { paths },
    {
      taskId: "T1",
      stage: "merge-resolve",
      skillName: "merge-resolve",
      worktreePath: root,
    },
  );
  assert.doesNotMatch(mergePrompt, /# Learnings/);

  const learningPrompt = await composePrompt(
    { paths },
    {
      taskId: "T1",
      stage: "update-learning",
      skillName: "update-learning",
      worktreePath: root,
    },
  );
  assert.doesNotMatch(learningPrompt, /# Learnings/);
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
  // No probe stub queued: the in-stream `usage` line above populates
  // contextPercentage during the run, so the post-run fallback probe is
  // skipped (see `observedInStream` gate in agent.ts).

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
      hasUI: false,
      hasSpec: true,
      hasCodeReview: true,
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

  // Probe was skipped: the in-stream usage event populated contextPercentage.
  // 3100 (input + cache_read + cache_create) / 200000 = 1.55% → rounds to 2.
  assert.equal(spawnerHandle.calls.length, 1);
  assert.equal(session.contextPercentage, 2);
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

test("synthetic stream-idle in assistant text → errorKind=api_stream_idle, transientError=false", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner } = makeRunner(root, spawnerHandle);
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "API Error: Stream idle timeout" }],
        },
      }),
    ],
    exitCode: 143,
  });

  const session = await runner.spawnAgent({
    taskId: "TSI",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.equal(session.errorKind, "api_stream_idle");
  assert.equal(session.transientError, false);
});

test("zero-token SIGTERM with no assistant text → errorKind=zero_token_kill, no retry", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner } = makeRunner(root, spawnerHandle);
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  // No assistant text at all; only an init line, then exit 143 with no usage.
  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 143,
  });

  const session = await runner.spawnAgent({
    taskId: "TZT",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.equal(session.errorKind, "zero_token_kill");
  assert.equal(session.transientError, false);
  assert.equal(session.tokens.total, 0);
});

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
// In-stream contextPercentage population
// ---------------------------------------------------------------------------

test("populates contextPercentage from in-stream usage", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths, bus } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  // 60_000 + 40_000 = 100_000 → 100_000 / 200_000 = 50%.
  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 60_000,
            cache_read_input_tokens: 40_000,
          },
        },
      }),
    ],
    exitCode: 0,
  });

  const updated: Session[] = [];
  bus.on("session.updated", ({ session }) => updated.push(session));

  const session = await runner.spawnAgent({
    taskId: "T-ctx-instream",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.contextPercentage, 50);
  // At least one mid-run session.updated carried the contextPercentage.
  const sawCtxUpdate = updated.some((s) => s.contextPercentage === 50);
  assert.ok(sawCtxUpdate, "expected session.updated event with contextPercentage=50");
});

test("skips fallback probe when in-stream usage seen", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 20_000 },
        },
      }),
    ],
    exitCode: 0,
  });
  // Queue a probe stub that, if invoked, would set contextPercentage to 99.
  // It must NOT be reached.
  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ usage: { input_tokens: 198_000 } })],
    exitCode: 0,
  });

  const session = await runner.spawnAgent({
    taskId: "T-ctx-skip-probe",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  // Only the main spawn happened — probe gated off.
  assert.equal(spawnerHandle.calls.length, 1);
  assert.equal(session.contextPercentage, 10); // 20_000 / 200_000 = 10%
});

test("fallback probe runs when no in-stream usage; uses --resume + json mode", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  // Main: no usage event at all — observedInStream stays false.
  spawnerHandle.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 0,
  });
  // Probe response: JSON-mode object whose usage tokens compute to 42%
  // against DEFAULT_CONTEXT_MAX = 200_000 (84_000 / 200_000 = 42%).
  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 84_000 },
      }),
    ],
    exitCode: 0,
  });

  const session = await runner.spawnAgent({
    taskId: "T-ctx-fallback",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.contextPercentage, 42);
  assert.equal(spawnerHandle.calls.length, 2);
  const probeArgs = spawnerHandle.calls[1]!.args;
  assert.ok(probeArgs.includes("--resume"), "probe must use --resume");
  assert.ok(probeArgs.includes("--output-format"), "probe must specify --output-format");
  assert.ok(probeArgs.includes("json"), "probe must use json output format");
  assert.ok(!probeArgs.includes("/context"), "probe must not use legacy /context");
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

test("rate_limit_event with resetsAt populates session.rateLimitResetsAt", async () => {
  const root = await mkTmp();
  const STALL_MS = 150;
  const RESETS_AT = 1_777_021_800;

  const frames: StallScriptFrame[] = [
    { line: JSON.stringify({ type: "system", subtype: "init" }), delayMs: 0 },
    {
      line: JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          overageStatus: "rejected",
          resetsAt: RESETS_AT,
          rateLimitType: "five_hour",
        },
      }),
      delayMs: 0,
    },
    { line: null, delayMs: STALL_MS * 4 },
  ];

  const { spawner } = makeStallSpawner(frames);
  const { runner, paths } = makeStallRunner(root, spawner, STALL_MS);
  await writeSkill(paths, "exec", "skill");

  const session = await runner.spawnAgent({
    taskId: "T-stall-resetsAt",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.transientError, true);
  assert.equal(session.rateLimitResetsAt, RESETS_AT);
  assert.equal(session.rateLimitType, "five_hour");
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

// ---------------------------------------------------------------------------
// E2 watchdog — consecutive-repeat cap with outcome awareness
// ---------------------------------------------------------------------------

function bashUseLine(cmd: string, id = "tu"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }],
    },
  });
}

function toolResultLine(opts: {
  id?: string;
  content: string;
  isError?: boolean;
}): string {
  const block: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: opts.id ?? "tu",
    content: opts.content,
  };
  if (opts.isError) block["is_error"] = true;
  return JSON.stringify({
    type: "user",
    message: { content: [block] },
  });
}

function nonBashUseLine(name: string, id = "tu-other"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name, input: {} }],
    },
  });
}

test("repeat cap: identical Bash with good intervening results does NOT fire", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      bashUseLine("git status", "a1"),
      toolResultLine({ id: "a1", content: "On branch main\n" }),
      bashUseLine("git status", "a2"),
      toolResultLine({ id: "a2", content: "On branch main\n" }),
      bashUseLine("git status", "a3"),
      toolResultLine({ id: "a3", content: "On branch main\n" }),
    ],
    exitCode: 0,
  });
  spawnerHandle.queue.push({ stdout: [], exitCode: 0 });

  const session = await runner.spawnAgent({
    taskId: "T-repeat-1",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "succeeded", `error: ${session.error}`);
  assert.doesNotMatch(session.error ?? "", /looped_on_blocked_tool/);
});

test("repeat cap: same Bash interleaved with a different tool does NOT fire", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      bashUseLine("grep -r FooService src/", "b1"),
      nonBashUseLine("Read", "r1"),
      bashUseLine("grep -r FooService src/", "b2"),
      nonBashUseLine("Read", "r2"),
      bashUseLine("grep -r FooService src/", "b3"),
    ],
    exitCode: 0,
  });
  spawnerHandle.queue.push({ stdout: [], exitCode: 0 });

  const session = await runner.spawnAgent({
    taskId: "T-repeat-2",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "succeeded", `error: ${session.error}`);
  assert.doesNotMatch(session.error ?? "", /looped_on_blocked_tool/);
});

test("repeat cap: 3 consecutive identical Bash with no result DOES fire", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      bashUseLine("npm test", "c1"),
      bashUseLine("npm test", "c2"),
      bashUseLine("npm test", "c3"),
    ],
    exitCode: 0,
  });

  const session = await runner.spawnAgent({
    taskId: "T-repeat-3",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /^looped_on_blocked_tool:/);
  assert.match(session.error ?? "", /npm test/);
});

test("repeat cap: 3 consecutive identical Bash with is_error results DOES fire", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      bashUseLine("flaky-cmd", "d1"),
      toolResultLine({ id: "d1", content: "boom: exit 1", isError: true }),
      bashUseLine("flaky-cmd", "d2"),
      toolResultLine({ id: "d2", content: "boom: exit 1", isError: true }),
      bashUseLine("flaky-cmd", "d3"),
      toolResultLine({ id: "d3", content: "boom: exit 1", isError: true }),
    ],
    exitCode: 0,
  });

  const session = await runner.spawnAgent({
    taskId: "T-repeat-4",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "failed");
  assert.match(session.error ?? "", /^looped_on_blocked_tool:/);
  assert.match(session.error ?? "", /flaky-cmd/);
});

test("repeat cap: tool_result + next tool_use bundled in one user payload still resets", async () => {
  const root = await mkTmp();
  const spawnerHandle = makeFakeSpawner();
  const { runner, paths } = makeRunner(root, spawnerHandle);
  await writeSkill(paths, "exec", "skill");

  // Mixed shape: one user payload carries both the result for the previous
  // tool_use and the next tool_use of the same command. The watchdog must
  // observe the result before classifying the new tool_use, or rule B fails
  // and the cap fires on healthy iterative work.
  const mixedPayload = (prevId: string, nextId: string): string =>
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: prevId,
            content: "ok\n",
          },
          {
            type: "tool_use",
            id: nextId,
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    });

  spawnerHandle.queue.push({
    stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      bashUseLine("npm test", "e1"),
      mixedPayload("e1", "e2"),
      mixedPayload("e2", "e3"),
      toolResultLine({ id: "e3", content: "ok\n" }),
    ],
    exitCode: 0,
  });
  spawnerHandle.queue.push({ stdout: [], exitCode: 0 });

  const session = await runner.spawnAgent({
    taskId: "T-repeat-5",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });

  assert.equal(session.status, "succeeded", `error: ${session.error}`);
  assert.doesNotMatch(session.error ?? "", /looped_on_blocked_tool/);
});

// ---------------------------------------------------------------------------
// killAllLive — SIGINT shutdown helper
// ---------------------------------------------------------------------------

test("killAllLive sends the signal to every registered live proc", async () => {
  const root = "/tmp/flow-killalllive-noop";
  const paths = new Paths(root);
  const bus = new EventBus();
  const handle = makeFakeSpawner();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner: handle.spawner,
    now: () => new Date(),
  });

  function fakeProc(): { proc: SpawnedProcess; signals: NodeJS.Signals[] } {
    const signals: NodeJS.Signals[] = [];
    const proc: SpawnedProcess = {
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      exit: new Promise<number>(() => {
        /* never resolves; SIGKILL escalation will be exercised */
      }),
      kill(signal) {
        signals.push(signal ?? "SIGTERM");
      },
    };
    return { proc, signals };
  }

  const a = fakeProc();
  const b = fakeProc();
  const liveProcs = (
    runner as unknown as { liveProcs: Set<SpawnedProcess> }
  ).liveProcs;
  liveProcs.add(a.proc);
  liveProcs.add(b.proc);

  await runner.killAllLive("SIGTERM", 0);

  assert.equal(a.signals[0], "SIGTERM");
  assert.equal(b.signals[0], "SIGTERM");
});

test("killAllLive escalates to SIGKILL for stragglers after the grace window", async () => {
  const root = "/tmp/flow-killalllive-escalate";
  const paths = new Paths(root);
  const bus = new EventBus();
  const handle = makeFakeSpawner();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner: handle.spawner,
    now: () => new Date(),
  });

  const signals: NodeJS.Signals[] = [];
  const wedged: SpawnedProcess = {
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exit: new Promise<number>(() => {
      /* simulates a child that ignores SIGTERM */
    }),
    kill(signal) {
      signals.push(signal ?? "SIGTERM");
    },
  };
  const liveProcs = (
    runner as unknown as { liveProcs: Set<SpawnedProcess> }
  ).liveProcs;
  liveProcs.add(wedged);

  await runner.killAllLive("SIGTERM", 5);

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("killAllLive does not SIGKILL procs that exit within the grace window", async () => {
  const root = "/tmp/flow-killalllive-clean";
  const paths = new Paths(root);
  const bus = new EventBus();
  const handle = makeFakeSpawner();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner: handle.spawner,
    now: () => new Date(),
  });

  const signals: NodeJS.Signals[] = [];
  const clean: SpawnedProcess = {
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exit: Promise.resolve(0),
    kill(signal) {
      signals.push(signal ?? "SIGTERM");
    },
  };
  const liveProcs = (
    runner as unknown as { liveProcs: Set<SpawnedProcess> }
  ).liveProcs;
  liveProcs.add(clean);
  // Mirror the spawn-site .finally that auto-removes from liveProcs on exit.
  void clean.exit.finally(() => liveProcs.delete(clean));

  await runner.killAllLive("SIGTERM", 50);

  assert.deepEqual(signals, ["SIGTERM"]);
});

test("killAllLive swallows errors from individual proc.kill calls", async () => {
  const root = "/tmp/flow-killalllive-swallow";
  const paths = new Paths(root);
  const bus = new EventBus();
  const handle = makeFakeSpawner();
  const runner = new AgentRunner({
    paths,
    config: defaultConfig(),
    eventBus: bus,
    spawner: handle.spawner,
    now: () => new Date(),
  });

  let secondKilled = false;
  const throwing: SpawnedProcess = {
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exit: new Promise<number>(() => {}),
    kill() {
      throw new Error("boom");
    },
  };
  const surviving: SpawnedProcess = {
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exit: new Promise<number>(() => {}),
    kill() {
      secondKilled = true;
    },
  };

  const liveProcs = (
    runner as unknown as { liveProcs: Set<SpawnedProcess> }
  ).liveProcs;
  liveProcs.add(throwing);
  liveProcs.add(surviving);

  await runner.killAllLive("SIGTERM", 0);
  assert.equal(secondKilled, true, "later procs must still be killed after a thrower");
});

test("ordinal: stable across orchestrator restarts when state is wired", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await writeSkill(paths, "exec", "skill");

  // First run: a fresh runner backed by an empty state assigns ordinal=1.
  const state1 = new StateStore(paths);
  await state1.load();
  const spawner1 = makeFakeSpawner();
  spawner1.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 0,
  });
  const { runner: runner1 } = makeRunner(root, spawner1, state1);
  const first = await runner1.spawnAgent({
    taskId: "TORD",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });
  assert.equal(first.ordinal, 1);
  state1.upsertSession(first);
  await state1.save();

  // Simulate a restart: brand-new state + runner pair, same on-disk
  // sessions. The pre-fix behavior reset to ordinal=1 here, colliding
  // with the persisted run.
  const state2 = new StateStore(paths);
  await state2.load();
  const spawner2 = makeFakeSpawner();
  spawner2.queue.push({
    stdout: [JSON.stringify({ type: "system", subtype: "init" })],
    exitCode: 0,
  });
  const { runner: runner2 } = makeRunner(root, spawner2, state2);
  const second = await runner2.spawnAgent({
    taskId: "TORD",
    stage: "exec",
    skillName: "exec",
    worktreePath: root,
  });
  assert.equal(second.ordinal, 2);
});
