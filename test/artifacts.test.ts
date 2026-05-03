import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { ProjectArtifacts } from "../src/artifacts.js";
import { resolveBundledAssetsDir, scaffoldFlowDir } from "../src/setup.js";

const ASSETS_DIR = resolveBundledAssetsDir();

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-artifacts-"));
  return fs.realpath(dir);
}

test(
  "ProjectArtifacts.fetch session.events with bogus sessionId yields zero chunks and does not throw",
  { timeout: 5000 },
  async () => {
    const root = await mkTmp();
    const paths = new Paths(root);
    await scaffoldFlowDir(paths, ASSETS_DIR);

    const state = new StateStore(paths);
    await state.load();

    const artifacts = new ProjectArtifacts(paths, state);

    const chunks: unknown[] = [];
    await assert.doesNotReject(async () => {
      for await (const chunk of artifacts.fetch("session.events", {
        sessionId: "definitely-not-a-real-session-id",
      })) {
        chunks.push(chunk);
      }
    });
    assert.equal(chunks.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Step 6 round-trips: every additional ArtifactKind
// ---------------------------------------------------------------------------

const fsp = fs;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test("ProjectArtifacts.fetch — text-body kinds (setup-notes/instructions/plan-md, task.* texts)", { timeout: 5000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  await fsp.writeFile(paths.setupNotes, "setup body\n", "utf8");
  await fsp.writeFile(paths.agentsMd, "instructions body\n", "utf8");
  await fsp.writeFile(paths.planMd, "plan body\n", "utf8");

  const taskId = "task-step6";
  await fsp.mkdir(paths.taskDir(taskId), { recursive: true });
  await fsp.writeFile(paths.taskProgressTxt(taskId), "progress body\n", "utf8");
  await fsp.writeFile(paths.taskSummary(taskId), "summary body\n", "utf8");
  await fsp.writeFile(paths.taskLearningsDraft(taskId), "draft body\n", "utf8");
  await fsp.writeFile(paths.taskVerifyLog(taskId), "verify body\n", "utf8");

  const state = new StateStore(paths);
  await state.load();
  const artifacts = new ProjectArtifacts(paths, state);

  const cases: Array<[Parameters<ProjectArtifacts["fetch"]>[0], Record<string, string>, string]> = [
    ["project.setup-notes", {}, "setup body\n"],
    ["project.instructions", {}, "instructions body\n"],
    ["project.plan-md", {}, "plan body\n"],
    ["task.progress", { taskId }, "progress body\n"],
    ["task.summary", { taskId }, "summary body\n"],
    ["task.learnings-draft", { taskId }, "draft body\n"],
    ["task.verify-log", { taskId }, "verify body\n"],
  ];

  for (const [kind, ids, expected] of cases) {
    const chunks = await collect(artifacts.fetch(kind, ids));
    assert.equal(chunks.length, 1, `${kind} should yield exactly 1 chunk`);
    const payload = chunks[0]!.payload as { body: string };
    assert.equal(payload.body, expected, `${kind} body mismatch`);
  }
});

test("ProjectArtifacts.fetch — project.skill / project.skills.list", { timeout: 5000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);
  // scaffoldFlowDir already populates skills; assert non-empty list and one
  // skill body roundtrips cleanly.
  const state = new StateStore(paths);
  await state.load();
  const artifacts = new ProjectArtifacts(paths, state);

  const list = await collect(artifacts.fetch("project.skills.list", {}));
  assert.ok(list.length > 0);
  const first = (list[0]!.payload as { name: string }).name;

  const skill = await collect(artifacts.fetch("project.skill", { name: first }));
  assert.equal(skill.length, 1);
  assert.equal((skill[0]!.payload as { name: string }).name, first);
  assert.ok(typeof (skill[0]!.payload as { body: string }).body === "string");
});

test("ProjectArtifacts.fetch — task.round-issues yields one chunk per round file in numeric order", { timeout: 5000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const taskId = "task-rounds";
  await fsp.mkdir(paths.taskIssuesDir(taskId), { recursive: true });
  await fsp.writeFile(paths.taskRoundIssues(taskId, 1), "r1\n", "utf8");
  await fsp.writeFile(paths.taskRoundIssues(taskId, 3), "r3\n", "utf8");
  await fsp.writeFile(paths.taskRoundIssues(taskId, 2), "r2\n", "utf8");

  const state = new StateStore(paths);
  await state.load();
  const artifacts = new ProjectArtifacts(paths, state);

  const all = await collect(artifacts.fetch("task.round-issues", { taskId }));
  assert.deepEqual(
    all.map((c) => (c.payload as { round: number }).round),
    [1, 2, 3],
    "rounds should be numerically sorted",
  );

  const single = await collect(artifacts.fetch("task.round-issues", { taskId, round: 2 }));
  assert.equal(single.length, 1);
  assert.equal((single[0]!.payload as { round: number; body: string }).body, "r2\n");
});

test("ProjectArtifacts.fetch — task.screenshot returns base64 of the file", { timeout: 5000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const taskId = "task-shot";
  await fsp.mkdir(paths.taskScreenshotsDir(taskId), { recursive: true });
  const filePath = path.join(paths.taskScreenshotsDir(taskId), "shot.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await fsp.writeFile(filePath, bytes);

  const state = new StateStore(paths);
  await state.load();
  const artifacts = new ProjectArtifacts(paths, state);

  const chunks = await collect(
    artifacts.fetch("task.screenshot", { taskId, filename: "shot.png" }),
  );
  assert.equal(chunks.length, 1);
  const p = chunks[0]!.payload as { filename: string; base64: string };
  assert.equal(p.filename, "shot.png");
  assert.equal(Buffer.from(p.base64, "base64").equals(bytes), true);
});

test("ProjectArtifacts.fetch — project.notifications + project.learnings full streams", { timeout: 5000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  // Three notifications via JSONL.
  await fsp.mkdir(path.dirname(paths.notificationsJsonl), { recursive: true });
  for (let i = 0; i < 3; i++) {
    const n = {
      id: `nx-${i}`,
      severity: "info",
      title: `t${i}`,
      body: "",
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      acknowledged: false,
    };
    await fsp.appendFile(paths.notificationsJsonl, JSON.stringify(n) + "\n", "utf8");
  }

  await fsp.mkdir(paths.learningsDir, { recursive: true });
  await fsp.writeFile(paths.learningFile("la"), "# A\nbody A", "utf8");
  await fsp.writeFile(paths.learningFile("lb"), "# B\nbody B", "utf8");

  const state = new StateStore(paths);
  await state.load();
  const artifacts = new ProjectArtifacts(paths, state);

  const notifs = await collect(artifacts.fetch("project.notifications", {}));
  assert.equal(notifs.length, 3);

  const learns = await collect(artifacts.fetch("project.learnings", {}));
  assert.equal(learns.length, 2);
  for (const c of learns) {
    const l = c.payload as { taskId: string; markdown: string };
    assert.ok(l.markdown.length > 0);
  }
});

test("session.events — envelope lines preserve their ts; legacy raw lines fall back to file mtime", { timeout: 5000 }, async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  await scaffoldFlowDir(paths, ASSETS_DIR);

  const sessionId = "session-ts-fallback";
  const filePath = paths.projectSessionJsonl(sessionId);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  // Line 1: legacy raw payload (no top-level ts) — should pick up mtime.
  // Line 2: new-style envelope with explicit ts — should be returned verbatim.
  const envelopeTs = "2026-01-15T10:30:00.000Z";
  const lines = [
    JSON.stringify({ type: "system", session_id: "x", uuid: "u1" }),
    JSON.stringify({
      sessionId,
      ts: envelopeTs,
      kind: "assistant",
      payload: { type: "assistant", uuid: "u2" },
    }),
  ];
  await fsp.writeFile(filePath, lines.join("\n") + "\n", "utf8");

  // Pin the file mtime so the fallback is deterministic.
  const mtime = new Date("2026-02-20T08:00:00.000Z");
  await fsp.utimes(filePath, mtime, mtime);

  const state = new StateStore(paths);
  await state.load();
  const artifacts = new ProjectArtifacts(paths, state);

  const chunks = await collect(artifacts.fetch("session.events", { sessionId }));
  assert.equal(chunks.length, 2);
  const e0 = chunks[0]!.payload as { ts: string };
  const e1 = chunks[1]!.payload as { ts: string };
  assert.equal(e0.ts, mtime.toISOString(), "legacy line uses file mtime");
  assert.equal(e1.ts, envelopeTs, "envelope line preserves its ts");
});
