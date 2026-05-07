import {
  ConfigSchema,
  type Config,
  type Effort,
  type PricingEntry,
  type StageConfig,
  type StageKey,
  type ThinkingMode,
  type TokenCounts,
} from "./types.js";
import { Paths } from "./paths.js";
import { readJsonIfExists, writeJsonAtomic } from "./atomic.js";

const SONNET_PRICING: PricingEntry = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheCreate: 3.75,
};

const OPUS_PRICING: PricingEntry = {
  input: 15,
  output: 75,
  cacheRead: 1.5,
  cacheCreate: 18.75,
};

const HAIKU_PRICING: PricingEntry = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheCreate: 1.25,
};

export const DEFAULT_PRICING: Record<string, PricingEntry> = {
  sonnet: SONNET_PRICING,
  opus: OPUS_PRICING,
  haiku: HAIKU_PRICING,
  "claude-sonnet-4-5": SONNET_PRICING,
  "claude-sonnet-4-6": SONNET_PRICING,
  "claude-opus-4-5": OPUS_PRICING,
  "claude-haiku-4-5": HAIKU_PRICING,
};

/** Per-stage defaults — the values the user landed on after the audit. */
export const DEFAULT_STAGE_CONFIG: Record<StageKey, StageConfig> = {
  setup: { model: "opus[1m]", effort: "xhigh" },
  "get-tasks": { model: "opus[1m]", effort: "max" },
  spec: { model: "sonnet", effort: "med" },
  exec: { model: "sonnet", effort: "high" },
  exec_ui_check: { model: "opus[1m]", effort: "med" },
  code_review: { model: "sonnet", effort: "med" },
  code_review_ui_check: { model: "opus[1m]", effort: "med" },
  documentation: { model: "sonnet", effort: "med" },
  "update-learning": { model: "opus[1m]", effort: "high" },
  "merge-resolve": { model: "sonnet", effort: "med" },
  "merge-verify": { model: "sonnet", effort: "med" },
  commit_recovery: { model: "sonnet", effort: "low" },
};

export function defaultConfig(): Config {
  const parsed = ConfigSchema.parse({
    defaults: {},
    git: {},
    ws: { port: 7777 },
    stages: { ...DEFAULT_STAGE_CONFIG },
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
  // Same for stages — fill in any missing keys with the baked-in defaults so
  // users who installed before the stages block existed pick up the new
  // entries without losing their overrides.
  const mergedStages = { ...DEFAULT_STAGE_CONFIG, ...parsed.stages };
  return { ...parsed, pricing: mergedPricing, stages: mergedStages };
}

export async function saveConfig(paths: Paths, config: Config): Promise<void> {
  await writeJsonAtomic(paths.configJson, config);
}

export type ConfigPatch = {
  maxConcurrent?: Config["maxConcurrent"];
  retryCount?: Config["retryCount"];
  maxConsecutiveApiRetries?: Config["maxConsecutiveApiRetries"];
  stallTimeoutMs?: Config["stallTimeoutMs"];
  repeatToolCallCap?: Config["repeatToolCallCap"];
  maxUIReviewIterations?: Config["maxUIReviewIterations"];
  hasDocs?: Config["hasDocs"];
  defaults?: Partial<Config["defaults"]>;
  stages?: Partial<Config["stages"]>;
  git?: Partial<Config["git"]>;
  verify?: Partial<Config["verify"]>;
  ws?: Partial<Config["ws"]>;
  pricing?: Record<string, PricingEntry>;
};

export function mergeConfigPatch(current: Config, patch: ConfigPatch): Config {
  const merged = {
    ...current,
    ...patch,
    defaults: {
      ...current.defaults,
      ...(patch.defaults ?? {}),
    },
    stages: {
      ...current.stages,
      ...(patch.stages ?? {}),
    },
    git: {
      ...current.git,
      ...(patch.git ?? {}),
    },
    verify: {
      ...current.verify,
      ...(patch.verify ?? {}),
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
  return ConfigSchema.parse(merged);
}

/**
 * Resolve the model + effort to use for a given stage. Stage entry overrides
 * fields one-by-one over the defaults block; missing keys fall back to the
 * baked-in DEFAULT_STAGE_CONFIG so an empty config still yields the user's
 * recommended mapping.
 */
export function resolveStageConfig(config: Config, stage: StageKey): StageConfig {
  const baked = DEFAULT_STAGE_CONFIG[stage];
  const stageOverride = config.stages?.[stage] ?? {};
  const model =
    stageOverride.model ?? baked.model ?? config.defaults.model;
  const effort =
    stageOverride.effort ?? baked.effort ?? config.defaults.effort ?? "med";
  const stallTimeoutMs =
    stageOverride.stallTimeoutMs ?? baked.stallTimeoutMs ?? config.stallTimeoutMs;
  const repeatToolCallCap =
    stageOverride.repeatToolCallCap ??
    baked.repeatToolCallCap ??
    config.repeatToolCallCap;
  return { model, effort, stallTimeoutMs, repeatToolCallCap };
}

/**
 * Per-model effort tier table. The CLI now accepts `--effort` directly, so
 * effort is forwarded as a flag instead of being injected into the prompt.
 * `thinkingMode` is retained as session metadata for the UI.
 */
export interface EffortResolved {
  /** Resolved thinking-budget keyword (UI metadata only — not injected). */
  thinkingMode: ThinkingMode;
}

const EFFORT_DEFAULT: Record<Effort, EffortResolved> = {
  low: { thinkingMode: "off" },
  med: { thinkingMode: "think" },
  high: { thinkingMode: "megathink" },
  xhigh: { thinkingMode: "ultrathink" },
  max: { thinkingMode: "ultrathink" },
};

const EFFORT_BY_MODEL: Record<string, Record<Effort, EffortResolved>> = {
  opus: EFFORT_DEFAULT,
  sonnet: EFFORT_DEFAULT,
  haiku: EFFORT_DEFAULT,
};

function modelAlias(modelString: string): string {
  // Strip any context-window suffix like `opus[1m]` → `opus`. Then if the
  // model is a versioned id like `claude-opus-4-5`, fall back to the family
  // prefix lookup.
  const base = modelString.replace(/\[[^\]]+\]$/, "");
  if (EFFORT_BY_MODEL[base]) return base;
  if (base.startsWith("claude-opus")) return "opus";
  if (base.startsWith("claude-sonnet")) return "sonnet";
  if (base.startsWith("claude-haiku")) return "haiku";
  return base;
}

export function resolveEffort(model: string, effort: Effort): EffortResolved {
  const alias = modelAlias(model);
  return EFFORT_BY_MODEL[alias]?.[effort] ?? EFFORT_DEFAULT[effort];
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
