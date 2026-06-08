import path from "node:path";

import { runCommand } from "../run-command";
import type { FundFlowItem } from "./types";
import { bjDate, bjIso } from "../../utils";

/**
 * Capital flow (主力资金流向) lookup via akshare stock_individual_fund_flow.
 *
 * The EastMoney-backed akshare API is unstable from this environment —
 * connection resets and 502s are common. This module has layered fallbacks:
 *
 *   1. Try the Python script (3 retries per symbol, 2s backoff).
 *   2. On total failure → return empty map (graceful degradation).
 *   3. Cache the successful results for 1 hour.
 *
 * Cache: daily (reset at midnight). Fund flow data is published once
 * after market close and doesn't change intraday.
 */

const AK_PYTHON = "/data/SilverM-quant/.venv/bin/python";
const AK_SCRIPT = path.join(process.cwd(), "scripts", "fetch_fund_flow.py");

let cache: { ts: number; date: string; bySymbol: Map<string, FundFlowItem> } | null = null;
let inflight: Promise<Map<string, FundFlowItem>> | null = null;

function cacheExpired(): boolean {
  if (!cache) return true;
  return cache.date !== bjDate();
}

export async function fetchFundFlow(
  symbols: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, FundFlowItem>> {
  if (symbols.length === 0) return new Map();

  if (!cacheExpired()) {
    const out = new Map<string, FundFlowItem>();
    for (const { symbol } of symbols) {
      const item = cache!.bySymbol.get(symbol);
      if (item) out.set(symbol, item);
    }
    return out;
  }

  if (inflight) return inflight;

  const quals = symbols.map((s) => `${s.exchange}${s.symbol}`).join(",");
  const today = bjDate();

  inflight = runCommand(AK_PYTHON, [AK_SCRIPT, quals], {
    cwd: process.cwd(),
    timeoutMs: 120_000,
  })
    .then((result) => {
      const parsed = JSON.parse(result.stdout || "{}") as Record<string, {
        date: string; name: string; mainNetInflow: number;
        superLargeInflow: number; largeInflow: number;
        mediumInflow: number; smallInflow: number;
      } | null>;

      const map = new Map<string, FundFlowItem>();
      const iso = bjIso();
      const qualToSym = new Map(symbols.map((s) => [`${s.exchange}${s.symbol}`, s.symbol]));
      for (const [qual, data] of Object.entries(parsed)) {
        if (!data) continue;
        const sym = qualToSym.get(qual);
        if (!sym) continue;
        map.set(sym, { symbol: sym, ...data, fetchedAt: iso });
      }
      cache = { ts: Date.now(), date: today, bySymbol: map };
      return map;
    })
    .catch((e) => {
      console.warn(
        `[positions/fund-flow] fetch failed (fund flow will be empty this cycle): ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
      // Graceful degradation: return empty. The page still works without fund flow.
      const empty = new Map<string, FundFlowItem>();
      cache = { ts: Date.now(), date: today, bySymbol: empty };
      return empty;
    })
    .finally(() => { inflight = null; });

  return inflight;
}

export function getCachedFundFlow(): Map<string, FundFlowItem> | null {
  if (cacheExpired()) return null;
  return cache.bySymbol;
}
