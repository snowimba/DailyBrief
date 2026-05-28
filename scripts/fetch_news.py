"""Fetch A-share stock news via akshare stock_news_em. Output JSON on stdout.
Usage: python fetch_news.py 600999,600519 [--max-age-days 7]
"""
import json, sys
from datetime import datetime, timedelta

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    kwargs = {}
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--max-age-days" and i + 1 < len(sys.argv):
            kwargs["max_age_days"] = int(sys.argv[i + 1])
            i += 2
        else:
            i += 1
    if not args:
        print(json.dumps({}))
        return
    symbols = args[0].split(",")
    max_age = kwargs.get("max_age_days", 7)
    cutoff = datetime.now() - timedelta(days=max_age)

    import akshare as ak
    result = {}
    for sym in symbols:
        try:
            df = ak.stock_news_em(symbol=sym.strip())
            items = []
            for _, row in df.head(20).iterrows():
                title = str(row.get("新闻标题", ""))
                content = str(row.get("新闻内容", ""))
                url = str(row.get("新闻链接", ""))
                source = str(row.get("文章来源", ""))
                pub_time = str(row.get("发布时间", ""))
                # Filter by date
                try:
                    pt = datetime.strptime(pub_time[:10], "%Y-%m-%d")
                    if pt < cutoff:
                        continue
                except ValueError:
                    pass
                items.append({
                    "title": title,
                    "summary": content[:200].replace("\n", " ").replace("\r", ""),
                    "url": url,
                    "source": source,
                    "publishedAt": pub_time[:16],  # YYYY-MM-DD HH:MM
                })
            result[sym.strip()] = items[:10]
        except Exception as e:
            print(f"[news-py] {sym}: {e}", file=sys.stderr)
            result[sym.strip()] = []
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
