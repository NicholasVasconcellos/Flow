import { promises as fs } from "node:fs";
import path from "node:path";
import { execa, type ExecaError, type ResultPromise } from "execa";

import { Paths } from "./paths.js";
import { EventBus } from "./events.js";
import { costFor } from "./config.js";
import { newClaudeSessionId, newId, nowIso } from "./ids.js";
import { appendJsonl, writeJsonAtomic } from "./atomic.js";
import type {
  Config,
  Notification,
  Session,
  SessionEvent,
  SessionEventKind,
  TaskDef,
  ThinkingMode,
} from "./types.js";

export interface SpawnArgs {
  taskId: string | null;
  stage: Session["stage"];
  skillName: string;
  model?: string;
  thinkingMode?: ThinkingMode;
  extraPrompt?: string;
  worktreePath: string;
  parentSessionId?: string;
  contextFiles?: string[];
  task?: TaskDef;
  sessionId?: string;
}

/**
 * Abstract shape of the subprocess we need to talk to. Lets tests inject a
 * fake rather than launching the real `claude` binary.
 */
export interface SpawnedProcess {
  /** Stream-json lines (no trailing newline) from stdout. */
  stdout: AsyncIterable<string>;
  /** Lines from stderr. */
  stderr: AsyncIterable<string>;
  /** Resolves with the final exit code. */
  exit: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export type ProcessSpawner = (args: {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => SpawnedProcess;

export interface AgentRunnerDeps {
  paths: Paths;
  config: Config;
  eventBus: EventBus;
  spawner?: ProcessSpawner;
  now?: () => Date;
}

const UPDATE_THROTTLE_MS = 1000;

// ---------------------------------------------------------------------------
// Prompt composition (exported for tests)
// ---------------------------------------------------------------------------

export async function composePrompt(
  deps: Pick<AgentRunnerDeps, "paths">,
  args: SpawnArgs,
): Promise<string> {
  // Reference the skill file via Claude Code's `@path` syntax — the subprocess
  // reads it directly so we avoid inlining 100+ lines of markdown into argv.
  // Fail-fast here if the file is missing so the caller sees the skill name,
  // not an opaque subprocess error.
  const skillPath = deps.paths.skillFile(args.skillName);
  try {
    await fs.access(skillPath);
  } catch {
    throw new Error(
      `Skill "${args.skillName}" not found at ${skillPath}. Ensure .flow/skills/${args.skillName}/SKILL.md exists.`,
    );
  }
  const sections: string[] = [`@${skillPath}`];

  const task = args.task;
  if (task) {
    const title = (task.title ?? "").trim();
    const desc = (task.description ?? "").trim();
    const parts: string[] = ["# Task"];
    parts.push(`ID: ${task.id}`);
    if (title) parts.push(`Title: ${title}`);
    if (desc) parts.push(`Description: ${desc}`);
    sections.push(parts.join("\n"));
  }

  // Make the worktree / main-project split explicit. Without this, agents
  // see a `<taskId>` placeholder and either guess a slug (writing artifacts
  // to the wrong directory) or extrapolate from absolute artifact paths to
  // write source code into the main project — stomping on other tasks'
  // worktrees.
  if (args.taskId && deps.paths) {
    const summaryPath = deps.paths.taskSummary(args.taskId);
    const screenshotsDir = deps.paths.taskScreenshotsDir(args.taskId);
    sections.push(
      [
        "# Runtime paths",
        `Task ID: ${args.taskId}`,
        `Worktree (your cwd): ${args.worktreePath}`,
        "",
        "Source code: **edit files only inside the worktree above**. Use paths",
        "relative to cwd (e.g. `src/foo.ts`) or absolute paths that begin with",
        "the worktree path. Never touch files under any other project root.",
        "",
        "Task artefacts (summary.md, screenshots) are written to the main",
        "project's `.flow/tasks/<taskId>/` directory so they survive worktree",
        "removal. Use these absolute paths verbatim:",
        `  summary.md:       ${summaryPath}`,
        `  screenshots dir:  ${screenshotsDir}`,
        "",
        "Whenever the skill body refers to `<taskId>` or to `.flow/tasks/<taskId>/...`,",
        "substitute the Task ID above and the absolute artefact paths above.",
      ].join("\n"),
    );
  }

  const ctx = args.contextFiles ?? [];
  if (ctx.length > 0) {
    const lines = ["# Context files", ...ctx.map((p) => `- ${p}`)];
    sections.push(lines.join("\n"));
  }

  const extra = (args.extraPrompt ?? "").trim();
  if (extra) {
    sections.push(`# Prior session summaries / addendum\n${extra}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Stream-json line mapping
// ---------------------------------------------------------------------------

interface TokenAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function emptyTokens(): TokenAccumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

/**
 * Deeply scan a payload for any `usage` object and update tokens. Claude Code
 * emits cumulative snapshots, so we keep the maximum seen across events.
 */
function updateTokensFromPayload(
  acc: TokenAccumulator,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  let changed = false;
  const visited = new WeakSet<object>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (visited.has(obj)) return;
    visited.add(obj);

    // Pull token counts from `usage` sub-objects or from any object directly
    // carrying these keys.
    const usage = obj["usage"];
    if (usage && typeof usage === "object") {
      changed = applyUsageObject(acc, usage as Record<string, unknown>) || changed;
    }
    if (
      "input_tokens" in obj ||
      "output_tokens" in obj ||
      "cache_read_input_tokens" in obj ||
      "cache_creation_input_tokens" in obj
    ) {
      changed = applyUsageObject(acc, obj) || changed;
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v);
    }
  };

  walk(payload);
  return changed;
}

function applyUsageObject(
  acc: TokenAccumulator,
  obj: Record<string, unknown>,
): boolean {
  let changed = false;
  const pairs: Array<[keyof TokenAccumulator, string]> = [
    ["input", "input_tokens"],
    ["output", "output_tokens"],
    ["cacheRead", "cache_read_input_tokens"],
    ["cacheCreate", "cache_creation_input_tokens"],
  ];
  for (const [key, raw] of pairs) {
    const v = obj[raw];
    if (typeof v === "number" && Number.isFinite(v) && v > acc[key]) {
      acc[key] = v;
      changed = true;
    }
  }
  return changed;
}

function totalTokens(acc: TokenAccumulator): number {
  return acc.input + acc.output + acc.cacheRead + acc.cacheCreate;
}

function isCompactBoundary(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  if (obj["type"] === "system") {
    if (obj["subtype"] === "compact_boundary") return true;
    const sys = obj["system"];
    if (sys && typeof sys === "object") {
      if ((sys as Record<string, unknown>)["subtype"] === "compact_boundary") {
        return true;
      }
    }
  }
  return false;
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const pieces: string[] = [];

  const collect = (block: unknown) => {
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

function hasThinkingBlock(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  const check = (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.some(
      (b) =>
        b &&
        typeof b === "object" &&
        ((b as Record<string, unknown>)["type"] === "thinking" ||
          (b as Record<string, unknown>)["type"] === "redacted_thinking"),
    );
  const message = obj["message"];
  if (message && typeof message === "object") {
    if (check((message as Record<string, unknown>)["content"])) return true;
  }
  return check(obj["content"]);
}

function hasToolUseBlock(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  const check = (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>)["type"] === "tool_use",
    );
  const message = obj["message"];
  if (message && typeof message === "object") {
    if (check((message as Record<string, unknown>)["content"])) return true;
  }
  return check(obj["content"]);
}

function hasToolResultBlock(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  const check = (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>)["type"] === "tool_result",
    );
  const message = obj["message"];
  if (message && typeof message === "object") {
    if (check((message as Record<string, unknown>)["content"])) return true;
  }
  return check(obj["content"]);
}

export function mapPayloadToEventKind(payload: unknown): SessionEventKind {
  if (!payload || typeof payload !== "object") return "system";
  const obj = payload as Record<string, unknown>;
  const type = obj["type"];

  if (type === "system") return "system";
  if (type === "tool_use") return "tool_use";
  if (type === "tool_result") return "tool_result";
  if (type === "usage") return "usage";
  if (type === "stop") return "stop";
  if (type === "result") {
    // Final result — carries usage too; classify as usage so it drives totals.
    return "usage";
  }
  if (type === "assistant") {
    if (hasThinkingBlock(obj)) return "assistant_thinking";
    if (hasToolUseBlock(obj)) return "tool_use";
    return "assistant_text";
  }
  if (type === "user") {
    if (hasToolResultBlock(obj)) return "tool_result";
    return "system";
  }
  if ("usage" in obj) return "usage";
  return "system";
}

function extractTimestamp(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const obj = payload as Record<string, unknown>;
  for (const key of ["timestamp", "ts", "time", "createdAt"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Execa-backed default spawner
// ---------------------------------------------------------------------------

async function* linesFromNodeStream(
  stream: NodeJS.ReadableStream | null | undefined,
): AsyncIterable<string> {
  if (!stream) return;
  stream.setEncoding?.("utf8");
  let buf = "";
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  const tail = buf.replace(/\r$/, "");
  if (tail.length > 0) yield tail;
}

function execaSpawner(args: {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): SpawnedProcess {
  const child: ResultPromise = execa(args.bin, args.args, {
    cwd: args.cwd,
    env: args.env,
    buffer: false,
    reject: false,
    stdin: "ignore",
  });

  const exit: Promise<number> = child.then(
    (r) => r.exitCode ?? 0,
    (err: ExecaError) => err.exitCode ?? 1,
  );

  return {
    stdout: linesFromNodeStream(child.stdout as NodeJS.ReadableStream | null),
    stderr: linesFromNodeStream(child.stderr as NodeJS.ReadableStream | null),
    exit,
    kill(signal?: NodeJS.Signals) {
      try {
        child.kill(signal ?? "SIGTERM");
      } catch {
        /* no-op */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

export class AgentRunner {
  private readonly paths: Paths;
  private readonly config: Config;
  private readonly eventBus: EventBus;
  private readonly spawner: ProcessSpawner;
  private readonly nowFn: () => Date;

  constructor(deps: AgentRunnerDeps) {
    this.paths = deps.paths;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.spawner = deps.spawner ?? execaSpawner;
    this.nowFn = deps.now ?? (() => new Date());
  }

  async spawnAgent(args: SpawnArgs): Promise<Session> {
    const sessionId = args.sessionId ?? newId();
    const model = args.model ?? this.config.defaults.model;
    const thinkingMode = args.thinkingMode ?? this.config.defaults.thinkingMode;

    const prompt = await composePrompt({ paths: this.paths }, args);

    // Claude CLI rejects non-UUID session ids, so we mint a UUID specifically
    // for the subprocess and keep it around for the /context follow-up call.
    const claudeSessionId = newClaudeSessionId();

    const session: Session = {
      id: sessionId,
      taskId: args.taskId,
      stage: args.stage,
      provider: "claude-code",
      model,
      ...(thinkingMode ? { thinkingMode } : {}),
      skillName: args.skillName,
      prompt,
      status: "running",
      startedAt: this.nowFn().toISOString(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
      autocompacted: false,
      costUsd: 0,
      claudeSessionId,
      ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
    };

    this.eventBus.emit("session.started", { session: { ...session } });

    const argv = buildClaudeArgv({
      prompt,
      model,
      sessionId: claudeSessionId,
    });

    const jsonlPath = this.paths.sessionJsonl(args.taskId, sessionId);

    const proc = this.spawner({
      bin: "claude",
      args: argv,
      cwd: args.worktreePath,
    });

    // Drain stderr, keeping the last ~40 lines so failures surface a reason.
    const stderrTail: string[] = [];
    const STDERR_TAIL_MAX = 40;
    void (async () => {
      try {
        for await (const line of proc.stderr) {
          stderrTail.push(line);
          if (stderrTail.length > STDERR_TAIL_MAX) stderrTail.shift();
        }
      } catch {
        /* ignore */
      }
    })();

    const tokens = emptyTokens();
    let lastUpdateAt = 0;
    let blockedReason: string | null = null;
    let killed = false;

    const flushUpdate = (force: boolean): void => {
      const now = this.nowFn().getTime();
      if (!force && now - lastUpdateAt < UPDATE_THROTTLE_MS) return;
      lastUpdateAt = now;
      const total = totalTokens(tokens);
      session.tokens = { ...tokens, total };
      session.costUsd = costFor(this.config, model, session.tokens);
      this.eventBus.emit("session.updated", { session: { ...session } });
    };

    try {
      for await (const rawLine of proc.stdout) {
        const line = rawLine.trim();
        if (!line) continue;

        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          // Not a JSON line — ignore (Claude may emit diagnostic text on stderr
          // ordinarily, but be defensive on stdout too).
          continue;
        }

        // Persist the raw line first so on-disk truth survives any downstream error.
        try {
          await appendJsonl(jsonlPath, payload);
        } catch {
          /* ignore disk errors — don't tear down the session */
        }

        const kind = mapPayloadToEventKind(payload);
        const ts = extractTimestamp(payload, this.nowFn().toISOString());
        const event: SessionEvent = {
          sessionId,
          ts,
          kind,
          payload,
        };
        this.eventBus.emit("session.event", { event });

        if (isCompactBoundary(payload)) {
          session.autocompacted = true;
        }

        const tokensChanged = updateTokensFromPayload(tokens, payload);
        if (tokensChanged) flushUpdate(false);

        if (kind === "assistant_text") {
          const text = extractAssistantText(payload);
          const match = /^FLOW_BLOCKED:\s*(.+)$/m.exec(text);
          if (match && !blockedReason) {
            blockedReason = match[1]!.trim();
            const notification: Notification = {
              id: newId(),
              ...(args.taskId ? { taskId: args.taskId } : {}),
              sessionId,
              severity: "blocked",
              title: args.taskId
                ? `Task ${args.taskId} blocked at ${args.stage}`
                : `Session blocked at ${args.stage}`,
              body: `Agent reported: ${blockedReason}`,
              createdAt: this.nowFn().toISOString(),
              acknowledged: false,
            };
            this.eventBus.emit("notification", { notification });
            killed = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              /* ignore */
            }
            break;
          }
        }
      }
    } catch (err) {
      // Stream iteration failure — treat as a failed session below.
      session.error = `Stream error: ${(err as Error).message}`;
    }

    let exitCode = 0;
    try {
      exitCode = await proc.exit;
    } catch {
      exitCode = 1;
    }

    // Final flush regardless of throttle.
    session.tokens = { ...tokens, total: totalTokens(tokens) };
    session.costUsd = costFor(this.config, model, session.tokens);
    session.exitCode = exitCode;
    session.endedAt = this.nowFn().toISOString();

    if (blockedReason) {
      session.status = "failed";
      session.error = `FLOW_BLOCKED: ${blockedReason}`;
    } else if (exitCode !== 0) {
      session.status = "failed";
      if (!session.error) {
        const tail = stderrTail.join("\n").trim();
        session.error = tail
          ? `Claude exited with code ${exitCode}\n--- stderr ---\n${tail}`
          : `Claude exited with code ${exitCode}`;
      }
    } else if (session.autocompacted) {
      session.status = "autocompacted";
    } else {
      session.status = "succeeded";
    }

    // Post-run context probe — best-effort.
    if (session.status !== "failed" && !killed) {
      try {
        const pct = await this.probeContextPercentage(
          claudeSessionId,
          args.worktreePath,
          model,
        );
        if (typeof pct === "number") session.contextPercentage = pct;
      } catch {
        /* swallow — best-effort only */
      }
      // Re-emit update with context percentage if it changed.
      if (typeof session.contextPercentage === "number") {
        this.eventBus.emit("session.updated", { session: { ...session } });
      }
    }

    try {
      await writeJsonAtomic(
        this.paths.sessionMeta(args.taskId, sessionId),
        session,
      );
    } catch {
      /* ignore meta write errors */
    }

    this.eventBus.emit("session.ended", { session: { ...session } });
    return { ...session };
  }

  private async probeContextPercentage(
    sessionId: string,
    cwd: string,
    model: string,
  ): Promise<number | undefined> {
    const proc = this.spawner({
      bin: "claude",
      args: [
        "-p",
        "/context",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--session-id",
        sessionId,
      ],
      cwd,
    });

    // Consume stderr to keep the pipe flowing.
    void (async () => {
      try {
        for await (const _l of proc.stderr) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    let pct: number | undefined;
    try {
      for await (const raw of proc.stdout) {
        const line = raw.trim();
        if (!line) continue;
        const match = /(\d+(?:\.\d+)?)\s*%/.exec(line);
        if (match) {
          const n = Number(match[1]);
          if (Number.isFinite(n) && n >= 0 && n <= 100) {
            pct = n;
          }
        }
      }
    } catch {
      /* ignore */
    }

    try {
      await proc.exit;
    } catch {
      /* ignore */
    }

    return pct;
  }
}

// ---------------------------------------------------------------------------
// argv construction — spec §8
// ---------------------------------------------------------------------------

export function buildClaudeArgv(opts: {
  prompt: string;
  model: string;
  sessionId?: string;
}): string[] {
  const argv = [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (opts.sessionId) {
    argv.push("--session-id", opts.sessionId);
  }
  return argv;
}

// Satisfy verbatimModuleSyntax/isolatedModules by re-exporting path if
// downstream ever needs the default reader.
export const _internal = { path };
