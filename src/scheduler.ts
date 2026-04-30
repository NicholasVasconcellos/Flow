import { promises as fs } from "node:fs";
import path from "node:path";
import { execa } from "execa";

import type {
  Config,
  Notification,
  Session,
  TaskDef,
  TaskRuntime,
  TaskStage,
} from "./types.js";
import type { AgentRunner } from "./agent.js";
import { isLoopedOnBlockedTool, MissingSkillError } from "./agent.js";
import type { StateStore } from "./state.js";
import type { GitManager } from "./git.js";
import type { EventBus } from "./events.js";
import type { Paths } from "./paths.js";
import { newId, nowIso } from "./ids.js";
import { readyTasks } from "./dag.js";
import { readLiveLock } from "./orchestratorLock.js";

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
  | "documentation"
  | "update-learning";

/** Canonical stage list before per-task filtering. */
export function stagesFor(config: Config): AgentStage[] {
  const stages: AgentStage[] = [
    "spec",
    "exec",
    "exec_ui_check",
    "code_review",
    "code_review_ui_check",
  ];
  if (config.hasDocs !== false) stages.push("documentation");
  stages.push("update-learning");
  return stages;
}

/** Per-task stage list. Filters the canonical list based on the task's
 *  feature flags so simple tasks skip stages they don't need:
 *  - `hasSpec=false` drops `spec`
 *  - `hasUI=false` drops both UI-check stages
 *  - `hasCodeReview=false` drops `code_review`
 *  Filter preserves order; resume-index logic in `resumeIndex` handles the
 *  case where a task's saved stage was filtered out by a flag change after
 *  it paused. */
export function stagesForTask(config: Config, task: TaskDef): AgentStage[] {
  return stagesFor(config).filter((s) => {
    if (s === "spec" && task.hasSpec === false) return false;
    if ((s === "exec_ui_check" || s === "code_review_ui_check") && task.hasUI === false) return false;
    if (s === "code_review" && task.hasCodeReview === false) return false;
    return true;
  });
}

/** Where a resumed task should re-enter its filtered stage list.
 *
 *  - "done"/"merged"            → past the last agent stage (skip loop, go to merge)
 *  - stage in `stages`          → its index
 *  - stage in `canonical` only  → first stage in `stages` whose canonical
 *                                 position ≥ original's (i.e. advance to the
 *                                 next valid stage; never rewind)
 *  - stage in neither           → 0, with `unknownStage: true` so the caller
 *                                 can warn rather than restart silently
 */
export function resumeIndex(
  canonical: AgentStage[],
  stages: AgentStage[],
  taskStage: TaskStage,
): { index: number; unknownStage: boolean } {
  if (taskStage === "done" || taskStage === "merged") {
    return { index: stages.length, unknownStage: false };
  }
  const direct = stages.indexOf(taskStage as AgentStage);
  if (direct >= 0) return { index: direct, unknownStage: false };

  const canonIdx = canonical.indexOf(taskStage as AgentStage);
  if (canonIdx >= 0) {
    const next = stages.findIndex((s) => canonical.indexOf(s) >= canonIdx);
    return { index: next < 0 ? stages.length : next, unknownStage: false };
  }
  return { index: 0, unknownStage: true };
}

export function stageSkill(stage: AgentStage): string {
  switch (stage) {
    case "spec":
      return "spec";
    case "exec":
      return "exec";
    case "exec_ui_check":
    case "code_review_ui_check":
      return "ui-check";
    case "code_review":
      return "review";
    case "documentation":
      return "docs";
    case "update-learning":
      return "update-learning";
  }
}

/** Read-only stages don't produce commits — UI checks are observational
 *  (ui-check/SKILL.md forbids editing application code) and code_review's
 *  happy path is "no findings, nothing to commit." update-learning writes
 *  to non-tracked files outside the worktree (`learnings-draft.md` and any
 *  promoted skills under the project's `.flow/skills/`). For these stages
 *  a `done` signal is sufficient to advance, with no HEAD-moved
 *  requirement. documentation stays strict because missing docs is a real
 *  failure mode. */
export function stageCommitsExpected(stage: AgentStage): boolean {
  switch (stage) {
    case "exec_ui_check":
    case "code_review_ui_check":
    case "code_review":
    case "update-learning":
      return false;
    default:
      return true;
  }
}

// Internal per-task coordination handle.
interface TaskHandle {
  cancelled: boolean;
}

/** How many consecutive transient API errors a task may absorb on a single
 *  stage before they start consuming the agent-logic retry budget. */
const TRANSIENT_RETRY_CAP = 3;

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
    hasUI: task.hasUI,
    hasSpec: task.hasSpec,
    hasCodeReview: task.hasCodeReview,
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

/** Count the open issues recorded in a `round-<N>-issues.md` file. Prefer
 *  the explicit `**Outcome:** N issues` header line written by ui-check; if
 *  that's absent, fall back to counting `## Issue ` H2 headings. Returns 0
 *  for an empty/clean round so the loop can advance. */
function countRoundIssues(body: string): number {
  const outcome = /^\*\*Outcome:\*\*\s+(\d+)\s+issues?/im.exec(body);
  if (outcome && outcome[1]) {
    const n = Number.parseInt(outcome[1], 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const headings = body.match(/^##\s+Issue\s+\d+/gm);
  return headings ? headings.length : 0;
}

/** Deterministic squash commit message — one commit per task on main, with a
 *  footer pinning the worktree branch SHA so the per-stage history is still
 *  reachable via reflog or `.flow/tasks/<id>/sessions/`. */
function composeSquashCommitMessage(
  task: TaskRuntime,
  shortSha: string | null,
): string {
  const title = task.title.trim() || task.id;
  const description = (task.description ?? "").trim();
  const lines: string[] = [title];
  if (description) {
    lines.push("", description);
  }
  const footer = shortSha
    ? `Includes commits from flow/${task.id} (${shortSha})`
    : `Includes commits from flow/${task.id}`;
  lines.push("", footer);
  return lines.join("\n");
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
  /** Serialize the entire merge stage. Two tasks reaching merge near-
   *  simultaneously would otherwise race on `git checkout main`, the merge
   *  index, and `MERGE_HEAD`. The mutex makes the foot-gun explicit instead
   *  of relying on `maxConcurrent === 1` as the implicit guard. */
  private mergeMutex: Promise<void> = Promise.resolve();

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

  /** Flip every task currently in `status="running"` to `paused` with the
   *  given message as `lastError`, then persist `state.json` once. Used by
   *  the SIGINT shutdown path so state reflects "interrupted" immediately
   *  rather than waiting for the next startup's `recoverStaleTasks()` sweep.
   *  Batched single-write keeps shutdown bounded under the 2s grace even at
   *  high concurrency. The status guard mirrors `recoverStaleTasks` and
   *  prevents stomping a task that paused itself just before the signal. */
  async pauseAllRunning(message: string): Promise<void> {
    const updated: TaskRuntime[] = [];
    for (const taskId of this.runningTaskIds()) {
      const task = this.state.getTask(taskId);
      if (!task || task.status !== "running") continue;
      task.status = "paused";
      task.lastError = { stage: task.stage, message, at: nowIso() };
      task.updatedAt = nowIso();
      this.state.upsertTask(task);
      updated.push({ ...task });
    }
    if (updated.length === 0) return;
    await this.saveState();
    for (const task of updated) {
      this.eventBus.emit("task.upsert", { task });
    }
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
   *  is an orphan from a previous process.
   *
   *  Skips entirely if a live orchestrator lock owned by a different PID
   *  exists — that sibling is the real owner of any `running` tasks and we
   *  must not stomp its state. */
  async recoverStaleTasks(): Promise<TaskRuntime[]> {
    const live = await readLiveLock(this.paths);
    if (live && live.pid !== process.pid) {
      return [];
    }
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
      task.transientRetries = 0;
      task.uiReviewRound = 0;
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
    task.transientRetries = 0;
    task.uiReviewRound = 0;
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
    const task0 = this.requireTask(taskId);
    if (!task0.startedAt) {
      task0.startedAt = nowIso();
    }

    const canonical = stagesFor(this.config);
    const stages = stagesForTask(this.config, task0);
    const resumeStage: TaskStage = task0.stage ?? "spec";
    const { index: startIndex, unknownStage } = resumeIndex(
      canonical,
      stages,
      resumeStage,
    );
    if (unknownStage) {
      await this.emitNotification({
        taskId,
        severity: "warn",
        title: "Resume: unknown stage",
        body: `Task was paused at stage "${resumeStage}", which is not part of the configured pipeline. Restarting from "${stages[0] ?? "<empty>"}".`,
      });
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

      // UI-Review loop. After `exec_ui_check` finalizes successfully, read
      // the round-N-issues.md the skill just wrote. If it lists open issues
      // and the iteration cap hasn't been hit, route back to `exec` so it
      // can address them; otherwise advance normally. Hitting the cap with
      // open issues marks the task blocked for human review.
      if (stage === "exec_ui_check") {
        const decision = await this.evaluateUIReviewRound(taskId);
        if (decision.kind === "blocked") {
          return this.requireTask(taskId);
        }
        if (decision.kind === "loop") {
          const execIdx = stages.indexOf("exec");
          if (execIdx >= 0) {
            // -1 because the for-loop will increment i on the next pass.
            i = execIdx - 1;
            continue;
          }
        }
        // kind === "advance" — fall through to next stage normally.
      }
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
    if (mergeResult.kind === "paused" || mergeResult.kind === "blocked") {
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
    // Bump the UI-Review round counter on entry to `exec_ui_check` so the
    // spawned skill can write its findings to round-<N>-issues.md and the
    // post-stage decision logic knows which file to read.
    if (stage === "exec_ui_check") {
      task.uiReviewRound = (task.uiReviewRound ?? 0) + 1;
    }
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

    // Snapshot HEAD before the agent runs so we can detect whether it
    // produced a real commit on the worktree branch (the canonical "stage
    // did work" signal alongside stage.json).
    const preHead = await this.git.getWorktreeHeadSha(taskId);

    const summary = await readIfExists(this.paths.taskSummary(taskId));
    const extraPrompt = [summary ?? "", errorAddendum]
      .filter((s) => s && s.trim())
      .join("\n\n---\n\n");

    // When re-entering `exec` after a UI-Review round found issues, surface
    // the most-recent round-N-issues.md so the agent has the remediation
    // list as a context file (per exec/SKILL.md Step 0).
    const stageContextFiles = [...task.contextFiles];
    if (stage === "exec" && (task.uiReviewRound ?? 0) > 0) {
      stageContextFiles.push(
        this.paths.taskRoundIssues(taskId, task.uiReviewRound),
      );
    }

    let session: Session;
    try {
      session = await this.agent.spawnAgent({
        taskId,
        stage,
        skillName: stageSkill(stage),
        worktreePath,
        task: taskDefView(task),
        contextFiles: stageContextFiles,
        ...(stage === "exec_ui_check"
          ? { uiReviewRound: task.uiReviewRound }
          : {}),
        ...(extraPrompt ? { extraPrompt } : {}),
      });
    } catch (err) {
      // Pre-spawn failures (e.g. missing skill file) never produce a Session,
      // so they bypass the failure-handling path below. Translate them into a
      // per-task pause here so a single bad stage can't escape into the drain
      // and crash peer tasks. Skip retries for non-recoverable errors like
      // MissingSkillError — retrying won't materialize the file.
      if (err instanceof MissingSkillError) {
        const message = `Skill "${err.skillName}" missing at ${err.skillPath}. Re-run \`flow init\` to install bundled skills, then resume the task.`;
        return await this.markPaused(taskId, stage, "", message);
      }
      const message = `${stage} crashed before producing a session: ${(err as Error).message}`;
      return await this.markPaused(taskId, stage, "", message);
    }

    this.state.upsertSession(session);

    task = this.requireTask(taskId);
    if (!task.sessionIds.includes(session.id)) {
      task.sessionIds = [...task.sessionIds, session.id];
    }
    task.currentSessionId = session.id;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);

    await this.persistReviewRequested(session, taskId, stage);

    const postHead = await this.git.getWorktreeHeadSha(taskId);
    const headMoved = preHead !== postHead && postHead !== null;

    const signal = await readStageSignal(this.paths, taskId);

    // Non-retryable filters first — these short-circuit regardless of signal
    // or HEAD state.
    if (session.status === "failed") {
      const err = session.error ?? `Stage ${stage} failed`;
      if (isBlockedError(err)) {
        return await this.markBlocked(taskId, stage, session.id, err);
      }
      if (isLoopedOnBlockedTool(err)) {
        // Non-retryable: the agent is stuck re-issuing the same Bash command.
        // Pause directly so a human can investigate (e.g. a GUI subprocess
        // hanging on a modal). Do not consume retries.
        return await this.markPaused(taskId, stage, session.id, err);
      }
    }

    // Agent-reported blocked via stage.json — respected on either path.
    if (signal && signal.status === "blocked") {
      const reason = signal.reason || `Stage ${stage} reported blocked`;
      return await this.markBlocked(
        taskId,
        stage,
        session.id,
        `FLOW_BLOCKED: ${reason}`,
      );
    }

    // Symmetric advance rule: signal "done" + matching stage means the agent
    // finished. Read-only stages (UI checks) don't need HEAD to move; for the
    // rest, require a commit so a "done"-without-work claim still gets caught.
    if (
      signal &&
      signal.status === "done" &&
      signal.stage === stage &&
      (headMoved || !stageCommitsExpected(stage))
    ) {
      return await this.finalizeStageSuccess(taskId);
    }

    // Stage drift — agent wrote a signal claiming a different stage. Retry
    // with a budget so the user notices.
    if (signal && signal.status === "done" && signal.stage !== stage) {
      const msg = `Stage signal mismatch: agent wrote stage="${signal.stage}" but expected "${stage}"`;
      return await this.bumpRetryOrPause(taskId, stage, session.id, msg);
    }

    // Failed session that wasn't rescued: transient retry first (no budget
    // consumption), then the regular retry/pause budget.
    if (session.status === "failed") {
      const err = session.error ?? `Stage ${stage} failed`;
      if (
        session.transientError &&
        (task.transientRetries ?? 0) < TRANSIENT_RETRY_CAP
      ) {
        task.transientRetries = (task.transientRetries ?? 0) + 1;
        task.lastError = { stage, message: err, at: nowIso() };
        task.updatedAt = nowIso();
        this.state.upsertTask(task);
        await this.saveState();
        this.eventBus.emit("task.upsert", { task: { ...task } });
        return {
          kind: "retry",
          addendum: `# Previous attempt error\nStage ${stage} failed transiently:\n${err}\n\nPlease resume and continue.`,
        };
      }
      return await this.bumpRetryOrPause(taskId, stage, session.id, err);
    }

    // Success-but-no-rescue cases:
    // - signal absent + HEAD moved → legacy fallback (commit_recovery + advance).
    // - signal "done" + HEAD didn't move → skill bug (claimed done but no commit); retry.
    // - signal absent + HEAD didn't move → agent did nothing; retry.
    if (!signal && headMoved) {
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
      return await this.finalizeStageSuccess(taskId);
    }

    const noProgressMsg = signal
      ? `Stage signal "done" but no commit was made on the worktree branch (this stage requires a commit).`
      : `Stage finished without a stage signal and without committing.`;
    return await this.bumpRetryOrPause(taskId, stage, session.id, noProgressMsg);
  }

  /** Decide what to do after `exec_ui_check` finalizes: read the round-N
   *  issues file the skill just wrote, count open issues, and route back to
   *  `exec` if non-zero (within the iteration cap) or advance otherwise.
   *  Hitting the cap with open issues marks the task blocked for human
   *  review and skips downstream stages. A missing or empty round file
   *  advances the pipeline — agents that forgot to write the file are
   *  treated permissively rather than spuriously looping. */
  private async evaluateUIReviewRound(
    taskId: string,
  ): Promise<{ kind: "advance" | "loop" | "blocked" }> {
    const task = this.requireTask(taskId);
    const round = task.uiReviewRound ?? 0;
    if (round <= 0) return { kind: "advance" };

    const roundFile = this.paths.taskRoundIssues(taskId, round);
    const body = await readIfExists(roundFile);
    if (body === null || !body.trim()) {
      return { kind: "advance" };
    }

    const issueCount = countRoundIssues(body);
    if (issueCount === 0) return { kind: "advance" };

    const cap = this.config.maxUIReviewIterations;
    if (round >= cap) {
      const sessionId = task.currentSessionId ?? "";
      const reason = `UI Review iterations exhausted: ${round} round(s) ran with ${issueCount} issue(s) still open in ${path.basename(roundFile)}. Human review required.`;
      await this.markBlocked(
        taskId,
        "exec_ui_check",
        sessionId,
        `FLOW_BLOCKED: ${reason}`,
      );
      return { kind: "blocked" };
    }

    return { kind: "loop" };
  }

  /** Per-stage cleanup when the stage completes — clears the signal, resets
   *  retry counters, and emits the upsert. Extracted so both the symmetric
   *  signal+HEAD rescue path and the legacy fallback path use identical
   *  finalize semantics. */
  private async finalizeStageSuccess(
    taskId: string,
  ): Promise<{ kind: "ok" }> {
    await clearStageSignal(this.paths, taskId);
    const task = this.requireTask(taskId);
    task.lastError = undefined;
    task.transientRetries = 0;
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    return { kind: "ok" };
  }

  /** Common path for "stage didn't progress this attempt": consume one retry
   *  slot if the budget allows, otherwise pause. */
  private async bumpRetryOrPause(
    taskId: string,
    stage: AgentStage,
    sessionId: string,
    err: string,
  ): Promise<
    { kind: "retry"; addendum: string } | { kind: "paused" }
  > {
    const task = this.requireTask(taskId);
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
    return await this.markPaused(taskId, stage, sessionId, err);
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

    await this.persistReviewRequested(session, taskId, "commit_recovery");

    if (session.status === "failed") {
      const err = session.error ?? "commit_recovery failed";
      if (isBlockedError(err)) {
        return await this.markBlocked(taskId, parentStage, session.id, err);
      }
      // looped_on_blocked_tool also pauses (non-retryable, mirrors the
      // runAgentStage path). markPaused already handles other failures.
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

  /** Run `fn` with the merge mutex held. The try/finally release is the
   *  deadlock guard — a thrown body still releases the lock so the next
   *  caller proceeds instead of wedging every future merge. */
  private async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeMutex;
    let release!: () => void;
    this.mergeMutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async runMergeStage(
    taskId: string,
  ): Promise<{ kind: "ok" } | { kind: "paused" } | { kind: "blocked" }> {
    return this.withMergeLock(() => this.runMergeStageInner(taskId));
  }

  private async runMergeStageInner(
    taskId: string,
  ): Promise<{ kind: "ok" } | { kind: "paused" } | { kind: "blocked" }> {
    const strategy = this.config.git.mergeStrategy ?? "squash";
    const branch = `flow/${taskId}`;
    // Capture the branch tip before the merge; the branch is deleted after
    // worktree cleanup, so the squash commit footer references it via this
    // value.
    const shortSha = await this.git.getBranchShortSha(branch);

    let result: Awaited<ReturnType<GitManager["mergeTaskIntoMain"]>>;
    try {
      result = await this.git.mergeTaskIntoMain(taskId, strategy);
    } catch (err) {
      return this.mergePause(taskId, (err as Error).message);
    }

    if (!result.ok) {
      const task = this.requireTask(taskId);
      // merge-resolve runs in the main checkout (where the merge is in
      // progress and conflict markers live), not the task's worktree.
      const session = await this.agent.spawnAgent({
        taskId,
        stage: "merge-resolve",
        skillName: "merge-resolve",
        worktreePath: this.paths.projectRoot,
        task: taskDefView(task),
        contextFiles: result.conflictPaths,
        extraPrompt: [
          "# Merge resolution",
          `Conflicting files (relative to project root): ${result.conflictPaths.join(", ")}.`,
          "Combine independent changes only (different files, or non-overlapping",
          "hunks). If both sides modified the same logical block, do NOT guess —",
          "emit `FLOW_BLOCKED: overlapping change in <path>` instead.",
          "If the resolution is plausible but you are not certain, stage it and",
          "emit `FLOW_REVIEW_REQUESTED: <one-sentence reason>` so a human can",
          "audit without halting the queue.",
          "Stage every resolved file. Do not modify any non-conflicted file.",
          "Do not run `git commit` — the orchestrator finalizes the merge.",
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

      await this.persistReviewRequested(session, taskId, "merge-resolve");

      if (session.status === "failed") {
        const err = session.error ?? "merge-resolve session failed";
        try {
          await this.git.abortMerge(strategy);
        } catch {
          /* ignore */
        }
        if (isBlockedError(err)) {
          return this.markBlockedAtMerge(taskId, session.id, err);
        }
        return this.mergePause(taskId, err);
      }

      const unresolved = await this.git.scanForConflictMarkers(
        result.conflictPaths,
      );
      if (unresolved.length > 0) {
        try {
          await this.git.abortMerge(strategy);
        } catch {
          /* ignore */
        }
        return this.mergePause(
          taskId,
          `merge-resolve left conflict markers in: ${unresolved.join(", ")}`,
        );
      }
    }

    // Pre-merge verification gate. Skipped when no command is configured.
    const gate = await this.runVerifyGate(taskId);
    if (!gate.ok) {
      try {
        await this.git.abortMerge(strategy);
      } catch {
        /* ignore */
      }
      return this.mergePause(
        taskId,
        `Pre-merge verify failed (exit ${gate.exitCode ?? "?"}). See ${gate.logPath} for full output.`,
      );
    }

    // Finalize the merge commit. For `merge` strategy, MERGE_MSG carries the
    // commit subject; for `squash`, we synthesize a deterministic message.
    let mergeSha: string;
    try {
      const taskNow = this.requireTask(taskId);
      const message =
        strategy === "squash"
          ? composeSquashCommitMessage(taskNow, shortSha)
          : "";
      mergeSha = await this.git.finalizeMerge(strategy, message);
    } catch (err) {
      try {
        await this.git.abortMerge(strategy);
      } catch {
        /* ignore */
      }
      return this.mergePause(taskId, (err as Error).message);
    }

    // Post-merge semantic-diff agent. Read-only; FLOW_BLOCKED moves the task
    // to blocked, FLOW_REVIEW_REQUESTED emits a warn notification, anything
    // else is a pass. Runs before worktree cleanup so the agent could in
    // principle reference per-task artefacts if its skill body asked it to.
    const verifyOutcome = await this.runMergeVerify(taskId, mergeSha);

    const task = this.requireTask(taskId);
    try {
      await this.git.removeWorktree(taskId, {
        branch: task.branchName,
        branchMerged: true,
      });
    } catch {
      /* worktree may already be gone; not fatal */
    }

    if (verifyOutcome.kind === "blocked") {
      // Task is already marked blocked by markBlockedAtMerge; the merge
      // commit stays on main. The user can decide whether to revert or
      // resolve the flagged concern.
      return verifyOutcome;
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

  /** Spawn the post-merge semantic-diff agent. Read-only — never reverts the
   *  merge that just landed. Returns `blocked` if the agent emitted
   *  `FLOW_BLOCKED:`; otherwise `ok` (review-requested still surfaces a warn
   *  notification but does not change task status). */
  private async runMergeVerify(
    taskId: string,
    mergeSha: string,
  ): Promise<{ kind: "ok" } | { kind: "blocked" }> {
    const task = this.requireTask(taskId);
    const session = await this.agent.spawnAgent({
      taskId,
      stage: "merge-verify",
      skillName: "merge-verify",
      worktreePath: this.paths.projectRoot,
      task: taskDefView(task),
      extraPrompt: [
        "# Post-merge semantic check",
        `Merge commit: ${mergeSha}`,
        `Inspect with: \`git show --stat ${mergeSha}\` then \`git show ${mergeSha}\`.`,
        "Compare the merge diff to the task title and description above.",
        "Flag concerns where the merge:",
        "- Drops behavior the task was supposed to add (or that landed",
        "  earlier from a sibling task and is no longer present).",
        "- Changes a public contract in a way the description does not justify.",
        "- Looks like a stale-import / wrong-signature artifact of a",
        "  conflict resolution.",
        "Conclude with one of:",
        "  - silence (no concerns) — the merge looks faithful to intent;",
        "  - `FLOW_REVIEW_REQUESTED: <one-sentence concern>` — surfaces a",
        "    warn-level notification without halting the queue;",
        "  - `FLOW_BLOCKED: <reason>` — task moves to blocked for human review.",
        "This is a read-only audit. Do not edit files, do not commit, do not",
        "revert the merge.",
      ].join("\n"),
    });

    this.state.upsertSession(session);
    const t = this.requireTask(taskId);
    if (!t.sessionIds.includes(session.id)) {
      t.sessionIds = [...t.sessionIds, session.id];
    }
    t.currentSessionId = session.id;
    this.state.upsertTask(t);

    await this.persistReviewRequested(session, taskId, "merge-verify");

    if (session.status === "failed") {
      const err = session.error ?? "merge-verify session failed";
      if (isBlockedError(err)) {
        return this.markBlockedAtMerge(taskId, session.id, err);
      }
      // Non-blocked verify failure: the merge has already landed, so we
      // surface a warn notification but let the task move to merged. A hard
      // pause here would be misleading (there is nothing to retry — the
      // commit is done).
      await this.emitNotification({
        taskId,
        sessionId: session.id,
        severity: "warn",
        title: `Task ${taskId} merge-verify failed`,
        body: `Merge already landed (${mergeSha}). Verify session error: ${err}`,
      });
    }
    return { kind: "ok" };
  }

  /** Run `config.verify.command` from the project root after a merge has
   *  been staged but before the final commit. Captures combined output to
   *  `.flow/tasks/<id>/verify.log` for inclusion in the pause notification.
   *  Returns `ok: true` when no command is configured. */
  private async runVerifyGate(
    taskId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; logPath: string; exitCode: number | null }
  > {
    const command = this.config.verify?.command;
    if (!command || !command.trim()) return { ok: true };
    const logPath = this.paths.taskVerifyLog(taskId);
    const timeoutMs = this.config.verify?.timeoutMs ?? 300_000;
    const startedAt = nowIso();

    let exitCode: number | null = null;
    let output = "";
    let timedOut = false;
    let runtimeError: string | null = null;
    try {
      const result = await execa(command, {
        cwd: this.paths.projectRoot,
        shell: true,
        timeout: timeoutMs,
        reject: false,
        all: true,
      });
      exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
      timedOut = Boolean(result.timedOut);
      output = typeof result.all === "string" ? result.all : "";
    } catch (err) {
      runtimeError = (err as Error).message;
    }

    const header = [
      `# verify gate — task ${taskId}`,
      `started: ${startedAt}`,
      `cwd:     ${this.paths.projectRoot}`,
      `command: ${command}`,
      `exit:    ${exitCode === null ? (timedOut ? "(timeout)" : "(spawn error)") : exitCode}`,
      runtimeError ? `error:   ${runtimeError}` : null,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n");
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, header + (output ?? ""), "utf8");
    } catch {
      /* best-effort log write */
    }

    if (exitCode === 0 && !timedOut && !runtimeError) return { ok: true };
    return { ok: false, logPath, exitCode };
  }

  /** Persist a warn-level notification when a session ended with
   *  `FLOW_REVIEW_REQUESTED:` set on it. The agent runner emits a real-time
   *  bus notification mid-stream, but it is not stored — this is the
   *  durable record. */
  private async persistReviewRequested(
    session: Session,
    taskId: string,
    stage: string,
  ): Promise<void> {
    if (!session.reviewRequested) return;
    await this.emitNotification({
      taskId,
      sessionId: session.id,
      severity: "warn",
      title: `Task ${taskId} review requested at ${stage}`,
      body: `Agent requested review: ${session.reviewRequested.reason}`,
    });
  }

  private async markBlockedAtMerge(
    taskId: string,
    sessionId: string,
    err: string,
  ): Promise<{ kind: "blocked" }> {
    const task = this.requireTask(taskId);
    task.status = "blocked";
    task.lastError = { stage: "merged", message: err, at: nowIso() };
    task.updatedAt = nowIso();
    this.state.upsertTask(task);
    await this.saveState();
    this.eventBus.emit("task.upsert", { task: { ...task } });
    await this.emitNotification({
      taskId,
      sessionId,
      severity: "blocked",
      title: `Task ${taskId} blocked at merge`,
      body: blockedReason(err) || err,
    });
    return { kind: "blocked" };
  }

  private async publishLearning(taskId: string): Promise<void> {
    const draftPath = this.paths.taskLearningsDraft(taskId);
    let body: string;
    try {
      body = await fs.readFile(draftPath, "utf8");
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
        // runTask should never throw — every per-task failure should already be
        // a paused/blocked status update inside runAgentStage. If something
        // escapes anyway, mark the task paused defensively so one bad task
        // can't take down the whole drain (mirrors runWithConcurrency below).
        const p = this.runTask(id)
          .catch(async (err) => {
            const t = this.state.getTask(id);
            if (t) {
              t.status = "paused";
              t.lastError = {
                stage: t.stage,
                message: `runTask threw unexpectedly: ${(err as Error).message}`,
                at: nowIso(),
              };
              t.updatedAt = nowIso();
              this.state.upsertTask(t);
              await this.saveState();
              this.eventBus.emit("task.upsert", { task: { ...t } });
              return { ...t };
            }
            throw err;
          })
          .finally(() => {
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
