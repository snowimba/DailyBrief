import type { BlockTradeItem, NewsItem } from "./types";

/**
 * Extract block trades, shareholder reductions, and other structured risk events
 * from the already-fetched EastMoney announcement stream.
 *
 * This is zero additional HTTP cost — the announcements are already being
 * fetched per-stock in announcements.ts. We just classify them.
 *
 * Cache: 30-min (same as announcement cache).
 */

const TAG_PATTERNS: Array<{ re: RegExp; tag: BlockTradeItem["tag"] }> = [
  { re: /大宗交易/, tag: "大宗交易" },
  { re: /减持(计划|股份|完成|结果|进展|比例)?/, tag: "减持" },
  { re: /增持(计划|股份|完成)?/, tag: "增持" },
  { re: /(股份|股权)质押/, tag: "质押" },
  { re: /解禁(上市|流通|股|前)?|限售(股)?(上市|解禁)/, tag: "解禁" },
];

function classifyTag(title: string, summary: string): BlockTradeItem["tag"] | null {
  const text = `${title} ${summary}`;
  for (const { re, tag } of TAG_PATTERNS) {
    if (re.test(text)) return tag;
  }
  return null;
}

function extractTradeDetails(
  summary: string,
): { tradePrice?: number; tradeVolume?: number; discountRate?: number } {
  // Try to extract structured fields from summary text when akshare data unavailable.
  // EastMoney columns may include price/volume in descriptive text.
  const priceM = summary.match(/成交价[格]?[：:]\s*([\d.]+)/);
  const volM = summary.match(/(?:成交|交易)(?:数量|量)[：:]\s*([\d.,]+)\s*(万)?股/);
  const discountM = summary.match(/折[溢价]率[：:]\s*([\d.-]+)%/);
  return {
    tradePrice: priceM ? parseFloat(priceM[1]) : undefined,
    tradeVolume: volM ? parseFloat(volM[1].replace(/,/g, "")) * (volM[2] ? 10_000 : 1) : undefined,
    discountRate: discountM ? parseFloat(discountM[1]) : undefined,
  };
}

export function extractBlockTradeAnnouncements(
  announcements: NewsItem[],
): BlockTradeItem[] {
  const out: BlockTradeItem[] = [];
  for (const a of announcements) {
    const tag = classifyTag(a.title, a.summary);
    if (!tag) continue;
    const details = extractTradeDetails(a.summary);
    out.push({
      symbol: a.id.split(":")[1] ?? "",
      title: a.title,
      summary: a.summary,
      url: a.url,
      publishedAt: a.publishedAt,
      tag,
      ...details,
    });
  }
  return out;
}

export function extractBlockTradesBySymbol(
  annMap: Record<string, NewsItem[]>,
): BlockTradeItem[] {
  const all: BlockTradeItem[] = [];
  for (const [symbol, items] of Object.entries(annMap)) {
    for (const item of items) {
      const tag = classifyTag(item.title, item.summary);
      if (!tag) continue;
      const details = extractTradeDetails(item.summary);
      all.push({
        symbol,
        title: item.title,
        summary: item.summary,
        url: item.url,
        publishedAt: item.publishedAt,
        tag,
        ...details,
      });
    }
  }
  return all;
}
