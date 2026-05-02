import { randomUUID } from "node:crypto";
import { ulid } from "ulid";

export function newId(): string {
  return ulid();
}

/** A lower-case UUIDv4 suitable for Claude Code's `--session-id` flag, which
 *  rejects any non-UUID identifier. Flow's internal session id remains a ULID
 *  so task/session ids stay sortable; the UUID is only what we hand to the
 *  `claude` subprocess. */
export function newClaudeSessionId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic slug derived from a task title. Matches the rule the
 *  `get-tasks` skill instructs the agent to use — lowercase, runs of
 *  non-alphanumeric chars collapsed to `-`, leading/trailing `-` trimmed,
 *  result truncated to 64 chars. Returns `""` if the input has no
 *  alphanumeric content; callers decide how to surface that. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}
