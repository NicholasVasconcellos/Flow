import path from "node:path";
import { promises as fs } from "node:fs";

import { Paths } from "./paths.js";
import { EventBus } from "./events.js";
import { StateStore } from "./state.js";
import { GitManager } from "./git.js";
import { AgentRunner } from "./agent.js";
import { Scheduler } from "./scheduler.js";
import {
  initProject,
  resolveBundledAssetsDir,
  ensureTasksLoaded as setupEnsureTasksLoaded,
  watchPlan,
} from "./setup.js";
import {
  loadConfig,
  mergeConfigPatch,
  saveConfig,
  type ConfigPatch,
} from "./config.js";
import { buildDag as buildDagFromTasks } from "./dag.js";
import { newId } from "./ids.js";
import { readJsonlLines } from "./atomic.js";
import type {
  Config,
  Dag,
  Events,
  EventName,
  Notification,
  Project,
  ProjectStatus,
  SessionEvent,
  TaskRuntime,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public Flow interface
// ---------------------------------------------------------------------------

export interface Flow {
  init(projectPath: string): Promise<void>;
  loadProject(projectPath: string): Promise<Project>;

  getTasks(): TaskRuntime[];
  getNextTask(): TaskRuntime | null;
  getReadyTasks(): TaskRuntime[];
  buildDag(): Dag;

  runOnce(): Promise<TaskRuntime | null>;
  runAllOnce(opts?: { limit?: number }): Promise<TaskRuntime[]>;
  runAll(opts?: { limit?: number }): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  resumePausedTasks(opts?: {
    status?: "paused" | "blocked" | "all";
  }): Promise<TaskRuntime[]>;
  cancelTask(taskId: string): Promise<void>;

  watch(): void;
  on<K extends keyof Events>(ev: K, cb: (e: Events[K]) => void): () => void;

  getConfig(): Config;
  updateConfig(patch: ConfigPatch): Promise<Config>;
  ensureTasksLoaded(): Promise<void>;
  stop(): void;
  getProject(): Project;
  getEventBus(): EventBus;
  replaySession(sessionId: string): Promise<AsyncIterable<SessionEvent>>;
  listNotifications(): Promise<Notification[]>;
  ackNotification(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Overrides — tests can inject fakes
// ---------------------------------------------------------------------------

export interface FlowOverrides {
  agent?: AgentRunner;
  git?: GitManager;
}

// ---------------------------------------------------------------------------
// Standalone init — callable before createFlow
// ---------------------------------------------------------------------------

export async function initFlowProject(
  projectPath: string,
  assetsDir?: string,
): Promise<void> {
  const paths = new Paths(projectPath);
  const cfg = await loadConfig(paths).catch(() => null);
  const mainBranch = cfg?.git.mainBranch ?? "main";
  const git = new GitManager(paths, mainBranch);
  await initProject(paths, {
    git,
    ...(assetsDir ? { assetsDir } : {}),
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FlowImpl implements Flow {
  private readonly paths: Paths;
  private readonly eventBus: EventBus;
  private readonly state: StateStore;
  private readonly git: GitManager;
  private readonly agent: AgentRunner;
  private readonly scheduler: Scheduler;
  private config: Config;
  private readonly projectPath: string;
  private readonly assetsDir: string;
  private watchDispose: (() => void) | null = null;
  private stopped = false;

  constructor(opts: {
    projectPath: string;
    assetsDir: string;
    paths: Paths;
    config: Config;
    state: StateStore;
    eventBus: EventBus;
    git: GitManager;
    agent: AgentRunner;
    scheduler: Scheduler;
  }) {
    this.projectPath = opts.projectPath;
    this.assetsDir = opts.assetsDir;
    this.paths = opts.paths;
    this.config = opts.config;
    this.state = opts.state;
    this.eventBus = opts.eventBus;
    this.git = opts.git;
    this.agent = opts.agent;
    this.scheduler = opts.scheduler;
  }

  // --- lifecycle ---------------------------------------------------------

  async init(projectPath: string): Promise<void> {
    await initFlowProject(projectPath, this.assetsDir);
  }

  async loadProject(_projectPath: string): Promise<Project> {
    // `_projectPath` is accepted per the interface contract but createFlow is
    // always bound to a specific root; honor the bound root instead.
    return this.getProject();
  }

  // --- tasks -------------------------------------------------------------

  getTasks(): TaskRuntime[] {
    return this.state.getTasks();
  }

  getReadyTasks(): TaskRuntime[] {
    return this.state.getTasks().filter((t) => t.status === "ready");
  }

  getNextTask(): TaskRuntime | null {
    const ready = this.getReadyTasks();
    if (ready.length === 0) return null;
    // Oldest by createdAt (lexical compare works for ISO-8601).
    const sorted = [...ready].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return sorted[0] ?? null;
  }

  buildDag(): Dag {
    return buildDagFromTasks(this.state.getTasks());
  }

  // --- execution ---------------------------------------------------------

  async runOnce(): Promise<TaskRuntime | null> {
    return this.scheduler.runOnce();
  }

  async runAllOnce(opts?: { limit?: number }): Promise<TaskRuntime[]> {
    return this.scheduler.runAllOnce(opts);
  }

  async runAll(opts?: { limit?: number }): Promise<void> {
    await this.scheduler.runAll(opts);
  }

  async retryTask(taskId: string): Promise<void> {
    await this.scheduler.retryTask(taskId);
  }

  async resumePausedTasks(opts?: {
    status?: "paused" | "blocked" | "all";
  }): Promise<TaskRuntime[]> {
    return this.scheduler.resumePausedTasks(opts);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.scheduler.cancelTask(taskId);
  }

  // --- watching ----------------------------------------------------------

  watch(): void {
    if (this.watchDispose || this.stopped) return;
    this.watchDispose = watchPlan(this.paths, () => {
      if (this.stopped) return;
      void (async () => {
        try {
          const previous = new Map(
            this.state.getTasks().map((t) => [t.id, t] as const),
          );
          await this.ensureTasksLoaded();
          // Emit upserts for changed/added tasks.
          for (const t of this.state.getTasks()) {
            const prev = previous.get(t.id);
            if (!prev || prev.updatedAt !== t.updatedAt) {
              this.eventBus.emit("task.upsert", { task: { ...t } });
            }
          }
        } catch (err) {
          this.eventBus.emit("error", {
            message: `plan.md reconcile failed: ${(err as Error).message}`,
          });
        }
      })();
    });
  }

  on<K extends EventName>(ev: K, cb: (e: Events[K]) => void): () => void {
    return this.eventBus.on(ev, cb);
  }

  // --- config + ensureTasks ---------------------------------------------

  getConfig(): Config {
    return this.config;
  }

  async updateConfig(patch: ConfigPatch): Promise<Config> {
    const next = mergeConfigPatch(this.config, patch);
    await saveConfig(this.paths, next);
    // Mutate the shared config reference in place so downstream holders
    // (Scheduler, AgentRunner) observe the new values without rewiring.
    // Clear top-level keys that shouldn't linger, then assign from `next`.
    for (const key of Object.keys(this.config) as Array<keyof Config>) {
      delete (this.config as Record<string, unknown>)[key];
    }
    Object.assign(this.config, next);
    this.eventBus.emit("config", { config: this.config });
    return this.config;
  }

  async ensureTasksLoaded(): Promise<void> {
    await setupEnsureTasksLoaded({
      paths: this.paths,
      config: this.config,
      state: this.state,
      git: this.git,
      agent: this.agent,
      eventBus: this.eventBus,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.watchDispose) {
      try {
        this.watchDispose();
      } catch {
        /* ignore */
      }
      this.watchDispose = null;
    }
    this.scheduler.cancel();
  }

  getProject(): Project {
    return buildProjectSnapshot(
      this.projectPath,
      this.config,
      this.state.getTasks(),
      "ready",
    );
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  async replaySession(sessionId: string): Promise<AsyncIterable<SessionEvent>> {
    const session = this.state.getSession(sessionId);
    const taskId = session?.taskId ?? null;
    const jsonlPath = this.paths.sessionJsonl(taskId, sessionId);
    // If we didn't find it in state and task-scoped path doesn't exist, fall
    // back to project-level path.
    const primary = jsonlPath;
    const fallback = this.paths.projectSessionJsonl(sessionId);

    const now = (): string => new Date().toISOString();
    const pickPath = async (): Promise<string | null> => {
      try {
        await fs.access(primary);
        return primary;
      } catch {
        /* try fallback */
      }
      try {
        await fs.access(fallback);
        return fallback;
      } catch {
        return null;
      }
    };

    async function* iter(): AsyncIterable<SessionEvent> {
      const p = await pickPath();
      if (!p) return;
      for await (const raw of readJsonlLines<unknown>(p)) {
        const event = toSessionEvent(raw, sessionId, now());
        if (event) yield event;
      }
    }
    return iter();
  }

  async listNotifications(): Promise<Notification[]> {
    return this.state.listNotifications();
  }

  async ackNotification(id: string): Promise<void> {
    await this.state.ackNotification(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSessionEvent(
  raw: unknown,
  sessionId: string,
  fallbackTs: string,
): SessionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Already-shaped SessionEvent?
  if (
    typeof obj["sessionId"] === "string" &&
    typeof obj["kind"] === "string" &&
    typeof obj["ts"] === "string" &&
    "payload" in obj
  ) {
    return obj as unknown as SessionEvent;
  }

  // Raw Claude Code stream-json payload — infer a minimal event envelope.
  const ts =
    typeof obj["timestamp"] === "string"
      ? (obj["timestamp"] as string)
      : typeof obj["ts"] === "string"
        ? (obj["ts"] as string)
        : fallbackTs;

  return {
    sessionId,
    ts,
    kind: inferKind(obj),
    payload: obj,
  };
}

function inferKind(payload: Record<string, unknown>): SessionEvent["kind"] {
  const type = payload["type"];
  switch (type) {
    case "system":
      return "system";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "usage":
    case "result":
      return "usage";
    case "stop":
      return "stop";
    case "assistant":
      return "assistant_text";
    default:
      return "system";
  }
}

function buildProjectSnapshot(
  projectPath: string,
  config: Config,
  tasks: TaskRuntime[],
  status: ProjectStatus,
): Project {
  const dag = buildDagFromTasks(tasks);
  return {
    name: path.basename(projectPath),
    path: projectPath,
    status,
    config,
    tasks,
    dag,
  };
}

// ---------------------------------------------------------------------------
// createFlow — factory
// ---------------------------------------------------------------------------

export async function createFlow(
  opts: { projectPath: string; assetsDir?: string },
  overrides?: FlowOverrides,
): Promise<Flow> {
  const projectPath = path.resolve(opts.projectPath);
  const assetsDir = opts.assetsDir ?? resolveBundledAssetsDir();
  const paths = new Paths(projectPath);

  const config = await loadConfig(paths);
  const eventBus = new EventBus();
  const state = new StateStore(paths);
  await state.load();

  const git = overrides?.git ?? new GitManager(paths, config.git.mainBranch);
  const agent =
    overrides?.agent ??
    new AgentRunner({
      paths,
      config,
      eventBus,
    });

  const scheduler = new Scheduler({
    paths,
    config,
    state,
    git,
    agent,
    eventBus,
  });

  // Clear out any tasks left `status=running` by a previous orchestrator
  // that was killed mid-run. No worker exists yet in this fresh process,
  // so everything flagged as running is an orphan.
  await scheduler.recoverStaleTasks();

  // If tasks.json already exists, sync defs into state + recompute readiness.
  // We do this via setupEnsureTasksLoaded, which is a no-op agent call when
  // tasks.json is already present.
  try {
    await fs.access(paths.tasksJson);
    await setupEnsureTasksLoaded({
      paths,
      config,
      state,
      git,
      agent,
      eventBus,
    });
  } catch {
    /* tasks.json missing or sync failed — caller can run ensureTasksLoaded */
  }

  const flow = new FlowImpl({
    projectPath,
    assetsDir,
    paths,
    config,
    state,
    eventBus,
    git,
    agent,
    scheduler,
  });

  // Emit project.state once.
  queueMicrotask(() => {
    try {
      eventBus.emit("project.state", { project: flow.getProject() });
    } catch {
      /* ignore */
    }
  });

  return flow;
}

// Satisfy tooling that expects a value-export for FlowImpl's module boundary.
export const _internal = { newId };
