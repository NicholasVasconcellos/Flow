import { z } from "zod";
import { slugifyTitle } from "./ids.js";

export const EffortSchema = z.enum(["low", "med", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const PhaseSchema = z.enum(["setup", "get-tasks", "exec"]);
export type Phase = z.infer<typeof PhaseSchema>;

const RawTaskDefSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  goal: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  targetFiles: z.array(z.string()).default([]),
  contextFiles: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
  hasUI: z.boolean().default(false),
  hasTests: z.boolean().default(true),
  hasReview: z.boolean().default(false),
});

export const TaskDefSchema = RawTaskDefSchema.transform((t, ctx) => {
  const id = t.id ?? slugifyTitle(t.title);
  if (!id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["id"],
      message: `Cannot derive id from title "${t.title}"`,
    });
    return z.NEVER;
  }
  return { ...t, id };
});
export type TaskDef = z.infer<typeof TaskDefSchema>;

export const TasksFileSchema = z
  .object({ tasks: z.array(RawTaskDefSchema) })
  .transform((file, ctx) => {
    const seen = new Set<string>();
    const tasks: TaskDef[] = [];
    for (const [i, raw] of file.tasks.entries()) {
      const explicit = typeof raw.id === "string" && raw.id.length > 0;
      let id = explicit ? raw.id! : slugifyTitle(raw.title);
      if (!id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", i, "id"],
          message: `Cannot derive id from title "${raw.title}"`,
        });
        return z.NEVER;
      }
      if (seen.has(id)) {
        if (explicit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tasks", i, "id"],
            message: `Duplicate id "${id}"`,
          });
          return z.NEVER;
        }
        let n = 2;
        while (seen.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      seen.add(id);
      tasks.push({ ...raw, id });
    }
    return { tasks };
  });
export type TasksFile = z.infer<typeof TasksFileSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  phase: PhaseSchema,
  model: z.string(),
  effort: EffortSchema.optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  status: z.enum(["running", "succeeded", "failed"]),
  error: z.string().optional(),
  costUsd: z.number().nonnegative().default(0),
});
export type Session = z.infer<typeof SessionSchema>;

const PhaseOverrideSchema = z
  .object({ model: z.string().optional(), effort: EffortSchema.optional() })
  .optional();

export const ConfigSchema = z.object({
  defaults: z.object({
    model: z.string().default("opus"),
    effort: EffortSchema.default("high"),
  }).default({ model: "opus", effort: "high" }),
  phases: z
    .object({
      setup: PhaseOverrideSchema,
      "get-tasks": PhaseOverrideSchema,
      exec: PhaseOverrideSchema,
    })
    .default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export type TaskStatus = "pending" | "ready" | "done" | "blocked";
