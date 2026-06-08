import path from "node:path";

import { runCommand } from "../run-command";
import type { CalendarEvent } from "./types";
import { bjDate, bjIso } from "../../utils";

/**
 * Upcoming financial events calendar (earnings reports + dividend dates)
 * via akshare stock_yjbb_em + stock_fhps_em.
 *
 * Cache: daily (reset at midnight Beijing time). Financial calendars change
 * infrequently — typically when new reports or dividend plans are announced.
 */

const AK_PYTHON = "/data/SilverM-quant/.venv/bin/python";
const AK_SCRIPT = path.join(process.cwd(), "scripts", "fetch_calendar.py");

let cache: { ts: number; date: string; events: CalendarEvent[] } | null = null;
let inflight: Promise<CalendarEvent[]> | null = null;

function cacheExpired(): boolean {
  if (!cache) return true;
  return cache.date !== bjDate();
}

async function fetchEvents(symbols: string[], daysAhead = 60): Promise<CalendarEvent[]> {
  const args = [
    AK_SCRIPT,
    "--symbols", symbols.join(","),
    "--days-ahead", String(daysAhead),
  ];
  const result = await runCommand(AK_PYTHON, args, {
    cwd: process.cwd(),
    timeoutMs: 120_000,
  });

  const raw = JSON.parse(result.stdout || "[]") as Array<{
    symbol: string; name: string; eventDate: string; eventType: string;
    description: string; dividendPerShare?: number;
  }>;

  const iso = bjIso();
  return raw.map((item) => {
    let eventType: CalendarEvent["eventType"] = "股东大会";
    if (item.eventType === "年报") eventType = "年报";
    else if (item.eventType === "半年报") eventType = "半年报";
    else if (item.eventType === "分红除权") eventType = "分红除权";
    else if (item.eventType === "股权登记") eventType = "股权登记";

    return {
      symbol: item.symbol,
      name: item.name,
      eventDate: item.eventDate,
      eventType,
      description: item.description,
      dividendPerShare: item.dividendPerShare,
      fetchedAt: iso,
    };
  });
}

export async function fetchCalendarEvents(
  symbols: string[],
  daysAhead = 60,
): Promise<CalendarEvent[]> {
  if (!cacheExpired()) {
    return cache!.events.filter((e) => symbols.includes(e.symbol));
  }

  if (inflight) return inflight;

  const today = bjDate();
  inflight = fetchEvents(symbols, daysAhead)
    .then((events) => {
      cache = { ts: Date.now(), date: today, events };
      return events;
    })
    .catch((e) => {
      console.warn(`[positions/calendar] fetch failed: ${e instanceof Error ? e.message : e}`);
      return cache?.events ?? [];
    })
    .finally(() => { inflight = null; });

  return inflight;
}

export function getCachedCalendarEvents(): CalendarEvent[] | null {
  if (cacheExpired()) return null;
  return cache.events;
}
