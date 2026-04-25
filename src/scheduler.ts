import { promises as fs } from "node:fs";

import type {
  Config,
  Notification,
  Session,
  TaskDef,
  TaskRuntime,
  TaskStage,
} from "./types.js";
import type { AgentRunner } from "./agent.js";
import type { StateStore } from "./state.js";
import type { GitManager } from "./git.js";
import type { EventBus } from "./events.js";
import type { Paths } from "./paths.js";
import { newId, nowIso } from "./ids.js";
import { readyTasks } from "./dag.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  paths: Paths;
  config: Config;
  state: StateStore;
  git: GitManager;
  agent: AgentRunner;
  eventBus: EventBus;
}

/** Ordered list of agent stages that actually run Claude. */
export type AgentStage =
  | "spec"
  | "exec"
  | "exec_ui_check"
  | "code_review"
  | "code_review_ui_check"
  | "documentation";

/** Full pipeline stage list (including synthetic done/merged markers). */
export function stagesFor(config: Config): AgentStage[] {
  const stages: AgentStage[] = [
    "spec",
    "exec",
    "exec_ui_check",
    "code_review",
    "code_review_ui_check",
  ];
  if (config.hasDocs !== false) stages.push("documentation");
  return stages;
}

export function stageSkill(stage: AgentStage): string {
  switch (stage) {
    case "spec":
      return "spec";
    case "exec":
      return "exec";
    case "exec_ui_check":
    case "code_review_ui_check":
      return "uiCheck";
    case "code_review":
      return "review";
    case "documentation":
      return "docs";
  }
}

// Internal per-task coordination handle.
interface TaskHandle {
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function taskDefView(task: TaskRuntime): TaskDef {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    contextFiles: task.contextFiles,
    requires: task.requires,
  };
}

function isBlockedError(message: string | undefined): boolean {
  return !!message && message.trimStart().startsWith("FLOW_BLOCKED:");
}

function blockedReason(message: string | undefined): string {
  if (!message) return "";
  const m = /FLOW_BLOCKED:\s*(.+)/.exec(message);
  return m ? (m[1] ?? "").trim() : message;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Stage signal payload the agent writes to `.flow/tasks/<id>/stage.json` to
 *  tell the orchestrator the stage finished cleanly (or is blocked). */
export interface StageSignal {
  stage: string;
  status: "done" | "blocked";
  reason?: string;
}

async function readStageSignal(
  paths: Paths,
  taskId: string,
): Promise<StageSignal | null> {
  const file = paths.taskStageSignal(taskId);
  let body: string;
  try {
    body = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as Partial<StageSignal>;
    if (
      parsed &&
      typeof parsed.stage === "string" &&
      (parsed.status === "done" || parsed.status === "blocked")
    ) {
      return {
        stage: parsed.stage,
        status: parsed.status,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      };
    }
  } catch {
    /* malformed — treat as missing */
  }
  return null;
}

async function clearStageSignal(paths: Paths, taskId: string): Promise<void> {
  try {
    await fs.unlink(paths.taskStageSignal(taskId));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly paths: Paths;
  private readonly config: Config;
  private readonly state: StateStore;
  private readonly git: GitManager;
  private readonly agent: AgentRunner;
  private readonly eventBus: EventBus;

  private running = new Map<string, TaskHandle>();
  private cancelFlag = false;
  /** Serialize state.save() calls so concurrent tasks don't race on the
   *  atomic tmp-file rename used by writeJsonAtomic. */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(deps: SchedulerDeps) {
    this.paths = deps.paths;
    this.config = deps.config;
    this.state = deps.state;
    this.git = deps.git;
    this.agent = deps.agent;
    this.eventBus = deps.eventBus;
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  runningCount(): number {
    return this.running.size;
  }

  runningTaskIds(): string[] {
    return Array.from(this.running.keys());
  }

  cancel(): void {
    this.cancelFlag = true;
  }

  async cancelTask(taskId: string): Promise<void> {
    const handle = this.running.get(taskId);
    if (handle) {
      handle.cancelled = true;
    }
    // Regardless of running state, mark paused so the UI shows something
    // coherent. If a stage is mid-flight the loop picks this up between
    // stages and returns without advancing.
    const task = this.state.getTask(taskId);
    if (task && (task.status === "running" || task.status === "ready")) {
      task.status = "paused";
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      await this.saveState();
      this.eventBus.emit("task.upsert", { task: { ...task } });
    }
  }

  /** Reset tasks left in `status=running` by a previous orchestrator crash
   *  or kill. Call once at Flow startup — when the Scheduler is fresh there
   *  is no live worker for anything, so any task still flagged as `running`
   *  is an orphan from a previous process. */
  async recoverStaleTasks(): Promise<TaskRuntime[]> {
    const recovered: TaskRuntime[] = [];
    for (const task of this.state.getTasks()) {
      if (task.status !== "running") continue;
      task.status = "paused";
      task.lastError = {
        stage: task.stage,
        message:
          "Orchestrator exited while this task was running; reset on startup.",
        at: nowIso(),
      };
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      recovered.push(task);
    }
    if (recovered.length > 0) {
      await this.saveState();
      for (const t of recovered) {
        this.eventBus.emit("task.upsert", { task: { ...t } });
      }
    }
    return recovered;
  }

  /** Flip paused and/or blocked tasks back to `ready` so the next `runAll`
   *  drain picks them up. Mirrors the per-task reset in `retryTask` but leaves
   *  scheduling to the drain loop so `maxConcurrent` is respected. */
  async resumePausedTasks(opts?: {
    status?: "paused" | "blocked" | "all";
  }): Promise<TaskRuntime[]> {
    const filter = opts?.status ?? "all";
    const resumed: TaskRuntime[] = [];
    for (const task of this.state.getTasks()) {
      const match =
        filter === "all"
          ? task.status === "paused" || task.status === "blocked"
          : task.status === filter;
      if (!match) continue;
      task.status = "ready";
      task.retries = 0;
      task.lastError = undefined;
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      resumed.push(task);
      this.eventBus.emit("task.upsert", { task: { ...task } });
    }
    if (resumed.length > 0) await this.saveState();
    return resumed;
  }

  async retryTask(taskId: string): Promise<void> {
    const task = this.state.getTask(taskId);
    if (!task) return;
    if (task.status !== "paused" && task.status !== "blocked") return;
    task.status = "running";
    task.retries = 0;
    task.lastError = undefined;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    // Fire the retry without awaiting — caller can observe via events. But if
    // this retry is part of programmatic control flow, we want completion
    // semantics: run inline.
    await this.runTask(taskId);
  }

  // -------------------------------------------------------------------------
  // Single-task runner
  // -------------------------------------------------------------------------

  async runTask(taskId: string): Promise<TaskRuntime> {
    const existing = this.state.getTask(taskId);
    if (!existing) {
      throw new Error(`Scheduler.runTask: unknown task id "${taskId}"`);
    }
    if (this.running.has(taskId)) {
      // Already running in this process — return current snapshot.
      return { ...existing };
    }
    const handle: TaskHandle = { cancelled: false };
    this.running.set(taskId, handle);
    try {
      return await this.drivePipeline(taskId, handle);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async drivePipeline(
    taskId: string,
    handle: TaskHandle,
  ): Promise<TaskRuntime> {
    const stages = stagesFor(this.config);

    const task0 = this.requireTask(taskId);
    if (!task0.startedAt) {
      task0.startedAt = nowIso();
    }

    const resumeStage: TaskStage = task0.stage ?? "spec";
    let startIndex = stages.indexOf(resumeStage as AgentStage);
    if (startIndex < 0) {
      if (resumeStage === "done" || resumeStage === "merged") {
        startIndex = stages.length;
      } else {
        startIndex = 0;
      }
    }

    let errorAddendum = "";

    for (let i = startIndex; i < stages.length; i++) {
      if (handle.cancelled) {
        return await this.pauseWithMessage(taskId, "Cancelled by user");
      }
      const stage = stages[i]!;
      const result = await this.runAgentStage(taskId, stage, errorAddendum);
      if (result.kind === "blocked" || result.kind === "paused") {
        return this.requireTask(taskId);
      }
      if (result.kind === "retry") {
        errorAddendum = result.addendum;
        i--;
        continue;
      }
      errorAddendum = "";
    }

    if (handle.cancelled) {
      return await this.pauseWithMessage(taskId, "Cancelled by user");
    }

    // Mark "done" between the final stage and merge so the UI can distinguish
    // "all stages complete, ready to merge" from "merging".
    {
      const t = this.requireTask(taskId);
      t.stage = "done";
      t.status = "running";
      t.updatedAt = nowIso();
      this.state.upsertTask(t);
      await this.saveState();
      this.eventBus.emit("task.upsert", { task: { ...t } });
    }

    const mergeResult = await this.runMergeStage(taskId);
    if (mergeResult.kind === "paused") {
      return this.requireTask(taskId);
    }
    return this.requireTask(taskId);
  }

  // -------------------------------------------------------------------------
  // Agent stage machinery
  // -------------------------------------------------------------------------

  private async runAgentStage(
    taskId: string,
    stage: AgentStage,
    errorAddendum: string,
  ): Promise<
    | { kind: "ok" }
    | { kind: "retry"; addendum: string }
    | { kind: "paused" }
    | { kind: "blocked" }
  > {
    let task = this.requireTask(taskId);
    task.stage = stage;
    task.status = "running";
    task.updatedAt = nowIso();
    if (!task.startedAt) task.startedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });

    if (!task.worktreePath) {
      const { worktreePath, branchName } = await this.git.createWorktree(taskId);
      task = this.requireTask(taskId);
      task.worktreePath = worktreePath;
      task.branchName = branchName;
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      await this.saveState();
      this.eventBus.emit("task.upsert", { task: { ...task } });
    }

    const worktreePath = task.worktreePath!;

    // Clear any leftover stage signal from a previous attempt before spawning.
    await clearStageSignal(this.paths, taskId);

    const summary = await readIfExists(this.paths.taskSummary(taskId));
    const extraPrompt = [summary ?? "", errorAddendum]
      .filter((s) => s && s.trim())
      .join("\n\n---\n\n");

    const session = await this.agent.spawnAgent({
      taskId,
      stage,
      skillName: stageSkill(stage),
      worktreePath,
      task: taskDefView(task),
      contextFiles: task.contextFiles,
      ...(extraPrompt ? { extraPrompt } : {}),
    });

    this.state.upsertSession(session);

    task = this.requireTask(taskId);
    if (!task.sessionIds.includes(session.id)) {
      task.sessionIds = [...task.sessionIds, session.id];
    }
    task.currentSessionId = session.id;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);

    if (session.status === "failed") {
      const err = session.error ?? `Stage ${stage} failed`;
      if (isBlockedError(err)) {
        return await this.markBlocked(taskId, stage, session.id, err);
      }
      if (task.retries < this.config.retryCount) {
        task.retries += 1;
        task.lastError = { stage, message: err, at: nowIso() };
        task.updatedAt = nowIso();
        this.state.upsertTask(task);
        await this.saveState();
        this.eventBus.emit("task.upsert", { task: { ...task } });
        return {
          kind: "retry",
          addendum: `# Previous attempt error\nStage ${stage} failed:\n${err}\n\nPlease fix and retry.`,
        };
      }
      return await this.markPaused(taskId, stage, session.id, err);
    }

    // Stage signal trumps regex parsing if present. Falls back to legacy
    // success-implies-advance behavior when the file is absent so unmigrated
    // skills keep working.
    const signal = await readStageSignal(this.paths, taskId);
    if (signal) {
      if (signal.status === "blocked") {
        const reason = signal.reason || `Stage ${stage} reported blocked`;
        return await this.markBlocked(
          taskId,
          stage,
          session.id,
          `FLOW_BLOCKED: ${reason}`,
        );
      }
      if (signal.stage !== stage) {
        // Drift — agent claimed a different stage. Treat as a failed stage so
        // the user notices, retrying if budget allows.
        const msg = `Stage signal mismatch: agent wrote stage="${signal.stage}" but expected "${stage}"`;
        if (task.retries < this.config.retryCount) {
          task.retries += 1;
          task.lastError = { stage, message: msg, at: nowIso() };
          task.updatedAt = nowIso();
          this.state.upsertTask(task);
          await this.saveState();
          this.eventBus.emit("task.upsert", { task: { ...task } });
          return {
            kind: "retry",
            addendum: `# Previous attempt error\n${msg}\n\nPlease fix and retry.`,
          };
        }
        return await this.markPaused(taskId, stage, session.id, msg);
      }
    }

    // Stage agent succeeded. Run commit_recovery if it left uncommitted work
    // — the per-stage commit instruction in the prompt should normally make
    // this a no-op.
    try {
      const dirty = await this.git.hasUncommittedChanges(taskId);
      if (dirty) {
        const recovered = await this.runCommitRecovery(taskId, stage);
        if (recovered.kind === "paused") return { kind: "paused" };
        if (recovered.kind === "blocked") return { kind: "blocked" };
      }
    } catch {
      /* defensive — recovery is best-effort */
    }

    await clearStageSignal(this.paths, taskId);

    task = this.requireTask(taskId);
    task.lastError = undefined;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    return { kind: "ok" };
  }

  private async markBlocked(
    taskId: string,
    stage: AgentStage,
    sessionId: string,
    err: string,
  ): Promise<{ kind: "blocked" }> {
    const task = this.requireTask(taskId);
    task.status = "blocked";
    task.lastError = { stage, message: err, at: nowIso() };
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    await this.emitNotification({
      taskId,
      sessionId,
      severity: "blocked",
      title: `Task ${taskId} blocked at ${stage}`,
      body: blockedReason(err) || err,
    });
    return { kind: "blocked" };
  }

  private async markPaused(
    taskId: string,
    stage: AgentStage,
    sessionId: string,
    err: string,
  ): Promise<{ kind: "paused" }> {
    const task = this.requireTask(taskId);
    task.status = "paused";
    task.lastError = { stage, message: err, at: nowIso() };
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    await this.emitNotification({
      taskId,
      sessionId,
      severity: "error",
      title: `Task ${taskId} paused at ${stage}`,
      body: err,
    });
    return { kind: "paused" };
  }

  /** Spawn a tight commit-only agent when a stage finished with dirty
   *  worktree state. Pauses the task if it can't produce a clean tree. */
  private async runCommitRecovery(
    taskId: string,
    parentStage: AgentStage,
  ): Promise<{ kind: "ok" } | { kind: "paused" } | { kind: "blocked" }> {
    const task = this.requireTask(taskId);
    const worktreePath = task.worktreePath!;

    const session = await this.agent.spawnAgent({
      taskId,
      stage: "commit_recovery",
      skillName: "commit",
      worktreePath,
      task: taskDefView(task),
      extraPrompt: `Stage \`${parentStage}\` finished but left uncommitted changes in the worktree. Stage and commit them with a tight one-liner subject + concise bullet body, then terminate.`,
    });
    this.state.upsertSession(session);

    const t = this.requireTask(taskId);
    if (!t.sessionIds.includes(session.id)) {
      t.sessionIds = [...t.sessionIds, session.id];
    }
    t.currentSessionId = session.id;
    this.state.upsertTask(t);

    if (session.status === "failed") {
      const err = session.error ?? "commit_recovery failed";
      if (isBlockedError(err)) {
        return await this.markBlocked(taskId, parentStage, session.id, err);
      }
      return await this.markPaused(taskId, parentStage, session.id, err);
    }

    const stillDirty = await this.git.hasUncommittedChanges(taskId);
    if (stillDirty) {
      return await this.markPaused(
        taskId,
        parentStage,
        session.id,
        `commit_recovery left uncommitted changes after running.`,
      );
    }
    return { kind: "ok" };
  }

  // -------------------------------------------------------------------------
  // Merge stage
  // -------------------------------------------------------------------------

  private async runMergeStage(
    taskId: string,
  ): Promise<{ kind: "ok" } | { kind: "paused" }> {
    let result: Awaited<ReturnType<GitManager["mergeTaskIntoMain"]>>;
    try {
      result = await this.git.mergeTaskIntoMain(taskId);
    } catch (err) {
      return this.mergePause(taskId, (err as Error).message);
    }

    if (!result.ok) {
      const task = this.requireTask(taskId);
      const worktreePath = task.worktreePath!;
      const session = await this.agent.spawnAgent({
        taskId,
        stage: "mergeResolve",
        skillName: "mergeResolve",
        worktreePath,
        task: taskDefView(task),
        contextFiles: result.conflictPaths,
        extraPrompt: [
          "# Merge resolution",
          `Conflicting files (relative to project root): ${result.conflictPaths.join(", ")}.`,
          "Resolve each conflict preserving both sides' intent where possible.",
          "Stage every resolved file. Do not modify any non-conflicted file.",
          "Do not run `git commit` — the orchestrator runs `git commit --no-edit`.",
          "Terminate as soon as every listed file is conflict-marker-free and staged.",
        ].join("\n"),
      });

      this.state.upsertSession(session);

      const t2 = this.requireTask(taskId);
      if (!t2.sessionIds.includes(session.id)) {
        t2.sessionIds = [...t2.sessionIds, session.id];
      }
      t2.currentSessionId = session.id;
      this.state.upsertTask(t2);

      if (session.status === "failed") {
        return this.mergePause(
          taskId,
          session.error ?? "mergeResolve session failed",
        );
      }

      const unresolved = await this.git.scanForConflictMarkers(
        result.conflictPaths,
      );
      if (unresolved.length > 0) {
        try {
          await this.git.abortMerge();
        } catch {
          /* ignore */
        }
        return this.mergePause(
          taskId,
          `mergeResolve left conflict markers in: ${unresolved.join(", ")}`,
        );
      }

      try {
        await this.git.completeMerge();
      } catch (err) {
        try {
          await this.git.abortMerge();
        } catch {
          /* ignore */
        }
        return this.mergePause(taskId, (err as Error).message);
      }
    }

    const task = this.requireTask(taskId);
    try {
      await this.git.removeWorktree(taskId, {
        branch: task.branchName,
        branchMerged: true,
      });
    } catch {
      /* worktree may already be gone; not fatal */
    }
    task.stage = "merged";
    task.status = "merged";
    task.completedAt = nowIso();
    task.updatedAt = nowIso();
    this.state.upsertTask(task);

    // Post-merge: copy progress.txt to learnings/<id>.md if non-empty so the
    // UI's learning feed has something to display per task.
    await this.publishLearning(taskId);

    const changed = this.state.recomputeReadiness();
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    for (const other of changed) {
      this.eventBus.emit("task.upsert", { task: { ...other } });
    }
    return { kind: "ok" };
  }

  private async publishLearning(taskId: string): Promise<void> {
    const progressPath = this.paths.taskProgressTxt(taskId);
    let body: string;
    try {
      body = await fs.readFile(progressPath, "utf8");
    } catch {
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;
    const learningPath = this.paths.learningFile(taskId);
    try {
      await fs.mkdir(this.paths.learningsDir, { recursive: true });
      await fs.writeFile(learningPath, trimmed + "\n", "utf8");
    } catch {
      return;
    }
    this.eventBus.emit("learning", {
      taskId,
      path: learningPath,
      markdown: trimmed,
    });
  }

  private async mergePause(
    taskId: string,
    message: string,
  ): Promise<{ kind: "paused" }> {
    const task = this.requireTask(taskId);
    task.status = "paused";
    task.lastError = { stage: "merged", message, at: nowIso() };
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    await this.emitNotification({
      taskId,
      severity: "error",
      title: `Task ${taskId} paused at merge`,
      body: message,
    });
    return { kind: "paused" };
  }

  // -------------------------------------------------------------------------
  // Batch runners
  // -------------------------------------------------------------------------

  async runOnce(): Promise<TaskRuntime | null> {
    // Ensure readiness is current first.
    const changed = this.state.recomputeReadiness();
    if (changed.length > 0) {
      await this.saveState();
      for (const t of changed) {
        this.eventBus.emit("task.upsert", { task: { ...t } });
      }
    }
    const ready = readyTasks(this.state.getTasks());
    const pick = ready.find((t) => !this.running.has(t.id));
    if (!pick) return null;
    return await this.runTask(pick.id);
  }

  async runAllOnce(opts?: { limit?: number }): Promise<TaskRuntime[]> {
    // Flip all currently-ready tasks to running concurrently with a concurrency cap.
    const changed = this.state.recomputeReadiness();
    if (changed.length > 0) {
      await this.saveState();
      for (const t of changed) {
        this.eventBus.emit("task.upsert", { task: { ...t } });
      }
    }
    const all = readyTasks(this.state.getTasks())
      .filter((t) => !this.running.has(t.id))
      .map((t) => t.id);
    const limited = opts?.limit ? all.slice(0, opts.limit) : all;
    return await this.runWithConcurrency(limited);
  }

  async runAll(opts?: { limit?: number }): Promise<void> {
    this.cancelFlag = false;
    const tracked: Promise<TaskRuntime>[] = [];
    const started = new Set<string>();

    const fillSlots = (): void => {
      if (this.cancelFlag) return;
      const cap = this.concurrencyCap();
      let slots = cap - this.running.size;
      if (slots <= 0) return;

      // Recompute readiness each fill (cheap).
      const changed = this.state.recomputeReadiness();
      if (changed.length > 0) {
        // Fire-and-forget save — we need to emit changes; but we want this
        // fill() call to stay sync to avoid race where another fill runs
        // before our upserts land. So we accept eventual-save here.
        void this.saveState();
        for (const t of changed) {
          this.eventBus.emit("task.upsert", { task: { ...t } });
        }
      }

      const ready = readyTasks(this.state.getTasks())
        .filter((t) => !this.running.has(t.id) && !started.has(t.id))
        .map((t) => t.id);
      const capLimit = opts?.limit;
      const candidates =
        capLimit !== undefined
          ? ready.slice(0, Math.max(0, capLimit - started.size))
          : ready;

      for (const id of candidates) {
        if (slots <= 0) break;
        started.add(id);
        slots -= 1;
        const p = this.runTask(id).finally(() => {
          // After this task settles, try filling more slots — deferred to
          // next microtask so the `running` map has been updated.
          queueMicrotask(fillSlots);
        });
        tracked.push(p);
      }
    };

    // Kick off initial batch, then wait until nothing is running and nothing
    // is ready.
    fillSlots();

    while (this.running.size > 0 || tracked.length > 0) {
      if (this.cancelFlag) break;
      // Await whichever task finishes next.
      const pending = tracked.slice();
      tracked.length = 0;
      try {
        await Promise.allSettled(pending);
      } catch {
        /* individual failures already captured on task objects */
      }
      // fillSlots runs via finally() above; drain is driven by it.
      // If no more tasks got scheduled and nothing is running, exit.
      if (this.running.size === 0) {
        // One last scan to catch tasks that became ready during this wave.
        const readyNow = readyTasks(this.state.getTasks()).filter(
          (t) => !started.has(t.id),
        );
        if (readyNow.length === 0) break;
        fillSlots();
      }
    }
  }

  private concurrencyCap(): number {
    const m = this.config.maxConcurrent;
    if (m === "off") return Number.POSITIVE_INFINITY;
    return m;
  }

  private async runWithConcurrency(ids: string[]): Promise<TaskRuntime[]> {
    const cap = this.concurrencyCap();
    const results: TaskRuntime[] = [];
    const queue = [...ids];
    const inflight = new Map<string, Promise<void>>();

    const launch = (id: string): void => {
      const settled = this.runTask(id).then(
        (t) => {
          results.push(t);
        },
        (err) => {
          // runTask doesn't throw on task failure, but defensively surface
          // unexpected exceptions so tests don't hang.
          const t = this.state.getTask(id);
          if (t) {
            results.push({
              ...t,
              status: "paused",
              lastError: {
                stage: t.stage,
                message: (err as Error).message,
                at: nowIso(),
              },
            });
          }
        },
      );
      const wrapped = settled.finally(() => {
        inflight.delete(id);
      });
      inflight.set(id, wrapped);
    };

    while (queue.length > 0 || inflight.size > 0) {
      while (queue.length > 0 && inflight.size < cap) {
        launch(queue.shift()!);
      }
      if (inflight.size > 0) {
        await Promise.race(inflight.values());
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private requireTask(taskId: string): TaskRuntime {
    const t = this.state.getTask(taskId);
    if (!t) throw new Error(`Scheduler: task "${taskId}" not found in state`);
    return t;
  }

  /** Serialized `state.save()`. The underlying writeJsonAtomic uses a
   *  `pid.Date.now()` tmp filename which can collide under fine-grained
   *  parallelism; this chain ensures only one save is in flight. */
  private async saveState(): Promise<void> {
    const prev = this.saveChain;
    const next = prev.then(() => this.state.save()).catch(() => {
      // Keep the chain alive even if a save fails — callers still awaited.
    });
    this.saveChain = next;
    await next;
  }

  private async pauseWithMessage(
    taskId: string,
    message: string,
  ): Promise<TaskRuntime> {
    const task = this.requireTask(taskId);
    task.status = "paused";
    task.lastError = { stage: task.stage, message, at: nowIso() };
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    return { ...task };
  }

  private async emitNotification(opts: {
    taskId?: string;
    sessionId?: string;
    severity: Notification["severity"];
    title: string;
    body: string;
  }): Promise<void> {
    const n: Notification = {
      id: newId(),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      severity: opts.severity,
      title: opts.title,
      body: opts.body,
      createdAt: nowIso(),
      acknowledged: false,
    };
    try {
      await this.state.appendNotification(n);
    } catch {
      /* best-effort */
    }
    this.eventBus.emit("notification", { notification: n });
  }
}
