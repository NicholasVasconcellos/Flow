import path from "node:path";

export class Paths {
  constructor(public readonly projectRoot: string) {}

  get planMd(): string {
    return path.join(this.projectRoot, "plan.md");
  }

  get flowDir(): string {
    return path.join(this.projectRoot, ".flow");
  }

  get configJson(): string {
    return path.join(this.flowDir, "config.json");
  }

  get tasksJson(): string {
    return path.join(this.flowDir, "tasks.json");
  }

  get stateJson(): string {
    return path.join(this.flowDir, "state.json");
  }

  get skillsDir(): string {
    return path.join(this.flowDir, "skills");
  }

  skillFile(name: string): string {
    return path.join(this.skillsDir, name, "SKILL.md");
  }

  get worktreesDir(): string {
    return path.join(this.flowDir, "worktrees");
  }

  worktreeDir(taskId: string): string {
    return path.join(this.worktreesDir, taskId);
  }

  get projectSessionsDir(): string {
    return path.join(this.flowDir, "sessions");
  }

  projectSessionJsonl(sessionId: string): string {
    return path.join(this.projectSessionsDir, `${sessionId}.jsonl`);
  }

  projectSessionMeta(sessionId: string): string {
    return path.join(this.projectSessionsDir, `${sessionId}.meta.json`);
  }

  get tasksDir(): string {
    return path.join(this.flowDir, "tasks");
  }

  taskDir(taskId: string): string {
    return path.join(this.tasksDir, taskId);
  }

  taskMetadata(taskId: string): string {
    return path.join(this.taskDir(taskId), "metadata.json");
  }

  taskSessionsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), "sessions");
  }

  taskSessionJsonl(taskId: string, sessionId: string): string {
    return path.join(this.taskSessionsDir(taskId), `${sessionId}.jsonl`);
  }

  taskSessionMeta(taskId: string, sessionId: string): string {
    return path.join(this.taskSessionsDir(taskId), `${sessionId}.meta.json`);
  }

  taskScreenshotsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), "screenshots");
  }

  taskSummary(taskId: string): string {
    return path.join(this.taskDir(taskId), "summary.md");
  }

  taskStageSignal(taskId: string): string {
    return path.join(this.taskDir(taskId), "stage.json");
  }

  taskProgressTxt(taskId: string): string {
    return path.join(this.taskDir(taskId), "progress.txt");
  }

  get learningsDir(): string {
    return path.join(this.flowDir, "learnings");
  }

  learningFile(taskId: string): string {
    return path.join(this.learningsDir, `${taskId}.md`);
  }

  get notificationsJsonl(): string {
    return path.join(this.flowDir, "notifications.jsonl");
  }

  // Session artefacts — project-level sessions have null taskId.
  sessionJsonl(taskId: string | null, sessionId: string): string {
    return taskId === null
      ? this.projectSessionJsonl(sessionId)
      : this.taskSessionJsonl(taskId, sessionId);
  }

  sessionMeta(taskId: string | null, sessionId: string): string {
    return taskId === null
      ? this.projectSessionMeta(sessionId)
      : this.taskSessionMeta(taskId, sessionId);
  }
}
