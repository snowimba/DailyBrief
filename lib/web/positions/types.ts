// Type definitions for the 盯盘助手 (positions / watchlist) tab.
// Mirrors §2 of docs/positions-tab.md. Keep the two in sync.

export type Exchange = "sh" | "sz" | "bj";

export interface Position {
  id: string;
  symbol: string;        // 6-digit code, e.g. "600519"
  exchange: Exchange;
  name?: string;         // populated after first quote fetch
  shares: number;
  avgCost: number;
  openedAt?: string;     // YYYY-MM-DD
  note?: string;
  starred?: boolean;
  alertRules: AlertRule[];
  industry?: string;     // looked up from SilverM-quant dwd_stock_info
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
}

export type AlertChannel = "telegram" | "browser" | "log_only";

export type AlertKind = "pct_from_cost" | "absolute" | "daily_change_pct";

export type AlertTrigger = "cross_up" | "cross_down" | "any";

export interface AlertRule {
  id: string;
  kind: AlertKind;
  pct?: number;          // pct_from_cost — signed, e.g. +5 / -3
  price?: number;        // absolute
  dailyPct?: number;     // daily_change_pct — signed, e.g. -7
  trigger: AlertTrigger;
  cooldownMin: number;
  channels: AlertChannel[];
  enabled: boolean;
  label?: string;
  lastFiredAt?: string;
  lastFiredPrice?: number;
}

export interface QuoteSummary {
  symbol: string;        // 6-digit
  exchange: Exchange;
  qualified: string;     // e.g. "sh600519"
  name: string;
  open: number;
  prevClose: number;
  last: number;
  high: number;
  low: number;
  volume: number;        // 股
  amount: number;        // 元
  bid1Price?: number;
  ask1Price?: number;
  changePct: number;     // (last - prevClose) / prevClose * 100, computed locally
  date: string;          // YYYY-MM-DD
  time: string;          // HH:MM:SS
  source: "sina" | "tencent";
  fetchedAt: string;     // ISO when WE fetched (not the exchange timestamp)
  stale?: boolean;       // true if served from cache
  raw?: string;          // original line for debugging (truncated)
}

export interface AlertEvent {
  ts: string;            // ISO when triggered
  positionId: string;
  ruleId: string;
  symbol: string;
  name: string;
  ruleLabel: string;     // e.g. "+5% 止盈位"
  kind: AlertKind;
  targetPrice: number;
  prevPrice: number;
  currPrice: number;
  pctFromCost: number;
  dailyChangePct: number;
  channels: AlertChannel[];
  deliveryStatus: "queued" | "success" | "failed" | "skipped";
  channelResults: Record<string, { ok: boolean; latencyMs?: number; error?: string }>;
}

/** Persisted alert state, separate file so engine writes don't race CRUD. */
export interface AlertStateEntry {
  ruleId: string;
  positionId: string;
  lastFiredAt?: string;
  lastFiredPrice?: number;
  prevPrice?: number;        // last seen price, for cross detection
  prevDayKey?: string;       // YYYY-MM-DD of last seen quote, for first-of-day skip
}

export interface NewPositionInput {
  symbol: string;
  shares: number;
  avgCost: number;
  openedAt?: string;
  note?: string;
}

export interface PatchPositionInput {
  shares?: number;
  avgCost?: number;
  openedAt?: string;
  note?: string;
  starred?: boolean;
}

export interface NewRuleInput {
  kind: AlertKind;
  pct?: number;
  price?: number;
  dailyPct?: number;
  trigger?: AlertTrigger;
  cooldownMin?: number;
  channels?: AlertChannel[];
  label?: string;
  enabled?: boolean;
}

// ---- T4 risk data types ----

export interface FundFlowItem {
  symbol: string;
  name: string;
  /** 主力净流入 (元) — negative = outflow */
  mainNetInflow: number;
  superLargeInflow: number;
  largeInflow: number;
  mediumInflow: number;
  smallInflow: number;
  date: string;
  fetchedAt: string;
}

export interface DragonTigerItem {
  symbol: string;
  name: string;
  boardDate: string;
  reason: string;
  closePrice: number;
  changePct: number;
  netBuyAmount: number;
  buyAmount: number;
  sellAmount: number;
  totalDealAmount: number;
  marketDealAmount: number;
  fetchedAt: string;
}

export interface BlockTradeItem {
  symbol: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  tag: "大宗交易" | "减持" | "增持" | "质押" | "解禁";
  tradePrice?: number;
  tradeVolume?: number;
  discountRate?: number;
}

export interface CalendarEvent {
  symbol: string;
  name: string;
  eventDate: string;
  eventType: "年报" | "半年报" | "分红除权" | "股权登记" | "股东大会";
  description: string;
  dividendPerShare?: number;
  dividendYield?: number;
  fetchedAt: string;
}

export interface STRiskItem {
  symbol: string;
  name: string;
  riskLevel: "st" | "star_st" | "delisted" | "normal";
  delistDate?: string;
  fetchedAt: string;
}

/** Position annotated with quote + industry + risk data for snapshot serialization. */
export interface PositionAnnotated extends Position {
  quote?: QuoteSummary;
  holdDays?: number;
  industry?: string;
  announcements?: import("./announcements").NewsItem[];
  fundFlow?: FundFlowItem;
  dragonTiger?: DragonTigerItem[];
  stRisk?: STRiskItem;
}
