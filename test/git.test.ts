import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { simpleGit } from "simple-git";

import { Paths } from "../src/paths.js";
import { GitManager, formatCommitMessage } from "../src/git.js";

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-git-"));
  // Resolve any macOS /var -> /private/var symlink so git paths round-trip.
  return fs.realpath(dir);
}

async function writeFile(root: string, rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("formatCommitMessage renders subject + bullets", () => {
  const out = formatCommitMessage({
    subject: "Add feature",
    bullets: ["First bullet", "Second bullet"],
  });
  assert.equal(out, "Add feature\n\n- First bullet\n- Second bullet");
});

test("formatCommitMessage handles empty bullets", () => {
  const out = formatCommitMessage({ subject: "only subject", bullets: [] });
  assert.equal(out, "only subject");
});

test("ensureRepo creates .git + initial commit on empty dir", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  await writeFile(root, ".flow/config.json", "{}\n");
  await writeFile(root, "README.md", "hello\n");

  const gm = new GitManager(paths, "main");
  const did = await gm.ensureRepo();
  assert.equal(did, true);
  assert.equal(await pathExists(path.join(root, ".git")), true);

  const git = simpleGit(root);
  const log = await git.log();
  assert.equal(log.total, 1);
  const status = await git.status();
  assert.equal(status.files.length, 0, "all scaffold files should be committed");
});

test("ensureRepo is a no-op on existing repo", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "a.txt", "one\n");
  const first = await gm.ensureRepo();
  assert.equal(first, true);

  const git = simpleGit(root);
  const logBefore = await git.log();
  assert.equal(logBefore.total, 1);

  // Add an untracked file; ensureRepo should not commit it.
  await writeFile(root, "b.txt", "two\n");
  const second = await gm.ensureRepo();
  assert.equal(second, false);

  const logAfter = await git.log();
  assert.equal(logAfter.total, 1, "no new commit produced");
  const status = await git.status();
  assert.equal(status.not_added.includes("b.txt"), true);
});

test("createWorktree / removeWorktree round-trip", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "src/index.ts", "export const x = 1;\n");
  await gm.ensureRepo();

  const taskId = "01ABC";
  const { worktreePath, branchName } = await gm.createWorktree(taskId);
  assert.equal(worktreePath, paths.worktreeDir(taskId));
  assert.equal(branchName, `flow/${taskId}`);
  assert.equal(await pathExists(worktreePath), true);
  assert.equal(await pathExists(path.join(worktreePath, "src/index.ts")), true);

  // Branch should exist.
  const branchesBefore = await simpleGit(root).branch();
  assert.ok(branchesBefore.all.includes(branchName));

  await gm.removeWorktree(taskId, { branch: branchName, branchMerged: true });
  assert.equal(await pathExists(worktreePath), false);

  const branchesAfter = await simpleGit(root).branch();
  assert.ok(!branchesAfter.all.includes(branchName), "branch deleted when merged=true");
});

test("commitAllInWorktree produces commit whose message matches the format", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "seed.txt", "seed\n");
  await gm.ensureRepo();

  const taskId = "01TASK";
  const { worktreePath } = await gm.createWorktree(taskId);
  await writeFile(worktreePath, "feature.txt", "shiny new feature\n");

  const msg = {
    subject: "Add shiny feature",
    bullets: ["Introduces feature.txt", "Bumps morale"],
  };
  const sha = await gm.commitAllInWorktree(taskId, msg);
  assert.match(sha, /^[0-9a-f]{7,40}$/);

  const wtGit = simpleGit(worktreePath);
  const log = await wtGit.log({ maxCount: 1 });
  const latest = log.latest!;
  const expected = formatCommitMessage(msg);
  const actual = `${latest.message}${latest.body ? `\n\n${latest.body.trimEnd()}` : ""}`;
  assert.equal(actual.trim(), expected.trim());
});

test("mergeTaskIntoMain (merge strategy) clean merge stages then finalizeMerge commits", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "a.txt", "a\n");
  await gm.ensureRepo();

  const taskId = "01CLEAN";
  const { worktreePath } = await gm.createWorktree(taskId);
  await writeFile(worktreePath, "b.txt", "b from task\n");
  await gm.commitAllInWorktree(taskId, {
    subject: "Add b.txt",
    bullets: ["New file"],
  });

  const result = await gm.mergeTaskIntoMain(taskId, "merge");
  assert.equal(result.ok, true);

  // Pre-finalize: changes are staged but no merge commit yet.
  const mergeHead = path.join(root, ".git", "MERGE_HEAD");
  assert.equal(await pathExists(mergeHead), true, "merge in progress");

  // Finalize via the orchestrator's path — merge strategy uses MERGE_MSG.
  const sha = await gm.finalizeMerge("merge");
  assert.match(sha, /^[0-9a-f]{7,40}$/);
  assert.equal(await pathExists(path.join(root, "b.txt")), true);
  assert.equal(await pathExists(mergeHead), false, "merge finalized");

  await gm.removeWorktree(taskId, { branch: `flow/${taskId}`, branchMerged: true });
});

test("mergeTaskIntoMain (squash strategy) clean merge produces single commit on main", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "a.txt", "a\n");
  await gm.ensureRepo();

  const taskId = "01SQUASH";
  const { worktreePath } = await gm.createWorktree(taskId);
  // Two distinct commits on the worktree branch — they should collapse to one.
  await writeFile(worktreePath, "b.txt", "b from task\n");
  await gm.commitAllInWorktree(taskId, {
    subject: "Add b.txt",
    bullets: ["first"],
  });
  await writeFile(worktreePath, "c.txt", "c from task\n");
  await gm.commitAllInWorktree(taskId, {
    subject: "Add c.txt",
    bullets: ["second"],
  });

  const rootGit = simpleGit(root);
  const mainBefore = await rootGit.log();
  const result = await gm.mergeTaskIntoMain(taskId, "squash");
  assert.equal(result.ok, true);

  // Squash does not set MERGE_HEAD; changes are staged for a single commit.
  assert.equal(
    await pathExists(path.join(root, ".git", "MERGE_HEAD")),
    false,
    "squash uses no MERGE_HEAD",
  );

  const sha = await gm.finalizeMerge("squash", "Squashed task\n\nDetails here.");
  assert.match(sha, /^[0-9a-f]{7,40}$/);

  const mainAfter = await rootGit.log();
  assert.equal(
    mainAfter.total,
    mainBefore.total + 1,
    "exactly one new commit on main",
  );
  assert.equal(mainAfter.latest!.message, "Squashed task");
  assert.equal(await pathExists(path.join(root, "b.txt")), true);
  assert.equal(await pathExists(path.join(root, "c.txt")), true);

  await gm.removeWorktree(taskId, { branch: `flow/${taskId}`, branchMerged: true });
});

test("mergeTaskIntoMain (merge strategy) with a real conflict returns conflictPaths; abortMerge('merge') cleans up", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "conflict.txt", "base\n");
  await gm.ensureRepo();

  // Create worktree from main, modify conflict.txt there.
  const taskId = "01CONFLICT";
  const { worktreePath } = await gm.createWorktree(taskId);
  await writeFile(worktreePath, "conflict.txt", "from task\n");
  await gm.commitAllInWorktree(taskId, {
    subject: "Task change",
    bullets: ["modify conflict.txt"],
  });

  // Make a competing change on main before merging.
  const rootGit = simpleGit(root);
  await writeFile(root, "conflict.txt", "from main\n");
  await rootGit.add(["-A"]);
  await rootGit.commit("main conflicting change");

  const result = await gm.mergeTaskIntoMain(taskId, "merge");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.conflictPaths.includes("conflict.txt"));
  }

  // Merge state should be live.
  const mergeHead = path.join(root, ".git", "MERGE_HEAD");
  assert.equal(await pathExists(mergeHead), true);

  await gm.abortMerge("merge");
  assert.equal(await pathExists(mergeHead), false);

  // After abort, conflict.txt reads back as the pre-merge main value.
  const after = await fs.readFile(path.join(root, "conflict.txt"), "utf8");
  assert.equal(after, "from main\n");

  // Calling abortMerge again when nothing to abort should not throw.
  await gm.abortMerge("merge");
});

test("mergeTaskIntoMain (squash strategy) with a real conflict returns conflictPaths; abortMerge('squash') resets cleanly", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");

  await writeFile(root, "conflict.txt", "base\n");
  await gm.ensureRepo();

  const taskId = "01SQ_CONFLICT";
  const { worktreePath } = await gm.createWorktree(taskId);
  await writeFile(worktreePath, "conflict.txt", "from task\n");
  await gm.commitAllInWorktree(taskId, {
    subject: "Task change",
    bullets: ["modify conflict.txt"],
  });

  const rootGit = simpleGit(root);
  await writeFile(root, "conflict.txt", "from main\n");
  await rootGit.add(["-A"]);
  await rootGit.commit("main conflicting change");

  const result = await gm.mergeTaskIntoMain(taskId, "squash");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.conflictPaths.includes("conflict.txt"));
  }

  // Squash never sets MERGE_HEAD, so `merge --abort` is invalid.
  // abortMerge('squash') uses `reset --hard` + `clean -fd` instead.
  assert.equal(
    await pathExists(path.join(root, ".git", "MERGE_HEAD")),
    false,
    "squash leaves no MERGE_HEAD",
  );

  await gm.abortMerge("squash");

  const after = await fs.readFile(path.join(root, "conflict.txt"), "utf8");
  assert.equal(after, "from main\n", "main contents restored after squash abort");

  // Idempotent — reset on a clean tree is a no-op.
  await gm.abortMerge("squash");
});

test("scanForConflictMarkers flags files whose contents still contain markers", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");
  await gm.ensureRepo();

  await writeFile(
    root,
    "unresolved.ts",
    [
      "const before = 1;",
      "<<<<<<< HEAD",
      'const x = "ours";',
      "=======",
      'const x = "theirs";',
      ">>>>>>> flow/TASK",
      "const after = 2;",
    ].join("\n"),
  );
  await writeFile(root, "clean.ts", 'const resolved = "value";\n');
  await writeFile(
    root,
    "equals-in-body.ts",
    "const sevenEquals = '=======';\n// inline, not a marker on its own line\n",
  );

  const unresolved = await gm.scanForConflictMarkers([
    "unresolved.ts",
    "clean.ts",
    "equals-in-body.ts",
    "does-not-exist.ts",
  ]);

  assert.deepEqual(unresolved.sort(), ["unresolved.ts"]);
});

test("scanForConflictMarkers flags all three marker variants independently", async () => {
  const root = await makeTempProject();
  const paths = new Paths(root);
  const gm = new GitManager(paths, "main");
  await gm.ensureRepo();

  await writeFile(root, "only-start.ts", "a\n<<<<<<< HEAD\nb\n");
  await writeFile(root, "only-sep.ts", "a\n=======\nb\n");
  await writeFile(root, "only-end.ts", "a\n>>>>>>> branch\nb\n");

  const flagged = await gm.scanForConflictMarkers([
    "only-start.ts",
    "only-sep.ts",
    "only-end.ts",
  ]);

  assert.deepEqual(flagged.sort(), ["only-end.ts", "only-sep.ts", "only-start.ts"]);
});
