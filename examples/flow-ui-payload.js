// Example Flow UI payloads backed by the real downstream pkmn-t8 `.flow` store.
//
// Backend-authored data is represented as ordered `ServerEvent` frames in
// FLOW_WS_FRAMES. Everything in FLOW_UI_FIXTURE is derived client-side from
// those frames and is provided only as a convenience for UI prototyping.

import fs from "node:fs";
import path from "node:path";

const FLOW_PROJECT_PATH =
  process.env.FLOW_UI_FIXTURE_PROJECT ?? "/Users/nicholas/Developer/pkmn-t8";
const FLOW_DIR = path.join(FLOW_PROJECT_PATH, ".flow");
const SESSION_DIR = path.join(FLOW_DIR, "sessions");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const readJsonl = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

const normalizeStage = (stage) => (stage === "getTasks" ? "get-tasks" : stage);
const normalizeSkillName = (skillName) => (skillName === "getTasks" ? "get-tasks" : skillName);

const zeroTokens = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
});

const normalizeSession = (session) => ({
  ...session,
  stage: normalizeStage(session.stage),
  skillName: normalizeSkillName(session.skillName),
  tokens: session.tokens ?? zeroTokens(),
  autocompacted: session.autocompacted ?? false,
  costUsd: session.costUsd ?? 0,
});

const normalizeTask = (task) => ({
  ...task,
  contextFiles: task.contextFiles ?? [],
  requires: task.requires ?? [],
  hasUI: task.hasUI ?? false,
  hasSpec: task.hasSpec ?? true,
  hasCodeReview: task.hasCodeReview ?? true,
  retries: task.retries ?? 0,
  transientRetries: task.transientRetries ?? 0,
  uiReviewRound: task.uiReviewRound ?? 0,
  sessionIds: task.sessionIds ?? [],
});

function buildConfig(rawConfig) {
  return {
    maxConcurrent: rawConfig.maxConcurrent ?? 3,
    retryCount: rawConfig.retryCount ?? 0,
    maxConsecutiveApiRetries: rawConfig.maxConsecutiveApiRetries ?? 5,
    stallTimeoutMs: rawConfig.stallTimeoutMs ?? 180000,
    repeatToolCallCap: rawConfig.repeatToolCallCap ?? 3,
    maxUIReviewIterations: rawConfig.maxUIReviewIterations ?? 3,
    hasDocs: rawConfig.hasDocs ?? true,
    defaults: {
      model: rawConfig.defaults?.model ?? "claude-sonnet-4-5",
      effort: rawConfig.defaults?.effort ?? "med",
      ...(rawConfig.defaults?.thinkingMode
        ? { thinkingMode: rawConfig.defaults.thinkingMode }
        : {}),
    },
    stages: rawConfig.stages ?? {},
    git: {
      ...(rawConfig.git?.remote ? { remote: rawConfig.git.remote } : {}),
      mainBranch: rawConfig.git?.mainBranch ?? "main",
      worktreeRoot: rawConfig.git?.worktreeRoot ?? ".flow/worktrees",
      mergeStrategy: rawConfig.git?.mergeStrategy ?? "squash",
    },
    verify: {
      ...(rawConfig.verify?.command ? { command: rawConfig.verify.command } : {}),
      timeoutMs: rawConfig.verify?.timeoutMs ?? 300000,
    },
    ws: { port: rawConfig.ws?.port ?? 7777 },
    pricing: rawConfig.pricing ?? {},
  };
}

function buildDag(tasks) {
  return {
    nodes: tasks.map((task) => task.id),
    edges: tasks.flatMap((task) => task.requires.map((required) => [required, task.id])),
  };
}

function hasContentBlock(payload, type) {
  const content = payload?.message?.content ?? payload?.content;
  return Array.isArray(content) && content.some((block) => block?.type === type);
}

function mapPayloadToEventKind(payload) {
  if (!payload || typeof payload !== "object") return "system";
  if (payload.type === "system") return "system";
  if (payload.type === "tool_use") return "tool_use";
  if (payload.type === "tool_result") return "tool_result";
  if (payload.type === "usage" || payload.type === "result" || "usage" in payload) return "usage";
  if (payload.type === "stop") return "stop";
  if (payload.type === "assistant") {
    if (hasContentBlock(payload, "thinking")) return "assistant_thinking";
    if (hasContentBlock(payload, "tool_use")) return "tool_use";
    return "assistant_text";
  }
  if (payload.type === "user") {
    if (hasContentBlock(payload, "tool_result")) return "tool_result";
    return "system";
  }
  return "system";
}

function eventTimestamp(payload, fallback) {
  for (const key of ["timestamp", "ts", "time", "createdAt"]) {
    if (typeof payload?.[key] === "string" && payload[key].length > 0) return payload[key];
  }
  return fallback;
}

function sessionEvent(sessionId, payload, fallbackTs) {
  return {
    type: "session.event",
    event: {
      sessionId,
      ts: eventTimestamp(payload, fallbackTs),
      kind: mapPayloadToEventKind(payload),
      payload,
    },
  };
}

function startedSession(session) {
  return {
    id: session.id,
    taskId: session.taskId,
    stage: session.stage,
    provider: session.provider,
    model: session.model,
    ...(session.thinkingMode ? { thinkingMode: session.thinkingMode } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(typeof session.ordinal === "number" ? { ordinal: session.ordinal } : {}),
    skillName: session.skillName,
    prompt: session.prompt,
    status: "running",
    startedAt: session.startedAt,
    tokens: zeroTokens(),
    autocompacted: false,
    costUsd: 0,
    ...(session.claudeSessionId ? { claudeSessionId: session.claudeSessionId } : {}),
  };
}

function readProjectSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((fileName) => fileName.endsWith(".meta.json"))
    .sort()
    .map((fileName) => normalizeSession(readJson(path.join(SESSION_DIR, fileName))));
}

function readRepresentativeSessionEvents(sessions) {
  if (!fs.existsSync(SESSION_DIR)) return [];

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const samples = new Map();
  let rateLimitSample = null;
  const preferredKinds = [
    "system",
    "assistant_thinking",
    "assistant_text",
    "tool_use",
    "tool_result",
    "usage",
  ];

  for (const fileName of fs.readdirSync(SESSION_DIR).filter((file) => file.endsWith(".jsonl")).sort()) {
    const sessionId = fileName.replace(/\.jsonl$/, "");
    const session = byId.get(sessionId);
    const fallbackTs = session?.startedAt ?? new Date(0).toISOString();

    for (const payload of readJsonl(path.join(SESSION_DIR, fileName))) {
      const kind = mapPayloadToEventKind(payload);
      if (payload.type === "rate_limit_event" && !rateLimitSample) {
        rateLimitSample = sessionEvent(sessionId, payload, fallbackTs);
      }
      if (!samples.has(kind)) {
        samples.set(kind, sessionEvent(sessionId, payload, fallbackTs));
      }
      if (rateLimitSample && preferredKinds.every((sampleKind) => samples.has(sampleKind))) break;
    }
  }

  return [
    ...preferredKinds.flatMap((kind) => (samples.has(kind) ? [samples.get(kind)] : [])),
    ...(rateLimitSample ? [rateLimitSample] : []),
  ];
}

function readLearnings() {
  const learningsDir = path.join(FLOW_DIR, "learnings");
  if (!fs.existsSync(learningsDir)) return [];
  return fs
    .readdirSync(learningsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .sort()
    .map((fileName) => ({
      type: "learning",
      taskId: fileName.replace(/\.md$/, ""),
      path: path.join(learningsDir, fileName),
      markdown: fs.readFileSync(path.join(learningsDir, fileName), "utf8"),
    }));
}

const STATE = readJson(path.join(FLOW_DIR, "state.json"));
const TASKS = STATE.tasks.map(normalizeTask);
const CONFIG = buildConfig(readJson(path.join(FLOW_DIR, "config.json")));
const STAGES = CONFIG.stages;
const DAG = buildDag(TASKS);
const PROJECT_STATUS = TASKS.some((task) => task.status === "running") ? "running" : "ready";

const PROJECT = {
  name: path.basename(FLOW_PROJECT_PATH),
  path: FLOW_PROJECT_PATH,
  status: PROJECT_STATUS,
  config: CONFIG,
  tasks: TASKS,
  dag: DAG,
};

const PROJECT_SESSIONS = readProjectSessions();
const STATE_SESSIONS = STATE.sessions.map(normalizeSession);
const SESSIONS = Array.from(
  new Map([...PROJECT_SESSIONS, ...STATE_SESSIONS].map((session) => [session.id, session])).values(),
);
const SESSION_EVENT_FRAMES = readRepresentativeSessionEvents(SESSIONS);
const NOTIFICATIONS = readJsonl(path.join(FLOW_DIR, "notifications.jsonl")).slice(-16);
const LEARNING_FRAMES = readLearnings();

const fixtureTask = (overrides) => ({
  id: overrides.id,
  title: overrides.title,
  description: overrides.description,
  contextFiles: overrides.contextFiles ?? [],
  requires: overrides.requires ?? [],
  hasUI: overrides.hasUI ?? false,
  hasSpec: overrides.hasSpec ?? true,
  hasCodeReview: overrides.hasCodeReview ?? true,
  status: overrides.status,
  stage: overrides.stage,
  retries: overrides.retries ?? 0,
  transientRetries: overrides.transientRetries ?? 0,
  uiReviewRound: overrides.uiReviewRound ?? 0,
  worktreePath: path.join(FLOW_DIR, "worktrees", overrides.id),
  branchName: `flow/${overrides.id}`,
  currentSessionId: overrides.currentSessionId,
  sessionIds: overrides.sessionIds ?? [],
  createdAt: overrides.createdAt ?? STATE.updatedAt,
  updatedAt: overrides.updatedAt ?? STATE.updatedAt,
  ...(overrides.startedAt ? { startedAt: overrides.startedAt } : {}),
  ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {}),
  ...(overrides.lastError ? { lastError: overrides.lastError } : {}),
});

const EDGE_CASE_TASKS = [
  fixtureTask({
    id: "fixture-edge-exec-ui-check",
    title: "Fixture edge: running exec UI check",
    description: "Synthetic coverage for a UI task currently looping through exec_ui_check.",
    contextFiles: ["scenes/title_screen.tscn"],
    requires: [TASKS[0]?.id].filter(Boolean),
    hasUI: true,
    status: "running",
    stage: "exec_ui_check",
    uiReviewRound: 1,
    currentSessionId: "fixture-edge-session-ui-check",
    sessionIds: ["fixture-edge-session-ui-check"],
    startedAt: STATE.updatedAt,
  }),
  fixtureTask({
    id: "fixture-edge-blocked-review",
    title: "Fixture edge: blocked code review",
    description: "Synthetic coverage for FLOW_BLOCKED handling at code_review.",
    contextFiles: ["autoloads/network_manager.gd"],
    status: "blocked",
    stage: "code_review",
    retries: 1,
    transientRetries: 3,
    currentSessionId: "fixture-edge-session-blocked-review",
    sessionIds: ["fixture-edge-session-blocked-review"],
    startedAt: STATE.updatedAt,
    lastError: {
      stage: "code_review",
      message: "FLOW_BLOCKED: godot-mcp not reachable for private visual review",
      at: STATE.updatedAt,
    },
  }),
  fixtureTask({
    id: "fixture-edge-review-ui-check",
    title: "Fixture edge: code review UI check",
    description: "Synthetic coverage for a second visual review pass.",
    contextFiles: ["scenes/lobby/lobby_scene.tscn"],
    hasUI: true,
    status: "running",
    stage: "code_review_ui_check",
    uiReviewRound: 2,
    currentSessionId: "fixture-edge-session-review-requested",
    sessionIds: ["fixture-edge-session-review-requested"],
    startedAt: STATE.updatedAt,
  }),
  fixtureTask({
    id: "fixture-edge-paused-docs",
    title: "Fixture edge: paused documentation",
    description: "Synthetic coverage for paused documentation plus skipped spec/review flags.",
    contextFiles: ["DOCS.md"],
    hasSpec: false,
    hasCodeReview: false,
    status: "paused",
    stage: "documentation",
    currentSessionId: "fixture-edge-session-autocompacted-docs",
    sessionIds: ["fixture-edge-session-autocompacted-docs"],
    startedAt: STATE.updatedAt,
    lastError: {
      stage: "documentation",
      message: "Stage signal \"done\" but no commit was made on the worktree branch.",
      at: STATE.updatedAt,
    },
  }),
  fixtureTask({
    id: "fixture-edge-done-awaiting-merge",
    title: "Fixture edge: done awaiting merge",
    description: "Synthetic coverage for a task that finished its pipeline but has not merged yet.",
    contextFiles: ["tests/unit/test_type_chart.gd"],
    status: "done",
    stage: "done",
    currentSessionId: "fixture-edge-session-merge-verify",
    sessionIds: ["fixture-edge-session-merge-verify"],
    startedAt: STATE.updatedAt,
    completedAt: STATE.updatedAt,
  }),
];

const fixtureSession = (overrides) => ({
  id: overrides.id,
  taskId: overrides.taskId,
  stage: overrides.stage,
  provider: "claude-code",
  model: overrides.model ?? CONFIG.defaults.model,
  thinkingMode: overrides.thinkingMode ?? "think",
  effort: overrides.effort ?? "med",
  ordinal: overrides.ordinal ?? 1,
  skillName: overrides.skillName,
  prompt: overrides.prompt ?? "@/Users/nicholas/Developer/pkmn-t8/.flow/skills/fixture-edge/SKILL.md",
  status: overrides.status,
  startedAt: overrides.startedAt ?? STATE.updatedAt,
  ...(overrides.endedAt ? { endedAt: overrides.endedAt } : {}),
  tokens: overrides.tokens ?? zeroTokens(),
  ...(typeof overrides.contextPercentage === "number"
    ? { contextPercentage: overrides.contextPercentage }
    : {}),
  autocompacted: overrides.autocompacted ?? false,
  costUsd: overrides.costUsd ?? 0,
  ...(overrides.parentSessionId ? { parentSessionId: overrides.parentSessionId } : {}),
  claudeSessionId: overrides.claudeSessionId,
  ...(typeof overrides.exitCode === "number" ? { exitCode: overrides.exitCode } : {}),
  ...(overrides.error ? { error: overrides.error } : {}),
  ...(typeof overrides.transientError === "boolean"
    ? { transientError: overrides.transientError }
    : {}),
  ...(overrides.reviewRequested ? { reviewRequested: overrides.reviewRequested } : {}),
  ...(overrides.surplus_children ? { surplus_children: overrides.surplus_children } : {}),
});

const EDGE_CASE_SESSIONS = [
  fixtureSession({
    id: "fixture-edge-session-ui-check",
    taskId: "fixture-edge-exec-ui-check",
    stage: "exec_ui_check",
    skillName: "ui-check",
    status: "succeeded",
    endedAt: STATE.updatedAt,
    contextPercentage: 35,
    costUsd: 0.11,
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440101",
    exitCode: 0,
  }),
  fixtureSession({
    id: "fixture-edge-session-blocked-review",
    taskId: "fixture-edge-blocked-review",
    stage: "code_review",
    skillName: "review",
    status: "failed",
    endedAt: STATE.updatedAt,
    contextPercentage: 44,
    costUsd: 0.17,
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440102",
    exitCode: 0,
    error: "FLOW_BLOCKED: godot-mcp not reachable for private visual review",
  }),
  fixtureSession({
    id: "fixture-edge-session-review-requested",
    taskId: "fixture-edge-review-ui-check",
    stage: "code_review_ui_check",
    skillName: "ui-check",
    status: "succeeded",
    endedAt: STATE.updatedAt,
    parentSessionId: "fixture-edge-session-blocked-review",
    contextPercentage: 51,
    costUsd: 0.23,
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440103",
    exitCode: 0,
    reviewRequested: { reason: "FLOW_REVIEW_REQUESTED: verify touch layout on iPhone safe areas." },
  }),
  fixtureSession({
    id: "fixture-edge-session-autocompacted-docs",
    taskId: "fixture-edge-paused-docs",
    stage: "documentation",
    skillName: "docs",
    status: "autocompacted",
    endedAt: STATE.updatedAt,
    contextPercentage: 92,
    autocompacted: true,
    costUsd: 0.41,
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440104",
    exitCode: 0,
  }),
  fixtureSession({
    id: "fixture-edge-session-commit-recovery",
    taskId: "fixture-edge-done-awaiting-merge",
    stage: "commit_recovery",
    skillName: "commit",
    status: "failed",
    endedAt: STATE.updatedAt,
    effort: "low",
    thinkingMode: "off",
    costUsd: 0.05,
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440105",
    exitCode: 1,
    error:
      "looped_on_blocked_tool: agent re-issued the same Bash command 3 times consecutively with no successful intervening result: npm test",
    transientError: true,
    surplus_children: [{ pid: 44122, name: "Chromium Helper" }],
  }),
  fixtureSession({
    id: "fixture-edge-session-merge-verify",
    taskId: "fixture-edge-done-awaiting-merge",
    stage: "merge-verify",
    skillName: "merge-verify",
    status: "running",
    parentSessionId: "fixture-edge-session-commit-recovery",
    contextPercentage: 63,
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440106",
  }),
];

const EDGE_CASE_SESSION_EVENT_FRAMES = [
  sessionEvent("fixture-edge-session-autocompacted-docs", {
    type: "system",
    subtype: "compact_boundary",
    timestamp: STATE.updatedAt,
  }),
  sessionEvent("fixture-edge-session-commit-recovery", {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    timestamp: STATE.updatedAt,
  }),
  sessionEvent("fixture-edge-session-blocked-review", {
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "FLOW_BLOCKED: godot-mcp not reachable for private visual review",
        },
      ],
    },
    timestamp: STATE.updatedAt,
  }),
  sessionEvent("fixture-edge-session-review-requested", {
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "FLOW_REVIEW_REQUESTED: verify touch layout on iPhone safe areas.",
        },
      ],
    },
    timestamp: STATE.updatedAt,
  }),
  sessionEvent("fixture-edge-session-commit-recovery", {
    type: "tool_use",
    id: "fixture-tool-test-1",
    name: "Bash",
    input: { command: "npm test" },
    timestamp: STATE.updatedAt,
  }),
  sessionEvent("fixture-edge-session-commit-recovery", {
    type: "tool_result",
    tool_use_id: "fixture-tool-test-1",
    content: "boom: exit 1",
    is_error: true,
    timestamp: STATE.updatedAt,
  }),
  sessionEvent("fixture-edge-session-merge-verify", {
    type: "stop",
    stop_reason: "end_turn",
    timestamp: STATE.updatedAt,
  }),
];

const EDGE_CASE_DAG = {
  nodes: [...DAG.nodes, ...EDGE_CASE_TASKS.map((task) => task.id)],
  edges: [
    ...DAG.edges,
    ...EDGE_CASE_TASKS.flatMap((task) => task.requires.map((required) => [required, task.id])),
  ],
};

const EDGE_CASE_NOTIFICATIONS = [
  {
    id: "fixture-edge-notification-blocked-review",
    taskId: "fixture-edge-blocked-review",
    sessionId: "fixture-edge-session-blocked-review",
    severity: "blocked",
    title: "Fixture edge: blocked code review",
    body: "FLOW_BLOCKED: godot-mcp not reachable for private visual review",
    createdAt: STATE.updatedAt,
    acknowledged: false,
  },
  {
    id: "fixture-edge-notification-review-requested",
    taskId: "fixture-edge-review-ui-check",
    sessionId: "fixture-edge-session-review-requested",
    severity: "warn",
    title: "Fixture edge: review requested",
    body: "Agent requested review: verify touch layout on iPhone safe areas.",
    createdAt: STATE.updatedAt,
    acknowledged: false,
  },
];

const firstTask = TASKS[0];
const runningTask = TASKS.find((task) => task.status === "running") ?? firstTask;
const readyTask = TASKS.find((task) => task.status === "ready") ?? firstTask;
const firstSession = SESSIONS[0];
const replaySession =
  SESSIONS.find((session) => session.id === SESSION_EVENT_FRAMES[0]?.event.sessionId) ?? firstSession;
const firstNotification = NOTIFICATIONS[0];
const projectError = readJsonl(path.join(FLOW_DIR, "notifications.jsonl"))[0];

export const FLOW_WS_FRAMES = [
  { type: "hello", version: "0.1.0" },
  {
    type: "project.list",
    projects: [
      {
        name: PROJECT.name,
        path: PROJECT.path,
        status: PROJECT.status,
        numTasks: PROJECT.tasks.length,
        lastOpenedAt: STATE.updatedAt,
      },
    ],
  },
  { type: "project.state", project: PROJECT },
  { type: "config", config: CONFIG },
  { type: "config.stages", stages: STAGES },
  { type: "dag", nodes: EDGE_CASE_DAG.nodes, edges: EDGE_CASE_DAG.edges },
  { type: "task.removed", taskId: "fixture-edge-obsolete-task" },
  ...[...SESSIONS, ...EDGE_CASE_SESSIONS].map((session) => ({
    type: "session.started",
    session: startedSession(session),
  })),
  ...SESSION_EVENT_FRAMES,
  ...EDGE_CASE_SESSION_EVENT_FRAMES,
  {
    type: "session.updated",
    session: {
      ...EDGE_CASE_SESSIONS.find((session) => session.id === "fixture-edge-session-merge-verify"),
      tokens: { input: 16000, output: 1800, cacheRead: 72000, cacheCreate: 2200, total: 92000 },
      contextPercentage: 66,
      costUsd: 0.19,
    },
  },
  ...[...SESSIONS, ...EDGE_CASE_SESSIONS].filter((session) => session.status !== "running").map((session) => ({
    type: "session.ended",
    session,
  })),
  ...TASKS.map((task) => ({ type: "task.upsert", task })),
  ...EDGE_CASE_TASKS.map((task) => ({ type: "task.upsert", task })),
  ...[...NOTIFICATIONS, ...EDGE_CASE_NOTIFICATIONS].map((notification) => ({
    type: "notification",
    notification,
  })),
  ...LEARNING_FRAMES,
  {
    type: "error",
    requestId: "project-open-pkmn-t8",
    message: projectError?.body ?? "No downstream Flow error notifications found.",
  },
];

export const FLOW_CLIENT_COMMANDS = [
  { type: "project.list", requestId: "project-list-1" },
  { type: "project.open", path: FLOW_PROJECT_PATH, requestId: "project-open-pkmn-t8" },
  {
    type: "project.create",
    name: "new-flow-project",
    parentDir: path.dirname(FLOW_PROJECT_PATH),
    requestId: "project-create-unsupported",
  },
  { type: "project.close", requestId: "project-close-unsupported" },
  { type: "run.once", requestId: "run-once-1" },
  { type: "run.allOnce", limit: 2, requestId: "run-all-once-1" },
  { type: "run.all", limit: 3, requestId: "run-all-1" },
  { type: "run.cancel", requestId: "run-cancel-1" },
  { type: "task.retry", taskId: readyTask.id, requestId: "task-retry-1" },
  { type: "task.cancel", taskId: runningTask.id, requestId: "task-cancel-1" },
  { type: "task.resume", taskId: readyTask.id, requestId: "task-resume-1" },
  { type: "session.replay", sessionId: replaySession.id, requestId: "session-replay-1" },
  { type: "notification.ack", id: firstNotification?.id ?? "notification-ack", requestId: "notification-ack-1" },
  { type: "config.get", requestId: "config-get-1" },
  { type: "config.update", patch: { retryCount: 1, maxConcurrent: 4 }, requestId: "config-update-1" },
  { type: "config.stages.get", requestId: "config-stages-get-1" },
  {
    type: "config.stages.update",
    stages: { exec: { model: CONFIG.defaults.model, effort: "high" } },
    requestId: "config-stages-update-1",
  },
];

function deriveUiFixture(frames) {
  const tasks = new Map();
  const sessions = new Map();
  const sessionEvents = new Map();
  const notifications = new Map();
  const learnings = [];
  const errors = [];
  let version = null;
  let project = null;
  let config = null;
  let dag = { nodes: [], edges: [] };

  for (const frame of frames) {
    switch (frame.type) {
      case "hello":
        version = frame.version;
        break;
      case "project.state":
        project = frame.project;
        config = frame.project.config;
        dag = frame.project.dag;
        for (const item of frame.project.tasks) tasks.set(item.id, item);
        break;
      case "config":
        config = frame.config;
        break;
      case "dag":
        dag = { nodes: frame.nodes, edges: frame.edges };
        break;
      case "task.upsert":
        tasks.set(frame.task.id, frame.task);
        break;
      case "task.removed":
        tasks.delete(frame.taskId);
        break;
      case "session.started":
      case "session.updated":
      case "session.ended":
        sessions.set(frame.session.id, frame.session);
        break;
      case "session.event": {
        const existing = sessionEvents.get(frame.event.sessionId) ?? [];
        existing.push(frame.event);
        sessionEvents.set(frame.event.sessionId, existing);
        break;
      }
      case "notification":
        notifications.set(frame.notification.id, frame.notification);
        break;
      case "learning":
        learnings.push({
          taskId: frame.taskId,
          path: frame.path,
          markdown: frame.markdown,
        });
        break;
      case "error":
        errors.push(frame);
        break;
      default:
        break;
    }
  }

  const sessionEventsBySessionId = Object.fromEntries(sessionEvents);
  const sessionsByTaskId = {};
  for (const value of sessions.values()) {
    const key = value.taskId ?? "__project__";
    sessionsByTaskId[key] = sessionsByTaskId[key] ?? [];
    sessionsByTaskId[key].push(value);
  }

  return {
    version,
    project,
    config,
    dag,
    tasks: Array.from(tasks.values()),
    sessions: Array.from(sessions.values()),
    sessionsByTaskId,
    sessionEventsBySessionId,
    notifications: Array.from(notifications.values()),
    learnings,
    errors,
    source: {
      projectPath: FLOW_PROJECT_PATH,
      statePath: path.join(FLOW_DIR, "state.json"),
      updatedAt: STATE.updatedAt,
    },
    contractNotes: [
      "Backend project.state currently contains name, path, status, config, tasks, and dag.",
      "Sessions, notifications, learnings, and logs are reconstructed from live or replayed websocket frames.",
      "This fixture is backed by the local pkmn-t8 .flow snapshot, so it reflects the states present in that project.",
      "Synthetic fixture-edge-* frames are layered on top only for contract states absent from the current pkmn-t8 snapshot.",
      "There is no implemented suggestion ServerEvent; do not expect SUGGESTIONS from the backend.",
      "Legacy PROJECTS, HOME_DIRECTORIES, TASK_DETAILS, and aggregate token rows are intentionally absent from backend frames.",
    ],
  };
}

export const FLOW_UI_FIXTURE = deriveUiFixture(FLOW_WS_FRAMES);

export const FLOW_UI_EXAMPLE = {
  FLOW_WS_FRAMES,
  FLOW_CLIENT_COMMANDS,
  FLOW_UI_FIXTURE,
};

if (typeof window !== "undefined") {
  window.FLOW_UI_EXAMPLE = FLOW_UI_EXAMPLE;
}

export default FLOW_UI_EXAMPLE;
