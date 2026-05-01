import { promises as fs } from "node:fs";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { execa, type ExecaError, type ResultPromise } from "execa";

import { Paths } from "./paths.js";
import { EventBus } from "./events.js";
import { costFor, resolveEffort, resolveStageConfig } from "./config.js";
import { newClaudeSessionId, newId } from "./ids.js";
import { appendJsonl, writeJsonAtomic } from "./atomic.js";
import type {
  Config,
  Effort,
  Notification,
  Session,
  SessionEvent,
  SessionEventKind,
  StageKey,
  SurplusChild,
  TaskDef,
  ThinkingMode,
} from "./types.js";

const execAsync = promisify(execCallback);

export interface SpawnArgs {
  taskId: string | null;
  stage: Session["stage"];
  skillName: string;
  model?: string;
  thinkingMode?: ThinkingMode;
  effort?: Effort;
  extraPrompt?: string;
  worktreePath: string;
  parentSessionId?: string;
  contextFiles?: string[];
  task?: TaskDef;
  sessionId?: string;
  /** UI grouping ordinal — auto-computed from prior sessions if omitted. */
  ordinal?: number;
  /** UI-Review round number (1-based) — supplied by the scheduler when
   *  spawning `exec_ui_check`. Used to derive the round-N issues file path
   *  injected into the prompt. */
  uiReviewRound?: number;
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
  /** OS PID of the spawned process, if available. Used by the end-of-session
   *  process-tree probe (`pgrep -P pid`) to record any surviving children. */
  readonly pid?: number;
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

// Approximate max-context tokens used to convert per-message `usage` totals
// into a percentage. Mirrors the hardcoded 200k in `web/src/store.js`. Per-
// model windows (Opus 1M, etc.) are intentionally out of scope here.
const DEFAULT_CONTEXT_MAX = 200_000;

// Grace window after a child process exits before we force its stdio streams
// shut. Claude spawns MCP-server grandchildren that inherit the stdout/stderr
// pipe FDs; they can keep the pipe open indefinitely after the direct child
// exits, stalling both the stdout `for await` loop and execa's exit promise
// (which waits for stdio close). See `execaSpawner`.
const STDIO_DRAIN_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Prompt composition (exported for tests)
// ---------------------------------------------------------------------------

/** Stages where the agent is doing actual work in the task's worktree —
 *  these all get the termination + stage-signal preamble.
 *  Project-level stages (setup, get-tasks) do not commit or signal. */
const TASK_AGENT_STAGES = new Set<string>([
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
  "update-learning",
  "merge-resolve",
  "commit_recovery",
]);

/** Subset of TASK_AGENT_STAGES that actually authors a commit. The protocol's
 *  "commit your changes" step is included only for these. Stages excluded:
 *  - `merge-resolve` / `update-learning`: skill bodies explicitly forbid commits
 *    (the orchestrator finalizes those).
 *  - `commit_recovery`: the `commit` skill body itself drives `git add -A &&
 *    git commit`, so the protocol step would be redundant. */
const COMMITTING_STAGES = new Set<string>([
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
]);

/** Stages that produce content for the per-task `learnings-draft.md`.
 *  `update-learning` consolidates the draft (Part A) so it is excluded;
 *  merge-resolve / commit_recovery do not produce learnings. */
const LEARNINGS_DRAFT_STAGES = new Set<string>([
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
]);

const THINKING_KEYWORD: Record<ThinkingMode, string> = {
  off: "",
  think: "Use the `think` thinking budget for this turn.",
  megathink: "Use the `megathink` thinking budget for this turn.",
  ultrathink: "Use the `ultrathink` thinking budget for this turn.",
};

export class MissingSkillError extends Error {
  readonly skillName: string;
  readonly skillPath: string;
  constructor(skillName: string, skillPath: string) {
    super(
      `Skill "${skillName}" not found at ${skillPath}. Ensure .flow/skills/${skillName}/SKILL.md exists.`,
    );
    this.name = "MissingSkillError";
    this.skillName = skillName;
    this.skillPath = skillPath;
  }
}

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
    throw new MissingSkillError(args.skillName, skillPath);
  }
  const sections: string[] = [`@${skillPath}`];

  // Optional thinking-budget hint, derived from the resolved effort tier.
  if (args.thinkingMode && args.thinkingMode !== "off") {
    const hint = THINKING_KEYWORD[args.thinkingMode];
    if (hint) sections.push(hint);
  }

  // Inject project-level `instructions.md` for every stage except setup
  // (which authors the file). Bootstrap-safe: skip silently when the file
  // doesn't exist yet so a fresh project's first setup run still works.
  if (args.stage !== "setup") {
    const instructionsPath = deps.paths.instructionsMd;
    try {
      await fs.access(instructionsPath);
      sections.push(`# Project instructions\n@${instructionsPath}`);
    } catch {
      /* not created yet — first setup run hasn't completed */
    }
  }

  const task = args.task;
  if (task) {
    const title = (task.title ?? "").trim();
    const desc = (task.description ?? "").trim();
    const heading = title || task.id;
    const body = desc ? `${heading}\n\n${desc}` : heading;
    sections.push(`# Task\n${body}`);
  }

  if (args.taskId && deps.paths) {
    const summaryPath = deps.paths.taskSummary(args.taskId);
    const screenshotsDir = deps.paths.taskScreenshotsDir(args.taskId);
    const progressPath = deps.paths.taskProgressTxt(args.taskId);
    const stageSignalPath = deps.paths.taskStageSignal(args.taskId);
    const learningsDraftPath = deps.paths.taskLearningsDraft(args.taskId);
    const runtimeLines = [
      "# Runtime paths",
      `cwd (worktree):    ${args.worktreePath}`,
      `summary.md:        ${summaryPath}`,
      `progress.txt:      ${progressPath}`,
      `learnings-draft:   ${learningsDraftPath}`,
      `screenshots:       ${screenshotsDir}`,
      `stage signal:      ${stageSignalPath}`,
    ];
    if (
      args.stage === "exec_ui_check" &&
      typeof args.uiReviewRound === "number"
    ) {
      const roundFile = deps.paths.taskRoundIssues(
        args.taskId,
        args.uiReviewRound,
      );
      runtimeLines.push(
        `round issues file: ${roundFile}`,
        `ui-review round:   ${args.uiReviewRound}`,
      );
    }
    // update-learning may promote learnings into Flow's project skills
    // dir at the project root (outside the worktree). Hand it the absolute
    // path so the agent doesn't try to resolve `.flow/skills/` relative to
    // the worktree's cwd.
    if (args.stage === "update-learning") {
      runtimeLines.push(`project skills dir: ${deps.paths.skillsDir}`);
    }
    runtimeLines.push(
      "Edit only files inside cwd (except `learnings-draft.md` and the",
      "stage signal, which live outside the worktree). Wherever the skill",
      `mentions \`<taskId>\`, substitute "${args.taskId}".`,
    );
    sections.push(runtimeLines.join("\n"));

    // Surface progress.txt as a context file so each stage sees prior notes.
    sections.push(`# Progress notes\n@${progressPath}`);
  }

  const ctx = args.contextFiles ?? [];
  if (ctx.length > 0) {
    const lines = ["# Context files", ...ctx.map((p) => `@${p}`)];
    sections.push(lines.join("\n"));
  }

  const extra = (args.extraPrompt ?? "").trim();
  if (extra) {
    sections.push(`# Prior session summaries / addendum\n${extra}`);
  }

  if (args.taskId && LEARNINGS_DRAFT_STAGES.has(args.stage as string)) {
    sections.push(
      [
        "# Learnings draft",
        "After completing the stage, append to `learnings-draft.md` (path in",
        "the **Runtime paths** block) ONLY IF this session surfaced something",
        "a future agent on this codebase would benefit from knowing.",
        "",
        "Append when:",
        "- You hit an error or surprising failure a future agent should avoid.",
        "- You discovered a tool quirk, flag, path, or version constraint that",
        "  was not documented.",
        "- You deviated from the obvious approach and the reason isn't visible",
        "  in the diff.",
        "- You learned a project invariant or convention not in CLAUDE.md.",
        "",
        "Do NOT write:",
        "- Lists of doc files updated or \"docs updated\" sentences.",
        "- Restatements of the task description.",
        "- Anything already visible in the diff or git history.",
        "- Session logs (progress.txt and summary.md handle those).",
        "",
        "An empty draft is the correct outcome when nothing surprising came up.",
        "",
        "Format each entry as:",
        "    ## <tool or topic>",
        "    - <one-sentence lesson title>: <2-3 sentence explanation: what,",
        "      when, why, and what to do differently>",
      ].join("\n"),
    );
  }

  if (args.taskId && TASK_AGENT_STAGES.has(args.stage as string)) {
    const stageSignalPath = deps.paths.taskStageSignal(args.taskId);
    const progressPath = deps.paths.taskProgressTxt(args.taskId);
    const isCommitting = COMMITTING_STAGES.has(args.stage as string);
    const lines: string[] = [
      "# Stage protocol",
      "1. Read `progress.txt` first; append any meaningful context or extremely concise progress notes.",
      "2. Do exactly the work this stage's skill requires — no adjacent cleanup.",
    ];
    if (isCommitting) {
      lines.push(
        "3. When the acceptance checks for this stage pass, commit your changes:",
        '   `git add -A && git commit -m "<imperative subject ≤72 chars>"`.',
        "   Body bullets describing each meaningful change are encouraged.",
        "   Untracked files alone don't block the stage, but still `git add -A && git commit` to capture any legitimate new tracked work.",
      );
    }
    const signalStepNum = isCommitting ? 4 : 3;
    lines.push(
      `${signalStepNum}. Write the stage signal and stop:`,
      `   echo '{"stage":"${args.stage}","status":"done"}' > ${stageSignalPath}`,
      '   (use `"status":"blocked","reason":"…"` instead if you cannot proceed).',
      `   progress.txt: ${progressPath}`,
      "",
      "If you complete the stage but want a human to audit a specific",
      "decision before it ships, emit a single line on stdout in addition",
      "to the stage signal:",
      "   `FLOW_REVIEW_REQUESTED: <one-sentence reason>`",
      "This surfaces a warn-level notification without halting the queue.",
      "Reserve `FLOW_BLOCKED:` for cases where you cannot proceed at all.",
    );
    sections.push(lines.join("\n"));
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
      changed =
        applyUsageObject(acc, usage as Record<string, unknown>) || changed;
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

/**
 * Returns input + cache_read + cache_creation for the most recent `usage`
 * object found in `payload` (document order), or `undefined` if none. This
 * approximates the model's current context occupancy at the moment the
 * message was produced. Unlike `updateTokensFromPayload`, this does NOT
 * accumulate across messages — sum-of-maxes overestimates because the
 * peaks for input / cache_read / cache_creation can fall on different turns.
 */
function extractCurrentContextTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const visited = new WeakSet<object>();
  let last: number | undefined;

  const readUsage = (obj: Record<string, unknown>): number | undefined => {
    const input = obj["input_tokens"];
    const cacheRead = obj["cache_read_input_tokens"];
    const cacheCreate = obj["cache_creation_input_tokens"];
    let total = 0;
    let any = false;
    if (typeof input === "number" && Number.isFinite(input)) {
      total += input;
      any = true;
    }
    if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) {
      total += cacheRead;
      any = true;
    }
    if (typeof cacheCreate === "number" && Number.isFinite(cacheCreate)) {
      total += cacheCreate;
      any = true;
    }
    return any ? total : undefined;
  };

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (visited.has(obj)) return;
    visited.add(obj);

    const usage = obj["usage"];
    if (usage && typeof usage === "object") {
      const v = readUsage(usage as Record<string, unknown>);
      if (typeof v === "number") last = v;
    }
    if (
      "input_tokens" in obj ||
      "cache_read_input_tokens" in obj ||
      "cache_creation_input_tokens" in obj
    ) {
      const v = readUsage(obj);
      if (typeof v === "number") last = v;
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v);
    }
  };

  walk(payload);
  return last;
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

/** Yield each `tool_use` block found in an event payload. Bash invocations
 *  may arrive either as a top-level `{type:"tool_use"}` event or embedded as
 *  a content block on an `assistant` event. */
function* iterToolUseBlocks(
  payload: unknown,
): Generator<{ name: string; input: unknown }> {
  if (!payload || typeof payload !== "object") return;
  const obj = payload as Record<string, unknown>;
  const visit = function* (
    block: unknown,
  ): Generator<{ name: string; input: unknown }> {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_use") {
      const name = typeof b["name"] === "string" ? (b["name"] as string) : "";
      yield { name, input: b["input"] };
    }
  };
  if (obj["type"] === "tool_use") {
    const name = typeof obj["name"] === "string" ? (obj["name"] as string) : "";
    yield { name, input: obj["input"] };
  }
  const message = obj["message"];
  if (message && typeof message === "object") {
    const c = (message as Record<string, unknown>)["content"];
    if (Array.isArray(c)) for (const b of c) yield* visit(b);
  }
  const c = obj["content"];
  if (Array.isArray(c)) for (const b of c) yield* visit(b);
}

/** Pull the Bash `command` string out of a tool_use input. Returns null for
 *  non-Bash tools or malformed inputs. The CLI emits `Bash` (capitalized);
 *  match case-insensitively to be defensive against future changes. */
function extractBashCommandFromBlock(block: {
  name: string;
  input: unknown;
}): string | null {
  if (block.name.toLowerCase() !== "bash") return null;
  if (!block.input || typeof block.input !== "object") return null;
  const cmd = (block.input as Record<string, unknown>)["command"];
  return typeof cmd === "string" ? cmd : null;
}

/** True if `error` is the non-retryable repeat-tool-call sentinel. */
export function isLoopedOnBlockedTool(err: string | undefined): boolean {
  return !!err && err.trimStart().startsWith("looped_on_blocked_tool:");
}

function isNonEmptyToolResultContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some((c) => {
      if (!c || typeof c !== "object") return false;
      const cc = c as Record<string, unknown>;
      if (typeof cc["text"] === "string") {
        return (cc["text"] as string).trim().length > 0;
      }
      return Object.keys(cc).length > 0;
    });
  }
  return false;
}

function someToolResultBlock(
  payload: unknown,
  predicate: (block: Record<string, unknown>) => boolean,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  const matches = (block: unknown): boolean => {
    if (!block || typeof block !== "object") return false;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "tool_result") return false;
    return predicate(b);
  };
  const message = obj["message"];
  if (message && typeof message === "object") {
    const c = (message as Record<string, unknown>)["content"];
    if (Array.isArray(c) && c.some(matches)) return true;
  }
  const c = obj["content"];
  if (Array.isArray(c) && c.some(matches)) return true;
  return false;
}

/** Best-effort: returns true if the payload carries a non-empty `tool_result`
 *  block. Used by the wall-clock stall watchdog so that a hung child tool
 *  (which never produces output) is not treated as progress. Deliberately
 *  permissive — error content (stack traces, etc.) still counts as bytes
 *  flowing, which is what the stall detector cares about. */
function hasNonEmptyToolResult(payload: unknown): boolean {
  return someToolResultBlock(payload, (b) =>
    isNonEmptyToolResultContent(b["content"]),
  );
}

/** Stricter sibling of `hasNonEmptyToolResult`: also rejects blocks marked
 *  `is_error: true`. Used by the consecutive-repeat watchdog (rule B): a
 *  previous run that produced meaningful, non-error output is treated as a
 *  successful result, so re-running the same command is a fresh legitimate
 *  call rather than a stuck loop. */
function hasGoodToolResult(payload: unknown): boolean {
  return someToolResultBlock(
    payload,
    (b) => b["is_error"] !== true && isNonEmptyToolResultContent(b["content"]),
  );
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

/** Read `rate_limit_info` off a `rate_limit_event` payload. The Claude
 *  stream-json format puts the info either at the top level or nested under
 *  `message`, so we accept both. */
export function extractRateLimitInfo(
  payload: Record<string, unknown> | null | undefined,
): { resetsAt?: number; rateLimitType?: string } | null {
  if (!payload) return null;
  const candidates: unknown[] = [
    payload["rate_limit_info"],
    (payload["message"] as Record<string, unknown> | undefined)?.[
      "rate_limit_info"
    ],
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const info = raw as Record<string, unknown>;
    const out: { resetsAt?: number; rateLimitType?: string } = {};
    if (typeof info["resetsAt"] === "number") {
      out.resetsAt = info["resetsAt"] as number;
    }
    if (typeof info["rateLimitType"] === "string") {
      out.rateLimitType = info["rateLimitType"] as string;
    }
    if (out.resetsAt !== undefined || out.rateLimitType !== undefined) {
      return out;
    }
  }
  return null;
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
    // Put the child in its own process group so a single signal to -pid
    // reaps the agent + its MCP grandchildren together. See `kill` below.
    detached: true,
  });

  // Force-close stdio after the grace window — see STDIO_DRAIN_GRACE_MS.
  child.on("exit", () => {
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, STDIO_DRAIN_GRACE_MS).unref();
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
      const sig = signal ?? "SIGTERM";
      // Group-kill: -pid signals every process in the child's process group
      // (the agent + any MCP grandchildren). Falls back to a direct child
      // signal if pid is unavailable or the group is already gone.
      const pid = child.pid;
      if (typeof pid === "number") {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          /* fall through to direct child kill */
        }
      }
      try {
        child.kill(sig);
      } catch {
        /* no-op */
      }
    },
    pid: child.pid,
  };
}

// ---------------------------------------------------------------------------
// E3 — process-tree probe at session end
// ---------------------------------------------------------------------------

/** Run `pgrep -P <pid> -l` and parse any surviving children. Returns [] when
 *  there are no children, when `pgrep` is missing, or on any other error —
 *  this is forensic-only and must never tear down a session. */
export async function probeSurplusChildren(
  pid: number,
): Promise<SurplusChild[]> {
  let stdout = "";
  try {
    const result = await execAsync(`pgrep -P ${pid} -l`, { timeout: 2000 });
    stdout = (result.stdout ?? "").toString();
  } catch (err) {
    // pgrep exits 1 when no processes match; execAsync rejects in that case
    // but the rejection still carries stdout (which is empty). Anything else
    // (ENOENT for missing binary, ETIMEDOUT, signal) we just swallow.
    const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer };
    if (e.stdout != null) {
      stdout = typeof e.stdout === "string" ? e.stdout : e.stdout.toString();
    } else {
      return [];
    }
  }
  const out: SurplusChild[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // `pgrep -l` formats as "<pid> <name>".
    const m = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const childPid = Number(m[1]);
    const name = (m[2] ?? "").trim();
    if (Number.isFinite(childPid) && childPid > 0 && name.length > 0) {
      out.push({ pid: childPid, name });
    }
  }
  return out;
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
  /** Per-(taskId, stage) running count of sessions spawned so the UI can
   *  group repeated runs as "T — exec — 1", "T — exec — 2", etc. */
  private readonly ordinalCounters = new Map<string, number>();
  /** Currently-live spawned processes. Registered on spawn and removed when
   *  the child exits. Used by `killAllLive` so the SIGINT path can reap any
   *  in-flight agent + its MCP grandchildren before exiting. */
  private readonly liveProcs = new Set<SpawnedProcess>();

  constructor(deps: AgentRunnerDeps) {
    this.paths = deps.paths;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.spawner = deps.spawner ?? execaSpawner;
    this.nowFn = deps.now ?? (() => new Date());
  }

  private computeOrdinal(taskId: string | null, stage: string): number {
    const key = `${taskId ?? "_proj"}:${stage}`;
    const next = (this.ordinalCounters.get(key) ?? 0) + 1;
    this.ordinalCounters.set(key, next);
    return next;
  }

  /** Send `signal` to every currently-live spawned process, then wait up
   *  to `graceMs` for clean exit and SIGKILL any stragglers. The default
   *  spawner uses `detached: true` and group-kill, so a single SIGTERM here
   *  reaps each agent + its MCP grandchildren. Used by the SIGINT shutdown
   *  path; safe to call when nothing is live (no-op). */
  async killAllLive(
    signal: NodeJS.Signals = "SIGTERM",
    graceMs = 1500,
  ): Promise<void> {
    const procs = Array.from(this.liveProcs);
    if (procs.length === 0) return;
    for (const proc of procs) {
      try {
        proc.kill(signal);
      } catch {
        /* ignore — best-effort */
      }
    }
    // Wait up to graceMs for clean exits, then escalate. Procs that exit
    // cleanly are auto-removed from liveProcs by the spawn-site .finally,
    // so anything still in the set after the race is a straggler.
    await Promise.race([
      Promise.allSettled(procs.map((p) => p.exit)),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, graceMs);
        t.unref?.();
      }),
    ]);
    for (const proc of this.liveProcs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore — best-effort */
      }
    }
  }

  async spawnAgent(args: SpawnArgs): Promise<Session> {
    const sessionId = args.sessionId ?? newId();

    // Resolve per-stage model + effort. Caller can override either explicitly.
    const stageKey = args.stage as StageKey;
    const stageCfg = resolveStageConfig(this.config, stageKey);
    const model = args.model ?? stageCfg.model ?? this.config.defaults.model;
    const effort =
      args.effort ?? stageCfg.effort ?? this.config.defaults.effort;
    const resolved = resolveEffort(model, effort);
    const thinkingMode =
      args.thinkingMode ??
      resolved.thinkingMode ??
      this.config.defaults.thinkingMode;

    const ordinal =
      args.ordinal ?? this.computeOrdinal(args.taskId, args.stage as string);

    const promptArgs: SpawnArgs = {
      ...args,
      model,
      effort,
      ...(thinkingMode ? { thinkingMode } : {}),
      ordinal,
    };
    const prompt = await composePrompt({ paths: this.paths }, promptArgs);

    // Claude CLI rejects non-UUID session ids, so we mint a UUID specifically
    // for the subprocess and keep it around for the /context follow-up call.
    const claudeSessionId = newClaudeSessionId();

    const session: Session = {
      id: sessionId,
      taskId: args.taskId,
      stage: args.stage,
      provider: "claude-code",
      model,
      effort,
      ordinal,
      ...(thinkingMode ? { thinkingMode } : {}),
      skillName: args.skillName,
      prompt,
      status: "running",
      startedAt: this.nowFn().toISOString(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
      autocompacted: false,
      costUsd: 0,
      claudeSessionId,
      ...(args.parentSessionId
        ? { parentSessionId: args.parentSessionId }
        : {}),
    };

    this.eventBus.emit("session.started", { session: { ...session } });

    // Persist a partial `.meta.json` so a mid-session crash leaves enough
    // forensic state (id, taskId, stage, startedAt) to reconstruct what the
    // session was attempting. Awaited so it can't race with the final write.
    try {
      await writeJsonAtomic(
        this.paths.sessionMeta(args.taskId, sessionId),
        session,
      );
    } catch {
      /* ignore meta write errors */
    }

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
    this.liveProcs.add(proc);
    void proc.exit.finally(() => this.liveProcs.delete(proc));

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
    let observedInStream = false;
    let blockedReason: string | null = null;
    let reviewRequestedReason: string | null = null;
    let killed = false;
    let consecutiveRetries = 0;
    let stale = false;
    let cliErrorResult: string | null = null;

    // Watchdog state — see E1/E2 in the GUI-stall plan.
    const stallTimeoutMs =
      stageCfg.stallTimeoutMs ?? this.config.stallTimeoutMs;
    const repeatToolCallCap =
      stageCfg.repeatToolCallCap ?? this.config.repeatToolCallCap;
    let stallTimer: NodeJS.Timeout | null = null;
    let stalledByWatchdog = false;
    let sawRateLimitEvent = false;
    let loopedToolKey: string | null = null;
    let loopedToolCount = 0;
    // E2 watchdog state — see the rewrite at the tool_use loop below for the
    // full rule. We only need to track the most recent tool key, the current
    // consecutive-streak count for that key, and whether the previous run of
    // that key produced a non-empty, non-error tool_result.
    let lastToolKey: string | null = null;
    let lastToolCount = 0;
    let lastResultWasGood = false;

    const armStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalledByWatchdog = true;
        killed = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, stallTimeoutMs);
      // Don't keep the event loop alive solely on this timer.
      stallTimer.unref?.();
    };
    const bumpProgress = (): void => armStallTimer();
    armStallTimer();

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

        const payloadObj =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : null;
        const payloadType = payloadObj?.["type"];
        const payloadSubtype = payloadObj?.["subtype"];

        if (payloadType === "system" && payloadSubtype === "api_retry") {
          consecutiveRetries += 1;
          if (consecutiveRetries >= this.config.maxConsecutiveApiRetries) {
            stale = true;
            killed = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              /* ignore */
            }
            break;
          }
        } else if (
          payloadType === "stream_event" ||
          payloadType === "assistant" ||
          payloadType === "user" ||
          payloadType === "tool_use" ||
          payloadType === "tool_result"
        ) {
          consecutiveRetries = 0;
        }

        if (payloadType === "rate_limit_event") {
          sawRateLimitEvent = true;
          const info = extractRateLimitInfo(payloadObj);
          if (info) {
            if (typeof info.resetsAt === "number") {
              session.rateLimitResetsAt = info.resetsAt;
            }
            if (typeof info.rateLimitType === "string") {
              session.rateLimitType = info.rateLimitType;
            }
          }
        }

        // E1: wall-clock progress watchdog. Assistant text, non-empty tool_result,
        // and Task-subagent progress frames count as activity. Tool_use bookkeeping
        // and thinking frames don't — they can fire continuously while a child is
        // hung on a GUI modal. Task subagents don't surface their inner stream on
        // the parent process; only `system.task_progress` / `system.task_updated`
        // frames mark forward motion, so they must refresh the timer too.
        if (kind === "assistant_text") {
          const txt = extractAssistantText(payload).trim();
          if (txt.length > 0) bumpProgress();
        } else if (kind === "tool_result") {
          if (hasNonEmptyToolResult(payload)) bumpProgress();
        } else if (
          payloadType === "system" &&
          (payloadSubtype === "task_progress" ||
            payloadSubtype === "task_updated")
        ) {
          bumpProgress();
        }

        // E2: consecutive-repeat cap, outcome-aware. The cap fires only when
        // the same Bash command is re-issued back-to-back AND no intervening
        // run produced a non-empty, non-error tool_result. This catches a
        // genuinely stuck loop (agent retries the same failing command with
        // nothing changing) without punishing healthy iterative work like
        // re-running `git status` after `git add`, `npm test` after a fix,
        // or polling commands that return useful output.
        //
        // Rules:
        //   A. Different tool_use key resets the streak (any non-Bash tool
        //      counts as "different" too — otherwise interleaved Read/Edit
        //      calls don't break a Bash:X streak).
        //   B. Same key but the prior run produced a good (non-empty,
        //      non-error) tool_result resets the streak.
        //   Else: increment, and if the streak hits the cap, kill — but
        //   only Bash blocks may trip the cap (matches the prior contract).
        //
        // Order matters: process tool_results from this payload first, so
        // rule B sees the latest outcome before any tool_use in the same
        // payload is classified.
        if (lastToolKey !== null && hasGoodToolResult(payload)) {
          lastResultWasGood = true;
        }

        let cappedThisIter = false;
        for (const block of iterToolUseBlocks(payload)) {
          const cmd = extractBashCommandFromBlock(block);
          const isBash = cmd !== null;
          const key = isBash ? `Bash:${cmd}` : `non-bash:${block.name}`;

          if (key !== lastToolKey || lastResultWasGood) {
            lastToolCount = 1;
          } else {
            lastToolCount += 1;
          }
          lastToolKey = key;
          lastResultWasGood = false;

          if (isBash && lastToolCount >= repeatToolCallCap) {
            loopedToolKey = cmd;
            loopedToolCount = lastToolCount;
            killed = true;
            cappedThisIter = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              /* ignore */
            }
            break;
          }
        }
        if (cappedThisIter) break;

        if (
          payloadType === "result" &&
          payloadObj?.["is_error"] === true &&
          typeof payloadObj["result"] === "string"
        ) {
          cliErrorResult = payloadObj["result"] as string;
        }

        if (isCompactBoundary(payload)) {
          session.autocompacted = true;
        }

        const tokensChanged = updateTokensFromPayload(tokens, payload);

        // Live context-percentage update: per-message `usage` already arrives
        // in the mid-run stream, so populate the donut continuously. The
        // post-run probe only fires as a fallback when this never observed a
        // usage event. Combined with the tokens flush below so both updates
        // land in the same throttled session.updated snapshot.
        let contextChanged = false;
        const ctxTokens = extractCurrentContextTokens(payload);
        if (typeof ctxTokens === "number") {
          observedInStream = true;
          const pct = Math.min(
            100,
            Math.round((ctxTokens / DEFAULT_CONTEXT_MAX) * 100),
          );
          if (pct !== session.contextPercentage) {
            session.contextPercentage = pct;
            contextChanged = true;
          }
        }

        if (tokensChanged || contextChanged) flushUpdate(false);

        if (kind === "assistant_text") {
          const text = extractAssistantText(payload);
          const blocked = /^FLOW_BLOCKED:\s*(.+)$/m.exec(text);
          if (blocked && !blockedReason) {
            blockedReason = blocked[1]!.trim();
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
          // FLOW_REVIEW_REQUESTED is the "I did this but you should look"
          // middle tier between auto-resolve and FLOW_BLOCKED. The session
          // continues — the agent has already done useful work — but a
          // warn-level notification surfaces the concern in the UI so a
          // human can audit without halting the queue.
          const review = /^FLOW_REVIEW_REQUESTED:\s*(.+)$/m.exec(text);
          if (review && !reviewRequestedReason) {
            reviewRequestedReason = review[1]!.trim();
            const notification: Notification = {
              id: newId(),
              ...(args.taskId ? { taskId: args.taskId } : {}),
              sessionId,
              severity: "warn",
              title: args.taskId
                ? `Task ${args.taskId} review requested at ${args.stage}`
                : `Session review requested at ${args.stage}`,
              body: `Agent requested review: ${reviewRequestedReason}`,
              createdAt: this.nowFn().toISOString(),
              acknowledged: false,
            };
            this.eventBus.emit("notification", { notification });
          }
        }

        // If the wall-clock watchdog already fired, exit the loop promptly so
        // we don't keep draining late-arriving events from the dying child.
        if (stalledByWatchdog) break;
      }
    } catch (err) {
      // Stream iteration failure — treat as a failed session below.
      session.error = `Stream error: ${(err as Error).message}`;
      session.transientError = true;
      session.errorKind = "agent_error";
    } finally {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
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
    } else if (loopedToolKey !== null) {
      // E2: non-retryable. Scheduler treats `looped_on_blocked_tool:` as
      // markPaused-immediately (see isLoopedOnBlockedTool).
      session.status = "failed";
      const truncated =
        loopedToolKey.length > 80
          ? `${loopedToolKey.slice(0, 80)}…`
          : loopedToolKey;
      session.error = `looped_on_blocked_tool: agent re-issued the same Bash command ${loopedToolCount} times consecutively with no successful intervening result: ${truncated}`;
      session.errorKind = "looped_tool";
    } else if (stalledByWatchdog) {
      // E1: wall-clock stall. Treated as a normal stage failure (consumes a
      // retry slot) — except when the session also saw a rate_limit_event,
      // in which case the stall is almost certainly an upstream backoff
      // window and should ride the transient-retry path so it doesn't burn
      // a regular retry slot.
      session.status = "failed";
      session.error = `Stall: no assistant progress for ${stallTimeoutMs}ms`;
      if (sawRateLimitEvent) {
        session.transientError = true;
        session.errorKind = "rate_limit";
      } else {
        session.errorKind = "stall";
      }
    } else if (stale) {
      session.status = "failed";
      session.error = `Session stale: ${consecutiveRetries} consecutive api_retry events with no progress`;
      session.transientError = true;
      session.errorKind = "agent_error";
    } else if (exitCode !== 0) {
      session.status = "failed";
      if (!session.error) {
        if (cliErrorResult) {
          session.error = cliErrorResult;
        } else {
          const tail = stderrTail.join("\n").trim();
          session.error = tail
            ? `Claude exited with code ${exitCode}\n--- stderr ---\n${tail}`
            : `Claude exited with code ${exitCode}`;
        }
      }
      if (!session.errorKind) session.errorKind = "agent_error";
    } else if (cliErrorResult) {
      session.status = "failed";
      if (!session.error) session.error = cliErrorResult;
      if (!session.errorKind) session.errorKind = "agent_error";
    } else if (session.autocompacted) {
      session.status = "autocompacted";
    } else {
      session.status = "succeeded";
    }

    // Surface FLOW_REVIEW_REQUESTED to the scheduler so it can persist a
    // warn-level notification (the in-stream notification above is real-time
    // only — not stored). Recorded regardless of final status so a session
    // that emitted the signal mid-stream and then errored still gets the
    // audit flag.
    if (reviewRequestedReason) {
      session.reviewRequested = { reason: reviewRequestedReason };
    }

    // Post-run context probe — fallback only when the in-stream path never
    // observed a `usage` event (e.g. the run errored before the first
    // assistant turn). The mid-run loop already populates contextPercentage
    // in the common case, so skip the extra subprocess and ping cost.
    if (session.status !== "failed" && !killed && !observedInStream) {
      try {
        const pct = await this.probeContextPercentage(
          claudeSessionId,
          args.worktreePath,
          model,
        );
        if (typeof pct === "number") {
          session.contextPercentage = pct;
          this.eventBus.emit("session.updated", { session: { ...session } });
        }
      } catch (err) {
        console.warn(
          `[probeContext] fallback probe threw for ${claudeSessionId}:`,
          err,
        );
      }
    }

    // E3: forensic process-tree probe. If the claude child left grandchildren
    // alive (common when a GUI subprocess like Godot was spawned without the
    // right headless flags), record them in the session meta so an audit can
    // see what was leaked. Don't kill — just record.
    if (typeof proc.pid === "number" && proc.pid > 0) {
      try {
        const surplus = await probeSurplusChildren(proc.pid);
        if (surplus.length > 0) session.surplus_children = surplus;
      } catch {
        /* pgrep absent or errored — silently skip */
      }
    }

    if (session.id !== sessionId) {
      throw new Error(
        `session id drift: expected "${sessionId}", got "${String(session.id)}"`,
      );
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
    // Resume the existing session with a benign no-op prompt and ask for a
    // single JSON response. The `.usage` block on that response reports
    // current per-message context tokens, which we convert to a percentage
    // against `DEFAULT_CONTEXT_MAX`. Note: `--resume` (not `--session-id`) —
    // the latter would create a new session with that id rather than
    // attaching to the accumulated context.
    const proc = this.spawner({
      bin: "claude",
      args: [
        "-p",
        "ping",
        "--resume",
        sessionId,
        "--model",
        model,
        "--output-format",
        "json",
      ],
      cwd,
    });
    this.liveProcs.add(proc);
    void proc.exit.finally(() => this.liveProcs.delete(proc));

    // 10s safety timeout so a hung probe never blocks session teardown.
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 10_000);
    timeout.unref?.();

    // Drain stderr, keeping a short tail for diagnostics.
    const stderrTail: string[] = [];
    void (async () => {
      try {
        for await (const l of proc.stderr) {
          stderrTail.push(l);
          if (stderrTail.length > 10) stderrTail.shift();
        }
      } catch {
        /* ignore */
      }
    })();

    const chunks: string[] = [];
    try {
      for await (const raw of proc.stdout) chunks.push(raw);
    } catch (err) {
      console.warn(
        `[probeContext] stdout read failed for session ${sessionId}:`,
        err,
      );
    }

    try {
      await proc.exit;
    } catch (err) {
      console.warn(
        `[probeContext] proc.exit rejected for session ${sessionId}:`,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = chunks.join("").trim();
    if (!text) {
      console.warn(
        `[probeContext] empty stdout for session ${sessionId} (stderr tail: ${stderrTail.join(" | ").slice(0, 200)})`,
      );
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(
        `[probeContext] non-JSON stdout for session ${sessionId}:`,
        text.slice(0, 200),
      );
      return undefined;
    }
    const ctx = extractCurrentContextTokens(parsed);
    if (typeof ctx !== "number") {
      console.warn(
        `[probeContext] no usage in JSON response for session ${sessionId}`,
      );
      return undefined;
    }
    return Math.min(100, Math.round((ctx / DEFAULT_CONTEXT_MAX) * 100));
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
