import type { QuoteSummary } from "./types";

/**
 * Public announcement (公告) fetcher for A-share holdings.
 *
 * Source: EastMoney `np-anotice-stock` endpoint (no auth, no token, public).
 *
 *   GET https://np-anotice-stock.eastmoney.com/api/security/ann
 *     ?sr=-1&page_size=10&page_index=1&ann_type=A
 *     &client_source=web&stock_list=600519
 *
 * Returns latest disclosed announcements for the symbol — title, time,
 * art_code (used to dedupe across polls), market column codes.
 *
 * Cache: 30-min TTL per symbol. Announcements are slow-moving (a stock
 * usually has 0-3 per week), so polling more frequently is wasteful.
 */

const ENDPOINT = "https://np-anotice-stock.eastmoney.com/api/security/ann";
const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;

export interface AnnouncementItem {
  artCode: string;        // unique identifier, dedupe key
  title: string;
  displayTime: string;    // YYYY-MM-DD HH:MM (no seconds, no ms)
  noticeDate: string;     // YYYY-MM-DD
  columns: string[];      // e.g. ["回购实施公告", "股本变动"]
}

interface CacheEntry {
  ts: number;
  items: AnnouncementItem[];
}

const cache = new Map<string, CacheEntry>();

interface RawApiResponse {
  data?: {
    list?: Array<{
      art_code?: string;
      title?: string;
      title_ch?: string;
      display_time?: string;
      notice_date?: string;
      columns?: Array<{ column_name?: string }>;
    }>;
  };
}

function trimTime(s: string): string {
  // "2026-05-27 18:42:15:380" → "2026-05-27 18:42"
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s.slice(0, 16);
}

async function fetchOne(symbol: string): Promise<AnnouncementItem[]> {
  const url =
    `${ENDPOINT}?sr=-1&page_size=10&page_index=1&ann_type=A&client_source=web` +
    `&stock_list=${encodeURIComponent(symbol)}&f_node=0&s_node=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "referer": "https://data.eastmoney.com/",
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as RawApiResponse;
    const list = json.data?.list ?? [];
    return list.map((row) => ({
      artCode: row.art_code ?? "",
      title: (row.title_ch || row.title || "").trim(),
      displayTime: trimTime(row.display_time ?? ""),
      noticeDate: (row.notice_date ?? "").slice(0, 10),
      columns: (row.columns ?? [])
        .map((c) => c.column_name ?? "")
        .filter(Boolean),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAnnouncements(symbols: string[]): Promise<Record<string, AnnouncementItem[]>> {
  const now = Date.now();
  const out: Record<string, AnnouncementItem[]> = {};
  const stale: string[] = [];
  for (const s of symbols) {
    const c = cache.get(s);
    if (c && now - c.ts < CACHE_TTL_MS) {
      out[s] = c.items;
    } else {
      stale.push(s);
    }
  }
  if (stale.length) {
    // Throttle slightly: 200ms between symbols. EastMoney is generous but
    // hammering N symbols at once tends to trip transient 403s.
    for (const s of stale) {
      const items = await fetchOne(s);
      cache.set(s, { ts: now, items });
      out[s] = items;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return out;
}

export function invalidateAnnouncementsCache(): void {
  cache.clear();
}

/** Used by the alert engine in a future patch — not wired yet. */
export const ANNOUNCEMENT_HOT_KEYWORDS = [
  "回购",
  "减持",
  "增持",
  "问询函",
  "重大资产",
  "股权激励",
  "业绩预告",
  "立案",
  "ST",
  "退市",
  "停牌",
  "复牌",
];

export function findHotKeywords(title: string): string[] {
  return ANNOUNCEMENT_HOT_KEYWORDS.filter((kw) => title.includes(kw));
}
