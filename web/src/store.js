/**
 * Flow UI state accumulator.
 *
 * Exports:
 *   initialState  – the empty state object (no mutations)
 *   applyEvent    – pure function: (state, frame) -> nextState
 */

export const initialState = {
  version: null,
  PROJECTS: [],
  PROJECT_NAME: '',
  PROJECT_PATH: '',
  GIT_REMOTE: null,
  CONFIG: {},
  TASKS: {},
  SESSIONS: {},
  SESSIONS_HYDRATED: false,
  LOG_EVENTS: [],
  NOTIFICATIONS: [],
  NOTIFICATIONS_TRUNCATED: false,
  LEARNINGS: [],
  DAG: { nodes: [], edges: [] },
  TASK_DETAILS: {},
  ARTIFACTS: {},
  SKILLS: {},
  SETUP_NOTES: null,
  INSTRUCTIONS: null,
  PLAN_MD: null,
  // _seenEventKeys is opaque internal state used by the dedup logic that
  // bridges live session.event frames and artifact.chunk session.events
  // replays. Per-session Set; never render from this.
  _seenEventKeys: {},
  SERVER: { version: null, readOnly: false, supportedCommands: [] },
};

// Single source of truth for button-disabling. Empty supportedCommands means
// the server hasn't said hello yet — be permissive so buttons aren't briefly
// disabled on first paint.
export function isCommandAllowed(cmdType, server) {
  if (!server) return true;
  const list = server.supportedCommands;
  if (!Array.isArray(list) || list.length === 0) return true;
  if (!list.includes(cmdType)) return false;
  if (server.readOnly) {
    const READ_ONLY_OK = new Set([
      'project.list',
      'project.open',
      'project.close',
      'artifact.fetch',
      'config.get',
      'config.stages.get',
      'notification.clearAll',
    ]);
    return READ_ONLY_OK.has(cmdType);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Artifact key helpers — keep in lockstep with useArtifact.js. The same
// `${kind}:${stableIds}` form is used as the ARTIFACTS map key and the
// inflight key in the hook.
// ---------------------------------------------------------------------------

export function stableIds(ids) {
  if (!ids || typeof ids !== 'object') return '{}';
  const keys = Object.keys(ids).sort();
  const pairs = keys.map((k) => `${k}=${String(ids[k])}`);
  return `{${pairs.join(',')}}`;
}

export function artifactKey(kind, ids) {
  return `${kind}:${stableIds(ids)}`;
}

// djb2 — small, fast, non-crypto string hash (12 lines, no dep). Used to
// shorten the dedup key so we don't keep an O(payload-size) string per event.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  // Render as unsigned hex so the key is stable across negatives.
  return (h >>> 0).toString(16);
}

function eventDedupKey(event) {
  const { sessionId, ts, kind, payload } = event;
  return `${sessionId}|${ts}|${kind}|${djb2(JSON.stringify(payload ?? null))}`;
}

function mergeTaskDetail(state, taskId, patch) {
  if (!taskId) return state;
  const prev = state.TASK_DETAILS[taskId] ?? {};
  return {
    ...state,
    TASK_DETAILS: { ...state.TASK_DETAILS, [taskId]: { ...prev, ...patch } },
  };
}

function rememberSeenEvent(state, event) {
  const sid = event.sessionId;
  const key = eventDedupKey(event);
  let map = state._seenEventKeys;
  let bucket = map[sid];
  if (!bucket) {
    bucket = new Set();
    map = { ...map, [sid]: bucket };
  }
  if (bucket.has(key)) return null;
  bucket.add(key);
  return map;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Re-join DAG raw nodes/edges with the current TASKS map.
 * rawNodes: string[]
 * rawEdges: [from, to][]
 */
function buildDAG(rawNodes, rawEdges, tasks) {
  const nodes = rawNodes.map((id) => {
    const task = tasks[id];
    return { id, status: task?.status ?? null, stage: task?.stage ?? null };
  });
  const edges = rawEdges.map(([from, to]) => ({ from, to }));
  return { nodes, edges };
}

/**
 * Pick the next ordinal for `(taskId, stage)` based on the highest ordinal
 * already seen for that pair. Reading max(ordinal)+1 instead of count+1
 * survives an out-of-order partial load: if frames arrive for ordinal
 * 3 before ordinal 1, count-based numbering would re-issue 1 (collision)
 * while max+1 correctly produces 4. Server-assigned ordinals on each
 * session are the source of truth; this fallback only kicks in when a
 * session arrives without one.
 */
function ordinalFor(sessions, taskId, stage) {
  let max = 0;
  for (const s of Object.values(sessions)) {
    if (s.taskId !== taskId || s.stage !== stage) continue;
    if (typeof s.ordinal === "number" && s.ordinal > max) max = s.ordinal;
  }
  return max + 1;
}

/**
 * Derive the display name for a session.
 * Pattern: "<taskId|'global'>:<stage>-run-<ordinal>"
 */
function sessionName(taskId, stage, ordinal) {
  const prefix = taskId ?? 'global';
  return `${prefix}:${stage}-run-${ordinal}`;
}

/**
 * Rename cacheCreate -> cacheWrite inside a tokens object.
 */
function normalizeTokens(tokens) {
  if (!tokens) return tokens;
  const { cacheCreate, ...rest } = tokens;
  const out = { ...rest };
  if (cacheCreate !== undefined) out.cacheWrite = cacheCreate;
  return out;
}

/**
 * Apply UI-shape transforms to a raw wire session: ordinal, display name,
 * context window derivation, token field renames. Used by both the
 * project.state snapshot merge and session.started/updated handlers so the
 * shape stays in lockstep.
 */
function hydrateSession(state, raw) {
  const id = raw.id;
  const existing = state.SESSIONS[id] ?? {};
  const ordinal =
    raw.ordinal ?? existing.ordinal ?? ordinalFor(state.SESSIONS, raw.taskId, raw.stage);
  const name = sessionName(raw.taskId, raw.stage, ordinal);
  const contextPercentage = raw.contextPercentage ?? existing.contextPercentage ?? 0;
  const contextMax = 200_000;
  const contextUsed = Math.round((contextMax * contextPercentage) / 100);
  return {
    ...existing,
    ...raw,
    ordinal,
    name,
    contextUsed,
    contextMax,
    tokens: normalizeTokens(raw.tokens) ?? existing.tokens,
  };
}

/**
 * Apply severity mapping to a raw notification.
 * Returns { severity, kind }
 */
function mapNotificationSeverity(raw) {
  const { severity, title = '', body = '' } = raw;

  if (severity === 'error' && /paused at /.test(title)) {
    return { severity: 'blocked', kind: 'task.blocked' };
  }
  if (severity === 'blocked') {
    return { severity: 'blocked', kind: 'task.blocked' };
  }
  if (severity === 'warn' && /FLOW_REVIEW|review/i.test(body)) {
    return { severity: 'review-requested', kind: 'review.requested' };
  }
  if (severity === 'warn' && /rate.?limit|retry|transient/i.test(body)) {
    return { severity: 'transient', kind: 'session.transient' };
  }
  if (severity === 'warn') {
    return { severity: 'needs-decision', kind: 'decision.required' };
  }
  // info (and any unmapped)
  return { severity: 'transient', kind: 'session.transient' };
}

/**
 * Parse a learning markdown string into { title, body, tags }.
 */
function parseLearning(markdown) {
  const lines = markdown.split('\n');
  let title = '';
  const bodyLines = [];

  for (const line of lines) {
    if (!title && line.trimStart().startsWith('#')) {
      title = line.replace(/^#+\s*/, '').trim();
    } else if (line.trim() !== '') {
      bodyLines.push(line);
    }
  }

  // If no heading found, first non-empty line becomes the title
  if (!title && bodyLines.length > 0) {
    title = bodyLines.shift();
  }

  const body = bodyLines.join('\n').trim();

  // Words starting with # in body are tags
  const tags = [];
  for (const word of body.split(/\s+/)) {
    if (word.startsWith('#') && word.length > 1) {
      tags.push(word.slice(1));
    }
  }

  return { title, body, tags };
}

/**
 * Build a LOG_EVENT from a session.event frame.
 * Returns null for kinds that should be dropped (system, usage, stop).
 */
function buildLogEvent(event) {
  const { sessionId, ts, kind, payload = {} } = event;

  // Drop these
  if (kind === 'system' || kind === 'usage' || kind === 'stop') return null;

  const base = { sessionId, ts, kind };

  // assistant_thinking -> assistant_text with thinking: true
  if (kind === 'assistant_thinking') {
    const content = extractContent(payload);
    return { ...base, kind: 'assistant_text', thinking: true, content };
  }

  if (kind === 'assistant_text') {
    const content = extractContent(payload);
    return { ...base, content };
  }

  if (kind === 'tool_use') {
    // Wire payload is usually `{type:"assistant", message:{content:[{type:"tool_use", id, name, input}, ...]}}`.
    // Top-level `{type:"tool_use", ...}` shape is also possible — fall back to it.
    const block = findContentBlock(payload, (b) => b?.type === 'tool_use');
    const tool = block?.name ?? payload.name ?? null;
    const input = block?.input ?? payload.input ?? null;
    const toolUseId = block?.id ?? payload.id ?? null;
    return { ...base, tool, input, toolUseId };
  }

  if (kind === 'tool_result') {
    const result = payload.tool_use_result ?? null;
    const block = findContentBlock(payload, (b) => b?.type === 'tool_result');
    let content = null;
    if (block) {
      content = typeof block.content === 'string'
        ? block.content
        : block.content != null ? JSON.stringify(block.content) : null;
    }
    if (content == null) content = payload.content ?? extractContent(payload);
    const toolUseId = block?.tool_use_id ?? payload.tool_use_id ?? null;
    const isError = block?.is_error === true || result?.is_error === true;
    return { ...base, result, content, toolUseId, isError };
  }

  // Passthrough for any other kept kinds
  return { ...base, payload };
}

/**
 * Find the first block in `payload.message.content` (or `payload.content`)
 * matching `predicate`. Returns null if none.
 */
function findContentBlock(payload, predicate) {
  const msgArr = payload?.message?.content;
  if (Array.isArray(msgArr)) {
    const block = msgArr.find(predicate);
    if (block) return block;
  }
  const arr = payload?.content;
  if (Array.isArray(arr)) {
    const block = arr.find(predicate);
    if (block) return block;
  }
  return null;
}

/**
 * Extract text content from a payload that may have a message.content array
 * or a direct content field.
 */
function extractContent(payload) {
  if (payload.message?.content) {
    const msgContent = payload.message.content;
    if (Array.isArray(msgContent)) {
      // Find text or thinking content block
      const block = msgContent.find(
        (b) => b.type === 'text' || b.type === 'thinking',
      );
      return block?.text ?? block?.thinking ?? null;
    }
    return String(msgContent);
  }
  if (payload.content !== undefined) return payload.content;
  return null;
}

// ---------------------------------------------------------------------------
// Stored raw DAG (nodes/edges as strings) for re-joining when tasks change
// ---------------------------------------------------------------------------
const _RAW_DAG_KEY = '__rawDag';

export function applyEvent(state, frame) {
  const { type } = frame;

  switch (type) {
    // -----------------------------------------------------------------------
    case 'hello': {
      const cap = frame.capabilities ?? {};
      return {
        ...state,
        version: frame.version,
        SERVER: {
          version: frame.version ?? null,
          readOnly: !!cap.readOnly,
          supportedCommands: Array.isArray(cap.supportedCommands)
            ? cap.supportedCommands
            : [],
        },
      };
    }

    // -----------------------------------------------------------------------
    case 'project.list':
      return { ...state, PROJECTS: frame.projects };

    // -----------------------------------------------------------------------
    case 'project.state': {
      const { project } = frame;
      // Merge config
      const newConfig = project.config
        ? { ...state.CONFIG, ...project.config }
        : state.CONFIG;

      // Merge tasks from project.state (treat each task as a task.upsert)
      let newTasks = { ...state.TASKS };
      if (Array.isArray(project.tasks)) {
        for (const task of project.tasks) {
          newTasks[task.id] = {
            ...newTasks[task.id],
            ...task,
            deps: task.requires,
          };
        }
      }

      // Merge sessions from project.state. Replays historical sessions on
      // (re)connect so the UI doesn't lose them between WS opens. Does NOT
      // synthesize prompt LOG_EVENTS — that is session.started-only behavior.
      let newSessions = state.SESSIONS;
      if (Array.isArray(project.sessions)) {
        newSessions = { ...state.SESSIONS };
        let working = { SESSIONS: newSessions };
        for (const raw of project.sessions) {
          newSessions[raw.id] = hydrateSession(working, raw);
        }
      }

      // Process embedded DAG if present
      let newDagState = state[_RAW_DAG_KEY] ?? { nodes: [], edges: [] };
      if (project.dag) {
        newDagState = { nodes: project.dag.nodes ?? [], edges: project.dag.edges ?? [] };
      }

      const dag = buildDAG(newDagState.nodes, newDagState.edges, newTasks);

      // Cold-load inlines (Step 4): notifications/learnings/taskArtifacts. Each
      // merges idempotently with prior state so a re-emitted project.state
      // (e.g. on reconnect) does not duplicate.
      let newNotifications = state.NOTIFICATIONS;
      let newNotificationsTruncated = state.NOTIFICATIONS_TRUNCATED ?? false;
      if (Array.isArray(project.notifications) && project.notifications.length > 0) {
        const seenIds = new Set(state.NOTIFICATIONS.map((n) => n.id));
        const additions = [];
        for (const raw of project.notifications) {
          if (seenIds.has(raw.id)) continue;
          seenIds.add(raw.id);
          const mapped = mapNotificationSeverity(raw);
          additions.push({ ...raw, ...mapped });
        }
        if (additions.length > 0) newNotifications = [...state.NOTIFICATIONS, ...additions];
      }
      if (typeof project.notificationsTruncated === 'boolean') {
        newNotificationsTruncated = project.notificationsTruncated;
      }

      let newLearnings = state.LEARNINGS;
      if (Array.isArray(project.learnings) && project.learnings.length > 0) {
        const seenPaths = new Set(state.LEARNINGS.map((l) => l.path));
        const additions = [];
        for (const raw of project.learnings) {
          if (seenPaths.has(raw.path)) continue;
          seenPaths.add(raw.path);
          const parsed = parseLearning(raw.markdown ?? '');
          additions.push({ ...raw, ...parsed });
        }
        if (additions.length > 0) newLearnings = [...state.LEARNINGS, ...additions];
      }

      let newTaskDetails = state.TASK_DETAILS;
      if (project.taskArtifacts && typeof project.taskArtifacts === 'object') {
        const next = { ...state.TASK_DETAILS };
        for (const [taskId, artifacts] of Object.entries(project.taskArtifacts)) {
          next[taskId] = { ...(next[taskId] ?? {}), ...artifacts };
        }
        newTaskDetails = next;
      }

      return {
        ...state,
        PROJECT_NAME: project.name ?? state.PROJECT_NAME,
        PROJECT_PATH: project.path ?? state.PROJECT_PATH,
        GIT_REMOTE: project.gitRemote ?? null,
        CONFIG: newConfig,
        TASKS: newTasks,
        SESSIONS: newSessions,
        SESSIONS_HYDRATED: true,
        DAG: dag,
        NOTIFICATIONS: newNotifications,
        NOTIFICATIONS_TRUNCATED: newNotificationsTruncated,
        LEARNINGS: newLearnings,
        TASK_DETAILS: newTaskDetails,
        [_RAW_DAG_KEY]: newDagState,
      };
    }

    // -----------------------------------------------------------------------
    case 'config':
      return { ...state, CONFIG: { ...state.CONFIG, ...frame.config } };

    // -----------------------------------------------------------------------
    case 'config.stages':
      return {
        ...state,
        CONFIG: {
          ...state.CONFIG,
          stages: { ...(state.CONFIG.stages ?? {}), ...frame.stages },
        },
      };

    // -----------------------------------------------------------------------
    case 'dag': {
      const rawDag = { nodes: frame.nodes ?? [], edges: frame.edges ?? [] };
      const dag = buildDAG(rawDag.nodes, rawDag.edges, state.TASKS);
      return { ...state, DAG: dag, [_RAW_DAG_KEY]: rawDag };
    }

    // -----------------------------------------------------------------------
    case 'task.upsert': {
      const { task } = frame;
      const prev = state.TASKS[task.id] ?? {};
      const newTask = {
        ...prev,
        ...task,
        deps: task.requires,
      };
      const newTasks = { ...state.TASKS, [task.id]: newTask };

      // Re-join DAG if we have one
      const rawDag = state[_RAW_DAG_KEY] ?? { nodes: [], edges: [] };
      const dag = rawDag.nodes.length > 0
        ? buildDAG(rawDag.nodes, rawDag.edges, newTasks)
        : state.DAG;

      return { ...state, TASKS: newTasks, DAG: dag };
    }

    // -----------------------------------------------------------------------
    case 'task.removed': {
      const { [frame.taskId]: _removed, ...newTasks } = state.TASKS;
      const rawDag = state[_RAW_DAG_KEY] ?? { nodes: [], edges: [] };
      const dag = rawDag.nodes.length > 0
        ? buildDAG(rawDag.nodes, rawDag.edges, newTasks)
        : state.DAG;
      return { ...state, TASKS: newTasks, DAG: dag };
    }

    // -----------------------------------------------------------------------
    case 'session.started': {
      const raw = frame.session;
      const id = raw.id;
      const session = hydrateSession(state, raw);
      const newSessions = { ...state.SESSIONS, [id]: session };

      // Synthesize a user LOG_EVENT from the prompt
      const userEvent = {
        id: `evt-${id}-prompt`,
        sessionId: id,
        ts: raw.startedAt,
        kind: 'user',
        content: raw.prompt ?? null,
      };

      return {
        ...state,
        SESSIONS: newSessions,
        LOG_EVENTS: [...state.LOG_EVENTS, userEvent],
      };
    }

    // -----------------------------------------------------------------------
    case 'session.updated': {
      const raw = frame.session;
      const id = raw.id;
      const existing = state.SESSIONS[id] ?? {};

      // Update ordinal if it arrives on wire
      const ordinal = raw.ordinal ?? existing.ordinal;
      const name = ordinal != null
        ? sessionName(raw.taskId ?? existing.taskId, raw.stage ?? existing.stage, ordinal)
        : existing.name;

      const contextPercentage = raw.contextPercentage ?? existing.contextPercentage ?? 0;
      const contextMax = 200_000;
      const contextUsed = Math.round(contextMax * contextPercentage / 100);

      const session = {
        ...existing,
        ...raw,
        ordinal,
        name,
        contextUsed,
        contextMax,
        tokens: raw.tokens ? normalizeTokens(raw.tokens) : existing.tokens,
      };

      return { ...state, SESSIONS: { ...state.SESSIONS, [id]: session } };
    }

    // -----------------------------------------------------------------------
    case 'session.ended': {
      const raw = frame.session;
      const id = raw.id;
      const existing = state.SESSIONS[id] ?? {};

      const session = {
        ...existing,
        ...raw,
        tokens: raw.tokens ? normalizeTokens(raw.tokens) : existing.tokens,
      };

      return { ...state, SESSIONS: { ...state.SESSIONS, [id]: session } };
    }

    // -----------------------------------------------------------------------
    case 'session.event': {
      const event = frame.event;
      const nextSeen = rememberSeenEvent(state, event);
      // Already seen via this or a prior artifact replay — drop silently.
      if (nextSeen === null) return state;
      const logEvent = buildLogEvent(event);
      if (!logEvent) {
        // Buildable kinds are dropped (system/usage/stop) but we still want
        // the dedup map updated so a later artifact.chunk for the same line
        // doesn't slip through.
        return { ...state, _seenEventKeys: nextSeen };
      }
      const withId = { id: `evt-${state.LOG_EVENTS.length}`, ...logEvent };
      return {
        ...state,
        LOG_EVENTS: [...state.LOG_EVENTS, withId],
        _seenEventKeys: nextSeen,
      };
    }

    // -----------------------------------------------------------------------
    // Artifact streaming — wire family complementing live event broadcasts.
    // 'artifact.fetch.start' is a synthetic frame dispatched by useArtifact
    // before sending the wire command, so subsequent useArtifact calls for
    // the same key see status='loading' and skip re-fetching.
    case 'artifact.fetch.start': {
      const key = artifactKey(frame.kind, frame.ids);
      return {
        ...state,
        ARTIFACTS: {
          ...state.ARTIFACTS,
          [key]: { status: 'loading', kind: frame.kind, ids: frame.ids },
        },
      };
    }

    case 'artifact.chunk': {
      const { kind, ids, payload } = frame;
      switch (kind) {
        case 'session.events': {
          // payload is a SessionEvent — route through the same buildLogEvent +
          // dedup machinery as live session.event frames.
          const nextSeen = rememberSeenEvent(state, payload);
          if (nextSeen === null) return state;
          const logEvent = buildLogEvent(payload);
          if (!logEvent) return { ...state, _seenEventKeys: nextSeen };
          const withId = { id: `evt-${state.LOG_EVENTS.length}`, ...logEvent };
          return {
            ...state,
            LOG_EVENTS: [...state.LOG_EVENTS, withId],
            _seenEventKeys: nextSeen,
          };
        }
        case 'project.notifications': {
          // Each chunk is one Notification. Dedup by id; live notification
          // frames may already have appended the same row.
          const seen = new Set(state.NOTIFICATIONS.map((n) => n.id));
          if (seen.has(payload.id)) return state;
          const mapped = mapNotificationSeverity(payload);
          return {
            ...state,
            NOTIFICATIONS: [...state.NOTIFICATIONS, { ...payload, ...mapped }],
          };
        }
        case 'project.learnings': {
          const seen = new Set(state.LEARNINGS.map((l) => l.path));
          if (seen.has(payload.path)) return state;
          const parsed = parseLearning(payload.markdown ?? '');
          return {
            ...state,
            LEARNINGS: [...state.LEARNINGS, { ...payload, ...parsed }],
          };
        }
        case 'project.skill':
          return {
            ...state,
            SKILLS: { ...state.SKILLS, [payload.name]: payload.body ?? '' },
          };
        case 'project.skills.list':
          return {
            ...state,
            SKILLS: state.SKILLS[payload.name] !== undefined
              ? state.SKILLS
              : { ...state.SKILLS, [payload.name]: null },
          };
        case 'project.setup-notes':
          return { ...state, SETUP_NOTES: payload.body ?? '' };
        case 'project.instructions':
          return { ...state, INSTRUCTIONS: payload.body ?? '' };
        case 'project.plan-md':
          return { ...state, PLAN_MD: payload.body ?? '' };
        case 'task.progress':
          return mergeTaskDetail(state, ids.taskId, { progress: payload.body ?? '' });
        case 'task.summary':
          return mergeTaskDetail(state, ids.taskId, { summary: payload.body ?? '' });
        case 'task.learnings-draft':
          return mergeTaskDetail(state, ids.taskId, { learningsDraft: payload.body ?? '' });
        case 'task.round-issues': {
          const prev = state.TASK_DETAILS[ids.taskId] ?? {};
          const prevBodies = prev.roundIssuesBodies ?? {};
          return mergeTaskDetail(state, ids.taskId, {
            roundIssuesBodies: { ...prevBodies, [payload.round]: payload.body ?? '' },
          });
        }
        case 'task.verify-log':
          return mergeTaskDetail(state, ids.taskId, { verifyLog: payload.body ?? '' });
        case 'task.screenshot': {
          const prev = state.TASK_DETAILS[ids.taskId] ?? {};
          const prevBlobs = prev.screenshotBlobs ?? {};
          return mergeTaskDetail(state, ids.taskId, {
            screenshotBlobs: { ...prevBlobs, [payload.filename]: payload.base64 },
          });
        }
        default:
          return state;
      }
    }

    case 'artifact.end': {
      const key = artifactKey(frame.kind, frame.ids);
      const prev = state.ARTIFACTS[key];
      return {
        ...state,
        ARTIFACTS: {
          ...state.ARTIFACTS,
          [key]: { ...(prev ?? {}), status: 'loaded', kind: frame.kind, ids: frame.ids },
        },
      };
    }

    case 'artifact.error': {
      const key = artifactKey(frame.kind, frame.ids);
      return {
        ...state,
        ARTIFACTS: {
          ...state.ARTIFACTS,
          [key]: {
            status: 'error',
            kind: frame.kind,
            ids: frame.ids,
            error: frame.message,
          },
        },
      };
    }

    // -----------------------------------------------------------------------
    case 'notification': {
      const raw = frame.notification;
      const mapped = mapNotificationSeverity(raw);
      const notification = { ...raw, ...mapped };
      return { ...state, NOTIFICATIONS: [...state.NOTIFICATIONS, notification] };
    }

    // -----------------------------------------------------------------------
    case 'notifications.cleared': {
      return { ...state, NOTIFICATIONS: [], NOTIFICATIONS_TRUNCATED: false };
    }

    // -----------------------------------------------------------------------
    case 'learning': {
      const { taskId, path, markdown } = frame;
      const parsed = parseLearning(markdown);
      const learning = { taskId, path, markdown, ...parsed };
      return { ...state, LEARNINGS: [...state.LEARNINGS, learning] };
    }

    // -----------------------------------------------------------------------
    case 'error': {
      // `error` frames now only fire for protocol-level parse failures (the
      // requestId may not even be known). Surface to console for triage and
      // pass state through unchanged — the toast layer handles user-visible
      // command failures via command.result.
      // eslint-disable-next-line no-console
      console.warn('ws error frame:', frame.message, frame.requestId ?? '(no requestId)');
      return state;
    }

    // -----------------------------------------------------------------------
    default:
      return state;
  }
}
