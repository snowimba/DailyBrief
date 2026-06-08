"""Fetch upcoming financial events for held stocks (lightweight — per-symbol).
Usage: python fetch_calendar.py --symbols 512480,600519 [--days-ahead 60]
Output: JSON array of calendar events.

Strategy: query per-symbol rather than downloading the full market dataset.
This avoids the 12-page akshare download that takes 120+ seconds.
"""
import json, sys
from datetime import datetime, timedelta

def main():
    args = sys.argv[1:]
    symbols = []
    days_ahead = 60
    i = 0
    while i < len(args):
        if args[i] == "--symbols" and i + 1 < len(args):
            symbols = [s.strip() for s in args[i + 1].split(",") if s.strip() and len(s.strip()) == 6]
            i += 2
        elif args[i] == "--days-ahead" and i + 1 < len(args):
            days_ahead = int(args[i + 1])
            i += 2
        else:
            i += 1

    if not symbols:
        print(json.dumps([]))
        return

    today = datetime.now()
    cutoff = today + timedelta(days=days_ahead)
    events = []

    import akshare as ak

    for sym in symbols:
        # Try per-stock dividend data (2025/2026 plans)
        try:
            df_div = ak.stock_fhps_em(date=str(today.year))
            if df_div is not None and not df_div.empty:
                mask = df_div["股票代码"].astype(str).str.strip() == sym
                matched = df_div[mask]
                for _, row in matched.iterrows():
                    name = str(row.get("股票简称", "") or "")
                    plan = str(row.get("分红方案", "") or "")[:80]
                    dps_raw = row.get("每股派息", None)
                    dps = float(dps_raw) if dps_raw is not None and dps_raw != "" else None

                    for col, etype in [("除权除息日", "分红除权"), ("股权登记日", "股权登记")]:
                        date_raw = str(row.get(col, "") or "")
                        if not date_raw or date_raw == "None" or date_raw == "nan":
                            continue
                        try:
                            edate = datetime.strptime(date_raw[:10], "%Y-%m-%d")
                        except ValueError:
                            continue
                        if edate < today or edate > cutoff:
                            continue
                        events.append({
                            "symbol": sym, "name": name,
                            "eventDate": date_raw[:10],
                            "eventType": etype,
                            "description": plan,
                            "dividendPerShare": dps,
                        })
        except Exception as e:
            print(f"[calendar-py] dividend {sym}: {e}", file=sys.stderr)

    # Deduplicate
    seen = set()
    unique = []
    for ev in events:
        key = (ev["symbol"], ev["eventDate"], ev["eventType"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(ev)

    unique.sort(key=lambda e: e["eventDate"])
    print(json.dumps(unique, ensure_ascii=False))


if __name__ == "__main__":
    main()
