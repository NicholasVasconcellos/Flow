import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskDefSchema,
  TasksFileSchema,
  type Config,
  type TaskDef,
  type TaskStage,
} from "../src/types.js";
import {
  resumeIndex,
  stagesFor,
  stagesForTask,
  type AgentStage,
} from "../src/scheduler.js";
import { defaultConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// TaskDefSchema backwards compat
// ---------------------------------------------------------------------------

test("TaskDefSchema: legacy task without flags parses with safe defaults", () => {
  const legacy = {
    id: "A",
    title: "Task A",
    description: "Do A",
    contextFiles: [],
    requires: [],
  };
  const parsed = TaskDefSchema.parse(legacy);
  assert.equal(parsed.hasUI, false);
  assert.equal(parsed.hasSpec, true);
  assert.equal(parsed.hasCodeReview, true);
});

test("TaskDefSchema: explicit flag values are preserved", () => {
  const explicit = {
    id: "B",
    title: "Task B",
    description: "Do B",
    contextFiles: [],
    requires: [],
    hasUI: true,
    hasSpec: false,
    hasCodeReview: false,
  };
  const parsed = TaskDefSchema.parse(explicit);
  assert.equal(parsed.hasUI, true);
  assert.equal(parsed.hasSpec, false);
  assert.equal(parsed.hasCodeReview, false);
});

test("TasksFileSchema: legacy tasks.json without flags parses cleanly", () => {
  const legacy = {
    tasks: [
      { id: "A", title: "A", description: "", contextFiles: [], requires: [] },
      { id: "B", title: "B", description: "", contextFiles: [], requires: ["A"] },
    ],
  };
  const parsed = TasksFileSchema.parse(legacy);
  assert.equal(parsed.tasks.length, 2);
  for (const t of parsed.tasks) {
    assert.equal(t.hasUI, false);
    assert.equal(t.hasSpec, true);
    assert.equal(t.hasCodeReview, true);
  }
});

// ---------------------------------------------------------------------------
// stagesForTask filtering
// ---------------------------------------------------------------------------

function mkTask(overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id: "T",
    title: "T",
    description: "",
    contextFiles: [],
    requires: [],
    hasUI: false,
    hasSpec: true,
    hasCodeReview: true,
    ...overrides,
  };
}

function fullConfig(): Config {
  return { ...defaultConfig(), hasDocs: true };
}

test("stagesForTask: defaults match canonical stagesFor minus UI checks", () => {
  const cfg = fullConfig();
  const task = mkTask();
  const stages = stagesForTask(cfg, task);
  // Defaults: hasUI=false drops both UI checks; hasSpec=true keeps spec;
  // hasCodeReview=true keeps code_review.
  const expected: AgentStage[] = [
    "spec",
    "exec",
    "code_review",
    "documentation",
    "update-learning",
  ];
  assert.deepEqual(stages, expected);
});

test("stagesForTask: hasUI=true keeps both UI-check stages", () => {
  const cfg = fullConfig();
  const task = mkTask({ hasUI: true });
  const stages = stagesForTask(cfg, task);
  assert.ok(stages.includes("exec_ui_check"));
  assert.ok(stages.includes("code_review_ui_check"));
});

test("stagesForTask: hasSpec=false drops only spec", () => {
  const cfg = fullConfig();
  const task = mkTask({ hasSpec: false, hasUI: true });
  const stages = stagesForTask(cfg, task);
  assert.ok(!stages.includes("spec"));
  assert.ok(stages.includes("exec"));
  assert.ok(stages.includes("code_review"));
});

test("stagesForTask: hasCodeReview=false drops only code_review", () => {
  const cfg = fullConfig();
  const task = mkTask({ hasCodeReview: false, hasUI: true });
  const stages = stagesForTask(cfg, task);
  assert.ok(!stages.includes("code_review"));
  assert.ok(stages.includes("spec"));
  assert.ok(stages.includes("exec_ui_check"));
  assert.ok(stages.includes("code_review_ui_check"));
});

test("stagesForTask: all flags off → minimal pipeline", () => {
  const cfg = fullConfig();
  const task = mkTask({ hasUI: false, hasSpec: false, hasCodeReview: false });
  const stages = stagesForTask(cfg, task);
  const expected: AgentStage[] = ["exec", "documentation", "update-learning"];
  assert.deepEqual(stages, expected);
});

test("stagesForTask: hasDocs=false drops documentation regardless of flags", () => {
  const cfg = { ...fullConfig(), hasDocs: false };
  const task = mkTask({ hasUI: true });
  const stages = stagesForTask(cfg, task);
  assert.ok(!stages.includes("documentation"));
});

test("stagesForTask preserves canonical stage order", () => {
  const cfg = fullConfig();
  const task = mkTask({ hasUI: true });
  const stages = stagesForTask(cfg, task);
  const canonical = stagesFor(cfg);
  // Filter preserves order — every stage in the filtered list appears in
  // the canonical list at a strictly increasing index.
  let lastIdx = -1;
  for (const s of stages) {
    const idx = canonical.indexOf(s);
    assert.ok(idx > lastIdx, `${s} out of canonical order`);
    lastIdx = idx;
  }
});

test("stagesForTask: legacy task (parsed via schema) yields default stage set", () => {
  // Round-trip a legacy literal through the schema — what the harness
  // actually does when reading an older tasks.json.
  const parsed = TaskDefSchema.parse({
    id: "Legacy",
    title: "Legacy",
    description: "",
    contextFiles: [],
    requires: [],
  });
  const stages = stagesForTask(fullConfig(), parsed);
  const expected: AgentStage[] = [
    "spec",
    "exec",
    "code_review",
    "documentation",
    "update-learning",
  ];
  assert.deepEqual(stages, expected);
});

// ---------------------------------------------------------------------------
// resumeIndex
// ---------------------------------------------------------------------------

test("resumeIndex: stage present in filtered list returns its index", () => {
  const cfg = fullConfig();
  const canonical = stagesFor(cfg);
  const stages = stagesForTask(cfg, mkTask({ hasUI: true }));
  assert.deepEqual(resumeIndex(canonical, stages, "code_review"), {
    index: stages.indexOf("code_review"),
    unknownStage: false,
  });
});

test("resumeIndex: filtered-out exec_ui_check advances to code_review", () => {
  const cfg = fullConfig();
  const canonical = stagesFor(cfg);
  // hasUI=false drops both UI-check stages.
  const stages = stagesForTask(cfg, mkTask({ hasUI: false }));
  assert.ok(!stages.includes("exec_ui_check"));
  assert.deepEqual(resumeIndex(canonical, stages, "exec_ui_check"), {
    index: stages.indexOf("code_review"),
    unknownStage: false,
  });
});

test("resumeIndex: filtered-out code_review_ui_check advances to documentation", () => {
  const cfg = fullConfig();
  const canonical = stagesFor(cfg);
  const stages = stagesForTask(cfg, mkTask({ hasUI: false }));
  assert.ok(!stages.includes("code_review_ui_check"));
  assert.deepEqual(resumeIndex(canonical, stages, "code_review_ui_check"), {
    index: stages.indexOf("documentation"),
    unknownStage: false,
  });
});

test("resumeIndex: filtered-out final stage with no successor → stages.length", () => {
  const canonical: AgentStage[] = ["spec", "exec", "documentation"];
  const stages: AgentStage[] = ["spec", "exec"];
  assert.deepEqual(resumeIndex(canonical, stages, "documentation"), {
    index: stages.length,
    unknownStage: false,
  });
});

test("resumeIndex: terminal stages return stages.length", () => {
  const cfg = fullConfig();
  const canonical = stagesFor(cfg);
  const stages = stagesForTask(cfg, mkTask());
  assert.deepEqual(resumeIndex(canonical, stages, "done"), {
    index: stages.length,
    unknownStage: false,
  });
  assert.deepEqual(resumeIndex(canonical, stages, "merged"), {
    index: stages.length,
    unknownStage: false,
  });
});

test("resumeIndex: exec is always present (sanity)", () => {
  const cfg = fullConfig();
  const canonical = stagesFor(cfg);
  const stages = stagesForTask(cfg, mkTask());
  assert.deepEqual(resumeIndex(canonical, stages, "exec"), {
    index: stages.indexOf("exec"),
    unknownStage: false,
  });
});

test("resumeIndex: unknown stage returns 0 with unknownStage=true", () => {
  const cfg = fullConfig();
  const canonical = stagesFor(cfg);
  const stages = stagesForTask(cfg, mkTask());
  const bogus = "totally-not-a-stage" as TaskStage;
  assert.deepEqual(resumeIndex(canonical, stages, bogus), {
    index: 0,
    unknownStage: true,
  });
});
