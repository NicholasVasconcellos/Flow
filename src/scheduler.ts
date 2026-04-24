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
import type { GitManager, CommitMessage } from "./git.js";
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

/** Parse "subject\n\n- bullet\n- bullet" style commit message out of
 * whatever assistant text the commit session produced. */
export function parseCommitMessage(
  text: string,
): { subject: string; bullets: string[] } | null {
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.trimEnd());
  // find first non-empty line as subject
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  if (i >= lines.length) return null;
  const subject = lines[i]!.trim();
  const bullets: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    const m = /^\s*-\s+(.+)$/.exec(line);
    if (m) bullets.push(m[1]!.trim());
  }
  return { subject, bullets };
}

function extractAssistantText(session: Session): string {
  // The session object itself doesn't carry assistant text — it only carries
  // summary numbers + error. For the commit/mergeResolve pipelines, we rely on
  // the session having a specifically-shaped `prompt`/output. In v1 we piggy-
  // back on session.error being empty and fall back to the default commit
  // message. When the AgentRunner is extended to expose the accumulated
  // assistant text, this helper becomes the single extension point.
  const anyS = session as unknown as { assistantText?: string };
  return anyS.assistantText ?? "";
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
    // Agent stages ---------------------------------------------------------
    const stages = stagesFor(this.config);

    // Find starting index: if the task is resuming a paused/blocked stage,
    // re-enter that stage; otherwise start at `spec`.
    const task0 = this.requireTask(taskId);
    if (!task0.startedAt) {
      task0.startedAt = nowIso();
    }

    // If task was paused/blocked mid-pipeline, resume at task.stage.
    const resumeStage: TaskStage = task0.stage ?? "spec";
    let startIndex = stages.indexOf(resumeStage as AgentStage);
    if (startIndex < 0) {
      // Could be "done"/"merged" already, or the stage was skipped. Start
      // from spec unless already past the agent stages.
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
      if (result.kind === "blocked") {
        return this.requireTask(taskId);
      }
      if (result.kind === "paused") {
        return this.requireTask(taskId);
      }
      if (result.kind === "retry") {
        errorAddendum = result.addendum;
        i--; // redo same stage
        continue;
      }
      errorAddendum = "";
    }

    if (handle.cancelled) {
      return await this.pauseWithMessage(taskId, "Cancelled by user");
    }

    // Commit ---------------------------------------------------------------
    const commitResult = await this.runCommitStage(taskId);
    if (commitResult.kind === "blocked" || commitResult.kind === "paused") {
      return this.requireTask(taskId);
    }

    if (handle.cancelled) {
      return await this.pauseWithMessage(taskId, "Cancelled by user");
    }

    // Merge ----------------------------------------------------------------
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
    // Set stage + running
    let task = this.requireTask(taskId);
    task.stage = stage;
    task.status = "running";
    task.updatedAt = nowIso();
    if (!task.startedAt) task.startedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });

    // Worktree
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

    // Extra prompt from summary.md + any error addendum.
    const summary = await readIfExists(this.paths.taskSummary(taskId));
    const extraPrompt = [summary ?? "", errorAddendum].filter((s) => s && s.trim()).join("\n\n---\n\n");

    const session = await this.agent.spawnAgent({
      taskId,
      stage,
      skillName: stageSkill(stage),
      worktreePath,
      task: taskDefView(task),
      contextFiles: task.contextFiles,
      ...(extraPrompt ? { extraPrompt } : {}),
    });

    // Record session id regardless of outcome.
    task = this.requireTask(taskId);
    if (!task.sessionIds.includes(session.id)) {
      task.sessionIds = [...task.sessionIds, session.id];
    }
    task.currentSessionId = session.id;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);

    if (session.status === "failed") {
      const err = session.error ?? `Stage ${stage} failed`;
      // Blocked?
      if (isBlockedError(err)) {
        task.status = "blocked";
        task.lastError = { stage, message: err, at: nowIso() };
        task.updatedAt = nowIso();
        this.state.upsertTask(task);
        await this.saveState();
        this.eventBus.emit("task.upsert", { task: { ...task } });
        await this.emitNotification({
          taskId,
          sessionId: session.id,
          severity: "blocked",
          title: `Task ${taskId} blocked at ${stage}`,
          body: blockedReason(err) || err,
        });
        return { kind: "blocked" };
      }

      // Retry?
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

      // Exhausted
      task.status = "paused";
      task.lastError = { stage, message: err, at: nowIso() };
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      await this.saveState();
      this.eventBus.emit("task.upsert", { task: { ...task } });
      await this.emitNotification({
        taskId,
        sessionId: session.id,
        severity: "error",
        title: `Task ${taskId} paused at ${stage}`,
        body: err,
      });
      return { kind: "paused" };
    }

    // Success
    task.lastError = undefined;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    return { kind: "ok" };
  }

  // -------------------------------------------------------------------------
  // Commit stage
  // -------------------------------------------------------------------------

  private async runCommitStage(
    taskId: string,
  ): Promise<{ kind: "ok" } | { kind: "paused" } | { kind: "blocked" }> {
    let task = this.requireTask(taskId);
    task.stage = "done";
    task.status = "running";
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });

    const worktreePath = task.worktreePath!;

    const session = await this.agent.spawnAgent({
      taskId,
      stage: "commit",
      skillName: "commit",
      worktreePath,
      task: taskDefView(task),
      contextFiles: task.contextFiles,
    });

    task = this.requireTask(taskId);
    if (!task.sessionIds.includes(session.id)) {
      task.sessionIds = [...task.sessionIds, session.id];
    }
    task.currentSessionId = session.id;

    if (session.status === "failed") {
      if (isBlockedError(session.error)) {
        task.status = "blocked";
        task.lastError = {
          stage: "done",
          message: session.error ?? "",
          at: nowIso(),
        };
        task.updatedAt = nowIso();
        this.state.upsertTask(task);
        await this.saveState();
        this.eventBus.emit("task.upsert", { task: { ...task } });
        await this.emitNotification({
          taskId,
          sessionId: session.id,
          severity: "blocked",
          title: `Task ${taskId} blocked at commit`,
          body: blockedReason(session.error),
        });
        return { kind: "blocked" };
      }
      task.status = "paused";
      task.lastError = {
        stage: "done",
        message: session.error ?? "commit failed",
        at: nowIso(),
      };
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      await this.saveState();
      this.eventBus.emit("task.upsert", { task: { ...task } });
      await this.emitNotification({
        taskId,
        sessionId: session.id,
        severity: "error",
        title: `Task ${taskId} paused at commit`,
        body: session.error ?? "commit failed",
      });
      return { kind: "paused" };
    }

    // Try to extract commit message from assistant text attached to session.
    // If unavailable (v1), fall back to a deterministic default.
    const text = extractAssistantText(session);
    const parsed = parseCommitMessage(text);
    const message: CommitMessage = parsed ?? {
      subject: `task(${taskId}): ${task.title}`,
      bullets: [],
    };

    try {
      await this.git.commitAllInWorktree(taskId, message);
    } catch (err) {
      task.status = "paused";
      task.lastError = {
        stage: "done",
        message: (err as Error).message,
        at: nowIso(),
      };
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      await this.saveState();
      this.eventBus.emit("task.upsert", { task: { ...task } });
      await this.emitNotification({
        taskId,
        severity: "error",
        title: `Task ${taskId} commit failed`,
        body: (err as Error).message,
      });
      return { kind: "paused" };
    }

    task.stage = "done";
    task.status = "done";
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    return { kind: "ok" };
  }

  // -------------------------------------------------------------------------
  // Merge stage
  // -------------------------------------------------------------------------

  private async runMergeStage(
    taskId: string,
  ): Promise<{ kind: "ok" } | { kind: "paused" }> {
    // Attempt merge once
    let result: Awaited<ReturnType<GitManager["mergeTaskIntoMain"]>>;
    try {
      result = await this.git.mergeTaskIntoMain(taskId);
    } catch (err) {
      return this.mergePause(taskId, (err as Error).message);
    }

    if (!result.ok) {
      // Conflict — run mergeResolve session pointed at worktree with
      // conflict paths in contextFiles.
      const task = this.requireTask(taskId);
      const worktreePath = task.worktreePath!;
      const session = await this.agent.spawnAgent({
        taskId,
        stage: "mergeResolve",
        skillName: "mergeResolve",
        worktreePath,
        task: taskDefView(task),
        contextFiles: result.conflictPaths,
      });

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

    // Success — remove worktree, mark merged.
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

    // Recompute readiness; emit upserts for anyone whose status changed.
    const changed = this.state.recomputeReadiness();
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    for (const other of changed) {
      this.eventBus.emit("task.upsert", { task: { ...other } });
    }
    return { kind: "ok" };
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
