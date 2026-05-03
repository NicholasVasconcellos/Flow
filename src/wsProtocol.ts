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
    type: z.literal("artifact.fetch"),
    fetchId: z.string(),
    kind: z.string(),
    ids: z.record(z.union([z.string(), z.number()])).default({}),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("notification.ack"),
    id: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("notification.clearAll"),
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

// Source of truth for the set of supported command types. Consumed by the
// server when populating `hello.capabilities.supportedCommands` and by tests
// that need to enumerate the wire surface. The `satisfies` clause keeps this
// in lockstep with the discriminated union literals above.
export const CLIENT_COMMAND_TYPES = [
  "project.list",
  "project.open",
  "project.create",
  "project.close",
  "run.once",
  "run.allOnce",
  "run.all",
  "run.cancel",
  "task.retry",
  "task.cancel",
  "task.resume",
  "artifact.fetch",
  "notification.ack",
  "notification.clearAll",
  "config.get",
  "config.update",
  "config.stages.get",
  "config.stages.update",
] as const satisfies readonly ClientCommand["type"][];

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------
//
// Typed discriminated union matching plan.md §14. No runtime validation on the
// outbound side — types are sufficient. `project?` on `hello` is optional per
// the plan; we send `project.state` as a separate frame when a project is open.

export interface ServerCapabilities {
  readOnly: boolean;
  supportedCommands: readonly string[];
}

export type ServerEvent =
  | {
      type: "hello";
      version: string;
      project?: Project;
      capabilities: ServerCapabilities;
    }
  | {
      type: "command.result";
      requestId: string;
      ok: boolean;
      message?: string;
      data?: unknown;
    }
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
  | { type: "notifications.cleared" }
  | { type: "learning"; taskId: string; path: string; markdown: string }
  | { type: "config"; config: Config }
  | { type: "config.stages"; stages: Partial<Record<StageKey, StageOverride>> }
  | {
      type: "artifact.chunk";
      fetchId: string;
      kind: string;
      ids: Record<string, string | number>;
      payload: unknown;
    }
  | {
      type: "artifact.end";
      fetchId: string;
      kind: string;
      ids: Record<string, string | number>;
    }
  | {
      type: "artifact.error";
      fetchId: string;
      kind: string;
      ids: Record<string, string | number>;
      message: string;
    }
  | { type: "error"; requestId?: string; message: string };
