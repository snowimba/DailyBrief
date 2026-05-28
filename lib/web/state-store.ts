import fs from "node:fs/promises";
import path from "node:path";

import { todayKey } from "../utils";

export const WEB_STATE_DIR = "web_state";

export function statePath(tabId: string, date = todayKey()): string {
  return path.join(WEB_STATE_DIR, date, `${tabId}.json`);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw e;
  }
}

export async function latestState<T>(tabId: string): Promise<T | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(WEB_STATE_DIR);
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw e;
  }
  const dates = entries
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));
  for (const date of dates) {
    const value = await readJson<T>(statePath(tabId, date));
    if (value) return value;
  }
  return null;
}
