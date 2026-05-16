import { promises as fs } from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", "node_modules", "dist", ".flow", ".worktrees", ".DS_Store"]);

interface Entry { name: string; isDir: boolean; }

async function walk(dir: string, depth: number, max: number, lines: string[], prefix = ""): Promise<void> {
  if (depth > max) return;
  let raw: Entry[];
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    raw = ents
      .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch { return; }
  raw.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  for (const e of raw) {
    lines.push(`${prefix}${e.name}${e.isDir ? "/" : ""}`);
    if (e.isDir) await walk(path.join(dir, e.name), depth + 1, max, lines, prefix + "  ");
  }
}

export async function writeMapMd(projectRoot: string, outPath: string): Promise<void> {
  const lines: string[] = ["# Map", ""];
  await walk(projectRoot, 0, 4, lines);
  await fs.writeFile(outPath, lines.join("\n") + "\n", "utf8");
}
