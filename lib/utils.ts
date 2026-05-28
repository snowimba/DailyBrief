/**
 * Resolve the timezone used for date-keyed filenames AND for date strings
 * rendered in HTML. Defaults to the system local timezone — set
 * `REPORT_TZ` (any IANA name, e.g. "America/Los_Angeles", "Europe/Berlin",
 * "Asia/Shanghai", or "UTC") to override.
 *
 * Lazy on purpose: `scripts/daily.ts` loads `.env.local` AFTER its
 * imports execute, so capturing the value at module init would freeze it
 * before dotenv has run. Each call site reads `process.env` fresh.
 */
export function getReportTz(): string | undefined {
  return process.env.REPORT_TZ?.trim() || undefined;
}

export function todayKey(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: getReportTz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** Beijing time (UTC+8) helpers for the positions/watchlist tab. */
export function bjNow(): { iso: string; date: string; hhmm: string; weekday: number } {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const iso = bj.toISOString().replace("Z", "+08:00");
  const date = iso.slice(0, 10);
  const hh = String(bj.getUTCHours()).padStart(2, "0");
  const mm = String(bj.getUTCMinutes()).padStart(2, "0");
  return { iso, date, hhmm: `${hh}:${mm}`, weekday: bj.getUTCDay() };
}

export function bjDate(): string {
  return bjNow().date;
}

export function bjIso(): string {
  return bjNow().iso;
}
