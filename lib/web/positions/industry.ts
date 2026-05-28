import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runCommand } from "../run-command";

/**
 * Industry / sector lookup for A-share holdings.
 *
 * Source order:
 *
 *   1) data/industry-map.json — produced by `npx tsx scripts/build-industry-map.ts`
 *      (baostock based, weekly cadence). This is the preferred source.
 *
 *   2) Fallback: SilverM-quant's `dwd_stock_info.industry` column inside the
 *      shared DuckDB. Currently empty in this env (baostock ingest doesn't
 *      fill it), but kept for future-compatibility with tushare-backed envs.
 *
 * In-process cache lives 24h; restart the web server to refresh.
 */

const JSON_FILE = path.join(process.cwd(), "data", "industry-map.json");

const QUANT_ROOT = process.env.QUANT_ROOT ?? "/data/SilverM-quant";
const QUANT_PYTHON = path.join(QUANT_ROOT, ".venv/bin/python");
const QUANT_DB = path.join(QUANT_ROOT, "data/Astock3.duckdb");

interface IndustryCache {
  ts: number;
  bySymbol: Map<string, string>;
  source: "json-sidecar" | "duckdb" | "none";
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

let cache: IndustryCache | null = null;

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadFromJson(): Promise<Map<string, string> | null> {
  if (!(await fileExists(JSON_FILE))) return null;
  try {
    const raw = await fs.readFile(JSON_FILE, "utf8");
    const parsed = JSON.parse(raw) as {
      map?: Record<string, string>;
      count?: number;
      updatedAt?: string;
    };
    if (!parsed.map) return null;
    const map = new Map(Object.entries(parsed.map));
    if (map.size > 0) {
      console.log(
        `[positions/industry] loaded ${map.size} entries from ${JSON_FILE}` +
          (parsed.updatedAt ? ` (updateDate ${parsed.updatedAt})` : ""),
      );
    }
    return map;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[positions/industry] failed to read ${JSON_FILE}: ${msg}`);
    return null;
  }
}

async function loadFromDuckDb(): Promise<Map<string, string> | null> {
  if (!(await fileExists(QUANT_DB))) return null;
  if (!(await fileExists(QUANT_PYTHON))) return null;
  const tmpDb = path.join(os.tmpdir(), "dailybrief_industry_snap.duckdb");
  const script = `
import duckdb, shutil, os, json
src = ${JSON.stringify(QUANT_DB)}
snap = ${JSON.stringify(tmpDb)}
shutil.copy2(src, snap)
wal = src + '.wal'
if os.path.exists(wal):
    shutil.copy2(wal, snap + '.wal')
con = duckdb.connect(snap, read_only=True)
cols = [r[1] for r in con.execute("PRAGMA table_info(dwd_stock_info)").fetchall()]
code_col = next((c for c in ['ts_code','code','symbol'] if c in cols), None)
ind_col = next((c for c in ['industry','sw_industry','industry_l1'] if c in cols), None)
if not code_col or not ind_col:
    print(json.dumps({}))
else:
    rows = con.execute(f"SELECT {code_col}, {ind_col} FROM dwd_stock_info WHERE {ind_col} IS NOT NULL").fetchall()
    out = {}
    for code, ind in rows:
        c = str(code).split('.')[0]
        if c.isdigit() and len(c) == 6:
            out[c] = ind
    print(json.dumps(out, ensure_ascii=False))
`;
  try {
    const result = await runCommand(QUANT_PYTHON, ["-c", script], {
      cwd: QUANT_ROOT,
      timeoutMs: 60_000,
    });
    const line = result.stdout.trim().split("\n").pop() ?? "{}";
    const obj = JSON.parse(line) as Record<string, string>;
    const map = new Map(Object.entries(obj));
    return map.size > 0 ? map : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[positions/industry] DuckDB fallback failed: ${msg}`);
    return null;
  } finally {
    fs.rm(tmpDb, { force: true }).catch(() => {});
    fs.rm(`${tmpDb}.wal`, { force: true }).catch(() => {});
  }
}

async function refreshCache(): Promise<IndustryCache> {
  const fromJson = await loadFromJson();
  if (fromJson && fromJson.size > 0) {
    return { ts: Date.now(), bySymbol: fromJson, source: "json-sidecar" };
  }
  const fromDb = await loadFromDuckDb();
  if (fromDb && fromDb.size > 0) {
    return { ts: Date.now(), bySymbol: fromDb, source: "duckdb" };
  }
  console.warn(
    "[positions/industry] no source available — run " +
      "`npx tsx scripts/build-industry-map.ts` to populate the sidecar",
  );
  return { ts: Date.now(), bySymbol: new Map(), source: "none" };
}

export async function getIndustry(symbol: string): Promise<string | undefined> {
  const now = Date.now();
  if (!cache || now - cache.ts > TWENTY_FOUR_HOURS) {
    cache = await refreshCache();
  }
  return cache.bySymbol.get(symbol);
}

export async function annotateIndustryAll(
  symbols: string[],
): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const s of symbols) out[s] = await getIndustry(s);
  return out;
}
