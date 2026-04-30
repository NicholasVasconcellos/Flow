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
  CONFIG: {},
  TASKS: {},
  SESSIONS: {},
  LOG_EVENTS: [],
  NOTIFICATIONS: [],
  LEARNINGS: [],
  SUGGESTIONS: [],
  DAG: { nodes: [], edges: [] },
  TASK_DETAILS: {},
  errors: [],
};

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
 * Count existing sessions for the same (taskId, stage) pair.
 */
function ordinalFor(sessions, taskId, stage) {
  let count = 0;
  for (const s of Object.values(sessions)) {
    if (s.taskId === taskId && s.stage === stage) count++;
  }
  return count + 1;
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
    const tool = payload.name ?? payload.type ?? null;
    const input = payload.input ?? null;
    return { ...base, tool, input };
  }

  if (kind === 'tool_result') {
    const content = payload.content ?? extractContent(payload);
    return { ...base, content };
  }

  // Passthrough for any other kept kinds
  return { ...base, payload };
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
    case 'hello':
      return { ...state, version: frame.version };

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
            phase: task.stage === 'exec' ? 'execute' : task.stage,
            deps: task.requires,
          };
        }
      }

      // Process embedded DAG if present
      let newDagState = state[_RAW_DAG_KEY] ?? { nodes: [], edges: [] };
      if (project.dag) {
        newDagState = { nodes: project.dag.nodes ?? [], edges: project.dag.edges ?? [] };
      }

      const dag = buildDAG(newDagState.nodes, newDagState.edges, newTasks);

      return {
        ...state,
        CONFIG: newConfig,
        TASKS: newTasks,
        DAG: dag,
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
        phase: task.stage === 'exec' ? 'execute' : task.stage,
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

      // Determine ordinal: use wire value if present, else count existing sessions
      const ordinal = raw.ordinal ?? ordinalFor(state.SESSIONS, raw.taskId, raw.stage);
      const name = sessionName(raw.taskId, raw.stage, ordinal);

      const contextPercentage = raw.contextPercentage ?? 0;
      const contextMax = 200_000;
      const contextUsed = Math.round(contextMax * contextPercentage / 100);

      const session = {
        ...state.SESSIONS[id],
        ...raw,
        ordinal,
        name,
        contextUsed,
        contextMax,
        tokens: normalizeTokens(raw.tokens),
      };

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
      const logEvent = buildLogEvent(frame.event);
      if (!logEvent) return state;
      return { ...state, LOG_EVENTS: [...state.LOG_EVENTS, logEvent] };
    }

    // -----------------------------------------------------------------------
    case 'notification': {
      const raw = frame.notification;
      const mapped = mapNotificationSeverity(raw);
      const notification = { ...raw, ...mapped };
      return { ...state, NOTIFICATIONS: [...state.NOTIFICATIONS, notification] };
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
      const err = { requestId: frame.requestId, message: frame.message };
      return { ...state, errors: [...state.errors, err] };
    }

    // -----------------------------------------------------------------------
    default:
      return state;
  }
}
