import {
  EXIT_DONE,
  EXIT_FATAL,
  EXIT_LOCK_CONFLICT,
  type OvernightOutcome,
} from "./overnight.js";

/** Wraps a spawned worker process. The supervisor never imports `child_process`
 *  directly; the cli builds the real implementation, tests build a fake. */
export interface SupervisedChild {
  pid: number;
  kill: (sig: NodeJS.Signals) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SupervisorDeps {
  spawnChild: (argv: string[], env: NodeJS.ProcessEnv) => SupervisedChild;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readLastResult: () => Promise<OvernightOutcome | null>;
  appendLog: (line: string) => Promise<void>;
  onSignal: (handler: (sig: "SIGINT" | "SIGTERM") => void) => () => void;
}

export interface SupervisorOpts {
  /** argv used for the very first spawn (preserves user-passed `--at HH:MM`). */
  argvFirst: string[];
  /** argv used for every restart after the first spawn (no `--at`). */
  argvRestart: string[];
  /** Env passed to every spawn (cli adds `FLOW_OVERNIGHT_CHILD=1`). */
  env: NodeJS.ProcessEnv;
  /** Consecutive fast crashes that trip the circuit breaker. Default 5. */
  maxFastFailures?: number;
  /** Crashes within this window of spawn count as "fast". Default 30s. */
  fastFailureWindowMs?: number;
  /** Maximum backoff sleep. Default 60s. */
  backoffCapMs?: number;
}

/** Exit codes the supervisor itself returns when responding to a signal. */
const SIGNAL_EXIT_CODE: Record<"SIGINT" | "SIGTERM", number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

const DEFAULT_MAX_FAST_FAILURES = 5;
const DEFAULT_FAST_FAILURE_WINDOW_MS = 30_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

function backoffMs(crashCount: number, capMs: number): number {
  // 1st crash → 1s, 2nd → 2s, 3rd → 4s, ... doubled, capped.
  const exp = Math.max(0, crashCount - 1);
  const base = 1000 * 2 ** exp;
  return Math.min(base, capMs);
}

function fmtFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(" ");
}

function supervisorLine(
  nowMs: number,
  event: string,
  fields: Record<string, unknown>,
): string {
  const ts = new Date(nowMs).toISOString();
  const tail = fmtFields(fields);
  return tail ? `[${ts}] [supervisor] ${event} ${tail}` : `[${ts}] [supervisor] ${event}`;
}

export async function superviseOvernight(
  deps: SupervisorDeps,
  opts: SupervisorOpts,
): Promise<{ exitCode: number }> {
  const maxFastFailures = opts.maxFastFailures ?? DEFAULT_MAX_FAST_FAILURES;
  const fastFailureWindowMs =
    opts.fastFailureWindowMs ?? DEFAULT_FAST_FAILURE_WINDOW_MS;
  const backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;

  // Sticky monotonic signal flag. Once any signal is observed, every subsequent
  // race against `sigPromise()` resolves immediately. The supervisor uses this
  // to abort backoff sleeps and to refuse new spawns after a shutdown request.
  let signalSeen: "SIGINT" | "SIGTERM" | null = null;
  const signalWaiters: Array<(sig: "SIGINT" | "SIGTERM") => void> = [];
  const onSig = (sig: "SIGINT" | "SIGTERM"): void => {
    if (signalSeen === null) signalSeen = sig;
    while (signalWaiters.length > 0) signalWaiters.shift()!(signalSeen);
  };
  const sigPromise = (): Promise<"SIGINT" | "SIGTERM"> => {
    if (signalSeen !== null) return Promise.resolve(signalSeen);
    return new Promise<"SIGINT" | "SIGTERM">((resolve) => {
      signalWaiters.push(resolve);
    });
  };
  const offSignal = deps.onSignal(onSig);

  let crashCount = 0;
  let fastFailureCount = 0;
  let spawnNum = 0;

  try {
    for (;;) {
      if (signalSeen !== null) {
        await deps.appendLog(
          supervisorLine(deps.now(), "shutdown_before_spawn", {
            signal: signalSeen,
          }),
        );
        return { exitCode: SIGNAL_EXIT_CODE[signalSeen] };
      }

      const argv = spawnNum === 0 ? opts.argvFirst : opts.argvRestart;
      const child = deps.spawnChild(argv, opts.env);
      spawnNum += 1;
      const spawnedAt = deps.now();
      await deps.appendLog(
        supervisorLine(deps.now(), "spawn", {
          pid: child.pid,
          attempt: spawnNum,
        }),
      );

      const childExited = child.exited;
      const winner = await Promise.race([
        childExited.then((r) => ({ kind: "exit" as const, ...r })),
        sigPromise().then((sig) => ({ kind: "signal" as const, sig })),
      ]);

      if (winner.kind === "signal") {
        await deps.appendLog(
          supervisorLine(deps.now(), "forwarding_signal", {
            sig: winner.sig,
            pid: child.pid,
          }),
        );
        try {
          child.kill(winner.sig);
        } catch {
          // best-effort; child may already be dead
        }
        const result = await childExited;
        const code = result.code ?? SIGNAL_EXIT_CODE[winner.sig];
        return { exitCode: code };
      }

      const exitCode = winner.code;
      const signal = winner.signal;
      const last = await deps.readLastResult();
      const ranMs = deps.now() - spawnedAt;

      // Clean terminal outcomes — propagate exit code, no restart.
      if (exitCode === EXIT_DONE && last !== null && last.kind === "done") {
        await deps.appendLog(
          supervisorLine(deps.now(), "worker_done", {
            merged: last.mergedCount,
            cycles: last.cycles,
          }),
        );
        return { exitCode: EXIT_DONE };
      }
      if (
        exitCode === EXIT_DONE &&
        last !== null &&
        last.kind === "needs-review"
      ) {
        await deps.appendLog(
          supervisorLine(deps.now(), "worker_needs_review", {
            review: last.reviewCount,
            cycles: last.cycles,
          }),
        );
        return { exitCode: EXIT_DONE };
      }
      if (exitCode === EXIT_FATAL && last !== null && last.kind === "fatal") {
        await deps.appendLog(
          supervisorLine(deps.now(), "worker_fatal", {
            fatal: last.fatalCount,
            cycles: last.cycles,
          }),
        );
        return { exitCode: EXIT_FATAL };
      }
      if (exitCode === EXIT_LOCK_CONFLICT) {
        await deps.appendLog(
          supervisorLine(deps.now(), "worker_lock_conflict", {}),
        );
        return { exitCode: EXIT_LOCK_CONFLICT };
      }
      // A worker that received SIGINT/SIGTERM internally and exited cleanly
      // with the conventional 128+signal codes — propagate, don't restart.
      if (signal === null && (exitCode === 130 || exitCode === 143)) {
        await deps.appendLog(
          supervisorLine(deps.now(), "worker_signal_exit", { code: exitCode }),
        );
        return { exitCode };
      }

      // Anything else: unexpected death. Backoff + restart.
      crashCount += 1;
      if (ranMs < fastFailureWindowMs) {
        fastFailureCount += 1;
      } else {
        fastFailureCount = 0;
      }

      if (fastFailureCount >= maxFastFailures) {
        await deps.appendLog(
          supervisorLine(deps.now(), "circuit_breaker_opened", {
            consecutive: fastFailureCount,
            window_ms: fastFailureWindowMs,
          }),
        );
        return { exitCode: 1 };
      }

      const backoff = backoffMs(crashCount, backoffCapMs);
      await deps.appendLog(
        supervisorLine(deps.now(), "worker_died", {
          exit: exitCode,
          signal: signal,
          ran_ms: ranMs,
          restart: crashCount,
          backoff_ms: backoff,
        }),
      );

      // Sleep, but a signal during backoff aborts cleanly.
      const winner2 = await Promise.race([
        deps.sleep(backoff).then(() => ({ kind: "slept" as const })),
        sigPromise().then((sig) => ({ kind: "signal" as const, sig })),
      ]);
      if (winner2.kind === "signal") {
        await deps.appendLog(
          supervisorLine(deps.now(), "shutdown_during_backoff", {
            sig: winner2.sig,
          }),
        );
        return { exitCode: SIGNAL_EXIT_CODE[winner2.sig] };
      }
      // Loop back and respawn.
    }
  } finally {
    offSignal();
  }
}
