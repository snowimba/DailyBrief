# 盯盘助手 Tab — 需求文档

> 在 `综合日报 / A 股日报` 之后新增第三个 web tab,记录持仓、自动算止盈止损位、推送提醒。
> 先以本文为口径,接下来的实现 PR 都对照这里走。

## 1. 范围与目标

**做什么**

- 用户手工录入 / 编辑 / 删除当前持有的 A 股仓位(数量、平均成本、备注、关注标志)
- 系统自动算出每条仓位的止盈止损目标价位(±1/3/5/10% 默认,可加自定义档位)
- 实时拉股价(免费 A 股行情接口,无 token),叠加在持仓表上展示当前价、当日涨跌、浮盈
- 命中价格触发条件 → 推送到 Telegram bot(`@moguddsuper_bot`,token 复用 OpenClaw 现有配置)+ 浏览器原生通知
- 历史快照:每个交易日盘后保存一份 `positions-YYYY-MM-DD.json`,可在历史下拉框里回看

**不做什么**

- 不接经纪商真实下单(纯记账)
- 不做选股 / 信号 / 回测(那是 A 股日报 tab 的事)
- 不做组合优化 / 风险模型(超出范围)

---

## 2. 数据模型

### 2.1 仓位 `Position`

```ts
interface Position {
  id: string;              // ulid 或 nanoid,前后端共用
  symbol: string;          // 6 位代码,如 "600519"
  exchange: "sh" | "sz" | "bj"; // 由 symbol 首位推断 + 用户可手改
  name?: string;           // 名称,首次拉行情后自动回填
  shares: number;          // 持有股数(手 ×100)
  avgCost: number;         // 平均成本价(元,精度 0.01,A 股最小变动 0.01 不再做精度处理)
  openedAt?: string;       // 首次建仓日期 YYYY-MM-DD,选填
  note?: string;           // 备注(策略 / 计划 / 风险点)
  starred?: boolean;       // 重点关注,UI 置顶
  alertRules: AlertRule[]; // 见下
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
}
```

### 2.2 提醒规则 `AlertRule`

```ts
interface AlertRule {
  id: string;              // ulid
  kind: "pct_from_cost" | "absolute" | "daily_change_pct";
  // 涉及成本价百分比的档位
  pct?: number;            // 例如 +5 / -3 / +10 / -10,正负号表示方向
  // 绝对价格触发
  price?: number;          // 当 kind=absolute 时使用
  // 当日涨跌幅触发(独立于成本价)
  dailyPct?: number;       // 例如 -7 = 当日跌 7%(几乎跌停)
  trigger: "cross_up" | "cross_down" | "any";
                           // 价格穿越方向(默认按 pct 正负推断)
  cooldownMin: number;     // 同条规则触发后的静默时长,默认 60
  channels: AlertChannel[];// 默认 ["browser", "telegram"]
  enabled: boolean;        // 用户可临时关
  lastFiredAt?: string;    // ISO,用于 cooldown
  lastFiredPrice?: number; // 用于穿越判断
  label?: string;          // 用户自定义标签,如 "止盈一档" / "强制止损"
}

type AlertChannel = "telegram" | "browser" | "log_only";
```

**重要**:**仓位录入后系统不创建任何告警规则**。UI 上的 ±1/3/5/10% 档位轨道是**纯展示**(给眼睛看的"现价相对成本"标尺)。

**用户什么时候自己加规则**:

- 看好这只票计划 +5% 止盈一档、+10% 止盈二档 → 手动在 UI 上点"加止盈位"
- 风险底线 -7% 必须减仓 → 手动加"止损位"
- 当日跌幅 ≤ -5% 想提醒 → 加 `daily_change_pct=-5` 规则

这么设计的核心理由:

1. 自动生成 8 条规则会让推送被噪声占满,真正想看的"我亲自定的关键位"反而被淹没
2. 把推送频率压到非常低(每天可能 0~3 条),即使将来切换到有配额限制的渠道也不会出问题
3. 档位轨道光做展示就能解决"我现在离 +3% 还差几毛钱"这种感性需求,不需要每次都打扰

### 2.3 快照 `PositionsSnapshot`

```ts
interface PositionsSnapshot {
  date: string;            // YYYY-MM-DD,交易日
  capturedAt: string;      // ISO,实际写入时间
  positions: Position[];   // 全量复制
  prices: Record<string, QuoteSummary>;
                           // symbol → 当日收盘行情
  totals: {
    marketValue: number;
    cost: number;
    floatingPnL: number;
    floatingPnLPct: number;
    dailyPnL: number;      // 与昨收对比的当日盈亏
  };
}
```

每个交易日 15:30(收盘 + 30 分钟,等延迟落盘)生成,落到
`positions_snapshots/<date>.json`。

### 2.4 文件布局

```
DailyBrief/
├── data/                            # gitignored,运行时数据
│   ├── positions.json               # 当前持仓的"活"状态
│   ├── alert-state.json             # 每条规则的 lastFiredAt / lastFiredPrice
│   └── positions_snapshots/
│       └── 2026-05-28.json
└── lib/web/positions/               # 新代码全部进这里
    ├── types.ts
    ├── store.ts                     # 读写 positions.json,原子写入
    ├── quote-source.ts              # Sina + Tencent 行情封装
    ├── alert-engine.ts              # 规则评估 + 触发
    ├── telegram.ts                  # Telegram Bot HTTP API 客户端(主推送)
    └── provider.ts                  # 注册成第三个 TabProvider
```

---

## 3. UI 设计

不画线框图,口语描述。复用现有 `web/styles.css` 调子,不引入新 CSS 框架。

```
┌─ 盯盘助手 ──────────────────────────────────────────────────┐
│  [+ 加仓位]   [⏸ 暂停盯盘]   实时(每 5s)·收盘 09:30-11:30 / │
│                              13:00-15:00 之外只更新 1 次/分  │
│                                                              │
│  汇总:总市值 ¥xxx,xxx · 浮盈 +¥xx,xxx (+x.xx%) · 当日 +¥xxx │
├──────────────────────────────────────────────────────────────┤
│  代码 / 名称   股数  成本   现价↻  涨跌    浮盈率   操作    │
│  ─────────────────────────────────────────────────────────   │
│  ★ 600519     500   1300   1275  -1.92%  -1.92%  [展开]    │
│      贵州茅台                                                │
│                                                              │
│      ── 档位标尺(纯展示)─────────────────────────────       │
│      ─10%  ─5%  ─3%  ─1% │成本│ +1%  +3%  +5%  +10%        │
│      1170  1235 1261 1287│1300│1313  1339  1365  1430       │
│                                                              │
│      ── 我设的提醒 ──────────────────────────────────         │
│      🔔 止盈一档 +5% (¥1365)    cooldown 60min  [关] [删]   │
│      🔔 止损位 -7% (¥1209)      cooldown 60min  [关] [删]   │
│      [+ 加止盈位] [+ 加止损位] [+ 当日涨跌阈值]              │
│                                                              │
│  600999     1000  17.40  17.10  -1.72%  -1.72%   [展开]    │
│  …                                                           │
└──────────────────────────────────────────────────────────────┘
```

**交互**:

- **加仓位**:模态框,字段 `symbol / shares / avgCost / note`,提交后行情先按需补一次。**默认不创建任何告警规则**
- **展开**:看档位标尺(展示)+ 我设的提醒(可加可删可关)+ 触发历史
- **加止盈/止损位的快速入口**:展开里有三个快捷按钮:
  - "+ 加止盈位" → 默认 `pct_from_cost +5`,可改
  - "+ 加止损位" → 默认 `pct_from_cost -7`,可改
  - "+ 当日涨跌阈值" → 默认 `daily_change_pct -5`(异动监控)
- **现价↻**:点 ↻ 强制刷新当条;否则页面在交易时段每 5 秒自动批量轮询一次
- **★ 标星**:重点关注,UI 置顶,推送时优先用 markdown 而非纯文本
- **删除仓位**:二次确认;不软删,直接从 `positions.json` 移除,但 snapshot 已经记录的不动

---

## 4. 行情数据源

调研结论:Sina / Tencent 都免费可用,无 token、无 referer 严格校验(Sina 需要随便给个 `Referer: https://finance.sina.com.cn/`)。本地实测两家都拿到最新一笔(贵州茅台 2026-05-28 15:00 收盘 1275.98)。

### 4.1 选型

| 源 | URL 模板 | 编码 | 字段密度 | 备注 |
|---|---|---|---|---|
| Sina(主)| `http://hq.sinajs.cn/list=sh600519,sz000001` | GBK | 中(33 字段)| 最稳,batch 友好 |
| Tencent(备)| `http://qt.gtimg.cn/q=sh600519,sz000001` | GBK | 高(50+ 字段)| Sina 出问题时切 |
| EastMoney | `https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=...` | UTF-8 JSON | 高 | 已在调研中尝试,某些字段返回空,留作 future fallback |

**默认走 Sina**,失败 / 返回 0 行(北交所新股偶发)再回落到 Tencent。

### 4.2 拉取节奏

- 交易时段(09:30-11:30 / 13:00-15:00,周一到周五,排除节假日):每 **5 秒** 批量拉一次,所有持仓一个请求(`list=` 用逗号拼)
- 非交易时段:每 **60 秒** 拉一次,主要是给最新收盘价 / 当晚集合竞价做兜底
- 整体节流:tab 切到后台或没人看 ≥ 2 分钟,降级到每 60 秒(浏览器 visibilitychange)
- 后端缓存 3 秒,避免多 tab 并发刷爆

### 4.3 错误降级

- 网络错误 / 解析错误 → 显示上一次成功的价(灰色),状态条提示"Sina 异常,5s 后重试"
- 连续 3 次失败 → 切 Tencent,通知 ops(打到 logs/web-server.log)
- 北交所(`bj` 前缀)Sina 偶发返回 0 行,自动跳 Tencent

### 4.4 字段映射(Sina)

```
hq_str_sh600519 → ["贵州茅台","1290.000","1303.000","1275.980","1304.000",
  "1271.000","1275.820","1275.980","4588998","5895475019.000",
  /* 5档买盘 量,价 ×5 */ "400","1275.820","300","1275.600", ...,
  /* 5档卖盘 量,价 ×5 */ ...,"2026-05-28","15:00:02","00",""]

→ { name, open, prevClose, last, high, low, bid1Price, ask1Price,
    volume, amount, bids[5], asks[5], date, time, suspendFlag }
```

完整映射表落到 `lib/web/positions/quote-source.ts` 注释里。

---

## 5. 提醒推送

### 5.1 触发逻辑

1. 行情 tick 到达 `alert-engine.ts`
2. **只对用户亲自添加的 enabled 规则**(系统不再注入默认规则)计算目标价:
   - `pct_from_cost`: `targetPrice = avgCost * (1 + pct/100)`
   - `absolute`: `targetPrice = price`
   - `daily_change_pct`: `targetPrice = prevClose * (1 + dailyPct/100)`
3. 取上一笔价 `prev` 与本笔价 `curr`,判定穿越:
   - `cross_up`:`prev < target && curr >= target`
   - `cross_down`:`prev > target && curr <= target`
   - `any`:`(prev - target) * (curr - target) <= 0`
4. 命中后检查 `cooldownMin`,在 cooldown 期内不重复触发
5. 触发后写 `lastFiredAt / lastFiredPrice` 到 `alert-state.json`
6. 当日首笔 quote 不评估规则,只更新 `prev`(防开盘集合竞价跳空假触发)

### 5.2 消息内容(Telegram MarkdownV2 / 浏览器通知)

Telegram 推送示例(MarkdownV2):

```
🔔 *{symbol} {name}* 触发 _{ruleLabel}_
现价 ¥{last}  ({pctFromCost:+.2%} vs 成本)
当日 {dailyChangePct:+.2%}
五档买一 ¥{bid1Price} / 卖一 ¥{ask1Price}
触发时间 {time}  · 规则 cooldown {cooldownMin}min
```

`ruleLabel` 例:`+5% 止盈位` / `-3% 止损位` / `当日 -7% 异常下跌`。

浏览器原生通知 — Title 取 `🔔 {symbol} {ruleLabel}`,Body 取上面 markdown 文本去掉格式符的纯文本,点击通知聚焦回 web tab。

### 5.3 渠道:Telegram(主)+ 浏览器原生通知

**渠道一:Telegram Bot HTTP API**(默认主推送通道)

- Bot:`@moguddsuper_bot`(id `8902737449`)
- Bot token:已在 `/root/.openclaw/openclaw.json` 的 `channels.telegram.botToken`,实现时复用同一个 token,**不要在 DailyBrief 自己的 .env.local 里另存一份**(避免两份不同步),代码用 `readOpenClawTelegramToken()` 直接读 OpenClaw 配置文件
- Target chat_id:`8399303460`(从 `channels.telegram.allowFrom` 读取),可在 `.env.local` 用 `TELEGRAM_CHAT_IDS` 覆盖支持多人

**鉴权**:无,token 自带

**发送 API**:

```
POST https://api.telegram.org/bot{token}/sendMessage
Content-Type: application/json
{
  "chat_id": 8399303460,
  "text": "...",                    # 纯文本或 markdown
  "parse_mode": "MarkdownV2",       # 可选,需要 escape 特殊字符
  "disable_web_page_preview": true
}
```

**配额**:Telegram 对 bot 的限制是 **30 msg/秒 全局 + 1 msg/秒 单聊**,对盯盘场景完全无感。每月无配额。

**失败重试**:
- 429 Too Many Requests → 读 `retry_after` 字段,等待后重试
- 5xx → 指数退避重试 3 次
- 4xx 其他 → 直接降级为浏览器通知 + log

**渠道二:浏览器原生通知**(默认勾选,与 Telegram 并列)

- 用 Web `Notification` API,首次进入盯盘 tab 弹"允许通知"权限请求
- tab 没开 / 浏览器关了 → 失效,但有 Telegram 兜底
- 0 配额、0 延迟,在桌面前看着 web 时这个体验最好

**渠道三(可选):log_only**

只写 `logs/alerts-*.jsonl`,不打扰。规则配置时可用,适合"试探性"告警阈值。

### 5.4 (已废弃)QQ 官方机器人渠道

QQ 官方机器人原计划做主推送,后因 4/月 主动消息限制 + 需要额外做 WebSocket 接收被动窗口,**复杂度收益不成比例**,改用 Telegram 顶上。

QQ 渠道做成可选 T4(§10),将来如果有"老人不用 Telegram 只用 QQ"这类用户再做。AppID / Secret 暂不入 `.env.local`,实现层不引入相关代码。

OpenClaw 那边历史 session(`/root/.openclaw/qqbot/`)保留不动,跟 DailyBrief 互不干扰。

### 5.5 推送审计

`logs/alerts-YYYY-MM-DD.jsonl` 每行一条:

```json
{"ts":"2026-05-28T13:42:11Z","symbol":"600519","ruleId":"...",
 "kind":"pct_from_cost","pct":-3,"price":1261.00,"channel":"telegram",
 "deliveryStatus":"success","latencyMs":284}
```

UI 在"展开"区显示该仓位最近 10 条触发记录。

---

## 6. 后端 API

挂在现有 `scripts/web-server.ts` 的路由表里,跟 `/api/tabs/*` 平级。

| Method | Path | 用途 |
|---|---|---|
| GET    | `/api/positions` | 当前持仓全量 + 当前行情 + 浮盈 |
| POST   | `/api/positions` | 新增,body = `Pick<Position, "symbol" | "shares" | "avgCost" | "note">` |
| PATCH  | `/api/positions/:id` | 改 shares / avgCost / note / starred / alertRules |
| DELETE | `/api/positions/:id` | 删 |
| GET    | `/api/positions/quotes?symbols=600519,000001` | 批量拉行情(供前端轮询) |
| POST   | `/api/positions/:id/rules` | 加规则 |
| DELETE | `/api/positions/:id/rules/:ruleId` | 删规则 |
| GET    | `/api/positions/snapshots` | 历史快照日期列表(给历史下拉框)|
| GET    | `/api/positions/snapshots/:date` | 取指定日期快照 |
| POST   | `/api/positions/test-alert` | 触发一次测试推送(给规则配置上的"测试"按钮)|

注册成 TabProvider:

```ts
// lib/web/providers/positions-provider.ts
export const positionsProvider: TabProvider = {
  id: "positions",
  label: "盯盘助手",
  description: "持仓跟踪、止盈止损、Telegram 提醒。",
  refreshLabel: "立即刷一次行情",
  loadLatest, loadDate, listDates, refresh,
};
```

`refresh()` = 强制重拉行情一次 + 评估规则;`listDates()` 返回 snapshots 目录里的日期。

---

## 7. 后台 daemon(进程内即可)

不另起进程,挂在 `scripts/web-server.ts` 启动后异步起一个 setInterval:

```ts
// 每 5s 一轮(交易时段)/ 60s(非交易时段)
async function tick() {
  if (positions.length === 0) return;
  const symbols = unique(positions.map(p => qualified(p)));
  const quotes = await batchQuote(symbols);
  for (const p of positions) evaluateRules(p, quotes[qualified(p)]);
  broadcastToOpenWebSockets(quotes);  // 可选,SSE/WS
}
```

**SSE 推前端**:`GET /api/positions/stream`(EventSource),每次 tick 推一次最新行情 + 触发事件。前端不用 polling 也能近实时;但保留 polling 接口作为 fallback。

**收盘快照**:`scripts/positions-snapshot.ts`,15:30 一个 cron 入口,落 `positions_snapshots/<date>.json`,给历史下拉框。

---

## 8. 配置(`.env.local` 新增)

```bash
# 盯盘助手
POSITIONS_QUOTE_SOURCE=sina            # sina | tencent
POSITIONS_TICK_TRADING_MS=5000
POSITIONS_TICK_OFFHOURS_MS=60000
POSITIONS_TZ=Asia/Shanghai             # 计算交易时段用

# Telegram(主推送渠道)
# 默认从 /root/.openclaw/openclaw.json 的 channels.telegram.botToken 读,
# 不在这里另存一份。仅当想跟 OpenClaw 解耦时,在下面覆盖:
# TELEGRAM_BOT_TOKEN=<override>
# TELEGRAM_CHAT_IDS=8399303460,<另一个>   # 默认从 openclaw allowFrom 读
TELEGRAM_DISABLE_PREVIEW=true            # 链接不展开预览
TELEGRAM_PARSE_MODE=MarkdownV2

# AlertChannel 默认值(规则没显式指定 channels 时用)
POSITIONS_DEFAULT_CHANNELS=browser,telegram
```

`.env.local` 已 gitignored;Telegram token 优先从 OpenClaw 配置读,实现层用 `lib/web/positions/telegram.ts` 内的 `loadTelegramConfig()` 集中处理回退顺序:

```
.env.local TELEGRAM_BOT_TOKEN
  ↓ 没设
/root/.openclaw/openclaw.json channels.telegram.botToken
  ↓ 没设
抛错,提示用户先 `openclaw channels add --channel telegram --token <token>` 或在 .env.local 里给一个
```

---

## 9. 进度规划(MVP 锁定)

**MVP = 一次性交付以下,验收通过后才开 T2**:

| 模块 | 范围 |
|---|---|
| **P1 持久化** | `data/positions.json` + atomic write + CRUD API |
| **P2 行情** | Sina(主)/ Tencent(备)拉取,5s/60s tick,前端 SSE 推送 |
| **P2 档位标尺** | UI 上 ±1/3/5/10% 价格点亮当前档(纯展示)|
| **P3 告警引擎** | 用户加止盈/止损规则,跨日首笔不评估,cooldown 60min,触发记录 |
| **P3 浏览器通知** | `Notification` API,首次打开请求权限;通知点击聚焦 web tab |
| **P3 log 渠道** | `logs/alerts-YYYY-MM-DD.jsonl`,审计与排错用 |
| **T1 汇总条** | 总市值 / 累计浮盈 / 当日浮盈 / 行业分布饼图(占位先用 list) |
| **T1 持有天数** | 仓位行 hover 显示"持有 N 天 · 期间最高/最低" |
| **T1 集合竞价异动** | 09:25 一次特殊轮询,开盘价 vs 昨收 ≥ ±3% → 浏览器通知 |
| **行业归属** | 启动时 snapshot SilverM-quant `dwd_stock_info`,持仓 symbol 反查行业 |

**验收标准**:

1. 新增一条 600519 / 500 股 / 1300 元 仓位,刷新页面持久
2. UI 看到现价、当日涨跌、档位标尺(±1/3/5/10% 价位亮起)、行业(应该是"白酒")
3. 用户给该仓位加 `+5% 止盈位`,模拟现价穿越后:
   - 浏览器右上角弹通知
   - `logs/alerts-2026-05-28.jsonl` 有一条记录
   - UI 触发历史里能看到
4. 09:25 集合竞价时段(下次能等到),开盘价跟昨收对比偏离 3% → 自动通知

---

**MVP 验收后才做 P4 + 后面**:

| Phase | 范围 |
|---|---|
| **P4** | Telegram 推送(复用 OpenClaw token)+ 失败重试 + 渠道开关 |
| **P5** | 收盘 snapshot + 历史下拉框 |
| **P6 (T2 优先 3)** | Trailing stop + A 股日报联动高亮 + 公告流(用户挑顺序) |
| **P7 (T2 剩 3)** | 量价异常 + LLM 收盘复盘 + CSV 导入导出 |
| **P8+** | T3 / T4 视使用反馈再排 |

---

## 10. 更多功能(分层调研)

按"性价比(信息密度 / 实现成本)"排序。**T1 一定做、T2 强烈建议、T3 可选、T4 待观察**。

### T1 — 一定做(核心体验)

| # | 功能 | 接口 / 数据源 | 备注 |
|---|---|---|---|
| 1 | **浏览器原生通知** | `Notification` API(MDN 标准) | 0 配额、0 延迟,tab 开着即可。所有告警**默认勾选**这个通道,QQ 只作为"离开电脑后的兜底"|
| 2 | **持仓汇总条** | 本地计算 | 总市值 / 累计浮盈 / 当日浮盈 / 行业分布饼图(行业从 SilverM-quant `dwd_stock_info` 反查) |
| 3 | **持有天数 + 当时建仓价回看** | 本地计算 + Sina/Tencent 历史 K | UI 上鼠标移到持仓行显示"持有 23 天 · 期间最高 1340 / 最低 1198" |
| 4 | **集合竞价异动提醒** | 09:25:00 一次特殊轮询 | 开盘价相对昨收 ±3% 自动 push(已设有 `daily_change_pct` 规则的话叠加),只走浏览器通知 |

### T2 — 强烈建议(护城河功能)

| # | 功能 | 接口 / 数据源 | 备注 |
|---|---|---|---|
| 5 | **Trailing stop(跟踪止损)** | 本地计算 | 涨过 X% 后,止损位自动上抬到"建仓价 + (max - 建仓) × ratio"。例如:涨 10% 后,止损从 -7% 自动上移到 +3%(锁定利润) |
| 6 | **A 股日报联动高亮** | 现成 `daily_signals` 表 | 持仓在今日 A 股日报里命中 S/A 级研究池 → 仓位行右上角徽章 + 提醒 |
| 7 | **公告流(本日新发)** | 东财 `np-anotice-stock`(实测可用)| 持仓当天有新公告 → 仓位行下方折叠条目;关键词("回购"/"减持"/"问询函"/"重大资产")命中自动浏览器通知 |
| 8 | **量价异常推送** | 同花顺 `d.10jqka.com.cn`(实测可用)| 当日成交量 ≥ 5 日均量的 2x **且** 涨跌幅 ≥ 3% → 触发。完全本地判定,不占 QQ 配额(走浏览器/log)|
| 9 | **LLM 收盘复盘** | daily-brief 现有 LLM stack(`runLlm`)| 收盘后调一次 LLM,基于持仓 + 当日行情 + 命中信号 + 公告生成一段 markdown 复盘,落 `data/positions_snapshots/<date>.md`,UI 一键展开 |
| 10 | **CSV 导入/导出** | 浏览器 File API | 支持券商导出格式(雪球 / 同花顺 / 富途的 CSV);导出走 RFC 4180,可直接导回 Excel |

### T3 — 可选(锦上添花)

| # | 功能 | 接口 / 数据源 |
|---|---|---|
| 11 | **观察仓(watchlist,无持股)** | 复用 `Position` 但 `shares=0` 的特殊态 |
| 12 | **平仓记录 + 胜率统计** | 新增 `closes.json`,卖出动作把仓位移过去;UI 展示历史已平仓的胜率、单笔平均盈亏、最大回撤 |
| 13 | **按行业分组视图** | DuckDB `dwd_stock_info.industry` |
| 14 | **行业 benchmark** | 同行业 ETF / 指数(如 `sh000300` 沪深 300)实时,行内显示"vs 大盘 +0.4%" |
| 15 | **盘中分时小图** | 东财 `trends2/get`(等找到稳定接口)或本地拼接当日 quote tick 历史 |
| 16 | **仓位 markdown 笔记** | `data/positions_notes/<symbol>.md`,UI 用最简单 textarea 编辑,留空就不显示 |
| 17 | **键盘快捷键** | `j/k` 切换持仓,`/` 搜索,`a` 加仓,`s` 加止盈位 |
| 18 | **导出每日复盘 markdown** | 直接复用 #9 的产物 |

### T4 — 待观察(技术不确定)

| # | 功能 | 风险点 |
|---|---|---|
| 19 | **主力资金流入** | 东财 push2 当前 502;需要等接口稳定或换数据源(Tushare 收费) |
| 20 | **龙虎榜命中** | 东财 `datacenter_v1` 工作但是历史数据,实时性弱 |
| 21 | **大宗交易 / 重要股东减持** | 巨潮 `cninfo.com.cn` 接口测试时返回空,需要找正确的 stockcode 格式 |
| 22 | **财报 / 分红日历** | 东财对应 endpoint 字段有变,等接口稳定 |
| 23 | **ST / 退市预警** | 数据来源:DuckDB `dwd_stock_info.list_status`(目前未启用,要先把 SilverM-quant 那边补这张表) |

### 跨系统集成清单(本机已有的资产)

| 资产 | 在哪 | 怎么用 |
|---|---|---|
| **A 股 DuckDB** | `/data/SilverM-quant/data/Astock3.duckdb` | 行业 / 信号 / 当日 K 线全在这里。只读 snapshot 即可,T1 #2、T2 #6、T3 #13 都靠它 |
| **5001 dashboard 的 baostock 拉数** | 已有 `POST /api/data-update/update` | 想做 1 分钟 K 线 / 历史回看,直接复用,不重造轮子 |
| **A 股选股 workflow** | `/root/.hermes/scripts/stock_selection_workflow.sh` | T2 #6 高亮就是它的产物 |
| **daily-brief LLM dispatcher** | `lib/ai/llm.ts` `runLlm()` | T2 #9 LLM 复盘直接调,5 个 backend 都能跑 |
| **daily-brief 财经 RSS** | `daily_reports/<date>-articles.json` | 命中持仓 ticker 的财经新闻自动进侧栏 |
| **OpenClaw Telegram 通道** | `/root/.openclaw/openclaw.json` 的 `channels.telegram` | bot token + allowFrom chat_id 全在里头,直接复用,不用让用户重配 |

### 工作流小工具(都是本地纯计算,免接口)

- **补仓计算器**:输入"我想再买 N 股,目标成本均价 X" → 反算需要的买入价 / 资金;反过来也行
- **按 % 减仓**:"卖掉 30% 仓位"一键算出股数(按 100 股取整)
- **税费估算**:基于 A 股印花税 0.05% + 经手 0.00341% + 过户 0.001%(深市免)+ 券商佣金可配置,默认 0.025% 单边,平仓模拟时算进去
- **"如果今天卖了"模拟器**:基于实时价 × 持股数 - 税费,一键展示总盈亏 / 收益率
- **盈亏曲线 sparkline**:把 `positions_snapshots/*.json` 里的 `floatingPnL` 串起来画 7d / 30d / 全部三档迷你折线,放在汇总条里

---

## 11. 风险与开放问题

1. **Telegram bot token 共用**:DailyBrief 复用 OpenClaw 的 token,如果用户在 OpenClaw 那边 rotate 了 token,DailyBrief 也得重启刷新缓存。`lib/web/positions/telegram.ts` 启动时读一次,送的时候验失败 → 重读一次 → 还失败才报错
2. **Sina / Tencent 行情没有 SLA**:任意一家被腾讯 / 新浪改协议,我们就要修;所以两家都接,主备切换。再恶劣的话留一条 fallback:`scripts/dry-run.ts` 风格手动触发任意 ticker fetch 输出原始报文
3. **数据本地化**:`positions.json` 是用户的核心私密数据,绝不进 git;`.gitignore` 必须显式排除 `data/` 整个目录(我后面建 PR 一起加)
4. **多浏览器同时开页面 / SSE 雪崩**:后端 quote 缓存 + 单进程 setInterval,前端只是被动接,不会重复发请求
5. **DuckDB 跨项目共用**:跟 SilverM-quant 共一个文件,要走 snapshot 模式(参考 `lib/web/astock-refresh-chain.ts` 已有的 `.duckdb` + `.wal` 拷贝法),否则会跟 5001 dashboard 抢锁

---

## 12. 不在范围里(显式排除,避免范围漂移)

- 不接券商真实行情(L2)
- 不存历史 tick(那个体量到 GB 级,内存放不下,Snapshot 一日一份就够)
- 不做策略回测 / 自动交易
- 不做用户登录 / 多租户(整个 dailybrief web 现在就是 single-user 本地服务)
- 不写 native iOS / Android 客户端

---

附:本机已侦测到的 Telegram bot 配置(`/root/.openclaw/`)

- Bot:`@moguddsuper_bot`(超级菇💵💵💵💵,id `8902737449`)
- Token:在 `openclaw.json` 的 `channels.telegram.botToken`,token fingerprint `daa85f1e26be1fad`
- 已 getMe 验证有效(`ok=true`)
- 允许 chat_id:`8399303460`(单用户)
- 最近一次 update:2026-05-25,update_id `976335951`(说明 bot 还活跃)

DailyBrief 实现时:
- token 直接 `readFileSync('/root/.openclaw/openclaw.json')` 取出,优先级见 §8
- chat_id 默认从 `channels.telegram.allowFrom` 读
- 不要在 DailyBrief 自己的 `.env.local` 重复存 token,只存覆盖项

—— end ——
