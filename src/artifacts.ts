import path from "node:path";
import { promises as fs } from "node:fs";

import { readJsonlLines } from "./atomic.js";
import { Paths } from "./paths.js";
import { StateStore } from "./state.js";
import type { Notification, SessionEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArtifactKind =
  | "session.events"
  | "project.notifications"
  | "project.learnings"
  | "project.skill"
  | "project.skills.list"
  | "project.setup-notes"
  | "project.instructions"
  | "project.plan-md"
  | "task.progress"
  | "task.summary"
  | "task.learnings-draft"
  | "task.round-issues"
  | "task.verify-log"
  | "task.screenshot";

export type ArtifactIds = Record<string, string | number>;

export interface ArtifactChunk {
  kind: ArtifactKind;
  ids: ArtifactIds;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// ProjectArtifacts — single dispatch surface for streaming on-disk artifacts
// (session JSONL, learnings, per-task files, project-level files) back to
// callers as ordered chunks. Wire-level WS handler in src/ws.ts wraps each
// yielded chunk in `artifact.chunk` frames; tests consume the iterable
// directly.
// ---------------------------------------------------------------------------

export class ProjectArtifacts {
  constructor(
    private readonly paths: Paths,
    private readonly state: StateStore,
  ) {}

  async *fetch(
    kind: ArtifactKind,
    ids: ArtifactIds,
  ): AsyncIterable<ArtifactChunk> {
    switch (kind) {
      case "session.events": {
        const sessionId = String(ids["sessionId"] ?? "");
        if (!sessionId) return;
        for await (const event of this.streamSessionEvents(sessionId)) {
          yield { kind, ids: { sessionId }, payload: event };
        }
        return;
      }

      case "project.notifications": {
        for (const n of await this.listAllNotifications()) {
          yield { kind, ids: {}, payload: n };
        }
        return;
      }

      case "project.learnings": {
        for await (const entry of this.streamAllLearnings()) {
          yield { kind, ids: {}, payload: entry };
        }
        return;
      }

      case "project.skill": {
        const name = String(ids["name"] ?? "");
        if (!name) return;
        const body = await readFileOrNull(this.paths.skillFile(name));
        if (body !== null) {
          yield { kind, ids: { name }, payload: { name, body } };
        }
        return;
      }

      case "project.skills.list": {
        for (const name of await listSkillNames(this.paths.skillsDir)) {
          yield { kind, ids: {}, payload: { name } };
        }
        return;
      }

      case "project.setup-notes": {
        const body = await readFileOrNull(this.paths.setupNotes);
        if (body !== null) yield { kind, ids: {}, payload: { body } };
        return;
      }

      case "project.instructions": {
        const body = await readFileOrNull(this.paths.agentsMd);
        if (body !== null) yield { kind, ids: {}, payload: { body } };
        return;
      }

      case "project.plan-md": {
        const body = await readFileOrNull(this.paths.planMd);
        if (body !== null) yield { kind, ids: {}, payload: { body } };
        return;
      }

      case "task.progress": {
        const taskId = String(ids["taskId"] ?? "");
        if (!taskId) return;
        const body = await readFileOrNull(this.paths.taskProgressTxt(taskId));
        if (body !== null) yield { kind, ids: { taskId }, payload: { body } };
        return;
      }

      case "task.summary": {
        const taskId = String(ids["taskId"] ?? "");
        if (!taskId) return;
        const body = await readFileOrNull(this.paths.taskSummary(taskId));
        if (body !== null) yield { kind, ids: { taskId }, payload: { body } };
        return;
      }

      case "task.learnings-draft": {
        const taskId = String(ids["taskId"] ?? "");
        if (!taskId) return;
        const body = await readFileOrNull(this.paths.taskLearningsDraft(taskId));
        if (body !== null) yield { kind, ids: { taskId }, payload: { body } };
        return;
      }

      case "task.round-issues": {
        const taskId = String(ids["taskId"] ?? "");
        if (!taskId) return;
        // If a specific round is requested, yield just that file. Otherwise
        // yield one chunk per round file in numeric order.
        const roundParam = ids["round"];
        if (roundParam !== undefined && roundParam !== null) {
          const round = Number(roundParam);
          const body = await readFileOrNull(this.paths.taskRoundIssues(taskId, round));
          if (body !== null) {
            yield { kind, ids: { taskId, round }, payload: { round, body } };
          }
          return;
        }
        const dir = this.paths.taskIssuesDir(taskId);
        let entries: string[];
        try {
          entries = await fs.readdir(dir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
          throw err;
        }
        const rounds: number[] = [];
        for (const name of entries) {
          const m = /^round-(\d+)-issues\.md$/.exec(name);
          if (m) rounds.push(Number(m[1]));
        }
        rounds.sort((a, b) => a - b);
        for (const round of rounds) {
          const body = await readFileOrNull(
            this.paths.taskRoundIssues(taskId, round),
          );
          if (body !== null) {
            yield { kind, ids: { taskId, round }, payload: { round, body } };
          }
        }
        return;
      }

      case "task.verify-log": {
        const taskId = String(ids["taskId"] ?? "");
        if (!taskId) return;
        const body = await readFileOrNull(this.paths.taskVerifyLog(taskId));
        if (body !== null) yield { kind, ids: { taskId }, payload: { body } };
        return;
      }

      case "task.screenshot": {
        const taskId = String(ids["taskId"] ?? "");
        const filename = String(ids["filename"] ?? "");
        if (!taskId || !filename) return;
        const filePath = path.join(
          this.paths.taskScreenshotsDir(taskId),
          filename,
        );
        try {
          const buf = await fs.readFile(filePath);
          yield {
            kind,
            ids: { taskId, filename },
            payload: { filename, base64: buf.toString("base64") },
          };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        return;
      }

      default: {
        const _exhaustive: never = kind;
        void _exhaustive;
        return;
      }
    }
  }

  private async listAllNotifications(): Promise<Notification[]> {
    return this.state.listNotifications();
  }

  private async *streamAllLearnings(): AsyncIterable<{
    taskId: string;
    path: string;
    markdown: string;
  }> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.paths.learningsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".md")) continue;
      const taskId = name.replace(/\.md$/, "");
      const filePath = path.join(this.paths.learningsDir, name);
      const body = await readFileOrNull(filePath);
      if (body !== null) {
        yield { taskId, path: filePath, markdown: body };
      }
    }
  }

  private async *streamSessionEvents(
    sessionId: string,
  ): AsyncIterable<SessionEvent> {
    const session = this.state.getSession(sessionId);
    const taskId = session?.taskId ?? null;
    const primary = this.paths.sessionJsonl(taskId, sessionId);
    const fallback = this.paths.projectSessionJsonl(sessionId);

    const pickPath = async (): Promise<string | null> => {
      try {
        await fs.access(primary);
        return primary;
      } catch {
        /* try fallback */
      }
      try {
        await fs.access(fallback);
        return fallback;
      } catch {
        return null;
      }
    };

    const p = await pickPath();
    if (!p) return;
    const fallbackTs = new Date().toISOString();
    for await (const raw of readJsonlLines<unknown>(p)) {
      const event = toSessionEvent(raw, sessionId, fallbackTs);
      if (event) yield event;
    }
  }
}

// ---------------------------------------------------------------------------
// Lifted helpers (previously in src/flow.ts) — exported so callers that still
// raw-decode JSONL lines can reuse the same envelope inference.
// ---------------------------------------------------------------------------

export function toSessionEvent(
  raw: unknown,
  sessionId: string,
  fallbackTs: string,
): SessionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Already-shaped SessionEvent?
  if (
    typeof obj["sessionId"] === "string" &&
    typeof obj["kind"] === "string" &&
    typeof obj["ts"] === "string" &&
    "payload" in obj
  ) {
    return obj as unknown as SessionEvent;
  }

  // Raw Claude Code stream-json payload — infer a minimal event envelope.
  const ts =
    typeof obj["timestamp"] === "string"
      ? (obj["timestamp"] as string)
      : typeof obj["ts"] === "string"
        ? (obj["ts"] as string)
        : fallbackTs;

  return {
    sessionId,
    ts,
    kind: inferKind(obj),
    payload: obj,
  };
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function listSkillNames(skillsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// Mirrors mapPayloadToEventKind in agent.ts. Kept aligned so artifact replay
// classifies the same way as live session.event emission — otherwise
// type:"assistant" payloads carrying tool_use or thinking blocks all collapse
// to assistant_text, and type:"user" tool_result payloads get dropped.
function inferKind(payload: Record<string, unknown>): SessionEvent["kind"] {
  const type = payload["type"];
  switch (type) {
    case "system":
      return "system";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "usage":
    case "result":
      return "usage";
    case "stop":
      return "stop";
    case "assistant": {
      const blocks = contentBlocks(payload);
      if (blocks.some((b) => b["type"] === "thinking" || b["type"] === "redacted_thinking")) {
        return "assistant_thinking";
      }
      if (blocks.some((b) => b["type"] === "tool_use")) return "tool_use";
      return "assistant_text";
    }
    case "user": {
      const blocks = contentBlocks(payload);
      if (blocks.some((b) => b["type"] === "tool_result")) return "tool_result";
      return "system";
    }
    default:
      return "system";
  }
}

function contentBlocks(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const pick = (arr: unknown): Array<Record<string, unknown>> | null => {
    if (!Array.isArray(arr)) return null;
    return arr.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
  };
  const message = payload["message"];
  if (message && typeof message === "object") {
    const fromMessage = pick((message as Record<string, unknown>)["content"]);
    if (fromMessage) return fromMessage;
  }
  return pick(payload["content"]) ?? [];
}
