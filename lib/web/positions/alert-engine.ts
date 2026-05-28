import fs from "node:fs/promises";
import path from "node:path";

import type {
  AlertEvent,
  AlertKind,
  AlertRule,
  AlertStateEntry,
  Position,
  QuoteSummary,
} from "./types";
import {
  findAlertState,
  loadAlertState,
  saveAlertState,
  upsertAlertState,
} from "./store";

/**
 * Pure-function alert engine. Walks each enabled rule on each position,
 * detects price-crossings against the user's targets, fires deliveries,
 * and persists state for cooldown + cross detection.
 *
 * Decoupled from the tick loop so we can also run it on-demand (e.g. when
 * the user changes a rule's threshold while the price is sitting on it).
 */

const LOG_DIR = "logs";

export interface ChannelDispatcher {
  /** Returns true on delivery success. */
  send(event: AlertEvent): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

export interface EngineDeps {
  /** Map of channel id → dispatcher. log_only is a no-op + audit log. */
  channels: Record<string, ChannelDispatcher>;
  /** Override "now" for tests. Default = `new Date()`. */
  now?: () => Date;
}

export function targetPriceFor(rule: AlertRule, position: Position, prevClose: number): number | null {
  if (rule.kind === "pct_from_cost" && rule.pct !== undefined) {
    return position.avgCost * (1 + rule.pct / 100);
  }
  if (rule.kind === "absolute" && rule.price !== undefined) {
    return rule.price;
  }
  if (rule.kind === "daily_change_pct" && rule.dailyPct !== undefined && prevClose > 0) {
    return prevClose * (1 + rule.dailyPct / 100);
  }
  return null;
}

export function ruleLabel(rule: AlertRule): string {
  if (rule.label) return rule.label;
  if (rule.kind === "pct_from_cost" && rule.pct !== undefined) {
    const sign = rule.pct > 0 ? "+" : "";
    const what = rule.pct > 0 ? "止盈位" : "止损位";
    return `${sign}${rule.pct}% ${what}`;
  }
  if (rule.kind === "absolute" && rule.price !== undefined) {
    return `绝对价 ¥${rule.price.toFixed(2)}`;
  }
  if (rule.kind === "daily_change_pct" && rule.dailyPct !== undefined) {
    const sign = rule.dailyPct > 0 ? "+" : "";
    return `当日 ${sign}${rule.dailyPct}%`;
  }
  return "规则";
}

function crossed(
  trigger: AlertRule["trigger"],
  prev: number,
  curr: number,
  target: number,
): boolean {
  switch (trigger) {
    case "cross_up":
      return prev < target && curr >= target;
    case "cross_down":
      return prev > target && curr <= target;
    case "any":
      return (prev - target) * (curr - target) <= 0;
  }
}

function inCooldown(
  rule: AlertRule,
  state: AlertStateEntry | undefined,
  now: Date,
): boolean {
  const lastIso = state?.lastFiredAt ?? rule.lastFiredAt;
  if (!lastIso) return false;
  const last = new Date(lastIso).getTime();
  return now.getTime() - last < rule.cooldownMin * 60_000;
}

/**
 * Evaluate one quote against one position; returns events that fired.
 * Caller persists `state` after collecting events from all positions.
 */
export function evaluatePosition(
  position: Position,
  quote: QuoteSummary,
  state: AlertStateEntry[],
  now: Date,
): { events: AlertEvent[]; nextState: AlertStateEntry[] } {
  const events: AlertEvent[] = [];
  let nextState = state;
  const dayKey = quote.date || now.toISOString().slice(0, 10);
  const dailyPct = quote.changePct;

  for (const rule of position.alertRules) {
    if (!rule.enabled) continue;
    const target = targetPriceFor(rule, position, quote.prevClose);
    if (target === null || !Number.isFinite(target)) continue;

    const prev = findAlertState(nextState, position.id, rule.id);
    const prevPrice = prev?.prevPrice;
    const prevDay = prev?.prevDayKey;

    // First quote of a new day → just seed prev, don't evaluate. This avoids
    // false-positives on opening 集合竞价 跳空 jumps.
    if (prevDay !== dayKey) {
      nextState = upsertAlertState(nextState, {
        positionId: position.id,
        ruleId: rule.id,
        prevPrice: quote.last,
        prevDayKey: dayKey,
        lastFiredAt: prev?.lastFiredAt,
        lastFiredPrice: prev?.lastFiredPrice,
      });
      continue;
    }

    if (prevPrice === undefined) {
      nextState = upsertAlertState(nextState, {
        positionId: position.id,
        ruleId: rule.id,
        prevPrice: quote.last,
        prevDayKey: dayKey,
        lastFiredAt: prev?.lastFiredAt,
        lastFiredPrice: prev?.lastFiredPrice,
      });
      continue;
    }

    const fired = crossed(rule.trigger, prevPrice, quote.last, target);
    if (fired && !inCooldown(rule, prev, now)) {
      events.push({
        ts: now.toISOString(),
        positionId: position.id,
        ruleId: rule.id,
        symbol: position.symbol,
        name: position.name ?? quote.name,
        ruleLabel: ruleLabel(rule),
        kind: rule.kind,
        targetPrice: target,
        prevPrice,
        currPrice: quote.last,
        pctFromCost: ((quote.last - position.avgCost) / position.avgCost) * 100,
        dailyChangePct: dailyPct,
        channels: rule.channels,
        deliveryStatus: "queued",
        channelResults: {},
      });
      nextState = upsertAlertState(nextState, {
        positionId: position.id,
        ruleId: rule.id,
        prevPrice: quote.last,
        prevDayKey: dayKey,
        lastFiredAt: now.toISOString(),
        lastFiredPrice: quote.last,
      });
    } else {
      nextState = upsertAlertState(nextState, {
        positionId: position.id,
        ruleId: rule.id,
        prevPrice: quote.last,
        prevDayKey: dayKey,
        lastFiredAt: prev?.lastFiredAt,
        lastFiredPrice: prev?.lastFiredPrice,
      });
    }
  }

  return { events, nextState };
}

async function appendAuditLog(events: AlertEvent[]): Promise<void> {
  if (events.length === 0) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `alerts-${date}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.appendFile(file, lines, "utf8");
}

async function dispatchEvent(
  event: AlertEvent,
  deps: EngineDeps,
): Promise<AlertEvent> {
  const next: AlertEvent = { ...event, channelResults: { ...event.channelResults } };
  let anyOk = false;
  for (const channel of next.channels) {
    const dispatcher = deps.channels[channel];
    if (!dispatcher) {
      next.channelResults[channel] = { ok: false, error: "no dispatcher registered" };
      continue;
    }
    try {
      const r = await dispatcher.send(next);
      next.channelResults[channel] = r;
      if (r.ok) anyOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      next.channelResults[channel] = { ok: false, error: msg };
    }
  }
  next.deliveryStatus = anyOk ? "success" : "failed";
  return next;
}

/** Top-level: evaluate every position, dispatch events, persist state. */
export async function runAlertEngine(
  positions: Position[],
  quotes: Record<string, QuoteSummary>,
  deps: EngineDeps,
): Promise<AlertEvent[]> {
  const now = (deps.now ?? (() => new Date()))();
  let state = await loadAlertState();
  const allEvents: AlertEvent[] = [];

  for (const pos of positions) {
    const qual = `${pos.exchange}${pos.symbol}`;
    const quote = quotes[qual];
    if (!quote) continue;
    const { events, nextState } = evaluatePosition(pos, quote, state, now);
    state = nextState;
    allEvents.push(...events);
  }

  if (allEvents.length === 0) {
    await saveAlertState(state);
    return [];
  }

  const dispatched: AlertEvent[] = [];
  for (const ev of allEvents) {
    dispatched.push(await dispatchEvent(ev, deps));
  }
  await saveAlertState(state);
  await appendAuditLog(dispatched);
  return dispatched;
}

// ---- log-only dispatcher: always success, no side effect (audit log is
// shared by all events anyway). ----

export const logOnlyDispatcher: ChannelDispatcher = {
  async send() {
    return { ok: true, latencyMs: 0 };
  },
};

// ---- browser dispatcher placeholder: actual delivery is via SSE to the
// frontend, this just acks. The frontend turns events into Notifications. ----

export const browserDispatcher: ChannelDispatcher = {
  async send() {
    return { ok: true, latencyMs: 0 };
  },
};
