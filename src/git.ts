import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Paths } from "./paths.js";

export interface CommitMessage {
  subject: string;
  bullets: string[];
}

export function formatCommitMessage(message: CommitMessage): string {
  const subject = message.subject.trim();
  const bullets = message.bullets
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (bullets.length === 0) return subject;
  return `${subject}\n\n${bullets.map((b) => `- ${b}`).join("\n")}`;
}

function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

export class GitManager {
  private readonly rootGit: SimpleGit;

  constructor(
    private readonly paths: Paths,
    private readonly mainBranch: string,
  ) {
    this.rootGit = simpleGit(paths.projectRoot);
  }

  async ensureRepo(): Promise<boolean> {
    const dotGit = path.join(this.paths.projectRoot, ".git");
    if (await pathExists(dotGit)) return false;

    const git = simpleGit(this.paths.projectRoot);
    await git.init(["-b", this.mainBranch]);

    // Ensure user identity is configured locally before first commit.
    await this.ensureUserIdentity(git);

    await git.add(["-A"]);
    await git.commit("chore: initial Flow scaffold", { "--allow-empty": null });
    return true;
  }

  private async ensureUserIdentity(git: SimpleGit): Promise<void> {
    const existingEmail = await this.readConfig(git, "user.email");
    if (!existingEmail) {
      await git.addConfig("user.email", "flow@localhost", false, "local");
    }
    const existingName = await this.readConfig(git, "user.name");
    if (!existingName) {
      await git.addConfig("user.name", "Flow", false, "local");
    }
  }

  private async readConfig(git: SimpleGit, key: string): Promise<string | null> {
    try {
      const value = await git.raw(["config", "--get", key]);
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  async setRemote(remoteUrl: string): Promise<void> {
    const git = this.rootGit;
    const remotes = await git.getRemotes(false);
    if (!remotes.some((r) => r.name === "origin")) {
      await git.addRemote("origin", remoteUrl);
    }
    await git.push(["-u", "origin", this.mainBranch]);
  }

  async createWorktree(
    taskId: string,
  ): Promise<{ worktreePath: string; branchName: string }> {
    const worktreePath = this.paths.worktreeDir(taskId);
    const branchName = `flow/${taskId}`;
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.rootGit.raw([
      "worktree",
      "add",
      worktreePath,
      "-b",
      branchName,
      this.mainBranch,
    ]);

    // Best-effort: stamp the worktree's per-clone exclude file with cache
    // paths for toolchains that regenerate state out-of-band. Without this,
    // the project's `.gitignore` is the only line of defence, and when it's
    // missing the orchestrator's commit pipeline keeps "rediscovering"
    // untracked cache dirs every build.
    try {
      await this.stampToolchainExcludes(worktreePath);
    } catch (err) {
      console.warn(
        `[flow] worktree exclude stamping failed for ${taskId}: ${
          (err as Error).message
        }`,
      );
    }

    // Seed an empty progress.txt for cross-stage notes. It lives under the
    // task artefacts dir (outside the worktree) so it survives worktree
    // removal and is the single carry-over between stages.
    const progressPath = this.paths.taskProgressTxt(taskId);
    await fs.mkdir(path.dirname(progressPath), { recursive: true });
    try {
      await fs.writeFile(progressPath, "", { flag: "wx" });
    } catch {
      // File already exists from a prior run — leave its contents intact.
    }

    return { worktreePath, branchName };
  }

  /** Append toolchain-specific cache paths to the worktree's
   *  `.git/info/exclude`. Conservative — only runs for projects we know
   *  regenerate cache state out-of-band, and only adds well-known cache
   *  paths (never source dirs). Idempotent: lines already present are
   *  skipped. */
  private async stampToolchainExcludes(worktreePath: string): Promise<void> {
    const additions: string[] = [];

    // Godot 4: `.godot/` is the editor cache, `*.import` are auto-generated
    // import metadata. Both regenerate on every editor run.
    if (await pathExists(path.join(this.paths.projectRoot, "project.godot"))) {
      additions.push(".godot/", "*.import");
    }

    if (additions.length === 0) return;

    // In a worktree, `.git` is a file pointing at the real gitdir under the
    // main repo's `worktrees/<name>/`. Resolve it via `git rev-parse` rather
    // than guessing.
    const wtGit = simpleGit(worktreePath);
    const gitDirRaw = await wtGit.raw(["rev-parse", "--git-dir"]);
    const gitDir = gitDirRaw.trim();
    const absGitDir = path.isAbsolute(gitDir)
      ? gitDir
      : path.resolve(worktreePath, gitDir);
    const excludePath = path.join(absGitDir, "info", "exclude");

    await fs.mkdir(path.dirname(excludePath), { recursive: true });

    let existing = "";
    try {
      existing = await fs.readFile(excludePath, "utf8");
    } catch {
      /* file doesn't exist yet — treat as empty */
    }

    const have = new Set(
      existing
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#")),
    );
    const missing = additions.filter((line) => !have.has(line));
    if (missing.length === 0) return;

    const prefix =
      existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const block = `${prefix}# flow: toolchain cache excludes\n${missing.join("\n")}\n`;
    await fs.appendFile(excludePath, block);
  }

  /** True iff the task's worktree has any uncommitted changes to **tracked**
   *  files (staged or unstaged). Untracked paths are deliberately ignored —
   *  toolchains like Godot/Unity regenerate cache dirs (`.godot/`, `Library/`)
   *  out-of-band, and counting them here loops `commit_recovery` forever
   *  (every `git add -A` re-creates the same untracked state on the next
   *  build). The scheduler's pause-trigger gate uses this; if you need to
   *  detect untracked work for a different reason, write a different helper. */
  async hasUncommittedChanges(taskId: string): Promise<boolean> {
    const git = simpleGit(this.paths.worktreeDir(taskId));
    try {
      const out = await git.raw([
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async removeWorktree(
    taskId: string,
    opts?: { branch?: string; branchMerged?: boolean },
  ): Promise<void> {
    const worktreePath = this.paths.worktreeDir(taskId);
    try {
      await this.rootGit.raw(["worktree", "remove", "--force", worktreePath]);
    } catch (err) {
      // If worktree is already gone, try to prune stale state and continue.
      if (await pathExists(worktreePath)) throw err;
      try {
        await this.rootGit.raw(["worktree", "prune"]);
      } catch {
        /* ignore */
      }
    }

    const branch = opts?.branch ?? `flow/${taskId}`;
    if (opts?.branchMerged) {
      try {
        await this.rootGit.raw(["branch", "-d", branch]);
      } catch {
        // branch may have already been deleted or never existed
      }
    }
  }

  /** Stage every change in the task's worktree. Must run before the
   *  `commit` skill so its `git diff --cached` sees the actual payload. */
  async stageAllInWorktree(taskId: string): Promise<void> {
    const git = simpleGit(this.paths.worktreeDir(taskId));
    await this.ensureUserIdentity(git);
    await git.add(["-A"]);
  }

  async commitAllInWorktree(
    taskId: string,
    message: CommitMessage,
  ): Promise<string> {
    const git = simpleGit(this.paths.worktreeDir(taskId));
    await this.ensureUserIdentity(git);
    // Re-stage in case the commit agent introduced new files or the caller
    // skipped stageAllInWorktree; this is idempotent.
    await git.add(["-A"]);
    const body = formatCommitMessage(message);
    await git.commit(body, { "--allow-empty": null });
    const sha = (await git.revparse(["HEAD"])).trim();
    return sha;
  }

  async mergeTaskIntoMain(
    taskId: string,
  ): Promise<
    | { ok: true; sha: string }
    | { ok: false; conflictPaths: string[] }
  > {
    const git = this.rootGit;
    await this.ensureUserIdentity(git);
    await git.checkout(this.mainBranch);
    const branch = `flow/${taskId}`;
    let caught: unknown = null;
    try {
      await git.raw(["merge", "--no-ff", branch]);
    } catch (err) {
      caught = err;
    }

    // simple-git's raw() does not reliably throw on merge conflicts, and even
    // when merge() throws a GitResponseError the conflicts array shape can
    // vary. Source of truth: filesystem state after the merge attempt.
    const conflictPaths = await this.collectConflictPaths(git, caught);
    if (conflictPaths.length > 0) {
      return { ok: false, conflictPaths };
    }
    if (caught) throw caught;

    const sha = (await git.revparse(["HEAD"])).trim();
    return { ok: true, sha };
  }

  private async collectConflictPaths(
    git: SimpleGit,
    err: unknown,
  ): Promise<string[]> {
    const found = new Set<string>();

    // Shape 1: simple-git's MergeResult-shaped error (GitResponseError)
    const anyErr = err as { git?: { conflicts?: Array<{ file?: string | null }> } };
    const conflicts = anyErr?.git?.conflicts;
    if (Array.isArray(conflicts)) {
      for (const c of conflicts) {
        if (c && typeof c.file === "string" && c.file.length > 0) {
          found.add(c.file);
        }
      }
    }

    // Shape 2: parse `git status --porcelain=v1` for UU / AA / DD etc.
    try {
      const porcelain = await git.raw(["status", "--porcelain=v1"]);
      for (const line of porcelain.split("\n")) {
        if (line.length < 3) continue;
        const x = line.charAt(0);
        const y = line.charAt(1);
        const isConflict =
          (x === "U" || y === "U") ||
          (x === "A" && y === "A") ||
          (x === "D" && y === "D");
        if (isConflict) {
          found.add(line.slice(3).trim());
        }
      }
    } catch {
      /* ignore */
    }

    return Array.from(found);
  }

  async completeMerge(): Promise<string> {
    const git = this.rootGit;
    await this.ensureUserIdentity(git);
    await git.add(["-A"]);
    await git.raw(["commit", "--no-edit"]);
    return (await git.revparse(["HEAD"])).trim();
  }

  /** Return the subset of `relPaths` (relative to the project root) whose
   *  file contents still contain literal conflict markers. A mergeResolve
   *  agent that stages a file without editing out `<<<<<<<` / `=======` /
   *  `>>>>>>>` leaves git's index technically resolved, so `git commit` will
   *  happily ship the markers to main. The scheduler calls this before
   *  completeMerge() to catch that case.
   *
   *  Missing/unreadable files are skipped — an agent legitimately resolving
   *  a conflict by deleting the file should not trip this check. */
  async scanForConflictMarkers(relPaths: readonly string[]): Promise<string[]> {
    const unresolved: string[] = [];
    const marker = /^(<{7}|={7}|>{7})(\s|$)/m;
    for (const rel of relPaths) {
      const abs = path.join(this.paths.projectRoot, rel);
      let body: string;
      try {
        body = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (marker.test(body)) unresolved.push(rel);
    }
    return unresolved;
  }

  async abortMerge(): Promise<void> {
    try {
      await this.rootGit.raw(["merge", "--abort"]);
    } catch {
      // Nothing to abort — leave quietly.
    }
  }
}
