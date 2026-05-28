import path from "node:path";

import type { RefreshResult, TabProvider } from "../types";
import {
  browserDispatcher,
  logOnlyDispatcher,
  runAlertEngine,
  type ChannelDispatcher,
} from "./alert-engine";
import {
  getCachedAnnouncements,
  refreshAnnouncementsBg,
  type AnnouncementItem,
} from "./announcements";
import fs from "node:fs/promises";
import path from "node:path";

import { bjNow } from "../../utils";
import { getIndustry } from "./industry";
import { fetchQuotes, qualified } from "./quote-source";
import {
  loadPositions,
  loadAlertState,
} from "./store";
import { telegramDispatcher, getTelegramConfig } from "./telegram";
import type { AlertEvent, Position, QuoteSummary } from "./types";

const TICK_TRADING_MS = Number(process.env.POSITIONS_TICK_TRADING_MS ?? 5_000);
const TICK_OFFHOURS_MS = Number(process.env.POSITIONS_TICK_OFFHOURS_MS ?? 60_000);
const PRE_MARKET_TIME = "09:25"; // HH:MM in Asia/Shanghai
const PRE_MARKET_THRESHOLD_PCT = 3;

interface SseClient {
  id: number;
  write: (event: string, data: unknown) => void;
}

const sseClients = new Map<number, SseClient>();
let sseSeq = 0;
let tickTimer: NodeJS.Timeout | null = null;
let lastEvents: AlertEvent[] = [];
let preMarketCheckedDay: string | null = null;

const channelRegistry: Record<string, ChannelDispatcher> = {
  log_only: logOnlyDispatcher,
  browser: browserDispatcher,
  telegram: telegramDispatcher,
};

function isTradingHours(): boolean {
  const { hhmm, weekday } = bjNow();
  if (weekday === 0 || weekday === 6) return false; // Sun / Sat
  // Holidays: ignored at this layer; over-poll on holidays is harmless,
  // upstream just returns stale data.
  return (
    (hhmm >= "09:30" && hhmm <= "11:30") ||
    (hhmm >= "13:00" && hhmm <= "15:00")
  );
}

function annotatePosition(p: Position, q?: QuoteSummary, industry?: string): Position {
  return {
    ...p,
    name: q?.name ?? p.name,
    industry: industry ?? p.industry,
  };
}

interface SnapshotPayload {
  generatedAt: string;
  positions: Array<Position & {
    quote?: QuoteSummary;
    holdDays?: number;
    pctFromCost?: number;
    marketValue?: number;
    floatingPnL?: number;
    todayPnL?: number;
    rungs?: Array<{ pct: number; price: number; reached: "above" | "below" | "at" }>;
    announcements?: AnnouncementItem[];
  }>;
  totals: {
    cost: number;
    marketValue: number;
    floatingPnL: number;
    floatingPnLPct: number;
    todayPnL: number;
  };
  industries: Record<string, number>;
  recentAlerts: AlertEvent[];
  isTradingHours: boolean;
  telegramReady: boolean;
  /** Last 7 days of {date, floatingPnL} for sparkline chart. */
  trend: Array<{ date: string; floatingPnL: number }>;
}

const RUNG_PCTS = [-10, -5, -3, -1, 1, 3, 5, 10];

function holdDays(openedAt?: string): number | undefined {
  if (!openedAt || !/^\d{4}-\d{2}-\d{2}$/.test(openedAt)) return undefined;
  const start = new Date(`${openedAt}T00:00:00Z`).getTime();
  const now = Date.now();
  return Math.floor((now - start) / (24 * 60 * 60 * 1000));
}

let trendCache: { ts: number; data: Array<{ date: string; floatingPnL: number }> } | null = null;

async function loadTrend(days = 7): Promise<Array<{ date: string; floatingPnL: number }>> {
  const now = Date.now();
  // Cache for 5 min — tick (5s/60s) hits cache, manual refresh or page load gets fresh.
  if (trendCache && now - trendCache.ts < 5 * 60_000) return trendCache.data;

  const dir = path.join(process.cwd(), "data", "positions_snapshots");
  try {
    const entries = await fs.readdir(dir);
    const dates = entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => a.localeCompare(b))  // ascending
      .slice(-days);
    const trend: Array<{ date: string; floatingPnL: number }> = [];
    for (const date of dates) {
      try {
        const raw = await fs.readFile(path.join(dir, `${date}.json`), "utf8");
        const snap = JSON.parse(raw) as SnapshotPayload;
        trend.push({ date, floatingPnL: snap.totals?.floatingPnL ?? 0 });
      } catch { /* skip corrupt files */ }
    }
    trendCache = { ts: now, data: trend };
    return trend;
  } catch {
    return trendCache?.data ?? [];
  }
}

export async function buildSnapshot(): Promise<SnapshotPayload> {
  const positions = await loadPositions();
  const trend = await loadTrend(7);
  if (positions.length === 0) {
    return {
      generatedAt: bjNow().iso,
      positions: [],
      totals: { cost: 0, marketValue: 0, floatingPnL: 0, floatingPnLPct: 0, todayPnL: 0 },
      industries: {},
      recentAlerts: lastEvents.slice(-10),
      isTradingHours: isTradingHours(),
      telegramReady: !!getTelegramConfig(),
      trend,
    };
  }
  const quals = positions.map((p) => qualified(p.symbol, p.exchange));
  const quotes = await fetchQuotes(quals);
  const byQual = new Map(quotes.map((q) => [q.qualified, q]));

  const industries: Record<string, number> = {};
  let totalCost = 0;
  let totalMarket = 0;
  let totalToday = 0;

  const annMap = getCachedAnnouncements(
    positions.map((p) => ({ symbol: p.symbol, name: p.name })),
  );

  const annotated: SnapshotPayload["positions"] = [];
  for (const p of positions) {
    const q = byQual.get(qualified(p.symbol, p.exchange));
    const industry = await getIndustry(p.symbol);
    const pos = annotatePosition(p, q, industry);

    const cost = pos.shares * pos.avgCost;
    totalCost += cost;
    let marketValue = cost;
    let floatingPnL = 0;
    let todayPnL = 0;
    let pctFromCost: number | undefined;
    let rungs:
      | Array<{ pct: number; price: number; reached: "above" | "below" | "at" }>
      | undefined;

    if (q) {
      marketValue = pos.shares * q.last;
      floatingPnL = marketValue - cost;
      todayPnL = pos.shares * (q.last - q.prevClose);
      pctFromCost = ((q.last - pos.avgCost) / pos.avgCost) * 100;
      rungs = RUNG_PCTS.map((pct) => {
        const price = pos.avgCost * (1 + pct / 100);
        const reached: "above" | "below" | "at" =
          q.last > price ? "above" : q.last < price ? "below" : "at";
        return { pct, price, reached };
      });
    }
    totalMarket += marketValue;
    totalToday += todayPnL;
    if (industry) industries[industry] = (industries[industry] ?? 0) + marketValue;

    annotated.push({
      ...pos,
      quote: q,
      holdDays: holdDays(pos.openedAt),
      pctFromCost,
      marketValue,
      floatingPnL,
      todayPnL,
      rungs,
      announcements: annMap[pos.symbol] ?? [],
    });
  }

  const totals = {
    cost: totalCost,
    marketValue: totalMarket,
    floatingPnL: totalMarket - totalCost,
    floatingPnLPct: totalCost > 0 ? ((totalMarket - totalCost) / totalCost) * 100 : 0,
    todayPnL: totalToday,
  };

  return {
    generatedAt: bjNow().iso,
    positions: annotated,
    totals,
    industries,
    recentAlerts: lastEvents.slice(-10),
    isTradingHours: isTradingHours(),
    telegramReady: !!getTelegramConfig(),
    trend,
  };
}

async function runTickAndAlert(): Promise<void> {
  const positions = await loadPositions();
  if (positions.length === 0) return;
  const quals = positions.map((p) => qualified(p.symbol, p.exchange));
  const quotes = await fetchQuotes(quals);
  const byQual: Record<string, QuoteSummary> = {};
  for (const q of quotes) byQual[q.qualified] = q;

  const events = await runAlertEngine(positions, byQual, { channels: channelRegistry });
  if (events.length) {
    lastEvents = [...lastEvents, ...events].slice(-50);
    broadcast("alerts", events);
  }
  // Also broadcast latest quotes regardless.
  broadcast("quotes", quotes);
}

async function maybePreMarketAnomalyCheck(): Promise<void> {
  const { day, hhmm } = bjNow();
  if (preMarketCheckedDay === day) return;
  if (hhmm < PRE_MARKET_TIME || hhmm > "09:30") return;
  preMarketCheckedDay = day;

  const positions = await loadPositions();
  if (positions.length === 0) return;
  const quals = positions.map((p) => qualified(p.symbol, p.exchange));
  const quotes = await fetchQuotes(quals);
  const anomalies = quotes.filter(
    (q) => Math.abs(q.changePct) >= PRE_MARKET_THRESHOLD_PCT,
  );
  if (anomalies.length === 0) return;
  // Reuse the alert event shape for browser notification, even though no rule
  // exists. Inject a synthetic "pre-market" event.
  const synthetic: AlertEvent[] = anomalies.map((q) => {
    const pos = positions.find((p) => p.symbol === q.symbol);
    return {
      ts: bjNow().iso,
      positionId: pos?.id ?? "",
      ruleId: "synthetic-pre-market",
      symbol: q.symbol,
      name: pos?.name ?? q.name,
      ruleLabel: `集合竞价异动 ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`,
      kind: "daily_change_pct",
      targetPrice: q.prevClose * (1 + (q.changePct >= 0 ? 3 : -3) / 100),
      prevPrice: q.prevClose,
      currPrice: q.last,
      pctFromCost: pos ? ((q.last - pos.avgCost) / pos.avgCost) * 100 : 0,
      dailyChangePct: q.changePct,
      channels: ["browser", "log_only"],
      deliveryStatus: "success",
      channelResults: { browser: { ok: true }, log_only: { ok: true } },
    };
  });
  lastEvents = [...lastEvents, ...synthetic].slice(-50);
  broadcast("alerts", synthetic);
}

let snapshotTakenDay: string | null = null;

async function maybeSnapshot(): Promise<void> {
  const { day, hhmm, weekday } = bjNow();
  if (weekday === 0 || weekday === 6) return;
  if (hhmm < "15:30" || hhmm > "15:35") return;
  if (snapshotTakenDay === day) return;
  snapshotTakenDay = day;

  try {
    const snap = await buildSnapshot();
    if (snap.positions.length === 0) return;
    const dir = path.join(process.cwd(), "data", "positions_snapshots");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${day}.json`);
    await fs.writeFile(file, JSON.stringify(snap, null, 2), "utf8");
    console.log(`[positions] snapshot saved — ${day}.json (${snap.positions.length} positions)`);
    trendCache = null; // invalidate so next loadTrend picks up the new file
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[positions] snapshot failed: ${msg}`);
  }
}

function startTickLoop(): void {
  if (tickTimer) return;
  const loop = async () => {
    try {
      await maybePreMarketAnomalyCheck();
      await maybeSnapshot();
      await runTickAndAlert();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[positions] tick failed: ${msg}`);
    } finally {
      const next = isTradingHours() ? TICK_TRADING_MS : TICK_OFFHOURS_MS;
      tickTimer = setTimeout(loop, next);
    }
  };
  tickTimer = setTimeout(loop, 1_000);
}

// ---- SSE plumbing ----

export function registerSseClient(write: SseClient["write"]): () => void {
  const id = ++sseSeq;
  sseClients.set(id, { id, write });
  // Send an immediate snapshot.
  buildSnapshot()
    .then((snap) => write("snapshot", snap))
    .catch((e) => write("error", { error: e instanceof Error ? e.message : String(e) }));
  return () => sseClients.delete(id);
}

function broadcast(event: string, data: unknown): void {
  for (const client of sseClients.values()) {
    try {
      client.write(event, data);
    } catch {
      sseClients.delete(client.id);
    }
  }
}

export function getRecentAlerts(): AlertEvent[] {
  return lastEvents.slice(-50);
}

export const positionsProvider: TabProvider = {
  id: "positions",
  label: "盯盘助手",
  description: "持仓跟踪、止盈止损、浏览器通知。",
  refreshLabel: "立即刷一次行情",

  async loadLatest(): Promise<RefreshResult | null> {
    const snap = await buildSnapshot();
    return wrapSnapshot(snap);
  },

  async loadDate(date: string): Promise<RefreshResult | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const file = path.join(process.cwd(), "data", "positions_snapshots", `${date}.json`);
    try {
      const raw = await fs.readFile(file, "utf8");
      const snap = JSON.parse(raw) as SnapshotPayload;
      return wrapSnapshot(snap);
    } catch {
      return null;
    }
  },

  async listDates(): Promise<string[]> {
    const dir = path.join(process.cwd(), "data", "positions_snapshots");
    try {
      const entries = await fs.readdir(dir);
      return entries
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  },

  async refresh(): Promise<RefreshResult> {
    // Force a fresh quote pull, evaluate alerts immediately.
    await runTickAndAlert();
    // Also kick off an announcement refresh (bg, non-blocking).
    refreshAnnouncementsNow();
    const snap = await buildSnapshot();
    return wrapSnapshot(snap);
  },
};

function wrapSnapshot(snap: SnapshotPayload): RefreshResult {
  // The shell expects html for non-positions tabs; for positions we return a
  // minimal placeholder + put the real data on `meta.snapshot`. Frontend
  // detects tabId === "positions" and renders from meta directly.
  return {
    tabId: "positions",
    date: snap.generatedAt?.slice(0, 10) ?? bjNow().iso.slice(0, 10),
    ok: true,
    refreshedAt: snap.generatedAt,
    title: "盯盘助手",
    summary: snap.positions.length
      ? `共 ${snap.positions.length} 条持仓 · 总市值 ¥${snap.totals.marketValue.toFixed(2)}`
      : "尚无持仓,点击上方加一条",
    html: "",
    meta: { snapshot: snap },
  };
}

async function refreshAnnouncementsNow(): Promise<void> {
  const positions = await loadPositions();
  if (positions.length === 0) return;
  refreshAnnouncementsBg(
    positions.map((p) => ({ symbol: p.symbol, name: p.name })),
  );
}

/** Bootstrapped once from web-server.ts on startup. */
export function startPositionsDaemon(): void {
  startTickLoop();
  // Fetch announcements once on startup.
  refreshAnnouncementsNow();
}
