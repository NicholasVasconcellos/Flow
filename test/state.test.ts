import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import type { Notification, TaskDef, TaskRuntime } from "../src/types.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "flow-"));
}

const TASK_DEFAULTS = { hasUI: false, hasSpec: true, hasCodeReview: true } as const;

function defA(): TaskDef {
  return { id: "A", title: "A", description: "task a", contextFiles: [], requires: [], ...TASK_DEFAULTS };
}
function defB(requires: string[] = ["A"]): TaskDef {
  return { id: "B", title: "B", description: "task b", contextFiles: [], requires, ...TASK_DEFAULTS };
}
function defC(requires: string[] = ["B"]): TaskDef {
  return { id: "C", title: "C", description: "task c", contextFiles: [], requires, ...TASK_DEFAULTS };
}

test("empty load works and saves without error", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const store = new StateStore(paths);
  const state = await store.load();
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.sessions, []);
  await store.save();

  // Reload roundtrip.
  const store2 = new StateStore(paths);
  const state2 = await store2.load();
  assert.deepEqual(state2.tasks, []);
  assert.deepEqual(state2.sessions, []);
});

test("syncFromTaskDefs adds new tasks, removes missing, updates changed", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const store = new StateStore(paths);
  await store.load();

  // Initial add.
  const r1 = store.syncFromTaskDefs([defA(), defB()]);
  assert.equal(r1.added.length, 2);
  assert.equal(r1.removed.length, 0);
  assert.equal(r1.updated.length, 0);
  for (const t of r1.added) {
    assert.equal(t.status, "pending");
    assert.equal(t.stage, "spec");
    assert.equal(t.retries, 0);
    assert.deepEqual(t.sessionIds, []);
  }

  // Simulate task A being running + having session history we must preserve.
  const a = store.getTask("A")!;
  a.status = "running";
  a.sessionIds = ["s1", "s2"];
  a.worktreePath = "/tmp/wt-a";
  a.branchName = "feature/a";
  a.stage = "exec";
  a.retries = 2;
  store.upsertTask(a);

  // Sync again: change B's title, drop nothing, add C.
  const r2 = store.syncFromTaskDefs([
    defA(),
    { ...defB(), title: "B renamed" },
    defC(),
  ]);
  assert.equal(r2.added.length, 1);
  assert.equal(r2.added[0]!.id, "C");
  assert.equal(r2.removed.length, 0);
  assert.equal(r2.updated.length, 1);
  assert.equal(r2.updated[0]!.id, "B");

  // Runtime fields preserved on A.
  const aAfter = store.getTask("A")!;
  assert.equal(aAfter.status, "running");
  assert.deepEqual(aAfter.sessionIds, ["s1", "s2"]);
  assert.equal(aAfter.worktreePath, "/tmp/wt-a");
  assert.equal(aAfter.branchName, "feature/a");
  assert.equal(aAfter.stage, "exec");
  assert.equal(aAfter.retries, 2);

  // B's title updated.
  const bAfter = store.getTask("B")!;
  assert.equal(bAfter.title, "B renamed");

  // Now drop B and C.
  const r3 = store.syncFromTaskDefs([defA()]);
  assert.deepEqual(r3.removed.sort(), ["B", "C"]);
  assert.equal(store.getTask("B"), undefined);
  assert.equal(store.getTask("C"), undefined);
});

test("recomputeReadiness flips pending -> ready through a 3-task chain", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const store = new StateStore(paths);
  await store.load();

  store.syncFromTaskDefs([defA(), defB(["A"]), defC(["B"])]);

  // First pass: only A (no requires) becomes ready.
  const c1 = store.recomputeReadiness();
  assert.deepEqual(c1.map((t) => t.id).sort(), ["A"]);
  assert.equal(store.getTask("A")!.status, "ready");
  assert.equal(store.getTask("B")!.status, "pending");
  assert.equal(store.getTask("C")!.status, "pending");

  // Finish A.
  const a = store.getTask("A")!;
  a.status = "done";
  store.upsertTask(a);

  const c2 = store.recomputeReadiness();
  assert.deepEqual(c2.map((t) => t.id), ["B"]);
  assert.equal(store.getTask("B")!.status, "ready");
  assert.equal(store.getTask("C")!.status, "pending");

  // Finish B (merged also counts).
  const b = store.getTask("B")!;
  b.status = "merged";
  store.upsertTask(b);

  const c3 = store.recomputeReadiness();
  assert.deepEqual(c3.map((t) => t.id), ["C"]);
  assert.equal(store.getTask("C")!.status, "ready");

  // Idempotent: no further changes.
  const c4 = store.recomputeReadiness();
  assert.equal(c4.length, 0);
});

test("notification append + ack round-trip via JSONL fold", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const store = new StateStore(paths);
  await store.load();

  // Nothing yet.
  assert.deepEqual(await store.listNotifications(), []);

  const n1: Notification = {
    id: "n1",
    severity: "info",
    title: "hello",
    body: "world",
    createdAt: new Date().toISOString(),
    acknowledged: false,
  };
  const n2: Notification = {
    id: "n2",
    severity: "error",
    title: "boom",
    body: "bad",
    createdAt: new Date().toISOString(),
    acknowledged: false,
  };
  await store.appendNotification(n1);
  await store.appendNotification(n2);

  const list1 = await store.listNotifications();
  assert.equal(list1.length, 2);
  assert.equal(list1.find((n) => n.id === "n1")!.acknowledged, false);

  // Ack n1.
  const acked = await store.ackNotification("n1");
  assert.ok(acked);
  assert.equal(acked!.acknowledged, true);

  const list2 = await store.listNotifications();
  assert.equal(list2.length, 2);
  // Folding: last record wins.
  assert.equal(list2.find((n) => n.id === "n1")!.acknowledged, true);
  assert.equal(list2.find((n) => n.id === "n2")!.acknowledged, false);

  // Ack unknown id returns null.
  assert.equal(await store.ackNotification("missing"), null);
});

test("upsertTask / removeTask basic semantics", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const store = new StateStore(paths);
  await store.load();

  const now = new Date().toISOString();
  const t: TaskRuntime = {
    id: "X",
    title: "x",
    description: "",
    contextFiles: [],
    requires: [],
    ...TASK_DEFAULTS,
    status: "pending",
    stage: "spec",
    retries: 0,
    transientRetries: 0,
    uiReviewRound: 0,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  store.upsertTask(t);
  assert.equal(store.getTasks().length, 1);
  const t2 = { ...t, title: "renamed" };
  store.upsertTask(t2);
  assert.equal(store.getTasks().length, 1);
  assert.equal(store.getTask("X")!.title, "renamed");
  store.removeTask("X");
  assert.equal(store.getTasks().length, 0);
});
