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
