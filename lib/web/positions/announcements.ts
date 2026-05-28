/**
 * Multi-source stock news aggregator for A-share holdings.
 *
 * Sources:
 *   1) EastMoney `np-anotice-stock` — company announcements (公告)
 *   2) 同花顺 `news.10jqka.com.cn` — financial news, filtered by stock name/code
 *   3) Google News RSS — international + Chinese news
 *   4) Bing News RSS — international news
 *
 * Each source has independent 30-min cache. Failed fetches keep stale
 * entries — never overwrite with empty.
 */

import https from "node:https";
import http from "node:http";
import path from "node:path";

import { bjNow } from "../../utils";
import { runCommand } from "../run-command";

// ---- types ----

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: "eastmoney" | string;
  sourceLabel: string;
  publishedAt: string; // YYYY-MM-DD HH:MM
}

export type AnnouncementItem = NewsItem;

// ---- http helpers ----

async function httpGetJson<T>(url: string, headers: Record<string, string>, timeoutMs: number, retries = 2): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await new Promise<T | null>((resolve) => {
      const client = url.startsWith("https://") ? https : http;
      const req = client.get(url, { headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
          catch { resolve(null); }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
    if (result !== null) return result;
    if (attempt < retries) await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

async function rssGet(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    https.get(url, { headers: { "user-agent": UA }, timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", () => resolve(null)).on("timeout", function(this: unknown) { (this as typeof https.get).destroy(); resolve(null); });
  });
}

// ---- constants ----

const CACHE_TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 10;
const MAX_AGE_DAYS = 7;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---- caches ----

interface CacheEntry { ts: number; items: NewsItem[]; }

const cacheGoogle = new Map<string, CacheEntry>();
const cacheBing = new Map<string, CacheEntry>();
const inflightGoogle = new Map<string, Promise<NewsItem[]>>();
const inflightBing = new Map<string, Promise<NewsItem[]>>();

// ---- helpers ----

function trimTime(s: string): string {
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s.slice(0, 16);
}

function titleToSummary(title: string, stockName?: string): string {
  let s = title;
  if (stockName && s.startsWith(stockName)) {
    s = s.slice(stockName.length).replace(/^[：:]/, "").trim();
  } else {
    const idx = s.search(/[：:]/);
    if (idx < 0) return "";
    s = s.slice(idx + 1).trim();
  }
  s = s.replace(/的公告$/, "").replace(/公告$/, "");
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

function dedupById(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => seen.has(item.id) ? false : (seen.add(item.id), true));
}

function titleTrigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "").slice(0, 60);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function titleOverlap(a: string, b: string): number {
  const ta = titleTrigrams(a);
  const tb = titleTrigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

function mergeAndDedup(all: NewsItem[]): NewsItem[] {
  const cutoff = new Date(bjNow().iso);
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recent = all.filter((item) => item.publishedAt >= cutoffStr);
  const sorted = recent.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const result: NewsItem[] = [];
  for (const item of sorted) {
    const dup = result.some(
      (r) => r.id === item.id || titleOverlap(r.title, item.title) >= 0.7,
    );
    if (!dup) result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}

// ---- RSS parser (shared by Google + Bing) ----

interface RssItem { title: string; link: string; pubDate: string; source: string; desc: string; }

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const title = (body.match(/<title>(.*?)<\/title>/) ?? [])[1] ?? "";
    const link = (body.match(/<link>(.*?)<\/link>/) ?? [])[1] ?? "";
    const pubDate = (body.match(/<pubDate>(.*?)<\/pubDate>/) ?? [])[1] ?? "";
    const source = (body.match(/<(?:source|News:Source)[^>]*>(.*?)<\/(?:source|News:Source)>/) ?? [])[1] ?? "";
    const descRaw = (body.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? "";
    const desc = descRaw.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
    if (title && link) items.push({ title, link, pubDate, source, desc });
  }
  return items;
}

function rssToNewsItems(items: RssItem[], prefix: string): NewsItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = item.link.slice(30, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({
      id: `${prefix}:${item.link.slice(30, 80)}`,
      title: item.title,
      summary: item.desc.slice(0, 120),
      url: item.link,
      source: prefix as "google",
      sourceLabel: item.source || prefix,
      publishedAt: item.pubDate
        ? new Date(item.pubDate).toISOString().slice(0, 16).replace("T", " ")
        : "",
    }));
}

// ---- source 1: EastMoney 公告 ----

interface EmApiRow {
  art_code?: string; title?: string; title_ch?: string;
  display_time?: string; notice_date?: string;
  columns?: Array<{ column_name?: string }>;
}
interface EmApiResponse { data?: { list?: EmApiRow[] }; }

async function fetchEastMoneyOne(symbol: string): Promise<NewsItem[]> {
  const url =
    `https://np-anotice-stock.eastmoney.com/api/security/ann` +
    `?sr=-1&page_size=20&page_index=1&ann_type=A&client_source=web` +
    `&stock_list=${encodeURIComponent(symbol)}&f_node=0&s_node=0`;
  const json = await httpGetJson<EmApiResponse>(url, {
    "user-agent": UA, "referer": "https://data.eastmoney.com/",
  }, FETCH_TIMEOUT_MS);
  if (!json) return [];
  return (json.data?.list ?? []).map((row) => {
    const artCode = row.art_code ?? "";
    const title = (row.title_ch || row.title || "").trim();
    const colNames = (row.columns ?? []).map((c) => c.column_name ?? "").filter(Boolean);
    return {
      id: `em:${artCode}`,
      title,
      summary: [colNames.join(" · "), titleToSummary(title)].filter(Boolean).join(" — "),
      url: artCode ? `https://data.eastmoney.com/notices/detail/${symbol}/${artCode}.html` : "",
      source: "eastmoney" as const,
      sourceLabel: "公告",
      publishedAt: trimTime(row.display_time ?? ""),
    };
  });
}

// ---- source 2: 同花顺 新闻 ----

interface TjqkaItem { id: string; title: string; digest: string; url: string; ctime: string; }
interface TjqkaApiResponse { code: string; data?: { list?: TjqkaItem[] }; }

async function fetch10jqkaOne(symbol: string, name?: string): Promise<NewsItem[]> {
  const url =
    `https://news.10jqka.com.cn/tapp/news/push/stock` +
    `?page=1&size=20&stock=${encodeURIComponent(symbol)}&type=0`;
  const json = await httpGetJson<TjqkaApiResponse>(url, {
    "user-agent": UA, "referer": "https://stockpage.10jqka.com.cn/",
  }, FETCH_TIMEOUT_MS);
  if (!json || json.code !== "200") return [];
  const out: NewsItem[] = [];
  for (const item of json.data?.list ?? []) {
    const text = (item.title ?? "") + (item.digest ?? "");
    if (!text.includes(symbol) && !(name && text.includes(name))) continue;
    out.push({
      id: `10jqka:${item.id}`,
      title: item.title ?? "",
      summary: (item.digest ?? "").slice(0, 120),
      url: item.url ?? "",
      source: "10jqka",
      sourceLabel: "新闻",
      publishedAt: item.ctime
        ? new Date(Number(item.ctime) * 1000).toISOString().slice(0, 16).replace("T", " ")
        : "",
    });
  }
  return out;
}

// ---- source 3: akshare batch (Python → EastMoney stock news) ----

const AK_PYTHON = "/data/SilverM-quant/.venv/bin/python";
const AK_SCRIPT = path.join(process.cwd(), "scripts", "fetch_news.py");

let akCache: { ts: number; data: Record<string, NewsItem[]> } | null = null;
let akInflight: Promise<Record<string, NewsItem[]>> | null = null;

async function fetchAkshareNews(symbols: string[]): Promise<Record<string, NewsItem[]>> {
  const now = Date.now();
  if (akCache && now - akCache.ts < CACHE_TTL_MS) return akCache.data;
  if (akInflight) return akInflight;

  akInflight = (async () => {
    try {
      const result = await runCommand(AK_PYTHON, [AK_SCRIPT, symbols.join(","), "--max-age-days", "7"], {
        cwd: process.cwd(),
        timeoutMs: 90_000,
      });
      const parsed = JSON.parse(result.stdout) as Record<string, Array<{
        title: string; summary: string; url: string; source: string; publishedAt: string;
      }>>;
      const out: Record<string, NewsItem[]> = {};
      for (const [sym, items] of Object.entries(parsed)) {
        out[sym] = (items ?? []).map((item, i) => ({
          id: `ak:${sym}:${i}`,
          title: item.title,
          summary: item.summary,
          url: item.url,
          source: "akshare",
          sourceLabel: item.source || "新闻",
          publishedAt: item.publishedAt,
        }));
      }
      akCache = { ts: Date.now(), data: out };
      return out;
    } catch {
      return akCache?.data ?? {};
    } finally {
      akInflight = null;
    }
  })();
  return akInflight;
}

// ---- source 4: Google News RSS ----

async function fetchGoogleNewsOne(symbol: string, name?: string): Promise<NewsItem[]> {
  const queries: Array<{ q: string; hl: string; gl: string; ceid: string }> = [
    { q: `${symbol} stock`, hl: "en-US", gl: "US", ceid: "US:en" },
  ];
  if (name) {
    queries.push({ q: `${name} ${symbol}`, hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans" });
  }
  const results = await Promise.all(queries.map(({ q, hl, gl, ceid }) =>
    rssGet(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`)
  ));
  return rssToNewsItems(results.filter(Boolean).flatMap((xml) => parseRssItems(xml!)), "google");
}

// ---- source 4: Bing News RSS ----

async function fetchBingNewsOne(symbol: string): Promise<NewsItem[]> {
  const xml = await rssGet(
    `https://www.bing.com/news/search?q=${encodeURIComponent(symbol)}&format=rss&setlang=en`
  );
  if (!xml) return [];
  return rssToNewsItems(parseRssItems(xml), "bing");
}

// ---- unified fetch ----

async function fetchCached(
  symbol: string,
  cache: Map<string, CacheEntry>,
  inflight: Map<string, Promise<NewsItem[]>>,
  fetcher: (s: string) => Promise<NewsItem[]>,
): Promise<NewsItem[]> {
  const now = Date.now();
  const c = cache.get(symbol);
  if (c && now - c.ts < CACHE_TTL_MS) return c.items;

  let promise = inflight.get(symbol);
  if (!promise) {
    promise = fetcher(symbol).finally(() => inflight.delete(symbol));
    inflight.set(symbol, promise);
  }
  const items = await promise;
  if (items.length > 0) { cache.set(symbol, { ts: Date.now(), items }); return items; }
  const prev = cache.get(symbol);
  if (!prev) cache.set(symbol, { ts: Date.now(), items: [] });
  return prev ? prev.items : [];
}

export async function fetchAnnouncements(
  symbols: Array<{ symbol: string; name?: string }>,
): Promise<Record<string, NewsItem[]>> {
  const out: Record<string, NewsItem[]> = {};

  // Batch akshare first (one Python call for all symbols).
  const akData = await fetchAkshareNews(symbols.map((s) => s.symbol));

  // Per-symbol: merge akshare + Google + Bing.
  for (const { symbol, name } of symbols) {
    const [ggItems, bgItems] = await Promise.all([
      fetchCached(symbol, cacheGoogle, inflightGoogle, (s) => fetchGoogleNewsOne(s, name)),
      fetchCached(symbol, cacheBing, inflightBing, (s) => fetchBingNewsOne(s)),
    ]);
    const akItems = akData[symbol] ?? [];
    const all = [...akItems, ...ggItems, ...bgItems];
    out[symbol] = dedupById(mergeAndDedup(all)).slice(0, MAX_ITEMS);
  }
  return out;
}

export function getCachedAnnouncements(
  symbols: Array<{ symbol: string; name?: string }>,
): Record<string, NewsItem[]> {
  const now = Date.now();
  const out: Record<string, NewsItem[]> = {};
  for (const { symbol } of symbols) {
    const gg = cacheGoogle.get(symbol);
    const bg = cacheBing.get(symbol);
    const all = [
      ...(akCache && now - akCache.ts < CACHE_TTL_MS ? (akCache.data[symbol] ?? []) : []),
      ...(gg && now - gg.ts < CACHE_TTL_MS ? gg.items : []),
      ...(bg && now - bg.ts < CACHE_TTL_MS ? bg.items : []),
    ];
    out[symbol] = dedupById(mergeAndDedup(all)).slice(0, MAX_ITEMS);
  }
  return out;
}

export function refreshAnnouncementsBg(
  symbols: Array<{ symbol: string; name?: string }>,
): void {
  fetchAnnouncements(symbols)
    .then((r) => {
      const counts = Object.entries(r).map(([k, v]) => `${k}:${v.length}`).join(", ");
      if (counts) console.log(`[news] bg fetch done — ${counts}`);
    })
    .catch((e) => console.error(`[news] bg fetch failed: ${e instanceof Error ? e.message : e}`));
}

export function invalidateAnnouncementsCache(): void {
  akCache = null;
  for (const m of [cacheGoogle, cacheBing]) m.clear();
  for (const m of [inflightGoogle, inflightBing]) m.clear();
}

// ---- hot-keyword detection ----

export const ANNOUNCEMENT_HOT_KEYWORDS = [
  "回购", "减持", "增持", "问询函", "重大资产",
  "股权激励", "业绩预告", "立案", "ST", "退市",
  "停牌", "复牌",
];

export function findHotKeywords(title: string): string[] {
  return ANNOUNCEMENT_HOT_KEYWORDS.filter((kw) => title.includes(kw));
}
