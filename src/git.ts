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

  /** True iff the task's worktree has any uncommitted changes (staged or
   *  unstaged or untracked). Used by the scheduler to decide whether the
   *  commit_recovery agent needs to run after a stage. */
  async hasUncommittedChanges(taskId: string): Promise<boolean> {
    const git = simpleGit(this.paths.worktreeDir(taskId));
    try {
      const out = await git.raw(["status", "--porcelain"]);
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
