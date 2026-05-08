import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";

import { EventBus } from "./events.js";
import { StateStore } from "./state.js";
import { GitManager } from "./git.js";
import { AgentRunner } from "./agent.js";
import { Paths } from "./paths.js";
import { ensureDir, exists, readJsonIfExists, writeJsonAtomic } from "./atomic.js";
import { defaultConfig, loadConfig, saveConfig } from "./config.js";
import { validateDag, DagError } from "./dag.js";
import { newId, nowIso } from "./ids.js";
import {
  TasksFileSchema,
  type Config,
  type Notification,
  type ProjectStatus,
  type State,
  type TaskDef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupDeps {
  paths: Paths;
  config: Config;
  state: StateStore;
  git: GitManager;
  agent: AgentRunner;
  eventBus: EventBus;
}

export interface InitOpts {
  assetsDir?: string;
  git: GitManager;
}

// ---------------------------------------------------------------------------
// Assets resolution
// ---------------------------------------------------------------------------

/**
 * Locate the bundled `assets/` directory that ships with the package.
 *
 * Production layout: `dist/setup.js` → `../assets/` lives next to `dist/`.
 * Dev layout (tsx): `src/setup.ts` → `../assets/` sits next to `src/`.
 * Both reduce to "../assets" from the module's directory.
 */
export function resolveBundledAssetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "assets");
}

// ---------------------------------------------------------------------------
// Project status
// ---------------------------------------------------------------------------

export async function resolveProjectStatus(paths: Paths): Promise<ProjectStatus> {
  const hasPlan = await exists(paths.planMd);
  if (!hasPlan) return "empty";

  const hasConfig = await exists(paths.configJson);
  if (!hasConfig) return "uninitialized";

  const hasTasks = await exists(paths.tasksJson);
  if (!hasTasks) return "uninitialized";

  return "ready";
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/**
 * Create `.flow/`, copy default skills from `assetsDir/skills/*` into
 * `.flow/skills/*`, write a default `config.json`, and initialise an empty
 * `state.json` — all idempotently. User files already present are not
 * overwritten.
 */
export async function scaffoldFlowDir(
  paths: Paths,
  assetsDir: string,
): Promise<void> {
  await ensureDir(paths.flowDir);
  await ensureDir(paths.skillsDir);
  await ensureDir(paths.promptsDir);
  await ensureDir(paths.tasksDir);
  await ensureDir(paths.projectSessionsDir);
  await ensureDir(paths.worktreesDir);
  await ensureDir(paths.learningsDir);

  // Copy bundled skills. Files are byte-compared and only refreshed if
  // they differ — see `copyAssetsTree`.
  const srcSkills = path.join(assetsDir, "skills");
  try {
    await fs.access(srcSkills);
    await copyAssetsTree(srcSkills, paths.skillsDir);
  } catch {
    // No bundled skills — leave the directory empty.
  }

  // Copy bundled stage prompts (flat dir of `prompt-<stage>.md` files).
  const srcPrompts = path.join(assetsDir, "prompts");
  try {
    await fs.access(srcPrompts);
    await copyAssetsTree(srcPrompts, paths.promptsDir);
  } catch {
    // No bundled prompts — leave the directory empty.
  }

  // Config.
  if (!(await exists(paths.configJson))) {
    await saveConfig(paths, defaultConfig());
  }

  // State.
  if (!(await exists(paths.stateJson))) {
    const emptyState: State = {
      version: 1,
      tasks: [],
      sessions: [],
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(paths.stateJson, emptyState);
  }
}

/**
 * Keep the bundled (core) skills shipped under `assets/skills/` in sync
 * with `.flow/skills/`:
 *
 * - Adds any bundled skill subdirectory missing locally.
 * - Within bundled subdirectories, refreshes files whose on-disk bytes
 *   differ from the bundled copy.
 *
 * Skills that exist only in `.flow/skills/` (project-added, e.g.
 * `pokemon-data-conventions`) are left alone — the loop iterates the
 * bundled source, never the destination. Returns the lists of skill
 * directories that were added or had at least one file refreshed.
 *
 * Safe to invoke on every non-read-only Flow command — idempotent.
 */
export async function syncBundledSkills(
  paths: Paths,
  assetsDir: string,
): Promise<{ added: string[]; updated: string[] }> {
  const srcSkills = path.join(assetsDir, "skills");
  try {
    await fs.access(srcSkills);
  } catch {
    return { added: [], updated: [] };
  }
  await ensureDir(paths.skillsDir);
  const [srcEntries, destEntries] = await Promise.all([
    fs.readdir(srcSkills, { withFileTypes: true }),
    fs.readdir(paths.skillsDir, { withFileTypes: true }).catch(() => []),
  ]);
  const destNames = new Set(
    destEntries.filter((e) => e.isDirectory()).map((e) => e.name),
  );
  const added = srcEntries
    .filter((e) => e.isDirectory() && !destNames.has(e.name))
    .map((e) => e.name)
    .sort();
  const updatedSet = new Set<string>();
  for (const entry of srcEntries) {
    if (!entry.isDirectory()) continue;
    const srcPath = path.join(srcSkills, entry.name);
    const destPath = path.join(paths.skillsDir, entry.name);
    const existedLocally = destNames.has(entry.name);
    const refreshed = await copyAssetsTree(srcPath, destPath);
    // Only count as "updated" if the directory already existed locally;
    // brand-new directories show up under `added` instead.
    if (refreshed && existedLocally) updatedSet.add(entry.name);
  }
  const updated = [...updatedSet].sort();
  return { added, updated };
}

/**
 * Sibling of `syncBundledSkills` for the flat `assets/prompts/` tree. Each
 * file (`prompt-<stage>.md`) is copied into `.flow/prompts/`, byte-compared
 * so unchanged files are skipped. Files that exist only locally are left
 * alone — the loop iterates the bundled source. Returns the lists of
 * filenames that were added or refreshed.
 *
 * Safe to invoke on every non-read-only Flow command — idempotent.
 */
export async function syncBundledPrompts(
  paths: Paths,
  assetsDir: string,
): Promise<{ added: string[]; updated: string[] }> {
  const srcPrompts = path.join(assetsDir, "prompts");
  try {
    await fs.access(srcPrompts);
  } catch {
    return { added: [], updated: [] };
  }
  await ensureDir(paths.promptsDir);
  const [srcEntries, destEntries] = await Promise.all([
    fs.readdir(srcPrompts, { withFileTypes: true }),
    fs.readdir(paths.promptsDir, { withFileTypes: true }).catch(() => []),
  ]);
  const destNames = new Set(
    destEntries.filter((e) => e.isFile()).map((e) => e.name),
  );
  const added: string[] = [];
  const updated: string[] = [];
  for (const entry of srcEntries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const srcPath = path.join(srcPrompts, entry.name);
    const destPath = path.join(paths.promptsDir, entry.name);
    if (destNames.has(entry.name)) {
      const [a, b] = await Promise.all([
        fs.readFile(srcPath),
        fs.readFile(destPath),
      ]);
      if (a.equals(b)) continue;
      await fs.copyFile(srcPath, destPath);
      updated.push(entry.name);
    } else {
      await fs.copyFile(srcPath, destPath);
      added.push(entry.name);
    }
  }
  added.sort();
  updated.sort();
  return { added, updated };
}

/**
 * Recursively copy `src` into `dest`. Files that already exist at the
 * destination are byte-compared and overwritten only when the bundled
 * content differs. Returns `true` if any file was written (added or
 * refreshed); the caller uses this to decide whether to surface the
 * directory in the `updated` list.
 */
async function copyAssetsTree(src: string, dest: string): Promise<boolean> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  let changed = false;
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyAssetsTree(srcPath, destPath);
      if (sub) changed = true;
      continue;
    }
    if (!entry.isFile()) continue;
    if (await exists(destPath)) {
      const [a, b] = await Promise.all([
        fs.readFile(srcPath),
        fs.readFile(destPath),
      ]);
      if (a.equals(b)) continue;
    }
    await ensureDir(path.dirname(destPath));
    await fs.copyFile(srcPath, destPath);
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------

/**
 * Initialise a Flow project: scaffold `.flow/`, ensure the git repo exists.
 *
 * Does NOT auto-run setup/get-tasks — those are triggered on project open via
 * `ensureTasksLoaded` so the UI can render progress around them.
 */
export async function initProject(paths: Paths, opts: InitOpts): Promise<void> {
  const assetsDir = opts.assetsDir ?? resolveBundledAssetsDir();
  await scaffoldFlowDir(paths, assetsDir);
  await opts.git.ensureRepo();
}

// ---------------------------------------------------------------------------
// Sessions: setup + get-tasks
// ---------------------------------------------------------------------------

/**
 * Run the `setup` skill at project level. Always runs — setup is the
 * environment gatekeeper and must verify MCPs/services/credentials before
 * any task work begins. (`config.hasDocs` only suppresses the per-task
 * `documentation` stage; it does not gate setup.) Project-level sessions
 * carry `taskId = null`.
 *
 * `plan.md` is auto-injected as a context file when present so setup can
 * extract the project's declared tooling. Setup tolerates the plan being
 * absent (`resolveProjectStatus` already prevents the orchestrator from
 * invoking setup in that case, but the lookup is permissive here so a
 * direct `runSetupSession` call doesn't blow up).
 */
export async function runSetupSession(deps: SetupDeps): Promise<void> {
  const lookup = await findPlan(deps.paths.projectRoot);
  await deps.agent.spawnAgent({
    taskId: null,
    stage: "setup",
    skillName: "setup",
    worktreePath: deps.paths.projectRoot,
    contextFiles: lookup.path ? [lookup.path] : undefined,
  });
}

/**
 * Run the `get-tasks` skill at project level, read the `tasks.json` the agent
 * wrote, validate it against the schema and the DAG invariants, then return
 * the parsed task defs.
 */
export interface PlanLookup {
  path: string | null;
  searched: string[];
}

/**
 * Locate a plan/PRD markdown document the get-tasks agent should decompose.
 *
 * Search order (first match wins, all comparisons case-insensitive):
 *   1. Project root — any `*.md` whose stem is exactly `plan` or `prd`, or
 *      contains the substring `plan`.
 *   2. `./plan/` directory at project root — any `*.md` file inside.
 *
 * Returns the absolute path of the first hit plus a human-readable trail of
 * every location inspected, so callers can build a diagnostic error message.
 */
export async function findPlan(projectRoot: string): Promise<PlanLookup> {
  const searched: string[] = [];

  const rootEntries = await fs.readdir(projectRoot, { withFileTypes: true });
  searched.push(
    `${projectRoot}: *.md with stem "plan", "prd", or containing "plan" (case-insensitive)`,
  );
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(".md")) continue;
    const stem = lower.slice(0, -3);
    if (stem === "plan" || stem === "prd" || stem.includes("plan")) {
      return { path: path.join(projectRoot, entry.name), searched };
    }
  }

  const planDirEntry = rootEntries.find(
    (e) => e.isDirectory() && e.name.toLowerCase() === "plan",
  );
  if (planDirEntry) {
    const planDirPath = path.join(projectRoot, planDirEntry.name);
    searched.push(`${planDirPath}/: any *.md file`);
    const dirEntries = await fs.readdir(planDirPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        return { path: path.join(planDirPath, entry.name), searched };
      }
    }
  } else {
    searched.push(`${path.join(projectRoot, "plan")}/: directory not present`);
  }

  return { path: null, searched };
}

export async function runGetTasksSession(deps: SetupDeps): Promise<TaskDef[]> {
  const lookup = await findPlan(deps.paths.projectRoot);
  if (!lookup.path) {
    const msg = [
      `No plan document found. get-tasks requires a plan/PRD markdown file.`,
      `Searched:`,
      ...lookup.searched.map((s) => `  - ${s}`),
      `Place a plan document at one of those locations and retry.`,
    ].join("\n");
    await emitError(deps, msg);
    throw new Error(msg);
  }

  await deps.agent.spawnAgent({
    taskId: null,
    stage: "get-tasks",
    skillName: "get-tasks",
    worktreePath: deps.paths.projectRoot,
    contextFiles: [lookup.path],
  });

  return readAndValidateTasksFile(deps);
}

async function readAndValidateTasksFile(deps: SetupDeps): Promise<TaskDef[]> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists<unknown>(deps.paths.tasksJson);
  } catch (err) {
    const msg = `Invalid tasks.json: ${(err as Error).message}`;
    await emitError(deps, msg);
    throw new Error(msg);
  }
  if (raw === null) {
    const msg = `No tasks.json found at ${deps.paths.tasksJson} after get-tasks session`;
    await emitError(deps, msg);
    throw new Error(msg);
  }

  const parsed = TasksFileSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = `Invalid tasks.json: ${parsed.error.message}`;
    await emitError(deps, msg);
    throw new Error(msg);
  }

  try {
    validateDag(parsed.data.tasks);
  } catch (err) {
    const code = err instanceof DagError ? err.code : "INVALID";
    const msg = `Invalid DAG in tasks.json (${code}): ${(err as Error).message}`;
    await emitError(deps, msg);
    throw new Error(msg);
  }

  return parsed.data.tasks;
}

async function emitError(deps: SetupDeps, body: string): Promise<void> {
  const notification: Notification = {
    id: newId(),
    severity: "error",
    title: "Task definitions could not be loaded",
    body,
    createdAt: nowIso(),
    acknowledged: false,
  };
  try {
    await deps.state.appendNotification(notification);
  } catch {
    /* best-effort */
  }
  deps.eventBus.emit("notification", { notification });
  deps.eventBus.emit("error", { message: body });
}

/**
 * If `tasks.json` already exists, parse + validate + return it. Otherwise
 * run setup (when hasDocs) then get-tasks, sync the resulting defs into the
 * state store, and return them.
 */
export async function ensureTasksLoaded(deps: SetupDeps): Promise<TaskDef[]> {
  const tasksExists = await exists(deps.paths.tasksJson);
  if (tasksExists) {
    const defs = await readAndValidateTasksFile(deps);
    // Keep runtime state in sync with whatever is on disk.
    await deps.state.load();
    deps.state.syncFromTaskDefs(defs);
    deps.state.recomputeReadiness();
    await deps.state.save();
    return defs;
  }

  await runSetupSession(deps);
  const defs = await runGetTasksSession(deps);

  await deps.state.load();
  deps.state.syncFromTaskDefs(defs);
  deps.state.recomputeReadiness();
  await deps.state.save();

  return defs;
}

// ---------------------------------------------------------------------------
// Plan watcher
// ---------------------------------------------------------------------------

/**
 * Watch `plan.md` for changes. Returns a disposer. `onChange` is called at
 * most once per 250ms burst.
 */
export function watchPlan(paths: Paths, onChange: () => void): () => void {
  const watcher = chokidar.watch(paths.planMd, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });

  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch {
        /* swallow — the caller is responsible for error handling */
      }
    }, 250);
  };

  watcher.on("add", fire);
  watcher.on("change", fire);
  watcher.on("unlink", fire);

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void watcher.close();
  };
}

// Keep `Config` + `loadConfig` reachable from callers that import from this
// module as a one-stop setup surface.
export { loadConfig };
