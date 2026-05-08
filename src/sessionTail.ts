import { promises as fs } from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";

import type { Paths } from "./paths.js";
import type { EventBus } from "./events.js";
import type { Session, SessionEvent } from "./types.js";
import { toSessionEvent } from "./artifacts.js";

interface Tail {
  taskId: string | null;
  filePath: string;
  watcher: FSWatcher;
  offset: number;
  residual: string;
  /** Drains are async; serialize so a fast burst of `change` events doesn't
   *  interleave reads against the same offset. */
  draining: Promise<void>;
}

/**
 * Watches per-session JSONL files on disk and re-emits each line as a
 * `session.event` on the supplied EventBus. Used by the `flow serve`
 * (read-only) Flow so that a UI connected to it sees live event streams from
 * agents driven by a sibling writer process (`run-all`, `overnight`).
 *
 * Lifecycle is reconciled against the in-memory session list: any session
 * whose status is `running` gets a tail; anything else gets stopped.
 *
 * Initial open reads from byte 0 — the UI's `seenEventKeys` dedup absorbs
 * any overlap with cold-load `artifact.fetch` replays.
 */
export class SessionTailer {
  private readonly tails = new Map<string, Tail>();
  private disposed = false;

  constructor(
    private readonly paths: Paths,
    private readonly eventBus: EventBus,
  ) {}

  /** Start tailers for every running session in `sessions` that isn't already
   *  tailed; stop tailers for any tailed session that's no longer running (or
   *  no longer in the list). Idempotent. */
  reconcile(sessions: Session[]): void {
    if (this.disposed) return;
    const wantedById = new Map<string, Session>();
    for (const s of sessions) {
      if (s.status === "running") wantedById.set(s.id, s);
    }
    for (const [id, tail] of this.tails) {
      if (!wantedById.has(id)) {
        void this.stop(id, tail);
      }
    }
    for (const [id, s] of wantedById) {
      if (!this.tails.has(id)) this.start(s.taskId, id);
    }
  }

  /** Begin tailing the JSONL for `(taskId, sessionId)`. Safe to call when the
   *  file doesn't exist yet — chokidar fires `add` once it appears. */
  start(taskId: string | null, sessionId: string): void {
    if (this.disposed || this.tails.has(sessionId)) return;
    const filePath = this.paths.sessionJsonl(taskId, sessionId);
    const watcher = chokidar.watch(filePath, {
      // We want to learn about the file's current size on `add`; usePolling
      // off (default) is fine on macOS/Linux. Disable awaitWriteFinish — the
      // writer appends one line at a time and we tolerate partial-line reads
      // via the residual buffer.
      ignoreInitial: false,
      awaitWriteFinish: false,
    });
    const tail: Tail = {
      taskId,
      filePath,
      watcher,
      offset: 0,
      residual: "",
      draining: Promise.resolve(),
    };
    this.tails.set(sessionId, tail);

    const onChange = (): void => {
      tail.draining = tail.draining.then(() => this.drain(sessionId));
    };
    watcher.on("add", onChange);
    watcher.on("change", onChange);
    watcher.on("error", () => {
      /* swallow — best-effort */
    });
  }

  private async drain(sessionId: string): Promise<void> {
    const tail = this.tails.get(sessionId);
    if (!tail) return;
    let stat;
    try {
      stat = await fs.stat(tail.filePath);
    } catch {
      return;
    }
    if (stat.size <= tail.offset) return;

    let buf: Buffer;
    let handle;
    try {
      handle = await fs.open(tail.filePath, "r");
      const length = stat.size - tail.offset;
      buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, tail.offset);
      if (bytesRead < length) buf = buf.subarray(0, bytesRead);
      tail.offset += bytesRead;
    } catch {
      return;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }

    const text = tail.residual + buf.toString("utf8");
    const lines = text.split("\n");
    tail.residual = lines.pop() ?? "";

    const fallbackTs = new Date().toISOString();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const event = toSessionEvent(raw, sessionId, fallbackTs);
      if (event) this.eventBus.emit("session.event", { event });
    }
  }

  /** Stop tailing a session. Drains once more so any final line written
   *  between the writer's last append and the status flip isn't dropped. */
  private async stop(sessionId: string, tail?: Tail): Promise<void> {
    const t = tail ?? this.tails.get(sessionId);
    if (!t) return;
    this.tails.delete(sessionId);
    try {
      await t.draining;
      await this.finalDrain(sessionId, t);
    } finally {
      try {
        await t.watcher.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** A non-recursive drain that doesn't go through the per-tail map (since
   *  the entry is already removed by `stop`). Reused only there. */
  private async finalDrain(sessionId: string, tail: Tail): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(tail.filePath);
    } catch {
      return;
    }
    if (stat.size <= tail.offset) {
      // Flush trailing residual if it's a complete JSON object (no newline yet).
      if (tail.residual.trim()) {
        try {
          const raw = JSON.parse(tail.residual);
          const event = toSessionEvent(
            raw,
            sessionId,
            new Date().toISOString(),
          );
          if (event) this.eventBus.emit("session.event", { event });
        } catch {
          /* ignore — partial line */
        }
      }
      return;
    }
    let handle;
    let buf: Buffer;
    try {
      handle = await fs.open(tail.filePath, "r");
      const length = stat.size - tail.offset;
      buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, tail.offset);
      if (bytesRead < length) buf = buf.subarray(0, bytesRead);
      tail.offset += bytesRead;
    } catch {
      return;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
    const text = tail.residual + buf.toString("utf8");
    const lines = text.split("\n");
    const trailing = lines.pop() ?? "";
    const all = [...lines];
    if (trailing.trim()) all.push(trailing);
    const fallbackTs = new Date().toISOString();
    for (const line of all) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const event = toSessionEvent(raw, sessionId, fallbackTs);
      if (event) this.eventBus.emit("session.event", { event });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const ids = Array.from(this.tails.keys());
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}

// Re-export for downstream typing.
export type { SessionEvent };
