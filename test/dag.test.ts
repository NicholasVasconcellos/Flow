import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDag, DagError, readyTasks, topoSort, validateDag } from "../src/dag.js";
import type { TaskDef, TaskRuntime, TaskStage, TaskStatus } from "../src/types.js";

function def(id: string, requires: string[] = []): TaskDef {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    contextFiles: [],
    requires,
  };
}

function runtime(
  id: string,
  requires: string[] = [],
  status: TaskStatus = "pending",
  stage: TaskStage = "spec",
): TaskRuntime {
  return {
    ...def(id, requires),
    status,
    stage,
    retries: 0,
    transientRetries: 0,
    sessionIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("buildDag produces correct nodes + edges for a 3-task linear chain", () => {
  const tasks = [def("a"), def("b", ["a"]), def("c", ["b"])];
  const dag = buildDag(tasks);
  assert.deepEqual(dag.nodes, ["a", "b", "c"]);
  // edges are [dependency, dependent]
  assert.deepEqual(dag.edges.sort(), [
    ["a", "b"],
    ["b", "c"],
  ]);
});

test("buildDag edges use [dependency, dependent] orientation", () => {
  const tasks = [def("root"), def("leaf", ["root"])];
  const { edges } = buildDag(tasks);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], ["root", "leaf"]);
});

function caught(fn: () => void): DagError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DagError, `expected DagError, got ${e}`);
    return e as DagError;
  }
  assert.fail("expected function to throw");
}

test("validateDag detects a 2-node cycle", () => {
  const tasks = [def("a", ["b"]), def("b", ["a"])];
  const err = caught(() => validateDag(tasks));
  assert.equal(err.code, "CYCLE");
  // Cycle message should show a path like "a -> b -> a" or "b -> a -> b".
  assert.match(err.message, /(a -> b -> a)|(b -> a -> b)/);
});

test("validateDag detects a 3-node cycle with cycle path in message", () => {
  const tasks = [def("a", ["c"]), def("b", ["a"]), def("c", ["b"])];
  const err = caught(() => validateDag(tasks));
  assert.equal(err.code, "CYCLE");
  // Some rotation of the three-node cycle should appear.
  const acceptable = [
    "a -> c -> b -> a",
    "b -> a -> c -> b",
    "c -> b -> a -> c",
  ];
  assert.ok(
    acceptable.some((p) => err.message.includes(p)),
    `expected cycle path in message, got: ${err.message}`,
  );
});

test("validateDag detects unknown dep", () => {
  const tasks = [def("a"), def("b", ["does-not-exist"])];
  const err = caught(() => validateDag(tasks));
  assert.equal(err.code, "UNKNOWN_DEP");
  assert.match(err.message, /does-not-exist/);
});

test("validateDag passes on a valid diamond", () => {
  const tasks = [
    def("a"),
    def("b", ["a"]),
    def("c", ["a"]),
    def("d", ["b", "c"]),
  ];
  assert.doesNotThrow(() => validateDag(tasks));
});

test("validateDag throws NON_LEAF_NEW when a newly-added id has dependents", () => {
  // x is "new" but y depends on it → x is not a leaf.
  const tasks = [def("x"), def("y", ["x"])];
  const err = caught(() => validateDag(tasks, { newlyAddedIds: ["x"] }));
  assert.equal(err.code, "NON_LEAF_NEW");
  assert.match(err.message, /x/);
});

test("validateDag allows a newly-added id that is a leaf", () => {
  // new task "z" depends on existing "a", nothing depends on z.
  const tasks = [def("a"), def("z", ["a"])];
  assert.doesNotThrow(() =>
    validateDag(tasks, { newlyAddedIds: ["z"] }),
  );
});

test("topoSort gives a valid order on a diamond (a -> {b, c} -> d)", () => {
  const tasks = [
    def("a"),
    def("b", ["a"]),
    def("c", ["a"]),
    def("d", ["b", "c"]),
  ];
  const order = topoSort(tasks);
  assert.equal(order.length, 4);
  // a first, d last
  assert.equal(order[0], "a");
  assert.equal(order[3], "d");
  // b and c both after a and before d
  assert.ok(order.indexOf("a") < order.indexOf("b"));
  assert.ok(order.indexOf("a") < order.indexOf("c"));
  assert.ok(order.indexOf("b") < order.indexOf("d"));
  assert.ok(order.indexOf("c") < order.indexOf("d"));
  // stable: b should come before c because it appears first in the input.
  assert.ok(order.indexOf("b") < order.indexOf("c"));
});

test("topoSort is stable by creation order for independent tasks", () => {
  const tasks = [def("c"), def("a"), def("b")];
  const order = topoSort(tasks);
  assert.deepEqual(order, ["c", "a", "b"]);
});

test("readyTasks: initial batch returns tasks with no deps, in input order", () => {
  const tasks = [
    runtime("a"),
    runtime("b", ["a"]),
    runtime("c"),
    runtime("d", ["c"]),
  ];
  const ready = readyTasks(tasks);
  assert.deepEqual(
    ready.map((t) => t.id),
    ["a", "c"],
  );
});

test("readyTasks: dependents become ready only after deps are done", () => {
  // a is done, so b (which requires a) becomes ready.
  const tasks = [
    runtime("a", [], "done", "done"),
    runtime("b", ["a"], "pending"),
    runtime("c", ["b"], "pending"),
  ];
  const ready = readyTasks(tasks);
  assert.deepEqual(
    ready.map((t) => t.id),
    ["b"],
  );
});

test("readyTasks: merged deps also unblock dependents", () => {
  const tasks = [
    runtime("a", [], "merged", "merged"),
    runtime("b", ["a"], "pending"),
  ];
  const ready = readyTasks(tasks);
  assert.deepEqual(
    ready.map((t) => t.id),
    ["b"],
  );
});

test("readyTasks: running/paused/blocked tasks are not re-emitted even if deps met", () => {
  const tasks = [
    runtime("a", [], "done", "done"),
    runtime("b", ["a"], "running", "exec"),
    runtime("c", ["a"], "paused"),
    runtime("d", ["a"], "blocked"),
    runtime("e", ["a"], "ready"),
  ];
  const ready = readyTasks(tasks);
  assert.deepEqual(
    ready.map((t) => t.id),
    ["e"],
  );
});

test("readyTasks: multi-dep task waits until all deps are satisfied", () => {
  const tasks = [
    runtime("a", [], "done", "done"),
    runtime("b", [], "pending"), // not done yet
    runtime("c", ["a", "b"], "pending"),
  ];
  const ready = readyTasks(tasks);
  // b is initially ready (no deps), c is not (b isn't done).
  assert.deepEqual(
    ready.map((t) => t.id),
    ["b"],
  );
});
