import { TasksFileSchema, type TaskDef, type TaskStatus } from "./types.js";
import { Paths } from "./paths.js";
import { exists, readJsonIfExists } from "./atomic.js";

export async function loadTasks(paths: Paths): Promise<TaskDef[]> {
  const raw = await readJsonIfExists<unknown>(paths.tasksJson);
  if (!raw) return [];
  const parsed = TasksFileSchema.parse(raw);
  return parsed.tasks;
}

export async function taskStatus(paths: Paths, task: TaskDef): Promise<TaskStatus> {
  if (await exists(paths.taskSummary(task.id))) return "done";
  if (await exists(paths.taskBlock(task.id))) return "blocked";
  return "pending";
}

/** Sequential pick: first task whose `requires` are all done. Returns null when
 *  every remaining task is done, blocked, or has unmet (non-done) deps — the
 *  caller decides whether that's queue-exhausted or stuck. */
export async function nextRunnableTask(
  paths: Paths,
  tasks: TaskDef[],
): Promise<TaskDef | null> {
  const statuses = new Map<string, TaskStatus>();
  for (const t of tasks) statuses.set(t.id, await taskStatus(paths, t));
  for (const t of tasks) {
    if (statuses.get(t.id) !== "pending") continue;
    const ok = t.requires.every((r) => statuses.get(r) === "done");
    if (ok) return t;
  }
  return null;
}
