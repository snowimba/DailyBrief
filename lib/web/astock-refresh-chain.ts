import fs from "node:fs/promises";
import path from "node:path";

import { todayKey } from "../utils";
import { runCommand } from "./run-command";

/**
 * One-shot chain that brings the SilverM-quant DuckDB up to today before
 * running the selection workflow. Steps:
 *
 *   1) POST /api/data-update/update with source=baostock to fetch any
 *      missing daily prices from upstream into `dwd_daily_price`.
 *   2) Poll the task until it reaches a terminal state.
 *   3) Run `signals.scan_signals_v2` once for each newly-arrived trade
 *      date so `daily_signals` is populated.
 *   4) Caller (stocks-provider) follows up with the existing selection
 *      workflow, which now sees the new latest signal date.
 *
 * Designed to be safe to call repeatedly: if the DB is already up to
 * date, baostock returns 0 new rows and scan_signals_v2 is skipped.
 */

const QUANT_DASHBOARD = process.env.QUANT_DASHBOARD_URL ?? "http://127.0.0.1:5001";
const QUANT_ROOT = process.env.QUANT_ROOT ?? "/data/SilverM-quant";
const QUANT_PYTHON = path.join(QUANT_ROOT, ".venv/bin/python");
const QUANT_DB = path.join(QUANT_ROOT, "data/Astock3.duckdb");

interface UpdateTaskState {
  status?: string;
  progress?: number;
  message?: string;
}

async function quantPost(pathSuffix: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${QUANT_DASHBOARD}${pathSuffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `quant dashboard POST ${pathSuffix} failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

async function quantGet(pathSuffix: string): Promise<unknown> {
  const res = await fetch(`${QUANT_DASHBOARD}${pathSuffix}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `quant dashboard GET ${pathSuffix} failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

async function getLatestPriceDate(): Promise<string | null> {
  const data = (await quantGet("/api/data-update/status")) as {
    success?: boolean;
    data?: { dwd_daily_price?: { latest?: string | null } };
  };
  return data.data?.dwd_daily_price?.latest ?? null;
}

interface DailyPriceFetchResult {
  triggered: boolean;
  taskId?: string;
  finalStatus?: string;
  finalMessage?: string;
}

/**
 * Fire baostock daily-price fetch covering [latest_in_db, today]. If the DB
 * is already current we still fire — baostock will detect zero deltas in a
 * few seconds. Polls until status is `success` or `error`.
 */
async function fetchDailyPricesViaBaostock(
  startDate: string,
  endDate: string,
  onProgress: (msg: string) => void,
): Promise<DailyPriceFetchResult> {
  const trigger = (await quantPost("/api/data-update/update", {
    data_type: "daily",
    start_date: startDate,
    end_date: endDate,
    source: "baostock",
    workers: 4,
  })) as { success?: boolean; task_id?: string; error?: string };
  if (!trigger.success || !trigger.task_id) {
    throw new Error(
      `failed to start baostock fetch: ${trigger.error ?? JSON.stringify(trigger)}`,
    );
  }
  const taskId = trigger.task_id;
  // Up to 6 minutes of polling at 5s intervals = 72 polls.
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const state = (await quantGet(`/api/data-update/task/${taskId}`)) as {
      success?: boolean;
      data?: UpdateTaskState;
    };
    const s = state.data ?? {};
    if (s.message) onProgress(s.message);
    if (s.status === "success" || s.status === "completed") {
      return { triggered: true, taskId, finalStatus: s.status, finalMessage: s.message };
    }
    if (s.status === "error" || s.status === "failed") {
      throw new Error(`baostock fetch failed: ${s.message ?? "unknown error"}`);
    }
  }
  throw new Error(`baostock fetch timed out after 6 minutes (task ${taskId})`);
}

/**
 * Read MAX(date) and the trade dates strictly after the previous max. We
 * snapshot the DuckDB to avoid lock contention with the always-on dashboard.
 */
async function listSignalsBacklog(
  prevPriceLatest: string | null,
  newPriceLatest: string | null,
): Promise<string[]> {
  if (!newPriceLatest) return [];
  // Snapshot via Python so we can read while 5001 holds the writer lock.
  // Both the main DB file AND the .wal sidecar must be copied — DuckDB
  // keeps unflushed writes in the WAL, and a snapshot without it will
  // show stale data right after a heavy ingest.
  const script = `
import duckdb, shutil, tempfile, os, json, sys
src = ${JSON.stringify(QUANT_DB)}
snap = os.path.join(tempfile.gettempdir(), 'dailybrief_signals_check.duckdb')
shutil.copy2(src, snap)
wal = src + '.wal'
if os.path.exists(wal):
    shutil.copy2(wal, snap + '.wal')
con = duckdb.connect(snap, read_only=True)
sig_max = con.execute("SELECT CAST(MAX(date) AS VARCHAR) FROM daily_signals").fetchone()[0]
# Trade dates we have prices for but not yet signals.
rows = con.execute(
    """
    SELECT DISTINCT CAST(trade_date AS VARCHAR)
      FROM dwd_daily_price
     WHERE trade_date > CAST(? AS DATE)
     ORDER BY 1
    """,
    [sig_max or '1970-01-01'],
).fetchall()
print(json.dumps({"sig_max": sig_max, "missing_dates": [r[0] for r in rows]}))
`;
  const result = await runCommand(QUANT_PYTHON, ["-c", script], {
    cwd: QUANT_ROOT,
    timeoutMs: 60_000,
  });
  const line = result.stdout.trim().split("\n").pop() ?? "{}";
  try {
    const parsed = JSON.parse(line) as { sig_max?: string; missing_dates?: string[] };
    return parsed.missing_dates ?? [];
  } catch {
    return [];
  }
}

async function scanSignalsForDate(date: string, _label: string): Promise<void> {
  const compact = date.replace(/-/g, "");
  // The 5001 dashboard holds an exclusive writer lock on the DuckDB. Its
  // /scan-signals endpoint temporarily closes that connection, runs
  // scan_signals_v2 in a subprocess, then re-opens — this is the only
  // way to scan without dropping the dashboard.
  const trigger = (await quantPost("/api/data-update/scan-signals", {
    date: compact,
    workers: 4,
  })) as { success?: boolean; task_id?: string; error?: string };
  if (!trigger.success || !trigger.task_id) {
    throw new Error(
      `failed to start scan_signals for ${date}: ${trigger.error ?? JSON.stringify(trigger)}`,
    );
  }
  const taskId = trigger.task_id;
  // scan_signals_v2 typically runs ~10 min full-market; cap polling at 15.
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    const state = (await quantGet(`/api/data-update/task/${taskId}`)) as {
      success?: boolean;
      data?: UpdateTaskState;
    };
    const s = state.data ?? {};
    if (s.status === "success" || s.status === "completed") return;
    if (s.status === "error" || s.status === "failed") {
      throw new Error(`scan_signals_v2 ${date} failed: ${s.message ?? "unknown error"}`);
    }
  }
  throw new Error(`scan_signals_v2 ${date} timed out after 15 minutes (task ${taskId})`);
}

export interface ChainProgress {
  step: "fetch" | "scan" | "done";
  message: string;
}

export interface ChainResult {
  fetch: DailyPriceFetchResult;
  scannedDates: string[];
  prevPriceLatest: string | null;
  newPriceLatest: string | null;
}

export async function refreshAstockData(options: {
  onProgress?: (p: ChainProgress) => void;
  startDate?: string;
  endDate?: string;
}): Promise<ChainResult> {
  const { onProgress = () => {} } = options;
  const today = todayKey();
  const start = options.startDate ?? deriveStart(await getLatestPriceDate());
  const end = options.endDate ?? today.replace(/-/g, "");
  const prevPriceLatest = await getLatestPriceDate();

  onProgress({
    step: "fetch",
    message: `baostock 拉取 ${start}→${end}（DB 当前最新 ${prevPriceLatest ?? "无"}）`,
  });
  const fetch = await fetchDailyPricesViaBaostock(start, end, (msg) =>
    onProgress({ step: "fetch", message: msg }),
  );

  const newPriceLatest = await getLatestPriceDate();
  const backlog = await listSignalsBacklog(prevPriceLatest, newPriceLatest);
  // Avoid pathological backfill: cap at the most recent 5 trade dates that
  // have prices but no signals. Earlier dates can be backfilled with a
  // dedicated script if ever needed.
  const dates = backlog.slice(-5);

  const scannedDates: string[] = [];
  for (const date of dates) {
    onProgress({
      step: "scan",
      message: `scan_signals_v2 ${date}（共 ${dates.length} 天待扫）`,
    });
    await scanSignalsForDate(date, `${todayKey()}`);
    scannedDates.push(date);
  }

  onProgress({ step: "done", message: `数据更新完成，最新交易日 ${newPriceLatest ?? "未知"}` });

  // Drop the snapshot copies after we're done so they don't linger.
  await fs.rm("/tmp/dailybrief_signals_check.duckdb", { force: true });
  await fs.rm("/tmp/dailybrief_signals_check.duckdb.wal", { force: true });

  return {
    fetch,
    scannedDates,
    prevPriceLatest,
    newPriceLatest,
  };
}

function deriveStart(latest: string | null): string {
  // Fetch from the day after the latest price, but never look further back
  // than 7 days — that's enough cushion for any short upstream gap.
  if (!latest) return offsetDate(todayKey(), -7);
  const next = offsetDate(latest, 1);
  const cutoff = offsetDate(todayKey(), -7);
  const startIso = next < cutoff ? cutoff : next;
  return startIso.replace(/-/g, "");
}

function offsetDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
