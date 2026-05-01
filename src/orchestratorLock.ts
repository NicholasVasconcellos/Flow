import { promises as fs, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";

import { ensureDir, readJsonIfExists, writeJsonAtomic } from "./atomic.js";
import type { Paths } from "./paths.js";
import { nowIso } from "./ids.js";

/** Heartbeat staleness threshold (ms). A lock whose heartbeat is older than
 *  this is considered abandoned even if its PID is still alive. */
const HEARTBEAT_STALE_MS = 30_000;

export interface OrchestratorLock {
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  command: string;
}

export interface AcquiredLock {
  released: () => Promise<void>;
  refresh: () => Promise<void>;
}

export interface LockConflict {
  conflict: OrchestratorLock;
}

/** Returns true if the given pid is reachable on this host. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists but we lack permission
    // (still alive from our perspective).
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function isLive(lock: OrchestratorLock): boolean {
  if (lock.host !== os.hostname()) {
    // Cross-host stale records can't be checked locally; treat as not-live so
    // the new orchestrator can proceed. Concurrent access from another host
    // to the same .flow/ directory isn't a supported configuration.
    return false;
  }
  if (!isPidAlive(lock.pid)) return false;
  const heartbeatTs = Date.parse(lock.heartbeatAt);
  if (!Number.isFinite(heartbeatTs)) return false;
  return Date.now() - heartbeatTs < HEARTBEAT_STALE_MS;
}

/** Read the current lock if it exists AND is still live (PID reachable +
 *  recent heartbeat). Returns null if the file is missing or stale. */
export async function readLiveLock(
  paths: Paths,
): Promise<OrchestratorLock | null> {
  const lock = await readJsonIfExists<OrchestratorLock>(paths.orchestratorLock);
  if (!lock) return null;
  if (!isLive(lock)) return null;
  return lock;
}

/** Best-effort delete of the lock file, only if it matches our PID. */
export async function releaseLock(
  paths: Paths,
  expectedPid: number,
): Promise<void> {
  const lock = await readJsonIfExists<OrchestratorLock>(paths.orchestratorLock);
  if (!lock) return;
  if (lock.pid !== expectedPid) return;
  try {
    await fs.unlink(paths.orchestratorLock);
  } catch {
    /* ignore — already gone */
  }
}

/** Synchronous companion to `releaseLock`, safe to call from
 *  `process.on("exit", ...)` handlers and the catastrophic
 *  uncaughtException / unhandledRejection paths where async I/O isn't
 *  guaranteed to flush. PID-checked so a sibling process that took over
 *  after a crash doesn't lose its claim to ours. */
export function releaseLockSync(paths: Paths, expectedPid: number): void {
  let raw: string;
  try {
    raw = readFileSync(paths.orchestratorLock, "utf8");
  } catch {
    return;
  }
  let lock: OrchestratorLock;
  try {
    lock = JSON.parse(raw) as OrchestratorLock;
  } catch {
    return;
  }
  if (lock.pid !== expectedPid) return;
  try {
    unlinkSync(paths.orchestratorLock);
  } catch {
    /* ignore */
  }
}

/** Try to atomically claim the orchestrator lock. If a live lock owned by a
 *  different process exists, returns `{ conflict }`. If the existing lock is
 *  stale (PID gone, heartbeat old, or wrong host), it's overwritten. */
export async function acquireLock(
  paths: Paths,
  command: string,
): Promise<AcquiredLock | LockConflict> {
  await ensureDir(paths.flowDir);

  const existing = await readJsonIfExists<OrchestratorLock>(
    paths.orchestratorLock,
  );
  if (existing && existing.pid !== process.pid && isLive(existing)) {
    return { conflict: existing };
  }
  // Either no existing lock, or it's stale, or it's already ours — claim it.
  // Surface stale-but-present overwrites: leaving this silent makes "why is
  // there no /tmp/.flow lock" debugging unnecessarily archaeological.
  if (existing && existing.pid !== process.pid && !isLive(existing)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[flow] reclaiming stale orchestrator lock (previousPid=${existing.pid}, previousHeartbeatAt=${existing.heartbeatAt}, previousCommand=${existing.command})`,
    );
  }

  const pid = process.pid;
  const host = os.hostname();
  const startedAt = nowIso();
  const lock: OrchestratorLock = {
    pid,
    host,
    startedAt,
    heartbeatAt: startedAt,
    command,
  };
  await writeJsonAtomic(paths.orchestratorLock, lock);

  return {
    refresh: async (): Promise<void> => {
      // Refresh only if we still own the lock; refuse to overwrite a competing
      // claim that might have arrived after stale-eviction.
      const cur = await readJsonIfExists<OrchestratorLock>(
        paths.orchestratorLock,
      );
      if (cur && cur.pid !== pid) return;
      const next: OrchestratorLock = {
        pid,
        host,
        startedAt,
        heartbeatAt: nowIso(),
        command,
      };
      await writeJsonAtomic(paths.orchestratorLock, next);
    },
    released: async (): Promise<void> => {
      await releaseLock(paths, pid);
    },
  };
}
