import { z } from "zod";
import { EffortSchema } from "./types.js";
import type {
  Config,
  Dag,
  Notification,
  Project,
  ProjectSummary,
  Session,
  SessionEvent,
  StageKey,
  StageOverride,
  TaskRuntime,
} from "./types.js";

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project.list"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("project.open"),
    path: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("project.create"),
    name: z.string(),
    parentDir: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("project.close"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.once"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.allOnce"),
    limit: z.number().int().positive().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.all"),
    limit: z.number().int().positive().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.cancel"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("task.retry"),
    taskId: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("task.cancel"),
    taskId: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("task.resume"),
    taskId: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("session.replay"),
    sessionId: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("notification.ack"),
    id: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("config.get"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("config.update"),
    patch: z.record(z.unknown()),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("config.stages.get"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("config.stages.update"),
    stages: z.record(
      z.string(),
      z.object({
        model: z.string().optional(),
        effort: EffortSchema.optional(),
      }),
    ),
    requestId: z.string().optional(),
  }),
]);

export type ClientCommand = z.infer<typeof ClientCommandSchema>;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------
//
// Typed discriminated union matching plan.md §14. No runtime validation on the
// outbound side — types are sufficient. `project?` on `hello` is optional per
// the plan; we send `project.state` as a separate frame when a project is open.

export type ServerEvent =
  | { type: "hello"; version: string; project?: Project }
  | { type: "project.list"; projects: ProjectSummary[] }
  | { type: "project.state"; project: Project }
  | { type: "task.upsert"; task: TaskRuntime }
  | { type: "task.removed"; taskId: string }
  | { type: "dag"; nodes: string[]; edges: [string, string][] }
  | { type: "session.started"; session: Session }
  | { type: "session.updated"; session: Session }
  | { type: "session.event"; event: SessionEvent }
  | { type: "session.ended"; session: Session }
  | { type: "notification"; notification: Notification }
  | { type: "learning"; taskId: string; path: string; markdown: string }
  | { type: "config"; config: Config }
  | { type: "config.stages"; stages: Partial<Record<StageKey, StageOverride>> }
  | { type: "error"; requestId?: string; message: string };
