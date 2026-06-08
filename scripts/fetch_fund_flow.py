"""Fetch daily capital flow (资金流向) data for held A-share stocks.
Usage: python fetch_fund_flow.py sh600519,sz000001
Output: JSON object mapping qualified symbol -> fund flow data, or null on failure.

The akshare fund flow API wraps EastMoney which may be unstable from this
environment. Each symbol gets up to 3 retries with 2s backoff. Failures
for individual symbols are non-fatal — they return null for that symbol
rather than killing the whole batch.
"""
import json, sys, time
from datetime import datetime

def fetch_one(ak, stock, market, retries=3):
    """Fetch fund flow for a single stock. Returns dict or None."""
    for attempt in range(retries):
        try:
            df = ak.stock_individual_fund_flow(stock=stock, market=market)
            if df is None or df.empty:
                return None
            # Take the most recent row
            last = df.iloc[-1]
            date_raw = last.get("日期", "")
            if hasattr(date_raw, "strftime"):
                date_str = date_raw.strftime("%Y-%m-%d")
            else:
                date_str = str(date_raw)[:10]
            main_inflow = float(last.get("主力净流入", 0) or 0)
            super_large = float(last.get("超大单净流入", 0) or 0)
            large = float(last.get("大单净流入", 0) or 0)
            medium = float(last.get("中单净流入", 0) or 0)
            small = float(last.get("小单净流入", 0) or 0)
            # If all flows are zero, treat as no data (ETF or API fallback).
            if main_inflow == 0 and super_large == 0 and large == 0 and medium == 0 and small == 0:
                return None
            return {
                "date": date_str,
                "name": str(last.get("股票名称", "") or ""),
                "mainNetInflow": main_inflow,
                "superLargeInflow": super_large,
                "largeInflow": large,
                "mediumInflow": medium,
                "smallInflow": small,
            }
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
            else:
                print(f"[fund-flow-py] {stock}.{market}: {e}", file=sys.stderr)
                return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({}))
        return

    quals = [q.strip() for q in sys.argv[1].split(",") if q.strip()]
    if not quals:
        print(json.dumps({}))
        return

    import akshare as ak

    result = {}
    for qual in quals:
        # Parse "sh600519" or "sz000001" style qualified symbols
        exchange = None
        code = qual
        if qual.startswith("sh"):
            exchange = "sh"
            code = qual[2:]
        elif qual.startswith("sz"):
            exchange = "sz"
            code = qual[2:]
        elif qual.startswith("bj"):
            exchange = "bj"
            code = qual[2:]

        if not exchange or not code.isdigit() or len(code) != 6:
            print(f"[fund-flow-py] skipping invalid qual: {qual}", file=sys.stderr)
            result[qual] = None
            continue

        data = fetch_one(ak, code, exchange)
        result[qual] = data

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
