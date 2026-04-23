import { ConfigSchema, type Config, type PricingEntry, type TokenCounts } from "./types.js";
import { Paths } from "./paths.js";
import { readJsonIfExists, writeJsonAtomic } from "./atomic.js";

export const DEFAULT_PRICING: Record<string, PricingEntry> = {
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheCreate: 3.75,
  },
  "claude-opus-4-5": {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheCreate: 18.75,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheCreate: 1.25,
  },
};

export function defaultConfig(): Config {
  const parsed = ConfigSchema.parse({
    defaults: {},
    git: {},
    ws: { port: 7777 },
  });
  return {
    ...parsed,
    pricing: { ...DEFAULT_PRICING, ...parsed.pricing },
  };
}

export async function loadConfig(paths: Paths): Promise<Config> {
  const raw = await readJsonIfExists<unknown>(paths.configJson);
  if (raw === null) {
    const cfg = defaultConfig();
    await saveConfig(paths, cfg);
    return cfg;
  }
  const parsed = ConfigSchema.parse(raw);
  // Merge in any missing pricing defaults without overwriting user entries.
  const mergedPricing: Record<string, PricingEntry> = { ...DEFAULT_PRICING };
  for (const [model, entry] of Object.entries(parsed.pricing)) {
    mergedPricing[model] = entry;
  }
  return { ...parsed, pricing: mergedPricing };
}

export async function saveConfig(paths: Paths, config: Config): Promise<void> {
  await writeJsonAtomic(paths.configJson, config);
}

export function mergeConfigPatch(current: Config, patch: Partial<Config>): Config {
  const next: Config = {
    ...current,
    ...patch,
    defaults: {
      ...current.defaults,
      ...(patch.defaults ?? {}),
    },
    git: {
      ...current.git,
      ...(patch.git ?? {}),
    },
    ws: {
      ...current.ws,
      ...(patch.ws ?? {}),
    },
    pricing: {
      ...current.pricing,
      ...(patch.pricing ?? {}),
    },
  };
  return ConfigSchema.parse(next);
}

export function costFor(config: Config, model: string, tokens: TokenCounts): number {
  const rate = config.pricing[model];
  if (!rate) return 0;
  return (
    (tokens.input / 1_000_000) * rate.input +
    (tokens.output / 1_000_000) * rate.output +
    (tokens.cacheRead / 1_000_000) * rate.cacheRead +
    (tokens.cacheCreate / 1_000_000) * rate.cacheCreate
  );
}
