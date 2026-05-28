import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_ASTOCK_REPORT_DIR,
  loadLatestAstockReport,
  type AstockReport,
} from "../../astock/report";
import { bjIso, todayKey } from "../../utils";
import { refreshAstockData } from "../astock-refresh-chain";
import { renderAstockWebHtml } from "../astock-html";
import { runCommand } from "../run-command";
import { statePath, writeJsonAtomic } from "../state-store";
import type { RefreshResult, TabProvider } from "../types";

const WORKFLOW = "/root/.hermes/scripts/stock_selection_workflow.sh";
const QUANT_ROOT = "/data/SilverM-quant";

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function astockReportDir(): string {
  return process.env.ASTOCK_REPORT_DIR ?? DEFAULT_ASTOCK_REPORT_DIR;
}

async function listAstockDates(): Promise<string[]> {
  const dir = astockReportDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const dates = new Set<string>();
  for (const file of entries) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})-astock\.json$/);
    if (m) dates.add(m[1]);
  }
  return [...dates].sort((a, b) => b.localeCompare(a));
}

function buildResult(report: AstockReport): RefreshResult {
  const html = renderAstockWebHtml(report);
  return {
    tabId: "stocks",
    date: report.trade_date,
    ok: true,
    refreshedAt: bjIso(),
    title: `A股日报 ${report.trade_date}`,
    summary: `候选 ${report.metadata.candidate_count ?? report.records.length} 条`,
    html,
    sourceFiles: [
      report.sourcePath,
      report.markdownPath ?? path.join(astockReportDir(), `${report.trade_date}-astock.md`),
    ],
    meta: {
      candidateCount: report.metadata.candidate_count ?? report.records.length,
      holdings: report.metadata.holdings ?? [],
      source: report.metadata.source,
    },
  };
}

async function runStockWorkflow(): Promise<void> {
  if (await fileExists(WORKFLOW)) {
    await runCommand(WORKFLOW, [], {
      cwd: QUANT_ROOT,
      timeoutMs: 8 * 60_000,
      logName: `web-refresh-stocks-${todayKey()}.log`,
    });
    return;
  }
  await runCommand(
    path.join(QUANT_ROOT, ".venv/bin/python"),
    [
      "-m",
      "selection.run_selection_workflow",
      "--top",
      "3",
      "--holdings",
      "600999",
      "--skip-8501",
    ],
    {
      cwd: QUANT_ROOT,
      timeoutMs: 8 * 60_000,
      logName: `web-refresh-stocks-${todayKey()}.log`,
    },
  );
}

export const stocksProvider: TabProvider = {
  id: "stocks",
  label: "A股日报",
  description: "本地 SilverM-quant A 股选股日报。",
  refreshLabel: "刷新 A股日报",

  async loadLatest(): Promise<RefreshResult | null> {
    const report = loadLatestAstockReport();
    if (!report) return null;
    return buildResult(report);
  },

  async loadDate(date: string): Promise<RefreshResult | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const report = loadLatestAstockReport(date);
    // loadLatestAstockReport falls back to an earlier date if the exact one
    // is missing — guard against that so historical selection is exact.
    if (!report || report.trade_date !== date) return null;
    return buildResult(report);
  },

  async listDates(): Promise<string[]> {
    return listAstockDates();
  },

  async refresh(): Promise<RefreshResult> {
    // Phase 1 & 2: bring the upstream DuckDB current via baostock and run
    // scan_signals_v2 for any newly-arrived trade dates. If this fails we
    // still try to run the selection workflow on whatever date the DB
    // already has, so a flaky upstream doesn't block reading old data.
    try {
      const chain = await refreshAstockData({
        onProgress: (p) => {
          console.log(`[web] astock-chain ${p.step}: ${p.message}`);
        },
      });
      console.log(
        `[web] astock-chain done: prev=${chain.prevPriceLatest} → new=${chain.newPriceLatest}, scanned=[${chain.scannedDates.join(",")}]`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[web] astock-chain SKIPPED (${msg}); falling through to workflow on existing data`);
    }

    // Phase 3: run the existing selection workflow against the now-current
    // signal pool.
    await runStockWorkflow();
    const latest = await this.loadLatest();
    if (!latest) throw new Error("stock refresh finished but no A-share report was found");
    await writeJsonAtomic(statePath("stocks", latest.date), latest);
    return latest;
  },
};
