import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';

import { initialState, applyEvent } from '../src/store.js';

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
  // error + "paused at" in title -> blocked (16 notifications)
  // blocked severity -> blocked (1 notification)
  // warn + review in body -> review-requested (1 notification)
  const notifs = fullState.NOTIFICATIONS;
  assert.strictEqual(notifs.length, 18, 'should have 18 notifications');

  const blocked = notifs.filter((n) => n.severity === 'blocked');
  const reviewRequested = notifs.filter((n) => n.severity === 'review-requested');

  assert.strictEqual(blocked.length, 17, `expected 17 blocked notifications, got ${blocked.length}`);
  assert.strictEqual(reviewRequested.length, 1, `expected 1 review-requested notification, got ${reviewRequested.length}`);

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
