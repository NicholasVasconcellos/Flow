import test from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { ClientCommandSchema } from "../src/wsProtocol.js";
import {
  ConfigSchema,
  DagSchema,
  NotificationSchema,
  ProjectSchema,
  ProjectSummarySchema,
  SessionEventSchema,
  SessionSchema,
  StageKeySchema,
  StageOverrideSchema,
  TaskRuntimeSchema,
} from "../src/types.js";

type FixtureModule = {
  FLOW_WS_FRAMES: unknown[];
  FLOW_CLIENT_COMMANDS: unknown[];
  FLOW_UI_FIXTURE: Record<string, unknown>;
  FLOW_UI_EXAMPLE: unknown;
  default: unknown;
};

const EXPECTED_SERVER_EVENT_TYPES = [
  "hello",
  "command.result",
  "project.list",
  "project.state",
  "task.upsert",
  "task.removed",
  "dag",
  "session.started",
  "session.updated",
  "session.event",
  "session.ended",
  "notification",
  "learning",
  "config",
  "config.stages",
  "error",
] as const;

const EXPECTED_CLIENT_COMMAND_TYPES = [
  "project.list",
  "project.open",
  "project.create",
  "project.close",
  "run.once",
  "run.allOnce",
  "run.all",
  "run.cancel",
  "task.retry",
  "task.cancel",
  "task.resume",
  "artifact.fetch",
  "notification.ack",
  "notification.clearAll",
  "config.get",
  "config.update",
  "config.stages.get",
  "config.stages.update",
] as const;

const EXPECTED_TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "paused",
  "blocked",
  "done",
  "merged",
] as const;

const EXPECTED_TASK_STAGES = [
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
  "update-learning",
  "done",
  "merged",
] as const;

const EXPECTED_SESSION_STAGES = [
  "setup",
  "get-tasks",
  "spec",
  "exec",
  "exec_ui_check",
  "code_review",
  "code_review_ui_check",
  "documentation",
  "update-learning",
  "commit",
  "commit_recovery",
  "merge-resolve",
  "merge-verify",
] as const;

const EXPECTED_SESSION_EVENT_KINDS = [
  "system",
  "assistant_text",
  "assistant_thinking",
  "tool_use",
  "tool_result",
  "usage",
  "stop",
] as const;

async function loadFixture(): Promise<FixtureModule> {
  const fixtureUrl = new URL("../examples/flow-ui-payload.js", import.meta.url).href;
  return (await import(fixtureUrl)) as FixtureModule;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

const HelloFrameSchema = z
  .object({
    type: z.literal("hello"),
    version: z.string(),
    project: ProjectSchema.optional(),
    capabilities: z
      .object({
        readOnly: z.boolean(),
        supportedCommands: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

const CommandResultFrameSchema = z
  .object({
    type: z.literal("command.result"),
    requestId: z.string(),
    ok: z.boolean(),
    message: z.string().optional(),
    data: z.unknown().optional(),
  })
  .strict();

const ProjectListFrameSchema = z
  .object({
    type: z.literal("project.list"),
    projects: z.array(ProjectSummarySchema),
  })
  .strict();

const LearningFrameSchema = z
  .object({
    type: z.literal("learning"),
    taskId: z.string(),
    path: z.string(),
    markdown: z.string(),
  })
  .strict();

const ErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    requestId: z.string().optional(),
    message: z.string(),
  })
  .strict();

function validateServerFrame(raw: unknown): string {
  const frame = asRecord(raw);
  const type = frame["type"];
  assert.equal(typeof type, "string");

  switch (type) {
    case "hello":
      HelloFrameSchema.parse(frame);
      break;
    case "command.result":
      CommandResultFrameSchema.parse(frame);
      break;
    case "project.list":
      ProjectListFrameSchema.parse(frame);
      break;
    case "project.state":
      z.object({ type: z.literal("project.state"), project: ProjectSchema })
        .strict()
        .parse(frame);
      break;
    case "task.upsert":
      z.object({ type: z.literal("task.upsert"), task: TaskRuntimeSchema })
        .strict()
        .parse(frame);
      break;
    case "task.removed":
      z.object({ type: z.literal("task.removed"), taskId: z.string() })
        .strict()
        .parse(frame);
      break;
    case "dag":
      z.object({
        type: z.literal("dag"),
        nodes: DagSchema.shape.nodes,
        edges: DagSchema.shape.edges,
      })
        .strict()
        .parse(frame);
      break;
    case "session.started":
      z.object({ type: z.literal("session.started"), session: SessionSchema })
        .strict()
        .parse(frame);
      break;
    case "session.updated":
      z.object({ type: z.literal("session.updated"), session: SessionSchema })
        .strict()
        .parse(frame);
      break;
    case "session.event":
      z.object({ type: z.literal("session.event"), event: SessionEventSchema })
        .strict()
        .parse(frame);
      break;
    case "session.ended":
      z.object({ type: z.literal("session.ended"), session: SessionSchema })
        .strict()
        .parse(frame);
      break;
    case "notification":
      z.object({
        type: z.literal("notification"),
        notification: NotificationSchema,
      })
        .strict()
        .parse(frame);
      break;
    case "learning":
      LearningFrameSchema.parse(frame);
      break;
    case "config":
      z.object({ type: z.literal("config"), config: ConfigSchema })
        .strict()
        .parse(frame);
      break;
    case "config.stages":
      z.object({
        type: z.literal("config.stages"),
        stages: z.record(StageKeySchema, StageOverrideSchema),
      })
        .strict()
        .parse(frame);
      break;
    case "error":
      ErrorFrameSchema.parse(frame);
      break;
    default:
      assert.fail(`Unexpected server event type in fixture: ${type}`);
  }

  return type;
}

function collectTasks(frames: unknown[]): Array<Record<string, unknown>> {
  const tasks: Array<Record<string, unknown>> = [];
  for (const raw of frames) {
    const frame = asRecord(raw);
    if (frame["type"] === "project.state") {
      const project = asRecord(frame["project"]);
      const projectTasks = project["tasks"];
      assert.ok(Array.isArray(projectTasks));
      tasks.push(...projectTasks.map(asRecord));
    }
    if (frame["type"] === "task.upsert") {
      tasks.push(asRecord(frame["task"]));
    }
  }
  return tasks;
}

function collectSessions(frames: unknown[]): Array<Record<string, unknown>> {
  const sessions: Array<Record<string, unknown>> = [];
  for (const raw of frames) {
    const frame = asRecord(raw);
    if (
      frame["type"] === "session.started" ||
      frame["type"] === "session.updated" ||
      frame["type"] === "session.ended"
    ) {
      sessions.push(asRecord(frame["session"]));
    }
  }
  return sessions;
}

test("flow UI payload fixture validates against implemented websocket schemas", async () => {
  const fixture = await loadFixture();
  assert.ok(Array.isArray(fixture.FLOW_WS_FRAMES));

  const seen = new Set(fixture.FLOW_WS_FRAMES.map(validateServerFrame));
  for (const expected of EXPECTED_SERVER_EVENT_TYPES) {
    assert.ok(seen.has(expected), `missing ServerEvent frame: ${expected}`);
  }
  for (const actual of seen) {
    assert.ok(
      EXPECTED_SERVER_EVENT_TYPES.includes(
        actual as (typeof EXPECTED_SERVER_EVENT_TYPES)[number],
      ),
      `unexpected ServerEvent frame: ${actual}`,
    );
  }
});

test("flow UI payload fixture validates representative client commands", async () => {
  const fixture = await loadFixture();
  assert.ok(Array.isArray(fixture.FLOW_CLIENT_COMMANDS));

  const seen = new Set<string>();
  for (const command of fixture.FLOW_CLIENT_COMMANDS) {
    const parsed = ClientCommandSchema.parse(command);
    seen.add(parsed.type);
  }

  for (const expected of EXPECTED_CLIENT_COMMAND_TYPES) {
    assert.ok(seen.has(expected), `missing ClientCommand example: ${expected}`);
  }
});

test("flow UI payload fixture covers current task states and stage flags", async () => {
  const fixture = await loadFixture();
  const tasks = collectTasks(fixture.FLOW_WS_FRAMES);
  const statuses = new Set(tasks.map((task) => task["status"]));
  const stages = new Set(tasks.map((task) => task["stage"]));

  assert.ok(tasks.length >= 90, "expected downstream pkmn-t8 task snapshot");
  assert.ok(
    tasks.some((task) => task["id"] === "initialize-godot-project-with-basic-configuration"),
    "missing real pkmn-t8 bootstrap task",
  );
  assert.ok(
    tasks.some((task) => task["id"] === "implement-dataregistry-autoload"),
    "missing real pkmn-t8 in-flight task",
  );

  for (const expected of EXPECTED_TASK_STATUSES) {
    assert.ok(statuses.has(expected), `missing task status example: ${expected}`);
  }
  for (const expected of EXPECTED_TASK_STAGES) {
    assert.ok(stages.has(expected), `missing task stage example: ${expected}`);
  }

  assert.ok(tasks.some((task) => task["hasUI"] === true), "missing hasUI=true task");
  assert.ok(tasks.some((task) => task["hasSpec"] === false), "missing hasSpec=false task");
  assert.ok(
    tasks.some((task) => task["hasCodeReview"] === false),
    "missing hasCodeReview=false task",
  );
  assert.ok(tasks.some((task) => "lastError" in task), "missing lastError task");
  assert.ok(tasks.some((task) => "worktreePath" in task), "missing worktreePath task");
  assert.ok(tasks.some((task) => "branchName" in task), "missing branchName task");
  assert.ok(
    tasks.some((task) => typeof task["currentSessionId"] === "string"),
    "missing currentSessionId task",
  );
  assert.ok(
    tasks.some((task) => Number(task["transientRetries"]) > 0),
    "missing transientRetries task",
  );
  assert.ok(
    tasks.some((task) => Number(task["uiReviewRound"]) > 0),
    "missing uiReviewRound task",
  );
});

test("flow UI payload fixture covers session metadata and stream event kinds", async () => {
  const fixture = await loadFixture();
  const sessions = collectSessions(fixture.FLOW_WS_FRAMES);
  const sessionStages = new Set(sessions.map((session) => session["stage"]));
  const sessionStatuses = new Set(sessions.map((session) => session["status"]));
  const eventKinds = new Set<string>();
  const eventPayloads: unknown[] = [];

  for (const frame of fixture.FLOW_WS_FRAMES.map(asRecord)) {
    if (frame["type"] !== "session.event") continue;
    const event = asRecord(frame["event"]);
    eventKinds.add(String(event["kind"]));
    eventPayloads.push(event["payload"]);
  }

  for (const expected of EXPECTED_SESSION_STAGES) {
    assert.ok(sessionStages.has(expected), `missing session stage example: ${expected}`);
  }
  for (const expected of ["running", "succeeded", "failed", "autocompacted"]) {
    assert.ok(sessionStatuses.has(expected), `missing session status example: ${expected}`);
  }
  for (const expected of EXPECTED_SESSION_EVENT_KINDS) {
    assert.ok(eventKinds.has(expected), `missing session.event kind: ${expected}`);
  }

  assert.ok(sessions.some((session) => session["taskId"] === null), "missing project-level session");
  assert.ok(sessions.some((session) => "ordinal" in session), "missing ordinal session");
  assert.ok(sessions.some((session) => "effort" in session), "missing effort session");
  assert.ok(sessions.some((session) => "parentSessionId" in session), "missing parentSessionId session");
  assert.ok(sessions.some((session) => "claudeSessionId" in session), "missing claudeSessionId session");
  assert.ok(sessions.some((session) => "contextPercentage" in session), "missing contextPercentage session");
  assert.ok(sessions.some((session) => session["autocompacted"] === true), "missing autocompacted session");
  assert.ok(sessions.some((session) => session["transientError"] === true), "missing transientError session");
  assert.ok(sessions.some((session) => "reviewRequested" in session), "missing reviewRequested session");
  assert.ok(sessions.some((session) => "surplus_children" in session), "missing surplus_children session");
  assert.ok(sessions.some((session) => "exitCode" in session), "missing exitCode session");
  assert.ok(sessions.some((session) => "error" in session), "missing error session");

  const payloadText = JSON.stringify(eventPayloads);
  assert.match(payloadText, /FLOW_BLOCKED/);
  assert.match(payloadText, /FLOW_REVIEW_REQUESTED/);
  assert.match(payloadText, /compact_boundary/);
  assert.match(payloadText, /api_retry/);
  assert.match(payloadText, /rate_limit_event/);
  assert.match(payloadText, /\/Users\/nicholas\/Developer\/pkmn-t8/);

  const sessionText = JSON.stringify(sessions);
  assert.match(sessionText, /looped_on_blocked_tool/);
  assert.match(sessionText, /Stall: no assistant progress/);
  assert.match(sessionText, /monthly usage limit/);
});

test("flow UI fixture is derived and avoids unsupported legacy payload keys", async () => {
  const fixture = await loadFixture();
  const exported = asRecord(fixture);
  const ui = fixture.FLOW_UI_FIXTURE;

  assert.ok(Array.isArray(ui["tasks"]));
  assert.ok(Array.isArray(ui["sessions"]));
  assert.ok(Array.isArray(ui["notifications"]));
  assert.ok(Array.isArray(ui["learnings"]));
  assert.equal(asRecord(ui["project"])["name"], "pkmn-t8");
  assert.equal(asRecord(ui["source"])["projectPath"], "/Users/nicholas/Developer/pkmn-t8");
  assert.ok(Object.keys(asRecord(ui["sessionEventsBySessionId"])).length > 0);

  for (const unsupported of [
    "PROJECTS",
    "HOME_DIRECTORIES",
    "TASK_DETAILS",
    "SUGGESTIONS",
  ]) {
    assert.equal(unsupported in exported, false, `${unsupported} should not be exported`);
  }

  assert.equal(
    fixture.FLOW_WS_FRAMES.some((frame) => asRecord(frame)["type"] === "suggestion"),
    false,
    "suggestion is not an implemented ServerEvent",
  );

  const notes = String(ui["contractNotes"]);
  assert.match(notes, /project\.state currently contains name, path, status, config, tasks, and dag/);
  assert.match(notes, /There is no implemented suggestion ServerEvent/);
  assert.equal(fixture.default, fixture.FLOW_UI_EXAMPLE);
});
