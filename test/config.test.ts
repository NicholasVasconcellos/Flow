import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Paths } from "../src/paths.js";
import {
  DEFAULT_PRICING,
  costFor,
  defaultConfig,
  loadConfig,
  mergeConfigPatch,
  saveConfig,
} from "../src/config.js";
import type { Config } from "../src/types.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "flow-"));
}

test("loadConfig writes defaults when config.json missing", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  const cfg = await loadConfig(paths);
  assert.equal(cfg.maxConcurrent, 3);
  assert.equal(cfg.defaults.model, "claude-sonnet-4-5");
  assert.equal(cfg.git.mainBranch, "main");
  assert.equal(cfg.ws.port, 7777);
  assert.ok(cfg.pricing["claude-sonnet-4-5"]);
  assert.ok(cfg.pricing["claude-opus-4-5"]);
  assert.ok(cfg.pricing["claude-haiku-4-5"]);

  // File was actually written.
  const raw = await fs.readFile(paths.configJson, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.defaults.model, "claude-sonnet-4-5");
});

test("loadConfig merges missing pricing defaults without overwriting user entries", async () => {
  const root = await mkTmp();
  const paths = new Paths(root);
  // Pre-populate a partial config with a custom override for sonnet only.
  const initial: Config = {
    ...defaultConfig(),
    pricing: {
      "claude-sonnet-4-5": {
        input: 99,
        output: 100,
        cacheRead: 1,
        cacheCreate: 2,
      },
    },
  };
  await saveConfig(paths, initial);

  const cfg = await loadConfig(paths);
  // Overridden entry is preserved.
  assert.equal(cfg.pricing["claude-sonnet-4-5"]!.input, 99);
  assert.equal(cfg.pricing["claude-sonnet-4-5"]!.output, 100);
  // Missing entries come from DEFAULT_PRICING.
  assert.deepEqual(
    cfg.pricing["claude-opus-4-5"],
    DEFAULT_PRICING["claude-opus-4-5"],
  );
  assert.deepEqual(
    cfg.pricing["claude-haiku-4-5"],
    DEFAULT_PRICING["claude-haiku-4-5"],
  );
});

test("costFor math matches per-1M formula", async () => {
  const cfg = defaultConfig();
  const tokens = {
    input: 1_000_000,
    output: 2_000_000,
    cacheRead: 500_000,
    cacheCreate: 4_000_000,
    total: 7_500_000,
  };
  // sonnet: 1*3 + 2*15 + 0.5*0.3 + 4*3.75 = 3 + 30 + 0.15 + 15 = 48.15
  const cost = costFor(cfg, "claude-sonnet-4-5", tokens);
  assert.ok(Math.abs(cost - 48.15) < 1e-9, `got ${cost}`);

  // Unknown model returns 0.
  assert.equal(costFor(cfg, "unknown-model", tokens), 0);
});

test("mergeConfigPatch merges nested fields and reparses", async () => {
  const base = defaultConfig();
  const patched = mergeConfigPatch(base, {
    maxConcurrent: 5,
    retryCount: 2,
    defaults: { model: "claude-opus-4-5" },
    git: { mainBranch: "develop", worktreeRoot: base.git.worktreeRoot },
    ws: { port: 9999 },
    pricing: {
      "custom-model": {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheCreate: 0.25,
      },
    },
  });

  assert.equal(patched.maxConcurrent, 5);
  assert.equal(patched.retryCount, 2);
  assert.equal(patched.defaults.model, "claude-opus-4-5");
  assert.equal(patched.git.mainBranch, "develop");
  assert.equal(patched.git.worktreeRoot, base.git.worktreeRoot);
  assert.equal(patched.ws.port, 9999);
  assert.ok(patched.pricing["custom-model"]);
  // Original entries are preserved.
  assert.ok(patched.pricing["claude-sonnet-4-5"]);
});
