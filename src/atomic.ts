import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    await fs.access(filePath, fsc.R_OK);
  } catch {
    return null;
  }
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

export async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
