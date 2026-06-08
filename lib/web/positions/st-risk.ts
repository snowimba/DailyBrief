import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runCommand } from "../run-command";
import type { STRiskItem } from "./types";
import { bjIso } from "../../utils";

/**
 * ST / delisting risk lookup via SilverM-quant DuckDB dwd_stock_info.
 *
 * Detects ST/*ST status from the `name` column prefix — no external API
 * needed. The DuckDB is refreshed daily by baostock ingest.
 *
 * Cache: 6 hours. ST status changes very rarely (quarterly reviews).
 */

const QUANT_ROOT = process.env.QUANT_ROOT ?? "/data/SilverM-quant";
const QUANT_PYTHON = path.join(QUANT_ROOT, ".venv/bin/python");
const QUANT_DB = path.join(QUANT_ROOT, "data/Astock3.duckdb");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache: { ts: number; bySymbol: Map<string, STRiskItem> } | null = null;

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function querySTRisks(symbols: string[]): Promise<Map<string, STRiskItem> | null> {
  if (!(await fileExists(QUANT_DB))) return null;
  if (!(await fileExists(QUANT_PYTHON))) return null;
  if (symbols.length === 0) return new Map();

  const tmpDb = path.join(os.tmpdir(), "dailybrief_strisk_snap.duckdb");
  const symbolList = JSON.stringify(symbols);
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
code_col = next((c for c in ['symbol','ts_code','code'] if c in cols), None)
name_col = next((c for c in ['name','stock_name'] if c in cols), None)
if not code_col or not name_col:
    print(json.dumps({}))
else:
    symbols = ${symbolList}
    placeholders = ','.join(['?' for _ in symbols])
    rows = con.execute(
        f"SELECT {code_col}, {name_col} FROM dwd_stock_info WHERE {code_col} IN ({placeholders})",
        symbols
    ).fetchall()
    out = {}
    for code, name in rows:
        c = str(code).split('.')[0]
        if c.isdigit() and len(c) == 6:
            out[c] = str(name or '')
    print(json.dumps(out, ensure_ascii=False))
`;

  try {
    const result = await runCommand(QUANT_PYTHON, ["-c", script], {
      cwd: QUANT_ROOT,
      timeoutMs: 30_000,
    });
    const line = result.stdout.trim().split("\n").pop() ?? "{}";
    const obj = JSON.parse(line) as Record<string, string>;

    const map = new Map<string, STRiskItem>();
    const iso = bjIso();
    for (const [sym, name] of Object.entries(obj)) {
      let riskLevel: STRiskItem["riskLevel"] = "normal";
      if (name.startsWith("*ST")) riskLevel = "star_st";
      else if (name.startsWith("ST")) riskLevel = "st";
      else continue; // skip normal stocks — only return risks

      map.set(sym, { symbol: sym, name, riskLevel, fetchedAt: iso });
    }
    return map;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[positions/st-risk] DuckDB query failed: ${msg}`);
    return null;
  } finally {
    fs.rm(tmpDb, { force: true }).catch(() => {});
    fs.rm(`${tmpDb}.wal`, { force: true }).catch(() => {});
  }
}

export async function fetchSTRisks(
  symbols: string[],
): Promise<Map<string, STRiskItem>> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    // Return only the requested symbols from cache (cache may have more).
    const out = new Map<string, STRiskItem>();
    for (const s of symbols) {
      const r = cache.bySymbol.get(s);
      if (r) out.set(s, r);
    }
    return out;
  }

  const raw = await querySTRisks(symbols);
  if (!raw) {
    // On failure, return stale cache if available.
    if (cache) {
      const out = new Map<string, STRiskItem>();
      for (const s of symbols) {
        const r = cache.bySymbol.get(s);
        if (r) out.set(s, r);
      }
      return out;
    }
    return new Map();
  }

  cache = { ts: now, bySymbol: raw };
  return raw;
}

export function getCachedSTRisks(): Map<string, STRiskItem> | null {
  if (!cache || Date.now() - cache.ts > CACHE_TTL_MS) return null;
  return cache.bySymbol;
}
