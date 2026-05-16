import { promises as fs } from "node:fs";
import { execa, type ExecaError, type ResultPromise } from "execa";

import { Paths } from "./paths.js";
import { resolvePhaseConfig } from "./config.js";
import { newClaudeSessionId, newId } from "./ids.js";
import { appendJsonl, writeJsonAtomic } from "./atomic.js";
import type { Config, Effort, Phase, Session, TaskDef } from "./types.js";
import { composePrompt } from "./prompts.js";

export interface SpawnArgs {
  phase: Phase;
  task?: TaskDef;
  projectRoot: string;
  taskId?: string | null;
  model?: string;
  effort?: Effort;
}

export class AgentRunner {
  constructor(
    private readonly paths: Paths,
    private readonly config: Config,
  ) {}

  async run(args: SpawnArgs): Promise<Session> {
    const sessionId = newId();
    const taskId = args.taskId ?? args.task?.id ?? null;
    const phaseCfg = resolvePhaseConfig(this.config, args.phase);
    const model = args.model ?? phaseCfg.model;
    const effort = args.effort ?? phaseCfg.effort;

    const prompt = await composePrompt(this.paths, {
      phase: args.phase,
      task: args.task,
      projectRoot: args.projectRoot,
    });

    const claudeSessionId = newClaudeSessionId();
    const session: Session = {
      id: sessionId,
      taskId,
      phase: args.phase,
      model,
      effort,
      startedAt: new Date().toISOString(),
      status: "running",
      costUsd: 0,
    };

    await writeJsonAtomic(this.paths.sessionMeta(taskId, sessionId), session);

    const argv = [
      "-p", prompt,
      "--model", model,
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--dangerously-skip-permissions",
      "--session-id", claudeSessionId,
    ];
    if (effort) {
      argv.push("--effort", effort === "med" ? "medium" : effort);
    }

    const child: ResultPromise = execa("claude", argv, {
      cwd: args.projectRoot,
      buffer: false,
      reject: false,
      stdin: "ignore",
    });

    const jsonlPath = this.paths.sessionJsonl(taskId, sessionId);
    let blockedReason: string | null = null;
    const stderrTail: string[] = [];

    // Drain stderr tail.
    void (async () => {
      const stream = child.stderr;
      if (!stream) return;
      stream.setEncoding?.("utf8");
      let buf = "";
      for await (const chunk of stream as AsyncIterable<string | Buffer>) {
        buf += typeof chunk === "string" ? chunk : chunk.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          stderrTail.push(buf.slice(0, i));
          if (stderrTail.length > 40) stderrTail.shift();
          buf = buf.slice(i + 1);
        }
      }
    })();

    try {
      const stream = child.stdout;
      if (stream) {
        stream.setEncoding?.("utf8");
        let buf = "";
        for await (const chunk of stream as AsyncIterable<string | Buffer>) {
          buf += typeof chunk === "string" ? chunk : chunk.toString();
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let payload: unknown;
            try { payload = JSON.parse(line); } catch { continue; }
            await appendJsonl(jsonlPath, { sessionId, ts: new Date().toISOString(), payload });

            // FLOW_BLOCKED detection on assistant text.
            const text = extractAssistantText(payload);
            const m = /^FLOW_BLOCKED:\s*(.+)$/m.exec(text);
            if (m && !blockedReason) {
              blockedReason = m[1]!.trim();
            }

            // Cost from result event.
            const cost = extractCost(payload);
            if (typeof cost === "number") session.costUsd = cost;
          }
        }
      }
    } catch (err) {
      session.error = `Stream error: ${(err as Error).message}`;
    }

    let exitCode = 0;
    try {
      const result = await child;
      exitCode = result.exitCode ?? 0;
    } catch (err) {
      exitCode = (err as ExecaError).exitCode ?? 1;
    }

    session.endedAt = new Date().toISOString();
    session.exitCode = exitCode;
    if (blockedReason) {
      session.status = "failed";
      session.error = `FLOW_BLOCKED: ${blockedReason}`;
    } else if (exitCode !== 0) {
      session.status = "failed";
      session.error = session.error ?? `claude exited ${exitCode}\n${stderrTail.join("\n").slice(-2000)}`;
    } else {
      session.status = "succeeded";
    }

    await writeJsonAtomic(this.paths.sessionMeta(taskId, sessionId), session);
    return session;
  }
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
    const c = (message as Record<string, unknown>)["content"];
    if (Array.isArray(c)) c.forEach(collect);
  }
  const c = obj["content"];
  if (Array.isArray(c)) c.forEach(collect);
  return pieces.join("\n");
}

function extractCost(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)["total_cost_usd"];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
