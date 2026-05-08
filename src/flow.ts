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
  syncBundledPrompts,
  syncBundledSkills,
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
import { ProjectArtifacts, toSessionEvent } from "./artifacts.js";
import { SessionTailer } from "./sessionTail.js";
import type {
  Config,
  Dag,
  Events,
  EventName,
  Notification,
  Project,
  ProjectLearning,
  ProjectStatus,
  Session,
  TaskArtifacts,
  TaskRuntime,
} from "./types.js";

// Re-export for downstream callers that previously imported the helper from
// flow.ts before it was lifted.
export { toSessionEvent };

// ---------------------------------------------------------------------------
// Public Flow interface
// ---------------------------------------------------------------------------

export interface Flow {
  init(projectPath: string): Promise<void>;
  loadProject(projectPath: string): Promise<Project>;

  getTasks(): TaskRuntime[];
  getNextTask(): TaskRuntime | null;
  getReadyTasks(): TaskRuntime[];
  getSessions(): Session[];
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
  shutdown(message?: string): Promise<void>;
  getProject(): Promise<Project>;
  getEventBus(): EventBus;
  getPaths(): Paths;
  getArtifacts(): ProjectArtifacts;
  listNotifications(): Promise<Notification[]>;
  ackNotification(id: string): Promise<void>;
  clearNotifications(): Promise<void>;
  /** True when the Flow was constructed in read-only mode (e.g. by `flow
   *  serve`). Mutating WS commands should reject when this is set; the
   *  driving orchestrator runs as a sibling process. */
  isReadOnly(): boolean;
  /** Re-read state.json from disk and emit `task.upsert` for any task whose
   *  fields differ from the in-memory copy. Used by the read-only WS server
   *  to surface mutations made by a sibling driver. No-op when the disk
   *  mtime hasn't advanced. */
  refreshFromDisk(): Promise<void>;
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
  private readonly artifacts: ProjectArtifacts;
  private config: Config;
  private readonly projectPath: string;
  private readonly assetsDir: string;
  private readonly gitRemote: string | null;
  private readonly readOnly: boolean;
  /** Live JSONL tailer for per-session event streams. Constructed only in
   *  read-only mode (`flow serve`) — in writer mode the agent emits events
   *  directly onto the in-process bus, so disk tail would double-emit. */
  private readonly sessionTailer: SessionTailer | null;
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
    gitRemote: string | null;
    readOnly?: boolean;
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
    this.gitRemote = opts.gitRemote;
    this.readOnly = opts.readOnly ?? false;
    this.artifacts = new ProjectArtifacts(opts.paths, opts.state);
    this.sessionTailer = this.readOnly
      ? new SessionTailer(opts.paths, opts.eventBus)
      : null;
    // Initial sweep — any session already running in the loaded state needs a
    // tailer immediately, before refreshFromDisk fires on the next mtime tick.
    if (this.sessionTailer) {
      this.sessionTailer.reconcile(this.state.getSessions());
    }
  }

  // --- lifecycle ---------------------------------------------------------

  async init(projectPath: string): Promise<void> {
    await initFlowProject(projectPath, this.assetsDir);
  }

  async loadProject(_projectPath: string): Promise<Project> {
    // `_projectPath` is accepted per the interface contract but createFlow is
    // always bound to a specific root; honor the bound root instead.
    return await this.getProject();
  }

  // --- tasks -------------------------------------------------------------

  getTasks(): TaskRuntime[] {
    return this.state.getTasks();
  }

  getReadyTasks(): TaskRuntime[] {
    return this.state.getTasks().filter((t) => t.status === "ready");
  }

  getSessions(): Session[] {
    return this.state.getSessions();
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

  private guardWritable(op: string): void {
    if (this.readOnly) {
      throw new Error(`${op} not permitted in read-only mode`);
    }
  }

  async runOnce(): Promise<TaskRuntime | null> {
    this.guardWritable("runOnce");
    return this.scheduler.runOnce();
  }

  async runAllOnce(opts?: { limit?: number }): Promise<TaskRuntime[]> {
    this.guardWritable("runAllOnce");
    return this.scheduler.runAllOnce(opts);
  }

  async runAll(opts?: { limit?: number }): Promise<void> {
    this.guardWritable("runAll");
    await this.scheduler.runAll(opts);
  }

  async retryTask(taskId: string): Promise<void> {
    this.guardWritable("retryTask");
    await this.scheduler.retryTask(taskId);
  }

  async resumePausedTasks(opts?: {
    status?: "paused" | "blocked" | "all";
  }): Promise<TaskRuntime[]> {
    this.guardWritable("resumePausedTasks");
    return this.scheduler.resumePausedTasks(opts);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.guardWritable("cancelTask");
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
    if (this.sessionTailer) {
      void this.sessionTailer.dispose();
    }
  }

  /** Graceful shutdown for the SIGINT/SIGTERM path: stop accepting new work,
   *  kill any in-flight agent processes (so they don't survive as orphans
   *  holding state-task slots), then checkpoint every still-`running` task
   *  to `paused` with the given message so `state.json` reflects reality
   *  before the process exits. Order matters — killing first means the next
   *  resume won't double-spawn against an already-paused task. */
  async shutdown(message = "Cancelled by SIGINT"): Promise<void> {
    this.stop();
    await this.agent.killAllLive("SIGTERM");
    await this.scheduler.pauseAllRunning(message);
  }

  async getProject(): Promise<Project> {
    return buildProjectSnapshot(
      this.projectPath,
      this.paths,
      this.config,
      this.state,
      "ready",
      this.gitRemote,
    );
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getPaths(): Paths {
    return this.paths;
  }

  getArtifacts(): ProjectArtifacts {
    return this.artifacts;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  async refreshFromDisk(): Promise<void> {
    const result = await this.state.reloadFromDiskIfChanged();
    if (!result) return;
    for (const t of result.tasks) {
      this.eventBus.emit("task.upsert", { task: { ...t } });
    }
    for (const s of result.sessions.started) {
      this.eventBus.emit("session.started", { session: { ...s } });
    }
    for (const s of result.sessions.updated) {
      this.eventBus.emit("session.updated", { session: { ...s } });
    }
    for (const s of result.sessions.ended) {
      this.eventBus.emit("session.ended", { session: { ...s } });
    }
    if (this.sessionTailer) {
      this.sessionTailer.reconcile(this.state.getSessions());
    }
  }

  async listNotifications(): Promise<Notification[]> {
    return this.state.listNotifications();
  }

  async ackNotification(id: string): Promise<void> {
    await this.state.ackNotification(id);
  }

  async clearNotifications(): Promise<void> {
    await this.state.clearNotifications();
    this.eventBus.emit("notifications.cleared", {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildProjectSnapshot(
  projectPath: string,
  paths: Paths,
  config: Config,
  state: StateStore,
  status: ProjectStatus,
  gitRemote: string | null,
): Promise<Project> {
  const tasks = state.getTasks();
  const sessions = state.getSessions();
  const dag = buildDagFromTasks(tasks);

  const [notifResult, learnings, taskArtifacts] = await Promise.all([
    readNotificationsBounded(paths),
    readLearningsBounded(paths),
    readAllTaskArtifacts(paths, tasks),
  ]);

  return {
    name: path.basename(projectPath),
    path: projectPath,
    status,
    config,
    tasks,
    sessions,
    dag,
    gitRemote,
    notifications: notifResult.entries,
    notificationsTruncated: notifResult.truncated,
    learnings,
    taskArtifacts,
  };
}

// ---------------------------------------------------------------------------
// Bounded artifact readers — used by buildProjectSnapshot to inline a
// size-capped snapshot of disk state into project.state. Caps per
// cross-cutting decision #3 of the implementation plan; unbounded artifacts
// (verify.log, full session events) stay lazy via artifact.fetch.
// ---------------------------------------------------------------------------

const NOTIFICATIONS_MAX_ENTRIES = 500;
const NOTIFICATIONS_MAX_BYTES = 256 * 1024;
const LEARNING_MAX_BYTES = 128 * 1024;
const TASK_TEXT_MAX_BYTES = 32 * 1024;

async function readBounded(
  filePath: string,
  byteCap: number,
): Promise<{ text: string; truncated: boolean } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (Buffer.byteLength(raw, "utf8") <= byteCap) {
    return { text: raw, truncated: false };
  }
  // Slice on UTF-8 byte cap, then drop the trailing partial char if any.
  const buf = Buffer.from(raw, "utf8").subarray(0, byteCap);
  return { text: buf.toString("utf8"), truncated: true };
}

async function readNotificationsBounded(
  paths: Paths,
): Promise<{ entries: Notification[]; truncated: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.notificationsJsonl, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], truncated: false };
    }
    throw err;
  }
  // Same fold semantics as StateStore.listNotifications: dedup by id, last
  // write wins (so an `acknowledged: true` rewrite shadows the original).
  const byId = new Map<string, Notification>();
  let total = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Notification;
      byId.set(parsed.id, parsed);
      total += 1;
    } catch {
      /* skip malformed lines — same as readJsonlLines */
    }
  }
  const all = Array.from(byId.values());
  // Sort oldest → newest, then take the trailing window.
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let truncated = false;
  let trimmed = all;
  if (trimmed.length > NOTIFICATIONS_MAX_ENTRIES) {
    trimmed = trimmed.slice(-NOTIFICATIONS_MAX_ENTRIES);
    truncated = true;
  }
  // Byte-budget tighten: drop oldest until under cap.
  while (trimmed.length > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
    if (bytes <= NOTIFICATIONS_MAX_BYTES) break;
    trimmed = trimmed.slice(1);
    truncated = true;
  }
  void total;
  return { entries: trimmed, truncated };
}

async function readLearningsBounded(paths: Paths): Promise<ProjectLearning[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.learningsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ProjectLearning[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    const taskId = name.replace(/\.md$/, "");
    const filePath = path.join(paths.learningsDir, name);
    const r = await readBounded(filePath, LEARNING_MAX_BYTES);
    if (!r) continue;
    const entry: ProjectLearning = {
      taskId,
      path: filePath,
      markdown: r.text,
    };
    if (r.truncated) entry.truncated = true;
    out.push(entry);
  }
  return out;
}

async function readAllTaskArtifacts(
  paths: Paths,
  tasks: TaskRuntime[],
): Promise<Record<string, TaskArtifacts>> {
  const out: Record<string, TaskArtifacts> = {};
  await Promise.all(
    tasks.map(async (t) => {
      const artifacts = await readTaskArtifacts(paths, t.id);
      // Keep the snapshot small — only emit entries that have *something*
      // worth inlining beyond the all-default skeleton.
      const hasContent =
        artifacts.progress !== undefined ||
        artifacts.summary !== undefined ||
        artifacts.learningsDraft !== undefined ||
        artifacts.roundIssues.length > 0 ||
        artifacts.screenshots.length > 0 ||
        artifacts.verifyLogPresent;
      if (hasContent) out[t.id] = artifacts;
    }),
  );
  return out;
}

async function readTaskArtifacts(
  paths: Paths,
  taskId: string,
): Promise<TaskArtifacts> {
  const [progress, summary, learningsDraft, issues, screenshots, verifyExists] =
    await Promise.all([
      readBounded(paths.taskProgressTxt(taskId), TASK_TEXT_MAX_BYTES),
      readBounded(paths.taskSummary(taskId), TASK_TEXT_MAX_BYTES),
      readBounded(paths.taskLearningsDraft(taskId), TASK_TEXT_MAX_BYTES),
      listRoundIssues(paths, taskId),
      listScreenshots(paths, taskId),
      fileExists(paths.taskVerifyLog(taskId)),
    ]);
  const result: TaskArtifacts = {
    roundIssues: issues,
    screenshots,
    verifyLogPresent: verifyExists,
  };
  if (progress) result.progress = progress.text;
  if (summary) result.summary = summary.text;
  if (learningsDraft) result.learningsDraft = learningsDraft.text;
  return result;
}

async function listRoundIssues(
  paths: Paths,
  taskId: string,
): Promise<TaskArtifacts["roundIssues"]> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.taskIssuesDir(taskId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: TaskArtifacts["roundIssues"] = [];
  for (const name of entries) {
    const m = /^round-(\d+)-issues\.md$/.exec(name);
    if (!m) continue;
    out.push({ round: Number(m[1]), filename: name });
  }
  out.sort((a, b) => a.round - b.round);
  return out;
}

async function listScreenshots(paths: Paths, taskId: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(paths.taskScreenshotsDir(taskId));
    return entries.sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// createFlow — factory
// ---------------------------------------------------------------------------

export async function createFlow(
  opts: { projectPath: string; assetsDir?: string; readOnly?: boolean },
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
      state,
    });

  const scheduler = new Scheduler({
    paths,
    config,
    state,
    git,
    agent,
    eventBus,
  });

  // Bundled prompts and skills can grow over time; existing projects must
  // pick up newly-added entries so stages like `update-learning` /
  // `merge-verify` don't crash the orchestrator on first reach. Bundled
  // files are refreshed in lockstep with Flow itself so a stage prompt
  // can't go stale; project-added skills are left untouched. Skipped for
  // read-only commands.
  if (!opts.readOnly) {
    const promptSync = await syncBundledPrompts(paths, assetsDir);
    if (promptSync.added.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Synced ${promptSync.added.length} bundled prompt(s) into .flow/prompts: ${promptSync.added.join(", ")}`,
      );
    }
    if (promptSync.updated.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Refreshed ${promptSync.updated.length} bundled prompt(s) in .flow/prompts: ${promptSync.updated.join(", ")}`,
      );
    }
    const skillSync = await syncBundledSkills(paths, assetsDir);
    if (skillSync.added.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Synced ${skillSync.added.length} bundled skill(s) into .flow/skills: ${skillSync.added.join(", ")}`,
      );
    }
    if (skillSync.updated.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Refreshed ${skillSync.updated.length} bundled skill(s) in .flow/skills: ${skillSync.updated.join(", ")}`,
      );
    }
  }

  // Clear out any tasks left `status=running` by a previous orchestrator
  // that was killed mid-run. No worker exists yet in this fresh process,
  // so everything flagged as running is an orphan.
  //
  // Skipped for read-only invocations (`flow status`, `dag`, `logs`) — those
  // commands must never mutate task state, since they're often run while a
  // sibling orchestrator (`run-all`, `serve`) is alive. The scheduler will
  // additionally skip the sweep if a live lock from another PID exists.
  if (!opts.readOnly) {
    await scheduler.recoverStaleTasks();
  }

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

  // Resolve origin URL once at project open. The user-set config.git.remote
  // takes precedence; otherwise we read `git remote get-url origin`. Never
  // queried per WS frame — TopBar reads from this cached value via getProject.
  const gitRemote: string | null =
    config.git.remote ?? (await git.getOriginUrl());

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
    gitRemote,
    readOnly: opts.readOnly ?? false,
  });

  // Emit project.state once.
  queueMicrotask(() => {
    void (async () => {
      try {
        const project = await flow.getProject();
        eventBus.emit("project.state", { project });
      } catch {
        /* ignore */
      }
    })();
  });

  return flow;
}

// Satisfy tooling that expects a value-export for FlowImpl's module boundary.
export const _internal = { newId };
