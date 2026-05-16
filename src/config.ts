import { ConfigSchema, type Config } from "./types.js";
import { Paths } from "./paths.js";
import { readJsonIfExists, writeJsonAtomic } from "./atomic.js";

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export async function loadConfig(paths: Paths): Promise<Config> {
  const raw = await readJsonIfExists<unknown>(paths.configJson);
  return ConfigSchema.parse(raw ?? {});
}

export async function saveConfig(paths: Paths, config: Config): Promise<void> {
  await writeJsonAtomic(paths.configJson, config);
}

export function resolvePhaseConfig(
  config: Config,
  phase: "setup" | "get-tasks" | "exec",
): { model: string; effort: Config["defaults"]["effort"] } {
  const override = config.phases?.[phase];
  return {
    model: override?.model ?? config.defaults.model,
    effort: override?.effort ?? config.defaults.effort,
  };
}
