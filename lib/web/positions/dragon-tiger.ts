import path from "node:path";

import { runCommand } from "../run-command";
import type { DragonTigerItem } from "./types";
import { bjDate, bjIso } from "../../utils";

/**
 * Dragon-tiger board (龙虎榜) lookup via akshare stock_lhb_detail_em.
 *
 * The board is published once per day after market close (usually ~16:30).
 * We batch-fetch the entire board for today and filter by held symbols.
 *
 * Cache: daily (reset at midnight Beijing time). Board data doesn't change
 * intraday after the initial publication.
 */

const AK_PYTHON = "/data/SilverM-quant/.venv/bin/python";
const AK_SCRIPT = path.join(process.cwd(), "scripts", "fetch_lhb.py");

let cache: { ts: number; date: string; bySymbol: Map<string, DragonTigerItem[]> } | null = null;
let inflight: Promise<Map<string, DragonTigerItem[]>> | null = null;

function cacheExpired(): boolean {
  if (!cache) return true;
  const today = bjDate();
  return cache.date !== today;
}

async function fetchBoard(dateStr: string, symbols: string[]): Promise<Map<string, DragonTigerItem[]>> {
  const args = [AK_SCRIPT, dateStr.replace(/-/g, "")];
  if (symbols.length > 0) {
    args.push("--symbols", symbols.join(","));
  }
  const result = await runCommand(AK_PYTHON, args, {
    cwd: process.cwd(),
    timeoutMs: 120_000,
  });

  const raw = JSON.parse(result.stdout || "[]") as Array<{
    symbol: string; name: string; boardDate: string; reason: string;
    closePrice: number; changePct: number; netBuyAmount: number;
    buyAmount: number; sellAmount: number; totalDealAmount: number; marketDealAmount: number;
  }>;

  const map = new Map<string, DragonTigerItem[]>();
  const iso = bjIso();
  for (const item of raw) {
    const entry: DragonTigerItem = { ...item, fetchedAt: iso };
    const list = map.get(item.symbol);
    if (list) list.push(entry);
    else map.set(item.symbol, [entry]);
  }
  return map;
}

export async function fetchDragonTiger(
  symbols: string[],
): Promise<Map<string, DragonTigerItem[]>> {
  if (!cacheExpired()) {
    const out = new Map<string, DragonTigerItem[]>();
    for (const s of symbols) {
      const items = cache!.bySymbol.get(s);
      if (items) out.set(s, items);
    }
    return out;
  }

  if (inflight) return inflight;

  const today = bjDate();
  inflight = fetchBoard(today, symbols)
    .then((map) => {
      cache = { ts: Date.now(), date: today, bySymbol: map };
      return map;
    })
    .catch((e) => {
      console.warn(`[positions/dragon-tiger] fetch failed: ${e instanceof Error ? e.message : e}`);
      return cache?.bySymbol ?? new Map();
    })
    .finally(() => { inflight = null; });

  return inflight;
}

export function getCachedDragonTiger(): Map<string, DragonTigerItem[]> | null {
  if (cacheExpired()) return null;
  return cache.bySymbol;
}
