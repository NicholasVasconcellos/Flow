import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';

import { initialState, applyEvent, artifactKey } from '../src/store.js';

// ---------------------------------------------------------------------------
// Load snapshot and build full-replay state
// ---------------------------------------------------------------------------
const snapshot = JSON.parse(
  readFileSync(new URL('../public/flow-ui-payload.snapshot.json', import.meta.url)),
);
const frames = snapshot.FLOW_WS_FRAMES;

/** Replay all frames from initialState */
function replayAll() {
  return frames.reduce((state, frame) => applyEvent(state, frame), initialState);
}

/** Replay frames up to (but not including) the first frame matching a predicate */
function replayUntil(pred) {
  let state = initialState;
  for (const frame of frames) {
    if (pred(frame)) break;
    state = applyEvent(state, frame);
  }
  return state;
}

const fullState = replayAll();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. hello frame sets state.version', () => {
  const helloFrame = frames.find((f) => f.type === 'hello');
  const s = applyEvent(initialState, helloFrame);
  assert.strictEqual(s.version, '0.1.0');
});

test('2. project.list sets PROJECTS array', () => {
  const frame = frames.find((f) => f.type === 'project.list');
  const s = applyEvent(initialState, frame);
  assert.ok(Array.isArray(s.PROJECTS), 'PROJECTS should be an array');
  assert.ok(s.PROJECTS.length > 0, 'PROJECTS should be non-empty');
  assert.ok(s.PROJECTS[0].name, 'project should have a name');
});

test('3. config frame populates CONFIG with expected fields', () => {
  const frame = frames.find((f) => f.type === 'config');
  const s = applyEvent(initialState, frame);
  assert.ok(s.CONFIG.maxConcurrent !== undefined, 'CONFIG.maxConcurrent should exist');
  assert.ok(s.CONFIG.defaults !== undefined, 'CONFIG.defaults should exist');
  assert.ok(s.CONFIG.git !== undefined, 'CONFIG.git should exist');
});

test('4. task.upsert — TASKS has >= 100 entries after full replay', () => {
  const count = Object.keys(fullState.TASKS).length;
  assert.ok(count >= 100, `expected >= 100 tasks, got ${count}`);
});

test('5. task.removed — fixture-edge-obsolete-task not in TASKS after full replay', () => {
  assert.ok(
    !('fixture-edge-obsolete-task' in fullState.TASKS),
    'fixture-edge-obsolete-task should have been removed',
  );
});

test('6. DAG join — DAG.nodes has objects with id, status, stage (not plain strings)', () => {
  assert.ok(Array.isArray(fullState.DAG.nodes), 'DAG.nodes should be an array');
  assert.ok(fullState.DAG.nodes.length > 0, 'DAG.nodes should be non-empty');
  const node = fullState.DAG.nodes[0];
  assert.ok(typeof node === 'object' && node !== null, 'node should be an object');
  assert.ok('id' in node, 'node should have id');
  assert.ok('status' in node, 'node should have status');
  assert.ok('stage' in node, 'node should have stage');
  // Edges should be {from, to} objects
  if (fullState.DAG.edges.length > 0) {
    const edge = fullState.DAG.edges[0];
    assert.ok('from' in edge && 'to' in edge, 'edge should have from and to');
  }
});

test('7. session accumulation — sessions have tokens.cacheWrite (not cacheCreate)', () => {
  const sessions = Object.values(fullState.SESSIONS);
  assert.ok(sessions.length > 0, 'SESSIONS should be non-empty');

  const withTokens = sessions.filter((s) => s.tokens != null);
  assert.ok(withTokens.length > 0, 'some sessions should have tokens');

  // cacheCreate should never appear; cacheWrite should appear on sessions that had
  // non-zero cache creation
  for (const s of withTokens) {
    assert.ok(
      !('cacheCreate' in (s.tokens ?? {})),
      `session ${s.id} should not have cacheCreate on tokens`,
    );
  }

  const withCacheWrite = withTokens.filter((s) => (s.tokens?.cacheWrite ?? 0) > 0);
  assert.ok(withCacheWrite.length > 0, 'at least one session should have tokens.cacheWrite > 0');
});

test('8. session name — at least one session has name matching /<prefix>:<stage>-run-<n>/', () => {
  const sessions = Object.values(fullState.SESSIONS);
  const namePattern = /^[\w-]+:[\w_-]+-run-\d+$/;
  const withName = sessions.filter((s) => s.name && namePattern.test(s.name));
  assert.ok(withName.length > 0, `no session matched name pattern. sample names: ${sessions.slice(0,3).map(s=>s.name).join(', ')}`);
});

test('9. contextUsed — at least one session has contextUsed > 0 and contextMax === 200_000', () => {
  const sessions = Object.values(fullState.SESSIONS);
  const withCtx = sessions.filter((s) => s.contextUsed > 0 && s.contextMax === 200_000);
  assert.ok(withCtx.length > 0, 'expected at least one session with contextUsed > 0');
});

test('10. LOG_EVENTS kinds — no system, usage, or stop kinds', () => {
  const forbidden = new Set(['system', 'usage', 'stop']);
  for (const evt of fullState.LOG_EVENTS) {
    assert.ok(
      !forbidden.has(evt.kind),
      `LOG_EVENTS should not contain kind '${evt.kind}'`,
    );
  }
});

test('11. LOG_EVENTS contains at least one user event', () => {
  const userEvents = fullState.LOG_EVENTS.filter((e) => e.kind === 'user');
  assert.ok(userEvents.length > 0, 'expected at least one user log event');
  assert.ok(userEvents[0].content != null, 'user event should have content');
});

test('12. notification severity mapping', () => {
  // 18 from live notification frames + 2 inlined via project.state in step 5 = 20:
  //   - error + "paused at" in title -> blocked (16 + 1 inlined = 17)
  //   - blocked severity -> blocked (1 = 1)
  //   - warn + review in body -> review-requested (1 + 1 inlined = 2)
  const notifs = fullState.NOTIFICATIONS;
  assert.strictEqual(notifs.length, 20, 'should have 20 notifications');

  const blocked = notifs.filter((n) => n.severity === 'blocked');
  const reviewRequested = notifs.filter((n) => n.severity === 'review-requested');

  assert.strictEqual(blocked.length, 18, `expected 18 blocked notifications, got ${blocked.length}`);
  assert.strictEqual(reviewRequested.length, 2, `expected 2 review-requested notifications, got ${reviewRequested.length}`);

  // kind field should be set
  blocked.forEach((n) => assert.strictEqual(n.kind, 'task.blocked'));
  reviewRequested.forEach((n) => assert.strictEqual(n.kind, 'review.requested'));
});

test('13. learnings parsed — at least one learning has title, body, tags', () => {
  assert.ok(fullState.LEARNINGS.length > 0, 'should have learnings');
  const learning = fullState.LEARNINGS[0];
  assert.ok(typeof learning.title === 'string', 'learning.title should be a string');
  assert.ok(typeof learning.body === 'string', 'learning.body should be a string');
  assert.ok(Array.isArray(learning.tags), 'learning.tags should be an array');
});

// ---------------------------------------------------------------------------
// Artifact streaming + dedup (Step 3)
// ---------------------------------------------------------------------------

test('14. artifact.chunk session.events appends a replayed event into LOG_EVENTS', () => {
  const replayed = fullState.LOG_EVENTS.find(
    (e) =>
      e.kind === 'assistant_text' &&
      typeof e.content === 'string' &&
      e.content.includes('replayed historical event'),
  );
  assert.ok(replayed, 'expected the replayed event from the fixture artifact.chunk to be present in LOG_EVENTS');
});

test('15. session.event + artifact.chunk dedup — duplicate of a live event drops the chunk copy', () => {
  // The fixture appends a duplicate of an existing live session.event as an
  // artifact.chunk (the assistant_text "I'll run a comprehensive pre-execution
  // discovery on this project."). After full replay that exact event (matched
  // by content) must appear exactly once. Note: the same (sessionId, ts) tuple
  // can host multiple distinct events — dedup is on the full payload hash, not
  // just (sid, ts).
  const sid = '01KPZ39SF2PGX50Z5BDB64BJYQ';
  const matches = fullState.LOG_EVENTS.filter(
    (e) =>
      e.sessionId === sid &&
      e.kind === 'assistant_text' &&
      typeof e.content === 'string' &&
      e.content.startsWith("I'll run a comprehensive pre-execution discovery"),
  );
  assert.strictEqual(
    matches.length,
    1,
    `expected dedup to leave exactly 1 copy, got ${matches.length}`,
  );
});

test('16. artifact.end transitions ARTIFACTS[key].status to "loaded"', () => {
  const key = artifactKey('session.events', { sessionId: '01KPZ39SF2PGX50Z5BDB64BJYQ' });
  const entry = fullState.ARTIFACTS[key];
  assert.ok(entry, `expected ARTIFACTS["${key}"] to be set`);
  assert.strictEqual(entry.status, 'loaded');
});

test('17. artifact.chunk arriving before any live frames still dedups subsequent dups', () => {
  // Synthetic — exercises the dedup map even when artifact arrives FIRST.
  let s = initialState;
  const sid = 'syn-S';
  const ev = { sessionId: sid, ts: '2026-04-30T00:00:00Z', kind: 'assistant_text', payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } };
  s = applyEvent(s, { type: 'artifact.chunk', fetchId: 'a', kind: 'session.events', ids: { sessionId: sid }, payload: ev });
  s = applyEvent(s, { type: 'session.event', event: ev });
  const matches = s.LOG_EVENTS.filter((e) => e.sessionId === sid);
  assert.strictEqual(matches.length, 1, 'live duplicate of an already-replayed artifact event must be dropped');
});

test('18. artifact.error sets ARTIFACTS[key].status to "error" with message', () => {
  const ids = { sessionId: 'never-existed' };
  const s = applyEvent(initialState, {
    type: 'artifact.error',
    fetchId: 'x',
    kind: 'session.events',
    ids,
    message: 'boom',
  });
  const entry = s.ARTIFACTS[artifactKey('session.events', ids)];
  assert.strictEqual(entry.status, 'error');
  assert.strictEqual(entry.error, 'boom');
});

// ---------------------------------------------------------------------------
// Step 5: project.state inlines (notifications/learnings/taskArtifacts)
// ---------------------------------------------------------------------------

test('20. project.state inlines — TASK_DETAILS hydrated from project.taskArtifacts', () => {
  const td = fullState.TASK_DETAILS['initialize-godot-project-with-basic-configuration'];
  assert.ok(td, 'expected fixture task to have TASK_DETAILS entry from project.state inline');
  assert.strictEqual(td.progress, 'in progress');
  assert.strictEqual(td.summary, 'all done');
  assert.strictEqual(td.learningsDraft, 'draft');
  assert.strictEqual(td.verifyLogPresent, true);
});

test('21. project.state inlines — NOTIFICATIONS contains hydrated entries with severity mapping', () => {
  const fix1 = fullState.NOTIFICATIONS.find((n) => n.id === 'fix-N1');
  assert.ok(fix1, 'expected fix-N1 to be hydrated from project.notifications');
  assert.strictEqual(fix1.severity, 'blocked');
  assert.strictEqual(fix1.kind, 'task.blocked');
});

test('22. project.state idempotency — re-emitting does not duplicate notifications', () => {
  const psFrame = JSON.parse(JSON.stringify(frames.find((f) => f.type === 'project.state')));
  const before = fullState.NOTIFICATIONS.length;
  const after = applyEvent(fullState, psFrame).NOTIFICATIONS.length;
  assert.strictEqual(after, before, 'NOTIFICATIONS must dedup by id across project.state replays');
});

test('23. NOTIFICATIONS_TRUNCATED is hydrated from project.notificationsTruncated', () => {
  assert.strictEqual(fullState.NOTIFICATIONS_TRUNCATED, true);
});

test('19. artifact.fetch.start synchronous guard — second mount sees status=loading', () => {
  // useArtifact dispatches `artifact.fetch.start` synchronously before sending
  // the WS command, so a sibling hook instance mounting in the same tick
  // (StrictMode dual-mount) sees ARTIFACTS[key].status === 'loading' and skips.
  // The hook also has a module-scope inflight Map as a redundant guard, but
  // this test pins the reducer-level guarantee.
  const ids = { sessionId: 'sync-S1' };
  const s = applyEvent(initialState, { type: 'artifact.fetch.start', kind: 'session.events', ids });
  const entry = s.ARTIFACTS[artifactKey('session.events', ids)];
  assert.strictEqual(entry.status, 'loading');
});

// ---------------------------------------------------------------------------
// Step 6: per-kind chunk routing into store slices
// ---------------------------------------------------------------------------

function chunk(kind, ids, payload) {
  return { type: 'artifact.chunk', fetchId: 'f', kind, ids, payload };
}

test('24. project.notifications chunk merges with id dedup', () => {
  let s = applyEvent(initialState, { type: 'notification', notification: { id: 'A', severity: 'info', title: 't', body: '', createdAt: '2026-01-01', acknowledged: false } });
  s = applyEvent(s, chunk('project.notifications', {}, { id: 'A', severity: 'info', title: 't', body: '', createdAt: '2026-01-01', acknowledged: false }));
  s = applyEvent(s, chunk('project.notifications', {}, { id: 'B', severity: 'warn', title: 'review', body: 'FLOW_REVIEW please', createdAt: '2026-01-02', acknowledged: false }));
  assert.strictEqual(s.NOTIFICATIONS.length, 2);
  const b = s.NOTIFICATIONS.find((n) => n.id === 'B');
  assert.strictEqual(b.severity, 'review-requested');
});

test('25. project.learnings chunk merges with path dedup + parses', () => {
  let s = applyEvent(initialState, chunk('project.learnings', {}, { taskId: 't1', path: '/p/t1.md', markdown: '# Title\nbody #tag-x' }));
  s = applyEvent(s, chunk('project.learnings', {}, { taskId: 't1', path: '/p/t1.md', markdown: '# Title\nbody #tag-x' })); // duplicate
  assert.strictEqual(s.LEARNINGS.length, 1);
  assert.strictEqual(s.LEARNINGS[0].title, 'Title');
  assert.deepStrictEqual(s.LEARNINGS[0].tags, ['tag-x']);
});

test('26. project.skill / project.skills.list populate SKILLS slice', () => {
  let s = applyEvent(initialState, chunk('project.skills.list', {}, { name: 'spec' }));
  s = applyEvent(s, chunk('project.skills.list', {}, { name: 'exec' }));
  s = applyEvent(s, chunk('project.skill', { name: 'spec' }, { name: 'spec', body: '# spec body' }));
  assert.strictEqual(s.SKILLS['spec'], '# spec body');
  // skills.list adds null placeholder; project.skill overwrites with body.
  assert.strictEqual(s.SKILLS['exec'], null);
});

test('27. project text bodies populate top-level slices', () => {
  let s = applyEvent(initialState, chunk('project.setup-notes', {}, { body: 'setup' }));
  s = applyEvent(s, chunk('project.instructions', {}, { body: 'inst' }));
  s = applyEvent(s, chunk('project.plan-md', {}, { body: 'plan' }));
  assert.strictEqual(s.SETUP_NOTES, 'setup');
  assert.strictEqual(s.INSTRUCTIONS, 'inst');
  assert.strictEqual(s.PLAN_MD, 'plan');
});

test('28. task.* text chunks merge into TASK_DETAILS[taskId]', () => {
  let s = applyEvent(initialState, chunk('task.progress', { taskId: 't9' }, { body: 'p' }));
  s = applyEvent(s, chunk('task.summary', { taskId: 't9' }, { body: 's' }));
  s = applyEvent(s, chunk('task.learnings-draft', { taskId: 't9' }, { body: 'd' }));
  s = applyEvent(s, chunk('task.verify-log', { taskId: 't9' }, { body: 'v' }));
  const td = s.TASK_DETAILS['t9'];
  assert.strictEqual(td.progress, 'p');
  assert.strictEqual(td.summary, 's');
  assert.strictEqual(td.learningsDraft, 'd');
  assert.strictEqual(td.verifyLog, 'v');
});

test('29. task.round-issues chunks accumulate into TASK_DETAILS[taskId].roundIssuesBodies', () => {
  let s = applyEvent(initialState, chunk('task.round-issues', { taskId: 't9', round: 1 }, { round: 1, body: 'r1' }));
  s = applyEvent(s, chunk('task.round-issues', { taskId: 't9', round: 2 }, { round: 2, body: 'r2' }));
  const td = s.TASK_DETAILS['t9'];
  assert.deepStrictEqual(td.roundIssuesBodies, { 1: 'r1', 2: 'r2' });
});

test('30. task.screenshot chunks accumulate into TASK_DETAILS[taskId].screenshotBlobs', () => {
  const s = applyEvent(
    initialState,
    chunk('task.screenshot', { taskId: 't9', filename: 'a.png' }, { filename: 'a.png', base64: 'AAAA' }),
  );
  assert.strictEqual(s.TASK_DETAILS['t9'].screenshotBlobs['a.png'], 'AAAA');
});
