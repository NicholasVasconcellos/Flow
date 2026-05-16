import { promises as fs } from "node:fs";
import { Paths } from "./paths.js";
import type { TaskDef, Phase } from "./types.js";

export interface ComposeArgs {
  phase: Phase;
  task?: TaskDef;
  projectRoot: string;
}

export async function composePrompt(paths: Paths, args: ComposeArgs): Promise<string> {
  const promptPath = paths.promptFile(args.phase);
  try { await fs.access(promptPath); }
  catch { throw new Error(`Missing prompt: ${promptPath}`); }

  const sections: string[] = [`@${promptPath}`];

  // Project agent rules — present after setup runs once.
  if (args.phase !== "setup") {
    try {
      await fs.access(paths.agentsMd);
      sections.push(`# Project rules\n@${paths.agentsMd}`);
    } catch { /* setup hasn't created it yet */ }
  }

  // Codebase map — regenerated before each task; available to all phases.
  try {
    await fs.access(paths.mapMd);
    sections.push(`# Codebase map\n@${paths.mapMd}`);
  } catch { /* first-run setup or get-tasks: no map yet */ }

  if (args.phase === "setup" || args.phase === "get-tasks") {
    sections.push(`# Plan\n@${paths.planMd}`);
  }

  if (args.phase === "exec" && args.task) {
    const t = args.task;
    const ac = t.acceptanceCriteria.length
      ? `\n## Acceptance Criteria\n${t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "";
    const targets = t.targetFiles.length
      ? `\n## Target Files (recommendation — may edit/extend; append unlisted edits to tasks.json targetFiles)\n${t.targetFiles.map((f) => `- ${f}`).join("\n")}`
      : "";
    const ctx = t.contextFiles.length
      ? `\n## Context Files\n${t.contextFiles.map((f) => `@${f}`).join("\n")}`
      : "";
    const flags = `\nFlags: hasTests=${t.hasTests} hasUI=${t.hasUI} hasReview=${t.hasReview}`;
    const goal = t.goal ? `\n## Goal\n${t.goal}` : "";
    sections.push(
      `# Task ${t.id}\n## Title\n${t.title}\n## Description\n${t.description}${goal}${ac}${targets}${ctx}${flags}`,
    );
    sections.push(
      `# Workspace\nsummary path:  ${paths.taskSummary(t.id)}\nblock path:    ${paths.taskBlock(t.id)}`,
    );
  }

  return sections.join("\n\n");
}
