import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import type { Flow } from "./flow.js";
import type { ErrorKind, Session, TaskRuntime } from "./types.js";

/** Worker process exit codes. The supervisor reads these to decide whether to
 *  restart. EXIT_FATAL/EXIT_LOCK_CONFLICT are sysexits-inspired distinct codes
 *  so a downstream wrapper (or human) can also tell outcomes apart. */
export const EXIT_DONE = 0;
export const EXIT_FATAL = 78;
export const EXIT_LOCK_CONFLICT = 75;

/** Buffer added on top of `resetsAt` so the request fires *after* the window
 *  reopens. Server clocks drift; this gives them headroom. */
export const RESUME_BUFFER_MS = 30_000;

/** Fallback wait when a transient pause was flagged but no `resetsAt` was
 *  captured on any session. Should not occur once `agent.ts` is shipped, but
 *  the loop must still make forward progress if it does. */
export const FALLBACK_WAIT_MS = 15 * 60 * 1000;

/** When the computed `waitUntil` is already in the past (we paused right at
 *  the boundary), nap briefly and re-evaluate instead of busy-looping. */
export const POST_BOUNDARY_RETRY_MS = 30_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface OvernightDeps {
  flow: Flow;
  /** Where to write the per-cycle log file (typically `.flow/overnight.log`). */
  logFilePath: string;
  /** Stdout sink. Defaults to `console.log`. */
  print?: (line: string) => void;
  /** DI for tests — return current ms-since-epoch. */
  now?: () => number;
  /** DI for tests — sleep for `ms`. */
  sleep?: (ms: number) => Promise<void>;
  /** When set, the worker writes its terminal `OvernightOutcome` to this path
   *  atomically before returning. The supervisor reads it after the child
   *  exits; "file present" means "worker reached a clean terminal outcome." */
  lastResultPath?: string;
}

export interface OvernightOpts {
  /** Defer start until the next occurrence of this HH:MM clock time. */
  atTime?: string;
  /** When true, the cycle classifier never returns `fatal` while the queue
   *  still has runnable work (`pending` / `ready` / `running`). Fatal-class
   *  pauses fall through to the wait-then-resume step instead of exiting,
   *  so an unattended overnight run keeps draining the DAG even after an
   *  agent-logic failure. Default `false` preserves CI/automation that
   *  relies on the fatal exit code as a stop signal. */
  endless?: boolean;
  /** Error kinds treated as infrastructure failures rather than fatal
   *  agent-logic failures. Tasks paused with one of these kinds are
   *  excluded from the cycle's fatal count and counted under `review`.
   *  Falls back to a defensive default when the caller doesn't supply
   *  the project's config-driven set. */
  infraKinds?: ReadonlyArray<ErrorKind>;
}

const DEFAULT_INFRA_KINDS: ReadonlyArray<ErrorKind> = [
  "api_stream_idle",
  "zero_token_kill",
  "stall",
];

export type OvernightOutcome =
  | {
      kind: "done";
      cycles: number;
      mergedCount: number;
      elapsedMs: number;
    }
  | {
      kind: "fatal";
      cycles: number;
      fatalCount: number;
      mergedCount: number;
      elapsedMs: number;
    }
  | {
      kind: "needs-review";
      cycles: number;
      reviewCount: number;
      mergedCount: number;
      elapsedMs: number;
    };

/** Validate an `--at HH:MM` argument; returns the next millisecond timestamp
 *  the clock will read `hh:mm` (today if still future, else tomorrow). Throws
 *  on malformed input. */
export function nextOccurrenceMs(hhmm: string, fromMs: number): number {
  const m = HHMM.exec(hhmm);
  if (!m) {
    throw new Error(`invalid --at "${hhmm}"; expected HH:MM (24h)`);
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const now = new Date(fromMs);
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    0,
    0,
  );
  if (target.getTime() <= fromMs) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function isTerminalStatus(status: TaskRuntime["status"]): boolean {
  return status === "merged" || status === "done";
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}m`;
}

export async function runOvernight(
  deps: OvernightDeps,
  opts: OvernightOpts = {},
): Promise<OvernightOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }));
  const print = deps.print ?? ((line: string) => console.log(line));

  await fs.mkdir(path.dirname(deps.logFilePath), { recursive: true });

  if (deps.lastResultPath) {
    try {
      await fs.unlink(deps.lastResultPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const writeOutcome = async (
    outcome: OvernightOutcome,
  ): Promise<OvernightOutcome> => {
    if (deps.lastResultPath) {
      await writeJsonAtomic(deps.lastResultPath, outcome);
    }
    return outcome;
  };

  const log = async (line: string): Promise<void> => {
    print(line);
    try {
      await fs.appendFile(deps.logFilePath, line + "\n");
    } catch {
      // Disk errors must not tear down the loop — stdout is still authoritative.
    }
  };

  if (opts.atTime !== undefined) {
    if (!HHMM.test(opts.atTime)) {
      throw new Error(`invalid --at "${opts.atTime}"; expected HH:MM (24h)`);
    }
    const target = nextOccurrenceMs(opts.atTime, now());
    await log(
      `[${new Date(now()).toISOString()}] deferred start: sleeping until ${new Date(target).toISOString()}`,
    );
    const waitMs = target - now();
    if (waitMs > 0) await sleep(waitMs);
  }

  const startedAt = now();
  let cycle = 0;
  let lastResumedCount: number | null = null;

  for (;;) {
    cycle += 1;
    const cycleStart = now();
    if (lastResumedCount !== null) {
      await log(
        `[${new Date(cycleStart).toISOString()}] cycle=${cycle} starting; resumed_tasks=${lastResumedCount}`,
      );
    } else {
      await log(
        `[${new Date(cycleStart).toISOString()}] cycle=${cycle} starting`,
      );
    }

    await deps.flow.runAll();

    const tasks = deps.flow.getTasks();
    const terminal = tasks.filter((t) => isTerminalStatus(t.status));
    const mergedCount = tasks.filter((t) => t.status === "merged").length;

    if (tasks.length > 0 && terminal.length === tasks.length) {
      const elapsedMs = now() - startedAt;
      await log(
        `[${new Date(now()).toISOString()}] cycle=${cycle} result=done merged=${mergedCount} fatal=0 cycles=${cycle} elapsed=${formatElapsed(elapsedMs)}`,
      );
      return await writeOutcome({
        kind: "done",
        cycles: cycle,
        mergedCount,
        elapsedMs,
      });
    }

    const sessionsById = new Map<string, Session>();
    for (const s of deps.flow.getSessions()) sessionsById.set(s.id, s);

    const latestSession = (t: TaskRuntime): Session | undefined => {
      const sid =
        t.currentSessionId ?? t.sessionIds[t.sessionIds.length - 1] ?? null;
      return sid ? sessionsById.get(sid) : undefined;
    };
    const isTransientPaused = (t: TaskRuntime): boolean =>
      t.status === "paused" && latestSession(t)?.transientError === true;
    const isReviewRequestedPaused = (t: TaskRuntime): boolean =>
      t.status === "paused" && latestSession(t)?.reviewRequested != null;
    const infraKinds = new Set<ErrorKind>(
      opts.infraKinds ?? DEFAULT_INFRA_KINDS,
    );
    const isInfraKindPaused = (t: TaskRuntime): boolean => {
      if (t.status !== "paused") return false;
      const k = t.lastError?.kind;
      return k !== undefined && infraKinds.has(k);
    };

    const transient = tasks.filter(isTransientPaused);
    const reviewRequested = tasks.filter(isReviewRequestedPaused);
    const infraPaused = tasks.filter(isInfraKindPaused);
    const fatal = tasks.filter(
      (t) =>
        (t.status === "paused" &&
          !isTransientPaused(t) &&
          !isReviewRequestedPaused(t) &&
          !isInfraKindPaused(t)) ||
        t.status === "blocked",
    );
    const reviewCount = reviewRequested.length + infraPaused.length;
    const hasRunnable = tasks.some(
      (t) =>
        t.status === "pending" ||
        t.status === "ready" ||
        t.status === "running",
    );

    if (fatal.length > 0) {
      // --endless: as long as runnable work remains, infra-class pauses
      // shouldn't cause the worker to exit. Log "result=continue" and
      // fall through to the wait-then-resume branch so the loop can
      // pick paused tasks back up after a backoff window.
      if (!opts.endless) {
        const elapsedMs = now() - startedAt;
        await log(
          `[${new Date(now()).toISOString()}] cycle=${cycle} result=fatal merged=${mergedCount} fatal=${fatal.length} review=${reviewCount} transient=${transient.length} cycles=${cycle} elapsed=${formatElapsed(elapsedMs)}`,
        );
        return await writeOutcome({
          kind: "fatal",
          cycles: cycle,
          fatalCount: fatal.length,
          mergedCount,
          elapsedMs,
        });
      }
      if (!hasRunnable && transient.length === 0) {
        // All non-fatal work drained; nothing to wait on. Exit fatal even
        // in endless mode rather than spinning indefinitely.
        const elapsedMs = now() - startedAt;
        await log(
          `[${new Date(now()).toISOString()}] cycle=${cycle} result=fatal merged=${mergedCount} fatal=${fatal.length} review=${reviewCount} transient=0 cycles=${cycle} elapsed=${formatElapsed(elapsedMs)} reason=endless-exhausted`,
        );
        return await writeOutcome({
          kind: "fatal",
          cycles: cycle,
          fatalCount: fatal.length,
          mergedCount,
          elapsedMs,
        });
      }
      await log(
        `[${new Date(now()).toISOString()}] cycle=${cycle} result=continue merged=${mergedCount} fatal=${fatal.length} review=${reviewCount} transient=${transient.length}`,
      );
    }

    if (transient.length === 0 && fatal.length === 0) {
      if (reviewRequested.length > 0) {
        const elapsedMs = now() - startedAt;
        await log(
          `[${new Date(now()).toISOString()}] cycle=${cycle} result=needs_review review=${reviewCount} merged=${mergedCount} cycles=${cycle} elapsed=${formatElapsed(elapsedMs)}`,
        );
        return await writeOutcome({
          kind: "needs-review",
          cycles: cycle,
          reviewCount,
          mergedCount,
          elapsedMs,
        });
      }
      if (opts.endless && infraPaused.length > 0 && hasRunnable) {
        // Pure infra-paused-with-runnable case: nothing transient to wait
        // on, but endless mode wants to keep cycling. Fall through to
        // fallback wait + resume.
      } else {
        // No work to do but DAG isn't drained — treat as fatal so we don't spin.
        const elapsedMs = now() - startedAt;
        await log(
          `[${new Date(now()).toISOString()}] cycle=${cycle} result=fatal merged=${mergedCount} fatal=0 review=${reviewCount} cycles=${cycle} elapsed=${formatElapsed(elapsedMs)} reason=stalled-no-runnable-tasks`,
        );
        return await writeOutcome({
          kind: "fatal",
          cycles: cycle,
          fatalCount: 0,
          mergedCount,
          elapsedMs,
        });
      }
    }

    let waitUntilMs = 0;
    let sawResetsAt = false;
    for (const t of transient) {
      const session = latestSession(t);
      if (session && typeof session.rateLimitResetsAt === "number") {
        sawResetsAt = true;
        const wakeMs =
          session.rateLimitResetsAt * 1000 + RESUME_BUFFER_MS;
        if (wakeMs > waitUntilMs) waitUntilMs = wakeMs;
      }
    }

    if (!sawResetsAt) {
      waitUntilMs = now() + FALLBACK_WAIT_MS;
      await log(
        `[${new Date(now()).toISOString()}] cycle=${cycle} warn: no rateLimitResetsAt captured; falling back to ${FALLBACK_WAIT_MS / 60000}m wait`,
      );
    }

    const tNow = now();
    if (waitUntilMs <= tNow) {
      await log(
        `[${new Date(tNow).toISOString()}] cycle=${cycle} result=rate_limited paused=${transient.length} reset_already_past; sleeping ${POST_BOUNDARY_RETRY_MS / 1000}s`,
      );
      await sleep(POST_BOUNDARY_RETRY_MS);
    } else {
      const note = sawResetsAt
        ? ` (resetsAt=${Math.floor((waitUntilMs - RESUME_BUFFER_MS) / 1000)}, +${RESUME_BUFFER_MS / 1000}s buffer)`
        : "";
      await log(
        `[${new Date(tNow).toISOString()}] cycle=${cycle} result=rate_limited paused=${transient.length} next_wake=${new Date(waitUntilMs).toISOString()}${note}`,
      );
      await sleep(waitUntilMs - tNow);
    }

    const resumed = await deps.flow.resumePausedTasks({ status: "paused" });
    lastResumedCount = resumed.length;
  }
}
