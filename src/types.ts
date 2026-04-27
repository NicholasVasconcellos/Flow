import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "paused",
  "blocked",
  "done",
  "merged",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskStageSchema = z.enum([
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
  "update-learning",
  "done",
  "merged",
]);
export type TaskStage = z.infer<typeof TaskStageSchema>;

export const ThinkingModeSchema = z.enum(["off", "think", "megathink", "ultrathink"]);
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;

export const EffortSchema = z.enum(["low", "med", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const StageKeySchema = z.enum([
  "setup",
  "get-tasks",
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
  "update-learning",
  "merge-resolve",
  "merge-verify",
  "commit_recovery",
]);
export type StageKey = z.infer<typeof StageKeySchema>;

export const StageConfigSchema = z.object({
  model: z.string(),
  effort: EffortSchema,
  /** Wall-clock max time without an `assistant_text`/`tool_result` progress
   *  event before the session is killed and marked failed. Catches GUI-modal
   *  hangs the api_retry-counter watchdog can't see. */
  stallTimeoutMs: z.number().int().positive().optional(),
  /** If the agent issues the same `(tool, command)` Bash invocation this many
   *  times in one session, kill it and surface a non-retryable
   *  `looped_on_blocked_tool` error. */
  repeatToolCallCap: z.number().int().positive().optional(),
});
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const TaskDefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  contextFiles: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
});
export type TaskDef = z.infer<typeof TaskDefSchema>;

export const TasksFileSchema = z.object({
  tasks: z.array(TaskDefSchema),
});
export type TasksFile = z.infer<typeof TasksFileSchema>;

export const TaskErrorSchema = z.object({
  stage: TaskStageSchema,
  message: z.string(),
  at: z.string(),
});
export type TaskError = z.infer<typeof TaskErrorSchema>;

export const TaskRuntimeSchema = TaskDefSchema.extend({
  status: TaskStatusSchema,
  stage: TaskStageSchema,
  retries: z.number().int().nonnegative(),
  /** Per-task counter of transient-API retries. Tracked separately from
   *  `retries` so a flaky API stream doesn't burn the agent-logic retry
   *  budget. Resets when a stage advances. */
  transientRetries: z.number().int().nonnegative().default(0),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  currentSessionId: z.string().optional(),
  sessionIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  lastError: TaskErrorSchema.optional(),
});
export type TaskRuntime = z.infer<typeof TaskRuntimeSchema>;

export const SessionStageSchema = z.union([
  TaskStageSchema,
  z.enum([
    "setup",
    "get-tasks",
    "commit",
    "commit_recovery",
    "merge-resolve",
    "merge-verify",
  ]),
]);
export type SessionStage = z.infer<typeof SessionStageSchema>;

export const SessionStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "autocompacted",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const TokenCountsSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreate: z.number().nonnegative(),
  total: z.number().nonnegative(),
});
export type TokenCounts = z.infer<typeof TokenCountsSchema>;

export const SurplusChildSchema = z.object({
  pid: z.number().int().nonnegative(),
  name: z.string(),
});
export type SurplusChild = z.infer<typeof SurplusChildSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  stage: SessionStageSchema,
  provider: z.literal("claude-code"),
  model: z.string(),
  thinkingMode: ThinkingModeSchema.optional(),
  effort: EffortSchema.optional(),
  /** UI grouping — count of prior sessions for the same (taskId, stage). */
  ordinal: z.number().int().nonnegative().optional(),
  skillName: z.string(),
  prompt: z.string(),
  status: SessionStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  tokens: TokenCountsSchema,
  contextPercentage: z.number().min(0).max(100).optional(),
  autocompacted: z.boolean(),
  costUsd: z.number().nonnegative(),
  parentSessionId: z.string().optional(),
  /** Claude Code's `--session-id` UUID — kept so a follow-up call (e.g. the
   *  `/context` probe) can resume into the same session. Distinct from `id`
   *  because the claude CLI rejects any non-UUID string. */
  claudeSessionId: z.string().optional(),
  exitCode: z.number().int().optional(),
  error: z.string().optional(),
  /** Set by the agent runner when a session failure was caused by a
   *  transient API/stream condition (stream errors, session-stale). The
   *  scheduler uses this to retry without consuming the agent-logic retry
   *  budget. */
  transientError: z.boolean().optional(),
  /** Set by the agent runner when the session emitted
   *  `FLOW_REVIEW_REQUESTED:`. The scheduler picks this up after the session
   *  ends to persist a warn-level notification — the queue continues. */
  reviewRequested: z
    .object({ reason: z.string() })
    .optional(),
  /** Forensic: child PIDs of the claude process still alive at session end,
   *  per `pgrep -P`. Best-effort; absent on systems without `pgrep`. */
  surplus_children: z.array(SurplusChildSchema).optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionEventKindSchema = z.enum([
  "system",
  "assistant_text",
  "assistant_thinking",
  "tool_use",
  "tool_result",
  "usage",
  "stop",
]);
export type SessionEventKind = z.infer<typeof SessionEventKindSchema>;

export const SessionEventSchema = z.object({
  sessionId: z.string(),
  ts: z.string(),
  kind: SessionEventKindSchema,
  payload: z.unknown(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const NotificationSeveritySchema = z.enum(["info", "warn", "error", "blocked"]);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  severity: NotificationSeveritySchema,
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  acknowledged: z.boolean(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const PricingEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreate: z.number().nonnegative(),
});
export type PricingEntry = z.infer<typeof PricingEntrySchema>;

export const StageOverrideSchema = StageConfigSchema.partial();
export type StageOverride = z.infer<typeof StageOverrideSchema>;

export const ConfigSchema = z.object({
  maxConcurrent: z.union([z.number().int().positive(), z.literal("off")]).default(3),
  retryCount: z.number().int().nonnegative().default(0),
  maxConsecutiveApiRetries: z.number().int().positive().default(5),
  /** Wall-clock max time (ms) without an `assistant_text`/`tool_result` event
   *  before a session is killed and marked failed. Defaults to 3 minutes.
   *  Per-stage `stallTimeoutMs` overrides this value when set. */
  stallTimeoutMs: z.number().int().positive().default(180_000),
  /** If the agent re-issues the same `(tool, command)` Bash invocation this
   *  many times in one session, the session is killed with a non-retryable
   *  `looped_on_blocked_tool:` error. Defaults to 3. */
  repeatToolCallCap: z.number().int().positive().default(3),
  hasDocs: z.boolean().default(true),
  defaults: z.object({
    model: z.string().default("sonnet"),
    effort: EffortSchema.default("med"),
    thinkingMode: ThinkingModeSchema.optional(),
  }),
  stages: z
    .object({
      setup: StageOverrideSchema.optional(),
      "get-tasks": StageOverrideSchema.optional(),
      spec: StageOverrideSchema.optional(),
      exec: StageOverrideSchema.optional(),
      exec_ui_check: StageOverrideSchema.optional(),
      code_review: StageOverrideSchema.optional(),
      code_review_ui_check: StageOverrideSchema.optional(),
      documentation: StageOverrideSchema.optional(),
      "update-learning": StageOverrideSchema.optional(),
      "merge-resolve": StageOverrideSchema.optional(),
      "merge-verify": StageOverrideSchema.optional(),
      commit_recovery: StageOverrideSchema.optional(),
    })
    .default({}),
  git: z.object({
    remote: z.string().optional(),
    mainBranch: z.string().default("main"),
    worktreeRoot: z.string().default(".flow/worktrees"),
    /** How to merge a completed task branch into main. `squash` collapses the
     *  task's per-stage commits into a single commit on main; `merge` keeps
     *  the legacy `--no-ff` merge commit shape with full per-stage history. */
    mergeStrategy: z.enum(["squash", "merge"]).default("squash"),
  }),
  /** Pre-merge verification gate. If `command` is set, the orchestrator runs
   *  it from the project root after a merge has been staged but before the
   *  final commit. Non-zero exit aborts the merge and pauses the task. */
  verify: z
    .object({
      command: z.string().optional(),
      /** Wall-clock cap for the verify command. Defaults to 5 minutes. */
      timeoutMs: z.number().int().positive().default(300_000),
    })
    .default({ timeoutMs: 300_000 }),
  ws: z
    .object({
      port: z.number().int().positive().default(7777),
    })
    .default({ port: 7777 }),
  pricing: z.record(z.string(), PricingEntrySchema).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export const StateSchema = z.object({
  version: z.number().int().positive().default(1),
  tasks: z.array(TaskRuntimeSchema).default([]),
  sessions: z.array(SessionSchema).default([]),
  updatedAt: z.string(),
});
export type State = z.infer<typeof StateSchema>;

export const ProjectStatusSchema = z.enum([
  "empty",
  "uninitialized",
  "ready",
  "running",
  "error",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  status: ProjectStatusSchema,
  numTasks: z.number().int().nonnegative(),
  lastOpenedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const DagSchema = z.object({
  nodes: z.array(z.string()),
  edges: z.array(z.tuple([z.string(), z.string()])),
});
export type Dag = z.infer<typeof DagSchema>;

export const ProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  status: ProjectStatusSchema,
  config: ConfigSchema,
  tasks: z.array(TaskRuntimeSchema),
  dag: DagSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export interface Events {
  "project.state": { project: Project };
  "task.upsert": { task: TaskRuntime };
  "task.removed": { taskId: string };
  dag: Dag;
  "session.started": { session: Session };
  "session.updated": { session: Session };
  "session.event": { event: SessionEvent };
  "session.ended": { session: Session };
  notification: { notification: Notification };
  learning: { taskId: string; path: string; markdown: string };
  config: { config: Config };
  error: { requestId?: string; message: string };
}

export type EventName = keyof Events;
