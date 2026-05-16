import path from "node:path";

export class Paths {
  constructor(public readonly projectRoot: string) {}

  get planMd(): string { return path.join(this.projectRoot, "plan.md"); }
  get mapMd(): string { return path.join(this.projectRoot, "Map.md"); }
  get agentsMd(): string { return path.join(this.projectRoot, "AGENTS.md"); }
  get flowDir(): string { return path.join(this.projectRoot, ".flow"); }
  get configJson(): string { return path.join(this.flowDir, "config.json"); }
  get tasksJson(): string { return path.join(this.flowDir, "tasks.json"); }
  get setupNotes(): string { return path.join(this.flowDir, "SetupNotes.md"); }
  get promptsDir(): string { return path.join(this.flowDir, "prompts"); }
  promptFile(name: string): string {
    return path.join(this.promptsDir, `${name}.md`);
  }
  get tasksDir(): string { return path.join(this.flowDir, "tasks"); }
  taskDir(taskId: string): string {
    return path.join(this.tasksDir, taskId);
  }
  taskSummary(taskId: string): string {
    return path.join(this.taskDir(taskId), "summary.md");
  }
  taskBlock(taskId: string): string {
    return path.join(this.taskDir(taskId), "block.md");
  }
  taskSessionsDir(taskId: string | null): string {
    return taskId === null
      ? path.join(this.flowDir, "sessions")
      : path.join(this.taskDir(taskId), "sessions");
  }
  sessionJsonl(taskId: string | null, sessionId: string): string {
    return path.join(this.taskSessionsDir(taskId), `${sessionId}.jsonl`);
  }
  sessionMeta(taskId: string | null, sessionId: string): string {
    return path.join(this.taskSessionsDir(taskId), `${sessionId}.meta.json`);
  }
}
