import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Paths } from "./paths.js";
import { AgentRunner } from "./agent.js";
import { loadConfig, defaultConfig, saveConfig } from "./config.js";
import { writeMapMd } from "./map.js";
import { loadTasks, nextRunnableTask, taskStatus } from "./tasks.js";
import { exists, writeJsonAtomic, ensureDir } from "./atomic.js";
import type { Config, Session, TaskDef } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveAssetsDir(): string {
  // dist/flow.js → ../assets ; src/flow.ts (tsx) → ../assets
  const candidate = path.resolve(__dirname, "..", "assets");
  return candidate;
}

async function copyPromptAsset(src: string, dest: string): Promise<void> {
  if (await exists(dest)) return; // never clobber user edits
  const body = await fs.readFile(src, "utf8");
  await ensureDir(path.dirname(dest));
  await fs.writeFile(dest, body, "utf8");
}

export class Flow {
  private readonly paths: Paths;
  private config: Config;
  private readonly agent: AgentRunner;

  private constructor(paths: Paths, config: Config) {
    this.paths = paths;
    this.config = config;
    this.agent = new AgentRunner(paths, config);
  }

  static async open(projectRoot: string): Promise<Flow> {
    const paths = new Paths(projectRoot);
    const config = await loadConfig(paths);
    return new Flow(paths, config);
  }

  /** Create .flow/, .flow/prompts/, default config. Idempotent. */
  async init(): Promise<void> {
    await ensureDir(this.paths.flowDir);
    await ensureDir(this.paths.promptsDir);
    await ensureDir(this.paths.tasksDir);

    const assets = resolveAssetsDir();
    for (const name of ["setup", "get-tasks", "exec"]) {
      await copyPromptAsset(
        path.join(assets, "prompts", `${name}.md`),
        this.paths.promptFile(name),
      );
    }
    if (!(await exists(this.paths.configJson))) {
      await saveConfig(this.paths, defaultConfig());
    }
  }

  /** Run setup if AGENTS.md absent. */
  async runSetup(): Promise<Session | null> {
    if (await exists(this.paths.agentsMd)) return null;
    if (!(await exists(this.paths.planMd))) {
      throw new Error(`plan.md missing at ${this.paths.planMd}`);
    }
    return this.agent.run({
      phase: "setup",
      projectRoot: this.paths.projectRoot,
    });
  }

  /** Run get-tasks if tasks.json absent. */
  async runGetTasks(): Promise<Session | null> {
    if (await exists(this.paths.tasksJson)) return null;
    await writeMapMd(this.paths.projectRoot, this.paths.mapMd);
    return this.agent.run({
      phase: "get-tasks",
      projectRoot: this.paths.projectRoot,
    });
  }

  /** Execute the next runnable task (deps all done). Returns null when queue
   *  is exhausted or blocked. */
  async runNextTask(): Promise<{ task: TaskDef; session: Session } | null> {
    const tasks = await loadTasks(this.paths);
    const task = await nextRunnableTask(this.paths, tasks);
    if (!task) return null;

    // Regenerate Map.md so the agent sees the current tree.
    await writeMapMd(this.paths.projectRoot, this.paths.mapMd);
    await ensureDir(this.paths.taskDir(task.id));

    const session = await this.agent.run({
      phase: "exec",
      task,
      projectRoot: this.paths.projectRoot,
      taskId: task.id,
    });
    return { task, session };
  }

  /** Drive: setup → get-tasks → loop exec until queue exhausted/stuck. */
  async run(): Promise<void> {
    await this.init();
    const setup = await this.runSetup();
    if (setup && setup.status !== "succeeded") {
      console.error(`Setup failed: ${setup.error ?? "unknown error"}`);
      return;
    }
    const gt = await this.runGetTasks();
    if (gt && gt.status !== "succeeded") {
      console.error(`Get-tasks failed: ${gt.error ?? "unknown error"}`);
      return;
    }
    for (;;) {
      const res = await this.runNextTask();
      if (!res) break;
      const status = await taskStatus(this.paths, res.task);
      console.log(`task ${res.task.id}: ${status}${res.session.error ? ` (${res.session.error.slice(0, 200)})` : ""}`);
      if (status === "blocked") {
        // Blocked tasks gate dependents; keep looping in case other branches remain.
        continue;
      }
      if (status === "pending") {
        // Agent ran but didn't write summary.md or block.md. Bail to avoid loops.
        console.error(`task ${res.task.id}: agent finished without writing summary.md or block.md`);
        return;
      }
    }
    console.log("queue exhausted");
  }

  getConfig(): Config { return this.config; }
  getPaths(): Paths { return this.paths; }
}

export async function initFlowProject(projectRoot: string): Promise<void> {
  const flow = await Flow.open(projectRoot);
  await flow.init();
}
