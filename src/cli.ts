#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { promises as fs } from "node:fs";

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";

import { createFlow, initFlowProject } from "./flow.js";
import { Paths } from "./paths.js";
import { loadConfig, mergeConfigPatch, saveConfig } from "./config.js";
import { readJsonlLines } from "./atomic.js";
import { topoSort } from "./dag.js";
import { startWsServer, type WsServer } from "./ws.js";
import type { Flow } from "./flow.js";
import type { Config, SessionEvent, TaskRuntime } from "./types.js";

const FLOW_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function termWidth(): number {
  const w = (process.stdout as NodeJS.WriteStream).columns;
  return typeof w === "number" && w > 20 ? w : 100;
}

function statusColor(status: TaskRuntime["status"]): (s: string) => string {
  switch (status) {
    case "ready":
      return chalk.cyan;
    case "running":
      return chalk.yellow;
    case "paused":
      return chalk.magenta;
    case "blocked":
      return chalk.red;
    case "done":
      return chalk.green;
    case "merged":
      return chalk.greenBright;
    case "pending":
    default:
      return chalk.gray;
  }
}

export function formatTaskRow(task: TaskRuntime): string {
  const colorize = statusColor(task.status);
  const id = chalk.dim(task.id.slice(-10));
  const title = truncate(task.title, 48);
  const status = colorize(task.status.padEnd(8));
  const stage = chalk.blue(task.stage.padEnd(22));
  const retries = task.retries > 0 ? chalk.yellow(`r${task.retries}`) : "   ";
  const session = task.currentSessionId
    ? chalk.dim(task.currentSessionId.slice(-8))
    : "".padEnd(8);
  return `${id}  ${status} ${stage} ${retries}  ${title}  ${session}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

function formatStatusTable(tasks: TaskRuntime[]): string {
  if (tasks.length === 0) return chalk.dim("(no tasks)");
  const header =
    chalk.dim("id        ") +
    "  " +
    chalk.dim("status  ") +
    " " +
    chalk.dim("stage                 ") +
    " " +
    chalk.dim("ret") +
    "  " +
    chalk.dim(truncate("title", 48)) +
    "  " +
    chalk.dim("session ");
  return [header, ...tasks.map(formatTaskRow)].join("\n");
}

function shortenToolArg(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof obj[key] === "string" ? (obj[key] as string) : null;
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return pick("file_path") ?? pick("path") ?? "";
    case "Bash":
      return truncate(pick("command") ?? "", 60).trimEnd();
    case "Glob":
      return pick("pattern") ?? "";
    case "Grep":
      return pick("pattern") ?? "";
    case "WebFetch":
      return pick("url") ?? "";
    case "Task":
      return pick("description") ?? pick("subagent_type") ?? "";
    default:
      // Try a few common keys.
      return (
        pick("file_path") ??
        pick("path") ??
        pick("command") ??
        pick("pattern") ??
        ""
      );
  }
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const pieces: string[] = [];
  const collect = (block: unknown): void => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      pieces.push(b["text"] as string);
    }
  };
  const message = obj["message"];
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (Array.isArray(content)) content.forEach(collect);
    else if (typeof content === "string") pieces.push(content);
  }
  const content = obj["content"];
  if (Array.isArray(content)) content.forEach(collect);
  if (typeof obj["text"] === "string") pieces.push(obj["text"] as string);
  return pieces.join("\n");
}

function extractThinkingText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const pieces: string[] = [];
  const collect = (block: unknown): void => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    if (b["type"] === "thinking" && typeof b["thinking"] === "string") {
      pieces.push(b["thinking"] as string);
    }
  };
  const message = obj["message"];
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (Array.isArray(content)) content.forEach(collect);
  }
  const content = obj["content"];
  if (Array.isArray(content)) content.forEach(collect);
  return pieces.join("\n");
}

function extractToolUse(
  payload: unknown,
): { name: string; input: unknown } | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (obj["type"] === "tool_use") {
    return {
      name: typeof obj["name"] === "string" ? (obj["name"] as string) : "",
      input: obj["input"],
    };
  }
  // Assistant blocks may embed tool_use entries.
  const walk = (node: unknown): { name: string; input: unknown } | null => {
    if (!node || typeof node !== "object") return null;
    const n = node as Record<string, unknown>;
    if (n["type"] === "tool_use") {
      return {
        name: typeof n["name"] === "string" ? (n["name"] as string) : "",
        input: n["input"],
      };
    }
    return null;
  };
  const message = obj["message"];
  if (message && typeof message === "object") {
    const c = (message as Record<string, unknown>)["content"];
    if (Array.isArray(c)) {
      for (const b of c) {
        const hit = walk(b);
        if (hit) return hit;
      }
    }
  }
  const c = obj["content"];
  if (Array.isArray(c)) {
    for (const b of c) {
      const hit = walk(b);
      if (hit) return hit;
    }
  }
  return null;
}

function wrap(text: string, width: number, indent = ""): string {
  const effective = Math.max(20, width - indent.length);
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= effective) {
      lines.push(indent + raw);
      continue;
    }
    const words = raw.split(/(\s+)/);
    let cur = "";
    for (const w of words) {
      if ((cur + w).length > effective) {
        if (cur.trim().length) lines.push(indent + cur.trimEnd());
        cur = w.trimStart();
      } else {
        cur += w;
      }
    }
    if (cur.trim().length) lines.push(indent + cur.trimEnd());
  }
  return lines.join("\n");
}

export function formatSessionEvent(
  evt: SessionEvent,
  opts: { width?: number } = {},
): string {
  const width = opts.width ?? termWidth();
  switch (evt.kind) {
    case "tool_use": {
      const tu = extractToolUse(evt.payload);
      if (!tu) return "";
      const arg = shortenToolArg(tu.name, tu.input);
      return chalk.cyan("⏺") + ` ${chalk.bold(tu.name)}` + (arg ? ` ${chalk.dim(arg)}` : "");
    }
    case "assistant_text": {
      const t = extractAssistantText(evt.payload).trim();
      if (!t) return "";
      return wrap(t, width);
    }
    case "assistant_thinking": {
      const t = extractThinkingText(evt.payload).trim();
      if (!t) return "";
      return chalk.dim(wrap(t, width, "  "));
    }
    case "tool_result": {
      return chalk.dim("  ↳ tool_result");
    }
    case "usage":
    case "system":
    case "stop":
      return "";
    default:
      return "";
  }
}

function formatSessionSummary(payload: unknown): string {
  // `session.ended` payload: we render compact tokens/cost/context %.
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const tokens = (p["tokens"] as Record<string, number> | undefined) ?? {};
  const cost = typeof p["costUsd"] === "number" ? (p["costUsd"] as number) : 0;
  const ctx = typeof p["contextPercentage"] === "number" ? (p["contextPercentage"] as number) : null;
  const stage = typeof p["stage"] === "string" ? (p["stage"] as string) : "";
  const status = typeof p["status"] === "string" ? (p["status"] as string) : "";
  const totals = tokens["total"] ?? 0;
  const parts = [
    chalk.dim(`[${stage}]`),
    chalk.gray(status),
    `${(totals / 1000).toFixed(1)}K tok`,
    `$${cost.toFixed(3)}`,
    ctx !== null ? `ctx ${ctx}%` : "",
  ].filter(Boolean);
  return chalk.dim("  ↳ ") + parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Streaming subscribers
// ---------------------------------------------------------------------------

function subscribeToFlow(flow: Flow): () => void {
  const offs: Array<() => void> = [];
  offs.push(
    flow.on("task.upsert", ({ task }) => {
      // eslint-disable-next-line no-console
      console.log(formatTaskRow(task));
    }),
  );
  offs.push(
    flow.on("session.event", ({ event }) => {
      const line = formatSessionEvent(event);
      if (line) {
        // eslint-disable-next-line no-console
        console.log(line);
      }
    }),
  );
  offs.push(
    flow.on("session.ended", ({ session }) => {
      // eslint-disable-next-line no-console
      console.log(formatSessionSummary(session));
    }),
  );
  offs.push(
    flow.on("notification", ({ notification }) => {
      const c =
        notification.severity === "error" || notification.severity === "blocked"
          ? chalk.red
          : notification.severity === "warn"
            ? chalk.yellow
            : chalk.cyan;
      // eslint-disable-next-line no-console
      console.log(c.bold(`! ${notification.title}`));
      if (notification.body.trim()) {
        // eslint-disable-next-line no-console
        console.log(c(wrap(notification.body, termWidth(), "  ")));
      }
    }),
  );
  return () => offs.forEach((o) => o());
}

function installSigintHandler(flow: Flow): void {
  let fired = false;
  const handler = (): void => {
    if (fired) {
      process.exit(130);
    }
    fired = true;
    // eslint-disable-next-line no-console
    console.log(chalk.yellow("\n[flow] interrupt received — stopping (2s grace)..."));
    try {
      flow.stop();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      process.exit(130);
    }, 2000).unref?.();
  };
  process.on("SIGINT", handler);
}

// ---------------------------------------------------------------------------
// DAG rendering
// ---------------------------------------------------------------------------

function renderDag(tasks: TaskRuntime[]): string {
  if (tasks.length === 0) return chalk.dim("(empty DAG)");
  const order = topoSort(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));

  // Compute layer for each node: 1 + max(layer of deps).
  const layer = new Map<string, number>();
  for (const id of order) {
    const t = byId.get(id);
    if (!t) continue;
    const reqs = t.requires ?? [];
    const lv = reqs.length === 0 ? 0 : 1 + Math.max(...reqs.map((d) => layer.get(d) ?? 0));
    layer.set(id, lv);
  }

  const layers = new Map<number, string[]>();
  for (const [id, lv] of layer) {
    const arr = layers.get(lv) ?? [];
    arr.push(id);
    layers.set(lv, arr);
  }

  const lines: string[] = [];
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  for (const lv of sortedLayers) {
    lines.push(chalk.bold(`Layer ${lv}`));
    const ids = layers.get(lv) ?? [];
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) continue;
      const deps = (t.requires ?? []).join(", ");
      const depsPart = deps ? chalk.dim(`  [deps: ${deps}]`) : "";
      lines.push(`  ${chalk.cyan(id)} ${truncate(t.title, 60).trimEnd()}${depsPart}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Config helpers (dotted path)
// ---------------------------------------------------------------------------

function getByPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (!next || typeof next !== "object") {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("flow")
  .description("Local task-orchestration runtime for Claude Code")
  .version("0.1.0");

program
  .command("init")
  .description("scaffold .flow/ in cwd, git init if needed")
  .action(async () => {
    const cwd = process.cwd();
    const spinner = ora(`Initializing .flow/ in ${cwd}`).start();
    try {
      await initFlowProject(cwd);
      spinner.succeed(`Initialized .flow/ in ${cwd}`);
    } catch (err) {
      spinner.fail(`init failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("table of tasks, stages, active sessions")
  .action(async () => {
    const flow = await createFlow({ projectPath: process.cwd() });
    const tasks = flow.getTasks();
    // eslint-disable-next-line no-console
    console.log(formatStatusTable(tasks));
    flow.stop();
  });

program
  .command("dag")
  .description("print DAG as ascii")
  .action(async () => {
    const flow = await createFlow({ projectPath: process.cwd() });
    // eslint-disable-next-line no-console
    console.log(renderDag(flow.getTasks()));
    flow.stop();
  });

program
  .command("run-once")
  .description("execute one ready task end-to-end")
  .action(async () => {
    const flow = await createFlow({ projectPath: process.cwd() });
    installSigintHandler(flow);
    const unsubscribe = subscribeToFlow(flow);
    const spinner = ora("Preparing tasks...").start();
    try {
      await flow.ensureTasksLoaded();
      spinner.stop();
      const result = await flow.runOnce();
      if (!result) {
        // eslint-disable-next-line no-console
        console.log(chalk.dim("(no ready tasks)"));
      }
    } catch (err) {
      spinner.fail(`run-once failed: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      unsubscribe();
      flow.stop();
    }
  });

program
  .command("run-all-once")
  .description("execute all currently-ready tasks")
  .option("--limit <n>", "max tasks", (v) => Number.parseInt(v, 10))
  .action(async (opts: { limit?: number }) => {
    const flow = await createFlow({ projectPath: process.cwd() });
    installSigintHandler(flow);
    const unsubscribe = subscribeToFlow(flow);
    const spinner = ora("Preparing tasks...").start();
    try {
      await flow.ensureTasksLoaded();
      spinner.stop();
      await flow.runAllOnce(opts.limit ? { limit: opts.limit } : undefined);
    } catch (err) {
      spinner.fail(`run-all-once failed: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      unsubscribe();
      flow.stop();
    }
  });

program
  .command("run-all")
  .description("drain queue continuously")
  .option("--limit <n>", "max tasks", (v) => Number.parseInt(v, 10))
  .action(async (opts: { limit?: number }) => {
    const flow = await createFlow({ projectPath: process.cwd() });
    installSigintHandler(flow);
    const unsubscribe = subscribeToFlow(flow);
    const spinner = ora("Preparing tasks...").start();
    try {
      await flow.ensureTasksLoaded();
      spinner.stop();
      await flow.runAll(opts.limit ? { limit: opts.limit } : undefined);
    } catch (err) {
      spinner.fail(`run-all failed: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      unsubscribe();
      flow.stop();
    }
  });

program
  .command("retry <taskId>")
  .description("resume a paused/blocked task")
  .action(async (taskId: string) => {
    const flow = await createFlow({ projectPath: process.cwd() });
    installSigintHandler(flow);
    const unsubscribe = subscribeToFlow(flow);
    try {
      await flow.retryTask(taskId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(chalk.red(`retry failed: ${(err as Error).message}`));
      process.exitCode = 1;
    } finally {
      unsubscribe();
      flow.stop();
    }
  });

program
  .command("cancel <taskId>")
  .description("cancel a running task")
  .action(async (taskId: string) => {
    const flow = await createFlow({ projectPath: process.cwd() });
    try {
      await flow.cancelTask(taskId);
      // eslint-disable-next-line no-console
      console.log(chalk.yellow(`Cancelled ${taskId}`));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(chalk.red(`cancel failed: ${(err as Error).message}`));
      process.exitCode = 1;
    } finally {
      flow.stop();
    }
  });

program
  .command("serve")
  .description("start WebSocket server for the UI")
  .option("--port <n>", "port", (v) => Number.parseInt(v, 10))
  .action(async (opts: { port?: number }) => {
    const flow = await createFlow({ projectPath: process.cwd() });
    let server: WsServer | null = null;
    let fired = false;
    const handler = (): void => {
      if (fired) {
        process.exit(130);
      }
      fired = true;
      // eslint-disable-next-line no-console
      console.log(
        chalk.yellow("\n[flow] interrupt received — stopping ws server..."),
      );
      void (async () => {
        try {
          if (server) await server.close();
        } catch {
          /* ignore */
        }
        try {
          flow.stop();
        } catch {
          /* ignore */
        }
        process.exit(130);
      })();
    };
    process.on("SIGINT", handler);

    try {
      const port = opts.port ?? flow.getConfig().ws.port;
      // eslint-disable-next-line no-console
      console.log(chalk.cyan(`[flow] starting ws server on :${port}`));
      server = await startWsServer({ flow, port, version: FLOW_VERSION });
      // eslint-disable-next-line no-console
      console.log(chalk.green(`[flow] listening on ws://127.0.0.1:${server.port}`));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(chalk.red(`serve failed: ${(err as Error).message}`));
      process.exitCode = 1;
      flow.stop();
    }
  });

program
  .command("logs <taskId>")
  .description("tail formatted session events")
  .option("--stage <stage>", "filter by stage")
  .action(async (taskId: string, opts: { stage?: string }) => {
    const cwd = process.cwd();
    const paths = new Paths(cwd);
    const sessionsDir = paths.taskSessionsDir(taskId);
    let files: string[] = [];
    try {
      files = (await fs.readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(chalk.red(`no sessions for task ${taskId}: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }

    // If --stage is given, filter by matching session meta.
    let filtered = files;
    if (opts.stage) {
      filtered = [];
      for (const f of files) {
        const base = f.replace(/\.jsonl$/, "");
        const metaPath = paths.taskSessionMeta(taskId, base);
        try {
          const raw = await fs.readFile(metaPath, "utf8");
          const meta = JSON.parse(raw) as { stage?: string };
          if (meta.stage === opts.stage) filtered.push(f);
        } catch {
          /* no meta, skip */
        }
      }
    }

    for (const f of filtered) {
      const full = path.join(sessionsDir, f);
      const sid = f.replace(/\.jsonl$/, "");
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`--- session ${sid} (${f}) ---`));
      for await (const raw of readJsonlLines<unknown>(full)) {
        const event = toEventFromRaw(raw, sid);
        if (!event) continue;
        const line = formatSessionEvent(event);
        if (line) {
          // eslint-disable-next-line no-console
          console.log(line);
        }
      }
    }
  });

const configCmd = program.command("config").description("read/write .flow/config.json");

configCmd
  .command("get [key]")
  .description("print a config value (or the whole config)")
  .action(async (key?: string) => {
    const paths = new Paths(process.cwd());
    const cfg = await loadConfig(paths);
    if (!key) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    const value = getByPath(cfg, key);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(value ?? null, null, 2));
  });

configCmd
  .command("set <key> <value>")
  .description("set a dotted config key (values auto-parsed as JSON)")
  .action(async (key: string, value: string) => {
    const paths = new Paths(process.cwd());
    const cfg = await loadConfig(paths);
    const parsed = parseValue(value);
    const base = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
    setByPath(base, key, parsed);
    const next = mergeConfigPatch(cfg, base as Partial<Config>);
    await saveConfig(paths, next);
    // eslint-disable-next-line no-console
    console.log(chalk.green(`set ${key} = ${JSON.stringify(parsed)}`));
  });

// ---------------------------------------------------------------------------
// Helper: raw JSONL line → SessionEvent
// ---------------------------------------------------------------------------

function toEventFromRaw(raw: unknown, sessionId: string): SessionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj["sessionId"] === "string" &&
    typeof obj["kind"] === "string" &&
    typeof obj["ts"] === "string" &&
    "payload" in obj
  ) {
    return obj as unknown as SessionEvent;
  }
  const ts =
    typeof obj["timestamp"] === "string"
      ? (obj["timestamp"] as string)
      : typeof obj["ts"] === "string"
        ? (obj["ts"] as string)
        : new Date().toISOString();
  const type = obj["type"];
  const kind: SessionEvent["kind"] =
    type === "tool_use"
      ? "tool_use"
      : type === "tool_result"
        ? "tool_result"
        : type === "assistant"
          ? "assistant_text"
          : type === "usage" || type === "result"
            ? "usage"
            : type === "stop"
              ? "stop"
              : "system";
  return { sessionId, ts, kind, payload: obj };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error(chalk.red(`flow: ${err.message}`));
  process.exit(1);
});
