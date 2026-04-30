import test from "node:test";
import assert from "node:assert/strict";

import {
  superviseOvernight,
  type SupervisedChild,
  type SupervisorDeps,
  type SupervisorOpts,
} from "../src/overnightSupervisor.js";
import type { OvernightOutcome } from "../src/overnight.js";

interface FakeChildHandle {
  child: SupervisedChild;
  finish: (code: number | null, signal?: NodeJS.Signals | null) => void;
  killed: NodeJS.Signals[];
}

function makeFakeChild(pid: number): FakeChildHandle {
  let resolveExit!: (e: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((r) => {
    resolveExit = r;
  });
  const killed: NodeJS.Signals[] = [];
  return {
    child: {
      pid,
      kill: (sig) => killed.push(sig),
      exited,
    },
    finish: (code, signal = null) => resolveExit({ code, signal }),
    killed,
  };
}

interface FakeSpawn {
  calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  enqueue: (h: FakeChildHandle) => void;
  spawn: SupervisorDeps["spawnChild"];
}

function makeFakeSpawn(): FakeSpawn {
  const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
  const queue: FakeChildHandle[] = [];
  const spawn: SupervisorDeps["spawnChild"] = (argv, env) => {
    calls.push({ argv: [...argv], env });
    const h = queue.shift();
    if (!h) {
      throw new Error(
        `fake spawn invoked ${calls.length}× but no child queued`,
      );
    }
    return h.child;
  };
  return {
    calls,
    enqueue: (h) => queue.push(h),
    spawn,
  };
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleepsRequested: number[];
  advance: (ms: number) => void;
  pending: () => number;
}

function makeFakeClock(startMs: number): FakeClock {
  let cur = startMs;
  const sleepsRequested: number[] = [];
  let pending: Array<{ wakeAt: number; resolve: () => void }> = [];
  return {
    now: () => cur,
    sleep: (ms) => {
      sleepsRequested.push(ms);
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.push({ wakeAt: cur + ms, resolve });
      });
    },
    sleepsRequested,
    advance: (ms) => {
      cur += ms;
      const due = pending.filter((p) => p.wakeAt <= cur);
      pending = pending.filter((p) => p.wakeAt > cur);
      for (const p of due) p.resolve();
    },
    pending: () => pending.length,
  };
}

interface SignalBus {
  onSignal: SupervisorDeps["onSignal"];
  fire: (sig: "SIGINT" | "SIGTERM") => void;
}

function makeSignalBus(): SignalBus {
  const handlers: Array<(sig: "SIGINT" | "SIGTERM") => void> = [];
  return {
    onSignal: (h) => {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    fire: (sig) => handlers.slice().forEach((h) => h(sig)),
  };
}

function lastResultQueue(
  items: Array<OvernightOutcome | null>,
): SupervisorDeps["readLastResult"] {
  let i = 0;
  return async () => {
    const v = items[i] ?? null;
    i += 1;
    return v;
  };
}

function logCollector(): {
  lines: string[];
  append: SupervisorDeps["appendLog"];
} {
  const lines: string[] = [];
  return {
    lines,
    append: async (line) => {
      lines.push(line);
    },
  };
}

/** Drain pending microtasks until `pred()` returns true or `maxTicks` is hit.
 *  The supervisor only yields on awaits, so a small number of ticks is enough
 *  to advance through any intermediate state we care about. */
async function until(
  pred: () => boolean,
  label: string,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  if (!pred()) throw new Error(`timeout waiting for: ${label}`);
}

const ARGV_FIRST = ["overnight", "--at", "23:00"];
const ARGV_RESTART = ["overnight"];

function makeOpts(overrides: Partial<SupervisorOpts> = {}): SupervisorOpts {
  return {
    argvFirst: ARGV_FIRST,
    argvRestart: ARGV_RESTART,
    env: { FLOW_OVERNIGHT_CHILD: "1" },
    ...overrides,
  };
}

function makeDeps(parts: {
  spawn: FakeSpawn;
  clock: FakeClock;
  bus: SignalBus;
  log: ReturnType<typeof logCollector>;
  results: Array<OvernightOutcome | null>;
}): SupervisorDeps {
  return {
    spawnChild: parts.spawn.spawn,
    now: parts.clock.now,
    sleep: parts.clock.sleep,
    readLastResult: lastResultQueue(parts.results),
    appendLog: parts.log.append,
    onSignal: parts.bus.onSignal,
  };
}

test("clean done: exits 0 after a single spawn", async () => {
  const spawn = makeFakeSpawn();
  const fc = makeFakeChild(1001);
  spawn.enqueue(fc);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({
      spawn,
      clock,
      bus,
      log,
      results: [
        { kind: "done", cycles: 3, mergedCount: 5, elapsedMs: 30_000 },
      ],
    }),
    makeOpts(),
  );

  fc.finish(0);
  const result = await promise;

  assert.equal(result.exitCode, 0);
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(spawn.calls[0]!.argv, ARGV_FIRST);
  assert.match(log.lines.join("\n"), /\[supervisor\] worker_done /);
});

test("fatal: worker exits 78 with kind=fatal → returns 78, one spawn", async () => {
  const spawn = makeFakeSpawn();
  const fc = makeFakeChild(1002);
  spawn.enqueue(fc);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({
      spawn,
      clock,
      bus,
      log,
      results: [
        {
          kind: "fatal",
          cycles: 1,
          fatalCount: 1,
          mergedCount: 0,
          elapsedMs: 1_000,
        },
      ],
    }),
    makeOpts(),
  );

  fc.finish(78);
  const result = await promise;

  assert.equal(result.exitCode, 78);
  assert.equal(spawn.calls.length, 1);
  assert.match(log.lines.join("\n"), /\[supervisor\] worker_fatal /);
});

test("lock conflict: exit 75 with no last-result → returns 75, one spawn", async () => {
  const spawn = makeFakeSpawn();
  const fc = makeFakeChild(1003);
  spawn.enqueue(fc);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({ spawn, clock, bus, log, results: [null] }),
    makeOpts(),
  );

  fc.finish(75);
  const result = await promise;

  assert.equal(result.exitCode, 75);
  assert.equal(spawn.calls.length, 1);
  assert.match(log.lines.join("\n"), /\[supervisor\] worker_lock_conflict/);
});

test("worker exits 130 (its own SIGINT exit code) → propagate, one spawn", async () => {
  const spawn = makeFakeSpawn();
  const fc = makeFakeChild(1004);
  spawn.enqueue(fc);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({ spawn, clock, bus, log, results: [null] }),
    makeOpts(),
  );

  fc.finish(130);
  const result = await promise;

  assert.equal(result.exitCode, 130);
  assert.equal(spawn.calls.length, 1);
  assert.equal(fc.killed.length, 0);
});

test("crash → backoff → recovery: returns 0 with two spawns", async () => {
  const spawn = makeFakeSpawn();
  const fc1 = makeFakeChild(2001);
  const fc2 = makeFakeChild(2002);
  spawn.enqueue(fc1);
  spawn.enqueue(fc2);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({
      spawn,
      clock,
      bus,
      log,
      results: [
        null,
        { kind: "done", cycles: 1, mergedCount: 1, elapsedMs: 200 },
      ],
    }),
    makeOpts(),
  );

  fc1.finish(1);
  await until(() => clock.sleepsRequested.length === 1, "first sleep requested");
  assert.equal(clock.sleepsRequested[0], 1000);
  clock.advance(1000);
  await until(() => spawn.calls.length === 2, "second spawn");
  fc2.finish(0);
  const result = await promise;

  assert.equal(result.exitCode, 0);
  assert.equal(spawn.calls.length, 2);
  assert.deepEqual(spawn.calls[1]!.argv, ARGV_RESTART);
});

test("5 fast crashes → circuit breaker opens, exit 1, exactly 5 spawns", async () => {
  const spawn = makeFakeSpawn();
  const handles: FakeChildHandle[] = [];
  for (let i = 0; i < 5; i++) {
    const h = makeFakeChild(3000 + i);
    handles.push(h);
    spawn.enqueue(h);
  }
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({
      spawn,
      clock,
      bus,
      log,
      results: [null, null, null, null, null],
    }),
    makeOpts(),
  );

  for (let i = 0; i < 5; i++) {
    await until(() => spawn.calls.length === i + 1, `spawn #${i + 1}`);
    handles[i]!.finish(1);
    if (i < 4) {
      // After each non-final crash there's a backoff sleep we must drain.
      await until(
        () => clock.sleepsRequested.length === i + 1,
        `sleep #${i + 1} requested`,
      );
      clock.advance(clock.sleepsRequested[i]!);
    }
  }

  const result = await promise;
  assert.equal(result.exitCode, 1);
  assert.equal(spawn.calls.length, 5);
  assert.match(
    log.lines.join("\n"),
    /\[supervisor\] circuit_breaker_opened /,
  );
});

test("slow crash resets fast-failure counter; restart still happens", async () => {
  const spawn = makeFakeSpawn();
  const handles: FakeChildHandle[] = [];
  // 4 fast crashes, 1 slow crash, 4 fast crashes, 1 clean done = 10 spawns.
  for (let i = 0; i < 10; i++) {
    const h = makeFakeChild(4000 + i);
    handles.push(h);
    spawn.enqueue(h);
  }
  const results: Array<OvernightOutcome | null> = [
    null, null, null, null,
    null,
    null, null, null, null,
    { kind: "done", cycles: 1, mergedCount: 1, elapsedMs: 100 },
  ];
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({ spawn, clock, bus, log, results }),
    makeOpts(),
  );

  for (let i = 0; i < 10; i++) {
    await until(() => spawn.calls.length === i + 1, `spawn #${i + 1}`);
    if (i === 4) {
      // Slow crash: advance the clock past the 30s window before finishing.
      clock.advance(31_000);
    }
    handles[i]!.finish(i === 9 ? 0 : 1);
    if (i < 9) {
      await until(
        () => clock.sleepsRequested.length === i + 1,
        `sleep #${i + 1} requested`,
      );
      clock.advance(clock.sleepsRequested[i]!);
    }
  }

  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.equal(spawn.calls.length, 10);
  assert.doesNotMatch(
    log.lines.join("\n"),
    /circuit_breaker_opened/,
  );
});

test("backoff cap: 8th crash sleeps 60s, not 128s", async () => {
  const spawn = makeFakeSpawn();
  const handles: FakeChildHandle[] = [];
  // 8 slow crashes (so the circuit breaker never trips), then a clean done.
  for (let i = 0; i < 9; i++) {
    const h = makeFakeChild(5000 + i);
    handles.push(h);
    spawn.enqueue(h);
  }
  const results: Array<OvernightOutcome | null> = [
    null, null, null, null, null, null, null, null,
    { kind: "done", cycles: 1, mergedCount: 1, elapsedMs: 100 },
  ];
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({ spawn, clock, bus, log, results }),
    makeOpts(),
  );

  for (let i = 0; i < 9; i++) {
    await until(() => spawn.calls.length === i + 1, `spawn #${i + 1}`);
    if (i < 8) {
      // Make every crash slow (>= 30s) so the breaker never trips.
      clock.advance(31_000);
    }
    handles[i]!.finish(i === 8 ? 0 : 1);
    if (i < 8) {
      await until(
        () => clock.sleepsRequested.length === i + 1,
        `sleep #${i + 1} requested`,
      );
      clock.advance(clock.sleepsRequested[i]!);
    }
  }

  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(clock.sleepsRequested, [
    1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
  ]);
});

test("argvFirst is used for spawn 1 only; argvRestart strips --at on spawn 2", async () => {
  const spawn = makeFakeSpawn();
  const fc1 = makeFakeChild(6001);
  const fc2 = makeFakeChild(6002);
  spawn.enqueue(fc1);
  spawn.enqueue(fc2);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({
      spawn,
      clock,
      bus,
      log,
      results: [
        null,
        { kind: "done", cycles: 1, mergedCount: 1, elapsedMs: 100 },
      ],
    }),
    makeOpts(),
  );

  fc1.finish(1);
  await until(() => clock.sleepsRequested.length === 1, "backoff sleep");
  clock.advance(clock.sleepsRequested[0]!);
  await until(() => spawn.calls.length === 2, "second spawn");
  fc2.finish(0);
  await promise;

  assert.deepEqual(spawn.calls[0]!.argv, ["overnight", "--at", "23:00"]);
  assert.deepEqual(spawn.calls[1]!.argv, ["overnight"]);
});

test("parent SIGINT during running → forwards to child → returns child's code", async () => {
  const spawn = makeFakeSpawn();
  const fc = makeFakeChild(7001);
  spawn.enqueue(fc);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({ spawn, clock, bus, log, results: [null] }),
    makeOpts(),
  );

  await until(() => spawn.calls.length === 1, "first spawn");
  bus.fire("SIGINT");
  await until(() => fc.killed.includes("SIGINT"), "child received SIGINT");
  fc.finish(130);
  const result = await promise;

  assert.equal(result.exitCode, 130);
  assert.equal(spawn.calls.length, 1);
  assert.match(log.lines.join("\n"), /\[supervisor\] forwarding_signal /);
});

test("parent SIGINT during backoff sleep → exits 130 without spawning again", async () => {
  const spawn = makeFakeSpawn();
  const fc = makeFakeChild(8001);
  spawn.enqueue(fc);
  const clock = makeFakeClock(1_000_000);
  const bus = makeSignalBus();
  const log = logCollector();

  const promise = superviseOvernight(
    makeDeps({ spawn, clock, bus, log, results: [null] }),
    makeOpts(),
  );

  await until(() => spawn.calls.length === 1, "first spawn");
  fc.finish(1);
  await until(() => clock.sleepsRequested.length === 1, "backoff sleep");
  bus.fire("SIGINT");
  const result = await promise;

  assert.equal(result.exitCode, 130);
  assert.equal(spawn.calls.length, 1);
  assert.match(
    log.lines.join("\n"),
    /\[supervisor\] shutdown_during_backoff /,
  );
});
