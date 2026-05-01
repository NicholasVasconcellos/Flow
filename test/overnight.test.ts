import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runOvernight, nextOccurrenceMs } from "../src/overnight.js";
import type { Flow } from "../src/flow.js";
import type { Session, TaskRuntime } from "../src/types.js";

async function mkTmp(prefix = "flow-overnight-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advanceTo: (ms: number) => void;
}

function makeFakeClock(startMs: number): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advanceTo: (ms: number) => {
      current = ms;
    },
  };
}

interface SnapshotStep {
  tasks: TaskRuntime[];
  sessions: Session[];
}

interface FakeFlowOpts {
  /** Snapshot returned after each `runAll()` call. The Nth call to `runAll`
   *  reads `snapshots[N-1]`. */
  snapshots: SnapshotStep[];
}

function makeFakeFlow(opts: FakeFlowOpts): {
  flow: Flow;
  readonly runAllCalls: number;
  readonly resumeCalls: number;
} {
  if (opts.snapshots.length === 0) {
    throw new Error("makeFakeFlow: snapshots cannot be empty");
  }
  const initial = opts.snapshots[0]!;
  const state = {
    runAllCalls: 0,
    resumeCalls: 0,
    current: initial as SnapshotStep,
  };
  const flow = {
    async runAll() {
      state.runAllCalls += 1;
      const idx = Math.min(state.runAllCalls - 1, opts.snapshots.length - 1);
      state.current = opts.snapshots[idx]!;
    },
    getTasks: () => state.current.tasks.map((t) => ({ ...t })),
    getSessions: () => state.current.sessions.map((s) => ({ ...s })),
    async resumePausedTasks() {
      state.resumeCalls += 1;
      const flipped: TaskRuntime[] = [];
      for (const t of state.current.tasks) {
        if (t.status === "paused") {
          t.status = "ready";
          flipped.push({ ...t });
        }
      }
      return flipped;
    },
  } as unknown as Flow;
  return {
    flow,
    get runAllCalls() {
      return state.runAllCalls;
    },
    get resumeCalls() {
      return state.resumeCalls;
    },
  };
}

function makeTask(overrides: Partial<TaskRuntime> & { id: string }): TaskRuntime {
  const base: TaskRuntime = {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: "",
    contextFiles: [],
    requires: [],
    hasUI: false,
    hasSpec: true,
    hasCodeReview: true,
    status: "ready",
    stage: "spec",
    retries: 0,
    transientRetries: 0,
    uiReviewRound: 0,
    sessionIds: [],
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

function makeSession(
  overrides: Partial<Session> & { id: string; taskId: string },
): Session {
  const base: Session = {
    id: overrides.id,
    taskId: overrides.taskId,
    stage: "exec",
    provider: "claude-code",
    model: "claude-opus-4-7",
    skillName: "exec",
    prompt: "",
    status: "failed",
    startedAt: "2026-04-29T00:00:00.000Z",
    tokens: {
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      total: 0,
    },
    autocompacted: false,
    costUsd: 0,
  };
  return { ...base, ...overrides };
}

test("nextOccurrenceMs returns today if HH:MM is in future, tomorrow otherwise", () => {
  const ref = new Date("2026-04-29T22:00:00.000Z").getTime();
  const localOffsetMin = new Date(ref).getTimezoneOffset();
  // Build a target string that's exactly 1 hour ahead in *local* clock time.
  const localNow = new Date(ref);
  const future = new Date(ref + 3600_000);
  const futureHHMM = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
  const target = nextOccurrenceMs(futureHHMM, ref);
  assert.ok(
    target > ref && target <= ref + 24 * 3600_000,
    `target ${new Date(target).toISOString()} not in expected window after ${new Date(ref).toISOString()} (offsetMin=${localOffsetMin}, localNow=${localNow.toISOString()})`,
  );

  // Past time should land tomorrow (so > 23h from ref but ≤ 24h).
  const past = new Date(ref - 3600_000);
  const pastHHMM = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
  const tomorrow = nextOccurrenceMs(pastHHMM, ref);
  assert.ok(
    tomorrow > ref + 22 * 3600_000 && tomorrow <= ref + 24 * 3600_000,
    `tomorrow ${new Date(tomorrow).toISOString()} not in 22-24h window after ${new Date(ref).toISOString()}`,
  );
});

test("invalid HH:MM throws", () => {
  assert.throws(() => nextOccurrenceMs("25:00", Date.now()));
  assert.throws(() => nextOccurrenceMs("12:60", Date.now()));
  assert.throws(() => nextOccurrenceMs("9:00", Date.now()));
  assert.throws(() => nextOccurrenceMs("not-a-time", Date.now()));
});

test("scenario A: rate-limit, sleep until resetsAt, then complete", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const resetsAtSec = Math.floor(startMs / 1000) + 60;
  const clock = makeFakeClock(startMs);

  const taskBefore = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const sessionBefore = makeSession({
    id: "S1",
    taskId: "T1",
    transientError: true,
    rateLimitResetsAt: resetsAtSec,
  });

  const taskAfter = makeTask({
    id: "T1",
    status: "merged",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });

  const fake = makeFakeFlow({
    snapshots: [
      { tasks: [taskBefore], sessions: [sessionBefore] },
      { tasks: [taskAfter], sessions: [sessionBefore] },
    ],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "done");
  if (result.kind === "done") {
    assert.equal(result.cycles, 2);
    assert.equal(result.mergedCount, 1);
  }
  assert.equal(fake.runAllCalls, 2);
  assert.equal(fake.resumeCalls, 1);
  // Slept until resetsAt + 30s buffer.
  assert.equal(clock.now(), resetsAtSec * 1000 + 30_000);
  // Log file written.
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /cycle=1 result=rate_limited/);
  assert.match(log, /cycle=2 starting; resumed_tasks=1/);
  assert.match(log, /cycle=2 result=done merged=1/);
});

test("scenario B: paused with transientError=false exits fatal without sleeping", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const task = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const session = makeSession({
    id: "S1",
    taskId: "T1",
    transientError: false,
    status: "failed",
  });

  const fake = makeFakeFlow({
    snapshots: [{ tasks: [task], sessions: [session] }],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "fatal");
  if (result.kind === "fatal") assert.equal(result.fatalCount, 1);
  assert.equal(fake.runAllCalls, 1);
  assert.equal(fake.resumeCalls, 0);
  // No sleeping happened — clock didn't advance.
  assert.equal(clock.now(), startMs);
});

test("scenario C: --at validates strictly", async () => {
  const dir = await mkTmp();

  // Valid HH:MM form: deferred sleep then immediately drains to done.
  const startMs = new Date("2026-04-29T20:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);
  const taskDone = makeTask({ id: "T1", status: "merged" });
  const fake = makeFakeFlow({
    snapshots: [{ tasks: [taskDone], sessions: [] }],
  });

  // Compute a HH:MM string ~1h in the future relative to the fake clock so the
  // deferred sleep is bounded.
  const future = new Date(startMs + 3600_000);
  const futureHHMM = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    { atTime: futureHHMM },
  );
  assert.equal(result.kind, "done");
  // Slept the deferred-start window before entering the loop.
  assert.ok(clock.now() >= startMs + 3500_000);

  // Invalid forms reject before doing any flow work.
  await assert.rejects(
    () =>
      runOvernight(
        {
          flow: fake.flow,
          logFilePath: path.join(dir, "overnight.log"),
          print: () => {},
          now: clock.now,
          sleep: clock.sleep,
        },
        { atTime: "25:00" },
      ),
    /invalid --at/,
  );
  await assert.rejects(
    () =>
      runOvernight(
        {
          flow: fake.flow,
          logFilePath: path.join(dir, "overnight.log"),
          print: () => {},
          now: clock.now,
          sleep: clock.sleep,
        },
        { atTime: "9:00" },
      ),
    /invalid --at/,
  );
});

test("scenario D: multiple transient sessions — sleep targets the max resetsAt", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const earlier = Math.floor(startMs / 1000) + 60;
  const later = Math.floor(startMs / 1000) + 600;

  const t1 = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const t2 = makeTask({
    id: "T2",
    status: "paused",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });
  const s1 = makeSession({
    id: "S1",
    taskId: "T1",
    transientError: true,
    rateLimitResetsAt: earlier,
  });
  const s2 = makeSession({
    id: "S2",
    taskId: "T2",
    transientError: true,
    rateLimitResetsAt: later,
  });

  const t1Done = makeTask({
    id: "T1",
    status: "merged",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const t2Done = makeTask({
    id: "T2",
    status: "merged",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });

  const fake = makeFakeFlow({
    snapshots: [
      { tasks: [t1, t2], sessions: [s1, s2] },
      { tasks: [t1Done, t2Done], sessions: [s1, s2] },
    ],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "done");
  // Wake time is the *later* resetsAt + 30s buffer, not the earlier one.
  assert.equal(clock.now(), later * 1000 + 30_000);
});

test("transient pause without any captured resetsAt falls back to 15m", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const task = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const session = makeSession({
    id: "S1",
    taskId: "T1",
    transientError: true,
    // No rateLimitResetsAt
  });

  const taskDone = makeTask({
    id: "T1",
    status: "merged",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });

  const fake = makeFakeFlow({
    snapshots: [
      { tasks: [task], sessions: [session] },
      { tasks: [taskDone], sessions: [session] },
    ],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );
  assert.equal(result.kind, "done");
  // Slept the 15-minute fallback.
  assert.equal(clock.now(), startMs + 15 * 60 * 1000);
});

test("scenario E: paused with reviewRequested set exits needs-review (not fatal), no sleep", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const task = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const session = makeSession({
    id: "S1",
    taskId: "T1",
    status: "succeeded",
    transientError: false,
    reviewRequested: { reason: "haptic feedback timing looks off" },
  });

  const fake = makeFakeFlow({
    snapshots: [{ tasks: [task], sessions: [session] }],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "needs-review");
  if (result.kind === "needs-review") {
    assert.equal(result.reviewCount, 1);
    assert.equal(result.mergedCount, 0);
    assert.equal(result.cycles, 1);
  }
  assert.equal(fake.runAllCalls, 1);
  assert.equal(fake.resumeCalls, 0);
  // No sleep — review pauses do not get retried.
  assert.equal(clock.now(), startMs);
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /cycle=1 result=needs_review review=1 merged=0/);
  assert.doesNotMatch(log, /result=fatal/);
});

test("scenario F: transient pause resolves, then surviving review pause exits needs-review", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const resetsAtSec = Math.floor(startMs / 1000) + 60;
  const clock = makeFakeClock(startMs);

  // Cycle 1: T1 transient-paused, T2 review-paused.
  const t1Pre = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const t2Pre = makeTask({
    id: "T2",
    status: "paused",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });
  const s1 = makeSession({
    id: "S1",
    taskId: "T1",
    transientError: true,
    rateLimitResetsAt: resetsAtSec,
  });
  const s2 = makeSession({
    id: "S2",
    taskId: "T2",
    status: "succeeded",
    reviewRequested: { reason: "double-check tile collision" },
  });

  // Cycle 2: T1 merged, T2 still review-paused. Use a fresh T2 object so the
  // fake's resumePausedTasks (which mutates state.current.tasks) doesn't
  // accidentally flip the cycle-2 snapshot's T2 to "ready".
  const t1Post = makeTask({
    id: "T1",
    status: "merged",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const t2Post = makeTask({
    id: "T2",
    status: "paused",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });

  const fake = makeFakeFlow({
    snapshots: [
      { tasks: [t1Pre, t2Pre], sessions: [s1, s2] },
      { tasks: [t1Post, t2Post], sessions: [s1, s2] },
    ],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "needs-review");
  if (result.kind === "needs-review") {
    assert.equal(result.reviewCount, 1);
    assert.equal(result.mergedCount, 1);
    assert.equal(result.cycles, 2);
  }
  assert.equal(fake.runAllCalls, 2);
  // Slept exactly once (cycle 1 transient wait), then one resume.
  assert.equal(fake.resumeCalls, 1);
  assert.equal(clock.now(), resetsAtSec * 1000 + 30_000);
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /cycle=1 result=rate_limited/);
  assert.match(log, /cycle=2 result=needs_review review=1 merged=1/);
});

test("lastResultPath: pre-existing file is unlinked on entry; outcome JSON is written before each return", async () => {
  const dir = await mkTmp();
  const lastResultPath = path.join(dir, "overnight.last-result.json");

  // Pre-seed a stale last-result file to confirm it's wiped on entry.
  await fs.writeFile(lastResultPath, '{"kind":"stale"}', "utf8");

  // --- done path ---
  {
    const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
    const clock = makeFakeClock(startMs);
    const taskDone = makeTask({ id: "T1", status: "merged" });
    const fake = makeFakeFlow({
      snapshots: [{ tasks: [taskDone], sessions: [] }],
    });
    const result = await runOvernight(
      {
        flow: fake.flow,
        logFilePath: path.join(dir, "overnight.log"),
        lastResultPath,
        print: () => {},
        now: clock.now,
        sleep: clock.sleep,
      },
      {},
    );
    assert.equal(result.kind, "done");
    const written = JSON.parse(await fs.readFile(lastResultPath, "utf8"));
    assert.deepEqual(written, result);
  }

  // --- fatal path: pre-existing (done) file from above gets unlinked on entry, then a fatal record is written ---
  {
    const startMs = new Date("2026-04-29T23:00:00.000Z").getTime();
    const clock = makeFakeClock(startMs);
    const tFatal = makeTask({
      id: "T1",
      status: "paused",
      currentSessionId: "S1",
      sessionIds: ["S1"],
    });
    const sFatal = makeSession({
      id: "S1",
      taskId: "T1",
      status: "failed",
      transientError: false,
    });
    const fake = makeFakeFlow({
      snapshots: [{ tasks: [tFatal], sessions: [sFatal] }],
    });
    const result = await runOvernight(
      {
        flow: fake.flow,
        logFilePath: path.join(dir, "overnight.log"),
        lastResultPath,
        print: () => {},
        now: clock.now,
        sleep: clock.sleep,
      },
      {},
    );
    assert.equal(result.kind, "fatal");
    const written = JSON.parse(await fs.readFile(lastResultPath, "utf8"));
    assert.deepEqual(written, result);
  }
});

test("scenario G: real fatal coexisting with review pause still exits fatal, count excludes reviews", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const tFatal = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const tReview = makeTask({
    id: "T2",
    status: "paused",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });
  const sFatal = makeSession({
    id: "S1",
    taskId: "T1",
    status: "failed",
    transientError: false,
    error: "agent crashed",
  });
  const sReview = makeSession({
    id: "S2",
    taskId: "T2",
    status: "succeeded",
    reviewRequested: { reason: "verify XP curve" },
  });

  const fake = makeFakeFlow({
    snapshots: [{ tasks: [tFatal, tReview], sessions: [sFatal, sReview] }],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "fatal");
  if (result.kind === "fatal") {
    // Fatal count must NOT include the review-pause.
    assert.equal(result.fatalCount, 1);
  }
  assert.equal(fake.runAllCalls, 1);
  assert.equal(clock.now(), startMs); // no sleep
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /result=fatal merged=0 fatal=1 review=1 transient=0/);
});

test("--endless: agent_error pause with runnable work falls through to wait+resume instead of fatal", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  // Cycle 1: T1 paused with agent_error (would be fatal in default mode);
  // T2 still pending. After resume, both reach merged.
  const tFatal = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
    lastError: {
      kind: "agent_error",
      stage: "exec",
      message: "boom",
      at: "2026-04-29T22:00:00.000Z",
    },
  });
  const tPending = makeTask({ id: "T2", status: "pending" });
  const sFatal = makeSession({
    id: "S1",
    taskId: "T1",
    status: "failed",
    transientError: false,
  });
  const merged1 = makeTask({ id: "T1", status: "merged" });
  const merged2 = makeTask({ id: "T2", status: "merged" });

  const fake = makeFakeFlow({
    snapshots: [
      { tasks: [tFatal, tPending], sessions: [sFatal] },
      { tasks: [merged1, merged2], sessions: [sFatal] },
    ],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    { endless: true },
  );

  assert.equal(result.kind, "done");
  assert.equal(fake.runAllCalls, 2);
  assert.equal(fake.resumeCalls, 1);
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /result=continue.*fatal=1/);
  assert.doesNotMatch(log, /result=fatal/);
});

test("infraKinds reclassifies stall pause as review, not fatal", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const tStall = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
    lastError: {
      kind: "stall",
      stage: "exec",
      message: "Stall: 180s",
      at: "2026-04-29T22:00:00.000Z",
    },
  });
  const sStall = makeSession({
    id: "S1",
    taskId: "T1",
    status: "failed",
    transientError: false,
  });

  const fake = makeFakeFlow({
    snapshots: [{ tasks: [tStall], sessions: [sStall] }],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  // Without --endless and with no transient, the loop still classifies
  // as fatal (no runnable + no transient) — but `stall` must NOT be
  // counted under fatal. fatalCount should be 0; review should be 1.
  assert.equal(result.kind, "fatal");
  if (result.kind === "fatal") assert.equal(result.fatalCount, 0);
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /fatal=0 review=1/);
});
