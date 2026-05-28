import iconv from "iconv-lite";

import { bjIso } from "../../utils";
import type { Exchange, QuoteSummary } from "./types";

/**
 * Free A-share realtime quote sources. Both return GBK-encoded plain text.
 *
 *   Sina:    http://hq.sinajs.cn/list=sh600519,sz000001
 *   Tencent: http://qt.gtimg.cn/q=sh600519,sz000001
 *
 * Sina is the primary source. Tencent fills in when Sina is empty (北交所 偶发)
 * or fails. EastMoney push2 was tested and returned 502s, so we skip it.
 *
 * The fetcher batches all requested symbols into a single HTTP call. There is
 * a 3-second cache so multiple concurrent tab visitors don't multiply the
 * upstream load.
 */

const SINA_BASE = "http://hq.sinajs.cn/list=";
const TENCENT_BASE = "http://qt.gtimg.cn/q=";
const SINA_REFERER = "https://finance.sina.com.cn/";

const CACHE_TTL_MS = 3_000;

interface CacheEntry {
  ts: number;
  quotes: Map<string, QuoteSummary>;
}

let cache: CacheEntry | null = null;

function isCacheFresh(now: number): boolean {
  return !!cache && now - cache.ts < CACHE_TTL_MS;
}

export function qualified(symbol: string, exchange: Exchange): string {
  return `${exchange}${symbol}`;
}

function exchangeOf(qual: string): Exchange {
  if (qual.startsWith("sh")) return "sh";
  if (qual.startsWith("bj")) return "bj";
  return "sz";
}

function symbolOf(qual: string): string {
  return qual.replace(/^[a-z]+/i, "");
}

async function fetchText(
  url: string,
  options: { referer?: string; timeoutMs: number },
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    };
    if (options.referer) headers["referer"] = options.referer;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return iconv.decode(Buffer.from(buffer), "gbk");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ----- Sina parsing -----
// var hq_str_sh600519="贵州茅台,1290.000,1303.000,1275.980,1304.000,1271.000,
//   1275.820,1275.980,4588998,5895475019.000,
//   /* bid×5: vol,price */ ..., /* ask×5: vol,price */ ...,
//   2026-05-28,15:00:02,00,";
function parseSinaLine(line: string): QuoteSummary | null {
  const m = line.match(/^var hq_str_([a-z]+\d+)="([^"]*)";?$/);
  if (!m) return null;
  const qual = m[1];
  const fields = m[2].split(",");
  if (fields.length < 33 || !fields[0]) return null;
  const last = parseFloat(fields[3]);
  const prevClose = parseFloat(fields[2]);
  if (!Number.isFinite(last) || last === 0 || !Number.isFinite(prevClose) || prevClose === 0) {
    return null;
  }
  const symbol = symbolOf(qual);
  const exchange = exchangeOf(qual);
  return {
    symbol,
    exchange,
    qualified: qual,
    name: fields[0],
    open: parseFloat(fields[1]),
    prevClose,
    last,
    high: parseFloat(fields[4]),
    low: parseFloat(fields[5]),
    bid1Price: parseFloat(fields[11]),
    ask1Price: parseFloat(fields[21]),
    volume: parseFloat(fields[8]),
    amount: parseFloat(fields[9]),
    changePct: ((last - prevClose) / prevClose) * 100,
    date: fields[30] || "",
    time: fields[31] || "",
    source: "sina",
    fetchedAt: bjIso(),
    raw: line.slice(0, 200),
  };
}

// ----- Tencent parsing -----
// v_sh600519="1~贵州茅台~600519~1275.98~1303.00~1290.00~..." (~50 fields)
function parseTencentLine(line: string): QuoteSummary | null {
  const m = line.match(/^v_([a-z]+\d+)="([^"]*)";?$/);
  if (!m) return null;
  const qual = m[1];
  const fields = m[2].split("~");
  if (fields.length < 47 || !fields[1]) return null;
  const last = parseFloat(fields[3]);
  const prevClose = parseFloat(fields[4]);
  if (!Number.isFinite(last) || last === 0) return null;
  const symbol = symbolOf(qual);
  const exchange = exchangeOf(qual);
  // fields[30] = "yyyymmddHHMMss"
  let date = "";
  let time = "";
  if (fields[30] && fields[30].length >= 14) {
    const t = fields[30];
    date = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    time = `${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
  }
  return {
    symbol,
    exchange,
    qualified: qual,
    name: fields[1],
    open: parseFloat(fields[5]),
    prevClose,
    last,
    high: parseFloat(fields[33]),
    low: parseFloat(fields[34]),
    bid1Price: parseFloat(fields[9]),
    ask1Price: parseFloat(fields[19]),
    volume: parseFloat(fields[6]) * 100, // tencent reports lots (手), convert to shares
    amount: parseFloat(fields[37]) * 10_000, // 万元 → 元
    changePct: ((last - prevClose) / prevClose) * 100,
    date,
    time,
    source: "tencent",
    fetchedAt: bjIso(),
    raw: line.slice(0, 200),
  };
}

async function fetchSina(quals: string[]): Promise<Map<string, QuoteSummary>> {
  const out = new Map<string, QuoteSummary>();
  if (!quals.length) return out;
  const text = await fetchText(`${SINA_BASE}${quals.join(",")}`, {
    referer: SINA_REFERER,
    timeoutMs: 6_000,
  });
  if (!text) return out;
  for (const line of text.split("\n")) {
    const parsed = parseSinaLine(line.trim());
    if (parsed) out.set(parsed.qualified, parsed);
  }
  return out;
}

async function fetchTencent(quals: string[]): Promise<Map<string, QuoteSummary>> {
  const out = new Map<string, QuoteSummary>();
  if (!quals.length) return out;
  const text = await fetchText(`${TENCENT_BASE}${quals.join(",")}`, {
    timeoutMs: 6_000,
  });
  if (!text) return out;
  for (const line of text.split("\n")) {
    const parsed = parseTencentLine(line.trim());
    if (parsed) out.set(parsed.qualified, parsed);
  }
  return out;
}

/** Batch quote fetch with main/fallback, 3s in-process cache. */
export async function fetchQuotes(quals: string[]): Promise<QuoteSummary[]> {
  const now = Date.now();
  if (isCacheFresh(now)) {
    const cached = cache!.quotes;
    const all = quals.every((q) => cached.has(q));
    if (all) return quals.map((q) => ({ ...cached.get(q)!, stale: true }));
  }
  const unique = Array.from(new Set(quals));
  let merged = await fetchSina(unique);
  // Find which ones are missing or zero-priced and try Tencent.
  const missing = unique.filter((q) => !merged.has(q));
  if (missing.length) {
    const tencent = await fetchTencent(missing);
    for (const [k, v] of tencent) merged.set(k, v);
  }
  // Update cache.
  const next = cache?.quotes ?? new Map<string, QuoteSummary>();
  for (const [k, v] of merged) next.set(k, v);
  cache = { ts: now, quotes: next };
  return unique.map((q) => merged.get(q)).filter((x): x is QuoteSummary => !!x);
}

/** Force refresh — bypass cache. */
export function invalidateQuoteCache(): void {
  cache = null;
}
