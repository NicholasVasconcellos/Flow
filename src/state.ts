import { promises as fs } from "node:fs";
import {
  StateSchema,
  type Notification,
  type Session,
  type State,
  type TaskDef,
  type TaskRuntime,
} from "./types.js";
import { Paths } from "./paths.js";
import {
  appendJsonl,
  readJsonIfExists,
  readJsonlLines,
  writeJsonAtomic,
} from "./atomic.js";
import { nowIso } from "./ids.js";

function emptyState(): State {
  return StateSchema.parse({ tasks: [], sessions: [], updatedAt: nowIso() });
}

export class StateStore {
  private state: State;

  constructor(private readonly paths: Paths) {
    this.state = emptyState();
  }

  async load(): Promise<State> {
    const raw = await readJsonIfExists<unknown>(this.paths.stateJson);
    if (raw === null) {
      this.state = emptyState();
      return this.state;
    }
    this.state = StateSchema.parse(raw);
    return this.state;
  }

  async save(): Promise<void> {
    this.state.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.stateJson, this.state);
  }

  getTasks(): TaskRuntime[] {
    return [...this.state.tasks];
  }

  getTask(taskId: string): TaskRuntime | undefined {
    return this.state.tasks.find((t) => t.id === taskId);
  }

  upsertTask(task: TaskRuntime): void {
    const idx = this.state.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      this.state.tasks[idx] = task;
    } else {
      this.state.tasks.push(task);
    }
  }

  removeTask(taskId: string): void {
    this.state.tasks = this.state.tasks.filter((t) => t.id !== taskId);
  }

  getSessions(): Session[] {
    return [...this.state.sessions];
  }

  getSession(sessionId: string): Session | undefined {
    return this.state.sessions.find((s) => s.id === sessionId);
  }

  upsertSession(session: Session): void {
    const idx = this.state.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      this.state.sessions[idx] = session;
    } else {
      this.state.sessions.push(session);
    }
  }

  syncFromTaskDefs(defs: TaskDef[]): {
    added: TaskRuntime[];
    removed: string[];
    updated: TaskRuntime[];
  } {
    const now = nowIso();
    const defsById = new Map(defs.map((d) => [d.id, d] as const));
    const existingById = new Map(this.state.tasks.map((t) => [t.id, t] as const));

    const added: TaskRuntime[] = [];
    const updated: TaskRuntime[] = [];
    const removed: string[] = [];

    // Removals first.
    for (const t of this.state.tasks) {
      if (!defsById.has(t.id)) {
        removed.push(t.id);
      }
    }

    // Build the new task list.
    const next: TaskRuntime[] = [];
    for (const def of defs) {
      const existing = existingById.get(def.id);
      if (!existing) {
        const fresh: TaskRuntime = {
          id: def.id,
          title: def.title,
          description: def.description,
          contextFiles: def.contextFiles,
          requires: def.requires,
          status: "pending",
          stage: "spec",
          retries: 0,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        };
        next.push(fresh);
        added.push(fresh);
        continue;
      }

      // Preserve runtime fields; update def-derived fields.
      const merged: TaskRuntime = {
        ...existing,
        title: def.title,
        description: def.description,
        contextFiles: def.contextFiles,
        requires: def.requires,
        updatedAt: now,
      };

      const changed =
        existing.title !== merged.title ||
        existing.description !== merged.description ||
        !arraysEqual(existing.contextFiles, merged.contextFiles) ||
        !arraysEqual(existing.requires, merged.requires);

      next.push(merged);
      if (changed) updated.push(merged);
    }

    this.state.tasks = next;
    return { added, removed, updated };
  }

  recomputeReadiness(): TaskRuntime[] {
    const byId = new Map(this.state.tasks.map((t) => [t.id, t] as const));
    const changed: TaskRuntime[] = [];
    const now = nowIso();
    for (const task of this.state.tasks) {
      if (task.status !== "pending") continue;
      const reqs = task.requires;
      const allDone =
        reqs.length === 0 ||
        reqs.every((rid) => {
          const dep = byId.get(rid);
          return !!dep && (dep.status === "done" || dep.status === "merged");
        });
      if (allDone) {
        task.status = "ready";
        task.updatedAt = now;
        changed.push(task);
      }
    }
    return changed;
  }

  async appendNotification(n: Notification): Promise<void> {
    await appendJsonl(this.paths.notificationsJsonl, n);
  }

  async listNotifications(): Promise<Notification[]> {
    const byId = new Map<string, Notification>();
    try {
      await fs.access(this.paths.notificationsJsonl);
    } catch {
      return [];
    }
    for await (const n of readJsonlLines<Notification>(this.paths.notificationsJsonl)) {
      byId.set(n.id, n);
    }
    return Array.from(byId.values());
  }

  async ackNotification(id: string): Promise<Notification | null> {
    const all = await this.listNotifications();
    const existing = all.find((n) => n.id === id);
    if (!existing) return null;
    const updated: Notification = { ...existing, acknowledged: true };
    await appendJsonl(this.paths.notificationsJsonl, updated);
    return updated;
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
