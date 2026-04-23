import type { Dag, TaskDef, TaskRuntime } from "./types.js";

export type DagErrorCode = "CYCLE" | "UNKNOWN_DEP" | "NON_LEAF_NEW";

export class DagError extends Error {
  public readonly code: DagErrorCode;

  constructor(code: DagErrorCode, message: string) {
    super(message);
    this.name = "DagError";
    this.code = code;
  }
}

type AnyTask = TaskDef | TaskRuntime;

function isRuntime(task: AnyTask): task is TaskRuntime {
  return typeof (task as TaskRuntime).status === "string";
}

/**
 * Build a Dag object (nodes + edges) from an ordered list of tasks.
 * edges = [dependency, dependent] pairs, i.e. [required, requires-it].
 */
export function buildDag(tasks: Array<AnyTask>): Dag {
  const nodes: string[] = tasks.map((t) => t.id);
  const edges: Array<[string, string]> = [];
  for (const task of tasks) {
    for (const dep of task.requires ?? []) {
      edges.push([dep, task.id]);
    }
  }
  return { nodes, edges };
}

/**
 * Throws DagError with:
 *   - code "UNKNOWN_DEP" if a `requires` points at a non-existent id.
 *   - code "CYCLE" (with a short cycle path in message) if a cycle is found.
 *   - code "NON_LEAF_NEW" if `newlyAddedIds` contains an id that is a
 *     dependency of any other task (new tasks must be DAG leaves per §9).
 */
export function validateDag(
  tasks: Array<AnyTask>,
  opts?: { newlyAddedIds?: string[] },
): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    ids.add(task.id);
  }

  // Unknown dep check.
  for (const task of tasks) {
    for (const dep of task.requires ?? []) {
      if (!ids.has(dep)) {
        throw new DagError(
          "UNKNOWN_DEP",
          `Task "${task.id}" requires unknown task "${dep}"`,
        );
      }
    }
  }

  // Cycle detection via DFS. Build adjacency: task.id -> deps it requires.
  const requiresMap = new Map<string, string[]>();
  for (const task of tasks) {
    requiresMap.set(task.id, [...(task.requires ?? [])]);
  }

  const WHITE = 0; // unvisited
  const GRAY = 1; // on current stack
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  const stack: string[] = [];

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    const deps = requiresMap.get(node) ?? [];
    for (const dep of deps) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // Found a back edge: cycle is from `dep`'s position in stack → ... → node → dep.
        const start = stack.indexOf(dep);
        const cyclePath = stack.slice(start).concat(dep).join(" -> ");
        throw new DagError("CYCLE", `Cycle detected: ${cyclePath}`);
      }
      if (c === WHITE) {
        dfs(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const id of ids) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      dfs(id);
    }
  }

  // Non-leaf new-task check.
  const newly = new Set(opts?.newlyAddedIds ?? []);
  if (newly.size > 0) {
    // An id is a dependency of another task iff some task's `requires`
    // contains it.
    const dependedOn = new Set<string>();
    for (const task of tasks) {
      for (const dep of task.requires ?? []) {
        dependedOn.add(dep);
      }
    }
    for (const id of newly) {
      if (dependedOn.has(id)) {
        throw new DagError(
          "NON_LEAF_NEW",
          `Newly-added task "${id}" has dependents; new tasks must be DAG leaves`,
        );
      }
    }
  }
}

/**
 * Topological order (ids). Stable by creation order in the input.
 * Assumes validateDag passed (no cycles, all deps known).
 *
 * Uses Kahn's algorithm but iterates candidate nodes in original input order
 * to preserve stability: among nodes whose in-degree has dropped to zero, we
 * emit them in the order they appear in the input.
 */
export function topoSort(tasks: Array<AnyTask>): string[] {
  const order: string[] = tasks.map((t) => t.id);
  const indexOf = new Map<string, number>();
  order.forEach((id, i) => indexOf.set(id, i));

  const inDegree = new Map<string, number>();
  for (const id of order) inDegree.set(id, 0);
  for (const task of tasks) {
    for (const _dep of task.requires ?? []) {
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  // dependents: for each id, list of task ids that require it.
  const dependents = new Map<string, string[]>();
  for (const id of order) dependents.set(id, []);
  for (const task of tasks) {
    for (const dep of task.requires ?? []) {
      dependents.get(dep)?.push(task.id);
    }
  }

  const result: string[] = [];
  const emitted = new Set<string>();

  // Repeatedly scan input order, emit any node with inDegree 0 not yet
  // emitted. Decrement dependents' inDegree as we emit. Continue until a
  // full pass emits nothing.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of order) {
      if (emitted.has(id)) continue;
      if ((inDegree.get(id) ?? 0) === 0) {
        result.push(id);
        emitted.add(id);
        progressed = true;
        for (const dependent of dependents.get(id) ?? []) {
          inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
        }
      }
    }
  }

  // If not every task was emitted, the input had a cycle; topoSort's
  // contract says validateDag has passed, but we fall back to appending the
  // remainder rather than throwing, so callers that skip validation still
  // get a deterministic result.
  for (const id of order) {
    if (!emitted.has(id)) result.push(id);
  }

  return result;
}

/**
 * Tasks whose requires[] are satisfied (all required ids present in the
 * set of completed tasks). Returns ids in topo order, filtered to
 * status === 'pending' | 'ready'. `done` and `merged` count as satisfied
 * for unblocking dependents.
 */
export function readyTasks(tasks: TaskRuntime[]): TaskRuntime[] {
  const completed = new Set<string>();
  for (const task of tasks) {
    if (task.status === "done" || task.status === "merged") {
      completed.add(task.id);
    }
  }

  const order = topoSort(tasks);
  const byId = new Map<string, TaskRuntime>();
  for (const task of tasks) byId.set(task.id, task);

  const result: TaskRuntime[] = [];
  for (const id of order) {
    const task = byId.get(id);
    if (!task) continue;
    if (task.status !== "pending" && task.status !== "ready") continue;
    const deps = task.requires ?? [];
    const satisfied = deps.every((d) => completed.has(d));
    if (satisfied) result.push(task);
  }
  return result;
}
