#!/usr/bin/env node
import process from "node:process";
import { Command } from "commander";

import { Flow, initFlowProject } from "./flow.js";

const program = new Command();
program.name("flow").version("0.2.0");

program
  .command("init")
  .description("Create .flow/ scaffolding (prompts, config)")
  .argument("[projectPath]", "project root", process.cwd())
  .action(async (projectPath: string) => {
    await initFlowProject(projectPath);
    console.log(`initialized .flow/ at ${projectPath}`);
  });

program
  .command("run")
  .description("Run setup → get-tasks → exec loop")
  .argument("[projectPath]", "project root", process.cwd())
  .action(async (projectPath: string) => {
    const flow = await Flow.open(projectPath);
    await flow.run();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
