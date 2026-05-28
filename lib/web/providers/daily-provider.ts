import fs from "node:fs/promises";
import path from "node:path";

import type { DailyReport } from "../../ai/pipeline";
import { todayKey } from "../../utils";
import { runCommand } from "../run-command";
import { statePath, writeJsonAtomic } from "../state-store";
import type { RefreshResult, TabProvider } from "../types";

const OUTPUT_DIR = "daily_reports";

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function findLatestReport(): Promise<string | null> {
  const dates = await listDailyReportDates();
  for (const date of dates) {
    const html = path.join(OUTPUT_DIR, date, `${date}.html`);
    if (await exists(html)) return html;
  }
  return null;
}

export async function listDailyReportDates(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(OUTPUT_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => path.basename(d) === d)
    .sort((a, b) => b.localeCompare(a));
}

async function loadReportMeta(date: string): Promise<DailyReport | null> {
  const file = path.join(OUTPUT_DIR, date, `${date}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as DailyReport;
  } catch {
    return null;
  }
}

export async function loadDailyReport(date: string): Promise<RefreshResult | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const htmlPath = path.join(OUTPUT_DIR, date, `${date}.html`);
  if (!(await exists(htmlPath))) return null;
  const html = await fs.readFile(htmlPath, "utf8");
  const meta = await loadReportMeta(date);
  return {
    tabId: "daily",
    date,
    ok: true,
    refreshedAt: new Date().toISOString(),
    title: meta?.hero_headline || `综合日报 ${date}`,
    summary: meta?.daily_overview,
    html,
    sourceFiles: [htmlPath],
    meta: {
      keywords: meta?.keywords ?? [],
      hasTrading: Boolean(meta?.trading),
    },
  };
}

export const dailyProvider: TabProvider = {
  id: "daily",
  label: "综合日报",
  description: "新闻、财经、时政、市场行情的每日简报。",
  refreshLabel: "刷新综合日报（约 5-8 分钟）",

  async loadLatest(): Promise<RefreshResult | null> {
    const htmlPath = await findLatestReport();
    if (!htmlPath) return null;
    const date = path.basename(htmlPath, ".html");
    return loadDailyReport(date);
  },

  async loadDate(date: string): Promise<RefreshResult | null> {
    return loadDailyReport(date);
  },

  async listDates(): Promise<string[]> {
    const dates = await listDailyReportDates();
    const available: string[] = [];
    for (const date of dates) {
      const html = path.join(OUTPUT_DIR, date, `${date}.html`);
      if (await exists(html)) available.push(date);
    }
    return available;
  },

  async refresh(): Promise<RefreshResult> {
    await runCommand("npm", ["run", "daily"], {
      cwd: process.cwd(),
      timeoutMs: 15 * 60_000,
      logName: `web-refresh-daily-${todayKey()}.log`,
      env: { WEB_MODE: "true" },
    });
    await runCommand("npm", ["run", "build-site"], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      logName: `web-build-site-${todayKey()}.log`,
    });
    const latest = await this.loadLatest();
    if (!latest) throw new Error("daily refresh finished but no report was found");
    await writeJsonAtomic(statePath("daily", latest.date), latest);
    return latest;
  },
};
