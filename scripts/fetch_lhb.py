"""Fetch dragon-tiger board (龙虎榜) data from akshare for a given date.
Usage: python fetch_lhb.py 20260528 [--symbols 600519,000001]
Output: JSON array of board entries matching the held symbols.
"""
import json, sys
from datetime import datetime

def main():
    if len(sys.argv) < 2:
        print(json.dumps([]))
        return

    date_str = sys.argv[1]
    # Validate date format YYYYMMDD
    if len(date_str) != 8 or not date_str.isdigit():
        print(json.dumps([]))
        return

    symbols = []
    for i, arg in enumerate(sys.argv):
        if arg == "--symbols" and i + 1 < len(sys.argv):
            symbols = [s.strip() for s in sys.argv[i + 1].split(",") if s.strip()]
            break

    import akshare as ak
    try:
        df = ak.stock_lhb_detail_em(start_date=date_str, end_date=date_str)
        items = []
        cols = list(df.columns)
        for _, row in df.iterrows():
            code = str(row.get("代码", ""))
            # Filter by held symbols if provided
            if symbols and code not in symbols:
                continue
            name = str(row.get("名称", "") or "")
            reason = str(row.get("上榜原因", "") or "")
            close_price = float(row.get("收盘价", 0) or 0)
            change_pct = float(row.get("涨跌幅", 0) or 0)
            net_buy = float(row.get("龙虎榜净买额", 0) or 0)
            buy_amt = float(row.get("龙虎榜买入额", 0) or 0)
            sell_amt = float(row.get("龙虎榜卖出额", 0) or 0)
            total_deal = float(row.get("龙虎榜成交额", 0) or 0)
            market_deal = float(row.get("市场总成交额", 0) or 0)

            items.append({
                "symbol": code,
                "name": name,
                "boardDate": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}",
                "reason": reason,
                "closePrice": close_price,
                "changePct": change_pct,
                "netBuyAmount": net_buy,
                "buyAmount": buy_amt,
                "sellAmount": sell_amt,
                "totalDealAmount": total_deal,
                "marketDealAmount": market_deal,
            })
        print(json.dumps(items, ensure_ascii=False))
    except Exception as e:
        print(f"[lhb-py] error: {e}", file=sys.stderr)
        print(json.dumps([]))

if __name__ == "__main__":
    main()
