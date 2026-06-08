const RUNG_PCTS_FRONT = [-10, -5, -3, -1, 1, 3, 5, 10];

// Beijing time helpers (frontend — matches lib/utils.ts bjNow/bjIso).
function bjNow() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    iso: bj.toISOString().replace("Z", "+08:00"),
    date: bj.toISOString().slice(0, 10),
  };
}
function bjIso() { return bjNow().iso; }

const state = {
  tabs: [],
  active: "daily",
  // per-tab cache: id -> { latest: RefreshResult|null, byDate: Map<date,RefreshResult>, dates: string[], selectedDate: string|null }
  perTab: new Map(),
};

const els = {
  tabs: document.querySelector("[data-tabs]"),
  title: document.querySelector("[data-title]"),
  summary: document.querySelector("[data-summary]"),
  meta: document.querySelector("[data-meta]"),
  refresh: document.querySelector("[data-refresh]"),
  status: document.querySelector("[data-status]"),
  content: document.querySelector("[data-content]"),
  historyWrap: document.querySelector("[data-history-wrap]"),
  history: document.querySelector("[data-history]"),
};

function tabState(id) {
  let s = state.perTab.get(id);
  if (!s) {
    s = { latest: null, byDate: new Map(), dates: [], selectedDate: null };
    state.perTab.set(id, s);
  }
  return s;
}

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function setStatus(text, tone = "") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    const preview = text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    throw new Error(`接口返回了非 JSON 响应 (${res.status}): ${preview || type || "empty"}`);
  }
  try {
    return { res, json: JSON.parse(text) };
  } catch (err) {
    throw new Error(`接口 JSON 解析失败 (${res.status}): ${err.message}`);
  }
}

function expandDailyHtml(html) {
  const override = `<meta name="color-scheme" content="light only">
<style>
    :root, html, body { color-scheme: light !important; }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #f7f8fb !important;
        --bg-elevated: #ffffff !important;
        --fg: #18181b !important;
        --fg-soft: #3f3f46 !important;
        --muted: #71717a !important;
        --rule: #dfe3ea !important;
        --card: #eef2f7 !important;
        --link: #1d4ed8 !important;
        --accent: #172033 !important;
        --accent-fg: #fafaf9 !important;
        --accent-soft: #e8eef8 !important;
        --positive: #15803d !important;
        --negative: #dc2626 !important;
        --warning: #b45309 !important;
        --rank-high-bg: #fee2e2 !important;
        --rank-high-fg: #991b1b !important;
        --rank-mid-bg: #fef3c7 !important;
        --rank-mid-fg: #92400e !important;
        --rank-low-bg: #e0e7ff !important;
        --rank-low-fg: #3730a3 !important;
        --hero-grad-from: #ffffff !important;
        --hero-grad-to: #eef4ff !important;
        --shadow: 0 18px 50px rgba(15, 23, 42, 0.08) !important;
        --page-sheen: rgba(255,255,255,0.68) !important;
      }
      body { background: var(--bg) !important; color: var(--fg) !important; }
    }
    body {
      background: #f7f8fb !important;
      color: #18181b !important;
      font-size: 18px !important;
      line-height: 1.75 !important;
    }
    main {
      max-width: 960px !important;
      width: 100% !important;
      padding: 1.6rem clamp(18px, 3vw, 40px) 3rem !important;
    }
    /* ———— typography scale-up ———— */
    .eyebrow, .hero-eyebrow, .section-kicker {
      font-size: 0.82rem !important;
      letter-spacing: 0.1em !important;
    }
    .overview-text, .digest-body, .article-blurb, .story-summary {
      font-size: 1rem !important;
      line-height: 1.8 !important;
    }
    .hero-headline { font-size: clamp(1.35rem, 2.2vw, 1.7rem) !important; line-height: 1.3 !important; }
    .hero-copy .overview-text { font-size: 1.05rem !important; line-height: 1.8 !important; max-width: 78ch !important; }
    .category-title { font-size: 1.1rem !important; font-weight: 700 !important; }
    .article-title, .digest-item-title, .story-headline {
      font-size: 1rem !important;
      line-height: 1.5 !important;
    }
    .article-meta, .source-line, .story-byline, time, .article-stats {
      font-size: 0.82rem !important;
      color: var(--muted) !important;
    }
    .article-excerpt, .article-summary {
      font-size: 0.95rem !important;
      line-height: 1.7 !important;
    }
    .keyword { font-size: 0.78rem !important; padding: 0.2rem 0.55rem !important; }
    }
    .hero-metric strong { font-size: 1.6rem !important; }
    .hero-metric span { font-size: 0.8rem !important; }
    .tab { font-size: 1rem !important; padding: 0.7rem 1.1rem !important; }
    .tab .count { font-size: 0.8rem !important; }
    .hero-card { border-radius: 0.55rem !important; }
    .archive-link { font-size: 0.95rem !important; }
    /* Make article lists more spacious */
    .article-row, .digest-item, .story-card {
      padding: 0.85rem 0 !important;
      line-height: 1.65 !important;
    }
    /* Trading section */
    .pick-symbol { font-size: 1.1rem !important; }
    .pick-name { font-size: 0.9rem !important; }
    .pick-rationale { font-size: 0.92rem !important; line-height: 1.65 !important; }
    .crypto-widget { font-size: 0.9rem !important; }
    .crypto-widget strong { font-size: 1.3rem !important; }
    .empty { font-size: 0.95rem !important; }
    a { font-size: inherit !important; }
    p { font-size: inherit !important; line-height: inherit !important; }
    /* The host shell already shows a title — drop the duplicated big header. */
    header.report-header { display: none !important; }
  </style>`;
  return String(html || "").replace("</head>", `${override}</head>`);
}

function resizeDailyFrame(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return;
    const chromeHeight = document.querySelector(".topbar").offsetHeight
      + document.querySelector(".side-nav").offsetHeight
      + document.querySelector(".panel-head").offsetHeight;
    const minHeight = Math.max(640, window.innerHeight - chromeHeight);
    const contentHeight = doc.documentElement.scrollHeight;
    frame.style.height = `${Math.max(minHeight, contentHeight)}px`;
  } catch {
    frame.style.height = "calc(100vh - 190px)";
  }
}

function renderTabs() {
  els.tabs.innerHTML = state.tabs
    .map(
      (tab) =>
        `<button class="nav-tab${tab.id === state.active ? " active" : ""}" data-tab="${tab.id}">
          <span>${tab.label}</span>
          <small>${tab.description}</small>
        </button>`,
    )
    .join("");
  els.tabs.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
}

function renderHistorySelect(tabId) {
  const s = tabState(tabId);
  if (tabId === "positions" || !s.dates.length) {
    els.historyWrap.hidden = true;
    els.history.innerHTML = "";
    return;
  }
  els.historyWrap.hidden = false;
  const current = s.selectedDate ?? s.dates[0];
  els.history.innerHTML = s.dates
    .map(
      (d, i) =>
        `<option value="${d}"${d === current ? " selected" : ""}>${d}${i === 0 ? "（最新）" : ""}</option>`,
    )
    .join("");
}

function renderContent(tabId, data) {
  els.content.classList.toggle("daily-content", tabId === "daily");
  els.content.classList.toggle("positions-content", tabId === "positions");
  els.title.textContent = data.title || state.tabs.find((tab) => tab.id === tabId)?.label || tabId;
  els.summary.textContent = data.summary || "";
  els.meta.innerHTML = [
    `<span>数据日期 ${data.date || "-"}</span>`,
    `<span>载入 ${fmtTime(data.refreshedAt)}</span>`,
  ].join("");

  const tab = state.tabs.find((item) => item.id === tabId);
  els.refresh.textContent = tab?.refreshLabel || "刷新";
  els.refresh.disabled = false;

  if (tabId === "positions") {
    renderPositions(data?.meta?.snapshot);
    ensurePositionsStream();
    return;
  }

  if (tabId === "daily") {
    els.content.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "daily-frame";
    frame.setAttribute("title", "综合日报");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    frame.srcdoc = expandDailyHtml(data.html);
    frame.addEventListener("load", () => {
      resizeDailyFrame(frame);
      setTimeout(() => resizeDailyFrame(frame), 150);
      setTimeout(() => resizeDailyFrame(frame), 800);
      try {
        new ResizeObserver(() => resizeDailyFrame(frame)).observe(frame.contentDocument.body);
      } catch {
        // Keep the static height fallback if iframe internals are unavailable.
      }
    });
    els.content.appendChild(frame);
  } else {
    els.content.innerHTML = data.html || `<div class="empty">暂无内容</div>`;
  }
}

async function pollUntilDone(tabId) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const { res, json } = await fetchJson(`/api/tabs/${tabId}/refresh`, { method: "GET" });
      if (res.status === 202) continue;
      if (res.ok) return json;
      throw new Error(json.error || `刷新异常 (${res.status})`);
    } catch (err) {
      // If the poll itself fails, keep trying.
      console.warn("[poll] attempt failed:", err.message);
    }
  }
  throw new Error("刷新超时（10 分钟），请稍后手动刷新页面");
}

async function loadHistoryDates(tabId) {
  const s = tabState(tabId);
  try {
    const { res, json } = await fetchJson(`/api/tabs/${tabId}/history`);
    if (!res.ok) return;
    s.dates = Array.isArray(json.dates) ? json.dates : [];
  } catch {
    // Non-fatal: just leave the picker empty.
    s.dates = [];
  }
  renderHistorySelect(tabId);
}

async function loadTab(tabId, options = {}) {
  const { force = false, date = null } = options;
  state.active = tabId;
  renderTabs();
  const s = tabState(tabId);

  // Decide which view to fetch.
  const targetDate = date ?? s.selectedDate ?? null;
  const isLatest = !targetDate || targetDate === s.dates[0];

  // Cache hit?
  if (!force) {
    if (isLatest && s.latest) {
      s.selectedDate = s.latest.date;
      renderHistorySelect(tabId);
      renderContent(tabId, s.latest);
      return;
    }
    if (targetDate && s.byDate.has(targetDate)) {
      s.selectedDate = targetDate;
      renderHistorySelect(tabId);
      renderContent(tabId, s.byDate.get(targetDate));
      return;
    }
  }

  els.content.innerHTML = `<div class="loading">正在载入...</div>`;
  els.refresh.disabled = true;
  setStatus(targetDate ? `载入 ${targetDate}` : "载入中");
  try {
    const url = targetDate
      ? `/api/tabs/${tabId}?date=${encodeURIComponent(targetDate)}`
      : `/api/tabs/${tabId}`;
    const { res, json } = await fetchJson(url);
    if (!res.ok) throw new Error(json.error || "载入失败");
    if (targetDate) {
      s.byDate.set(targetDate, json);
      s.selectedDate = targetDate;
    } else {
      s.latest = json;
      s.byDate.set(json.date, json);
      s.selectedDate = json.date;
    }
    renderHistorySelect(tabId);
    renderContent(tabId, json);
    setStatus("就绪", "ok");
  } catch (err) {
    els.content.innerHTML = `<div class="empty error">${err.message}</div>`;
    setStatus(err.message, "error");
  }
}

async function activateTab(tabId) {
  // Make sure we have a dates list for this tab; do it in parallel with
  // loading the content so the picker shows up as soon as possible.
  loadHistoryDates(tabId);
  await loadTab(tabId);
}

async function refreshActive() {
  const tabId = state.active;
  els.refresh.disabled = true;
  const startedAt = Date.now();
  const tab = state.tabs.find((item) => item.id === tabId);
  const isDaily = tabId === "daily";
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    const hint = isDaily ? "完整日报通常需要 3-8 分钟" : "通常需要 1-3 分钟";
    setStatus(`刷新 ${tab?.label ?? ""} ${minutes}:${rest}，${hint}`);
  }, 1000);
  setStatus(`刷新 ${tab?.label ?? ""} 0:00`);
  try {
    const { res, json } = await fetchJson(`/api/tabs/${tabId}/refresh`, { method: "POST" });
    // 202 = async refresh started — poll until done.
    let result;
    if (res.status === 202) {
      setStatus(json.message || "刷新已启动", "ok");
      result = await pollUntilDone(tabId);
      setStatus("刷新完成", "ok");
    } else if (!res.ok) {
      throw new Error(json.error || "刷新失败");
    } else {
      result = json;
      setStatus("刷新完成", "ok");
    }
    const s = tabState(tabId);
    s.latest = result;
    s.byDate.set(result.date, result);
    s.selectedDate = result.date;
    // Refresh produced a new date — reload the dates list.
    await loadHistoryDates(tabId);
    renderContent(tabId, result);
  } catch (err) {
    setStatus(err.message, "error");
    els.refresh.disabled = false;
  } finally {
    clearInterval(timer);
  }
}

async function boot() {
  els.refresh.addEventListener("click", refreshActive);
  els.history.addEventListener("change", (event) => {
    const date = event.target.value;
    if (date) loadTab(state.active, { date });
  });
  const { json } = await fetchJson("/api/tabs");
  state.tabs = json.tabs || [];
  state.active = state.tabs[0]?.id || "daily";
  renderTabs();
  await activateTab(state.active);
}

boot().catch((err) => {
  setStatus(err.message, "error");
});

// ============================================================================
// 盯盘助手 tab — positions / watchlist
// ============================================================================

const positions = {
  sse: null,
  expanded: new Set(),     // position ids whose detail is open
  notifEnabled: false,     // browser Notification permission cached
  telegramReady: false,    // server reports Telegram is configured
};

// Helpers — read/write the positions snapshot through the per-tab cache,
// matching the shape produced by loadTab(). Without these, every "optimistic
// update" path was silently throwing because state.data doesn't exist on the
// state object (we use state.perTab).
function getPositionsSnapshot() {
  return state.perTab.get("positions")?.latest?.meta?.snapshot ?? null;
}
function getPositionById(id) {
  const snap = getPositionsSnapshot();
  return snap?.positions?.find((p) => p.id === id);
}

function setPositionsSnapshot(snap) {
  const s = tabState("positions");
  s.latest = {
    tabId: "positions",
    date: snap.generatedAt?.slice(0, 10) ?? bjNow().date,
    ok: true,
    refreshedAt: snap.generatedAt,
    title: "盯盘助手",
    summary: snap.positions?.length ? `共 ${snap.positions.length} 条持仓` : "尚无持仓",
    html: "",
    meta: { snapshot: snap },
  };
  s.byDate.set(s.latest.date, s.latest);
}

const fmtMoney = (n) => {
  if (n == null || Number.isNaN(n)) return "-";
  const s = n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s;
};
// Signed-money formatter for P&L lines: always shows +¥ / -¥ explicitly so a
// negative loss never silently renders as a positive number.
const fmtSignedMoney = (n) => {
  if (n == null || Number.isNaN(n)) return "-";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}¥${fmtMoney(Math.abs(n))}`;
};
const fmtPct = (n) => (n == null || Number.isNaN(n) ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
// A-share stocks tick at 0.01, but ETFs / LOFs tick at 0.001 — show enough
// decimals to never lose information. Trim only trailing zero on the third
// digit so a 1300.00 stock still reads as "1300.00" rather than "1300.000".
const fmtPrice = (n) => {
  if (n == null || Number.isNaN(n)) return "-";
  const three = n.toFixed(3);
  return three.endsWith("0") ? three.slice(0, -1) : three;
};
const colorOf = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

// ---- T4 risk data badges ----

function renderSTRiskBadge(st) {
  if (!st || st.riskLevel === "normal") return "";
  const label = st.riskLevel === "star_st" ? "*ST" : st.riskLevel === "delisted" ? "退市" : "ST";
  const cls = st.riskLevel === "star_st" || st.riskLevel === "delisted" ? "st-danger" : "st-warn";
  return `<span class="st-badge ${cls}">${label}</span>`;
}

function renderDragonTigerBadge(dt) {
  if (!dt || dt.length === 0) return "";
  const net = dt[0].netBuyAmount;
  const sign = net >= 0 ? "+" : "";
  const unit = Math.abs(net) >= 1e8
    ? `${(Math.abs(net) / 1e8).toFixed(2)}亿`
    : `${(Math.abs(net) / 1e4).toFixed(0)}万`;
  return `<span class="dt-badge">龙虎榜 ${sign}${unit}</span>`;
}

function renderFundFlowBadge(ff) {
  if (!ff || ff.mainNetInflow == null || ff.mainNetInflow === 0) return "";
  const n = ff.mainNetInflow;
  const cls = n > 0 ? "up" : n < 0 ? "down" : "";
  const sign = n > 0 ? "+" : "";
  const unit = Math.abs(n) >= 1e8
    ? `${(Math.abs(n) / 1e8).toFixed(2)}亿`
    : `${(Math.abs(n) / 1e4).toFixed(0)}万`;
  return `<span class="ff-badge ${cls}">主力${sign}${unit}</span>`;
}

function renderCalendarSection(events) {
  if (!events || events.length === 0) {
    return `<div class="cal-section"><span class="kicker">📅 财报/分红日历</span><div class="muted">暂无近期事件（加载中…）</div></div>`;
  }
  const upcoming = events.slice(0, 8);
  return `
    <div class="cal-section">
      <span class="kicker">📅 财报/分红日历</span>
      <div class="cal-grid">
        ${upcoming.map((e) => `
          <div class="cal-item">
            <span class="cal-date">${escapeHtml(e.eventDate.slice(5))}</span>
            <span class="cal-symbol">${escapeHtml(e.symbol)}</span>
            <span class="cal-type">${escapeHtml(e.eventType)}</span>
            ${e.dividendYield != null ? `<span class="cal-yield">${e.dividendYield.toFixed(2)}%</span>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderBlockTradesSection(items) {
  if (!items || items.length === 0) {
    return `<div class="ann-section"><span class="kicker">大宗交易 / 股东变动</span><div class="muted">暂无数据</div></div>`;
  }
  return `
    <div class="ann-section">
      <span class="kicker">大宗交易 / 股东变动 (${items.length})</span>
      <ul class="ann-list">
        ${items.map((bt) => {
          const tagCls = bt.tag === "减持" || bt.tag === "解禁" ? "hot" : "";
          return `<li class="ann-item ${tagCls}">
            <span class="ann-source ann-tag-source">${escapeHtml(bt.tag)}</span>
            <span class="ann-time">${escapeHtml(bt.publishedAt)}</span>
            ${bt.discountRate != null ? `<span class="ann-tag">折溢率 ${bt.discountRate.toFixed(2)}%</span>` : ""}
            <div class="ann-body">
              ${bt.url ? `<a href="${escapeHtml(bt.url)}" target="_blank" rel="noopener" class="ann-link">${escapeHtml(bt.title)}</a>` : `<span class="ann-title">${escapeHtml(bt.title)}</span>`}
            </div>
          </li>`;
        }).join("")}
      </ul>
    </div>
  `;
}

function renderPositions(snap) {
  if (!snap) {
    els.content.innerHTML = `<div class="loading">载入持仓数据…</div>`;
    return;
  }
  positions.telegramReady = !!snap.telegramReady;
  const html = `
    <div class="positions-page">
      ${renderSummary(snap)}
      ${renderToolbar(snap)}
      ${renderCalendarSection(snap.calendarEvents || [])}
      ${renderBlockTradesSection(snap.blockTrades || [])}
      ${renderTable(snap)}
      ${renderRecentAlerts(snap.recentAlerts || [])}
    </div>
  `;
  els.content.innerHTML = html;
  bindPositionsHandlers();
}

function renderSummary(snap) {
  const t = snap.totals || {};
  const indEntries = Object.entries(snap.industries || {}).sort((a, b) => b[1] - a[1]);
  const topIndustries = indEntries.slice(0, 4);
  const indHtml = topIndustries.length
    ? topIndustries
        .map(
          ([name, val]) =>
            `<span class="ind-pill">${escapeHtml(name)} <em>${fmtMoney(val)}</em></span>`,
        )
        .join("")
    : `<span class="muted">行业信息缺失（数据源未填）</span>`;
  const sparkHtml = renderSparkline(snap.trend || []);
  return `
    <div class="pos-summary">
      <div class="pos-summary-cell">
        <span class="kicker">总市值</span>
        <strong>¥ ${fmtMoney(t.marketValue)}</strong>
      </div>
      <div class="pos-summary-cell">
        <span class="kicker">累计浮盈</span>
        <strong class="${colorOf(t.floatingPnL)}">${fmtSignedMoney(t.floatingPnL)} ${t.floatingPnL != null ? `(${fmtPct(t.floatingPnLPct)})` : ""}</strong>
      </div>
      <div class="pos-summary-cell">
        <span class="kicker">当日盈亏</span>
        <strong class="${colorOf(t.todayPnL)}">${fmtSignedMoney(t.todayPnL)}</strong>
      </div>
      <div class="pos-summary-cell pos-sparkline-cell">
        <span class="kicker">7日盈亏趋势</span>
        ${sparkHtml}
      </div>
      <div class="pos-summary-industries">
        <span class="kicker">行业分布</span>
        <div class="ind-pills">${indHtml}</div>
      </div>
    </div>
  `;
}

function renderSparkline(trend) {
  if (!trend || trend.length < 2) return `<span class="muted">暂无数据</span>`;
  const values = trend.map((p) => p.floatingPnL);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 180, h = 40, pad = 2;
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  // Color: green if latest > earliest, red otherwise
  const up = values[values.length - 1] >= values[0];
  const stroke = up ? "var(--up)" : "var(--down)";
  const fill = up ? "rgba(21,128,61,0.12)" : "rgba(220,38,38,0.10)";
  // Add a fill polygon
  const firstX = pad;
  const lastX = w - pad;
  const firstY = pad + (1 - (values[0] - min) / range) * (h - pad * 2);
  const lastY = pad + (1 - (values[values.length - 1] - min) / range) * (h - pad * 2);
  const polyPts = `${firstX},${h - pad} ${points} ${lastX},${h - pad}`;
  // Labels: first and last date
  const firstDate = (trend[0].date || "").slice(5); // MM-DD
  const lastDate = (trend[trend.length - 1].date || "").slice(5);
  return `
    <div class="sparkline-wrap">
      <span class="spark-date">${firstDate}</span>
      <svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
        <polygon points="${polyPts}" fill="${fill}" />
        <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="spark-date">${lastDate}</span>
    </div>
  `;
}

function renderToolbar(snap) {
  const trading = snap.isTradingHours ? "🟢 交易时段（每 5 秒刷新）" : "⚪ 非交易时段（每分钟一次）";
  const notif = positions.notifEnabled ? "🔔 浏览器通知已开" : "🔕 浏览器通知未开 [启用]";
  const tg = snap.telegramReady ? "✈️ Telegram 已配置" : "✈️ Telegram 未配置";
  const riskFresh = snap.riskDataFetchedAt
    ? `📊 风控数据 ${snap.riskDataFetchedAt.slice(11, 16)}`
    : "";
  return `
    <div class="pos-toolbar">
      <button class="primary-btn" data-pos-add>+ 加仓位</button>
      <span class="muted">${trading}</span>
      <span class="muted" data-notif-toggle role="button" tabindex="0">${notif}</span>
      <span class="muted">${tg}</span>
      ${riskFresh ? `<span class="muted">${riskFresh}</span>` : ""}
    </div>
  `;
}

function renderTable(snap) {
  if (!snap.positions?.length) {
    return `<div class="empty">暂无持仓,点上方"+ 加仓位"开始</div>`;
  }
  const rows = snap.positions
    .map((p) => renderPositionRow(p, positions.expanded.has(p.id)))
    .join("");
  return `
    <div class="pos-table-wrap">
      <table class="pos-table">
        <thead>
          <tr>
            <th></th>
            <th>代码 / 名称</th>
            <th>持有</th>
            <th>股数</th>
            <th>成本</th>
            <th>现价</th>
            <th>当日</th>
            <th>浮盈率</th>
            <th>市值</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderPositionRow(p, expanded) {
  const q = p.quote;
  const last = q ? fmtPrice(q.last) : "-";
  const dailyPct = q ? q.changePct : null;
  const pctFromCost = p.pctFromCost;
  const star = p.starred ? "★" : "☆";
  const industry = p.industry ? `<span class="muted">· ${escapeHtml(p.industry)}</span>` : "";
  const holdHint = p.holdDays != null ? `${p.holdDays}d` : "—";
  return `
    <tr class="pos-row${expanded ? " expanded" : ""}" data-pos="${p.id}">
      <td><button class="star-btn" data-pos-star="${p.id}" title="${p.starred ? "取消重点" : "标记重点"}">${star}</button></td>
      <td>
        <strong>${p.symbol}</strong> <span class="muted">${escapeHtml(p.name || "")}</span>
        ${industry}
        ${renderSTRiskBadge(p.stRisk)}
        ${renderDragonTigerBadge(p.dragonTiger)}
      </td>
      <td class="muted">${holdHint}</td>
      <td>${p.shares.toLocaleString("zh-CN")}</td>
      <td>${fmtPrice(p.avgCost)}</td>
      <td><strong>${last}</strong></td>
      <td class="${colorOf(dailyPct)}">${fmtPct(dailyPct)}</td>
      <td class="${colorOf(pctFromCost)}">${fmtPct(pctFromCost)}</td>
      <td>¥ ${fmtMoney(p.marketValue)} ${renderFundFlowBadge(p.fundFlow)}</td>
      <td>
        <button class="link-btn" data-pos-toggle="${p.id}">${expanded ? "收起" : "展开"}</button>
        <button class="link-btn" data-pos-edit="${p.id}">改</button>
        <button class="link-btn danger" data-pos-delete="${p.id}">删</button>
      </td>
    </tr>
    ${expanded ? renderExpand(p) : ""}
  `;
}

function renderExpand(p) {
  const rungs = p.rungs || [];
  const rungsHtml = rungs.map((r) => {
    const cls = r.reached === "above" ? "reached-above" : r.reached === "below" ? "reached-below" : "reached-at";
    const sign = r.pct > 0 ? "+" : "";
    return `<div class="rung ${cls}">
      <span class="rung-label">${sign}${r.pct}%</span>
      <span class="rung-price">¥${fmtPrice(r.price)}</span>
    </div>`;
  }).join("");
  const rules = p.alertRules || [];
  const ruleListHtml = rules.length
    ? rules.map((r) => renderRule(p.id, r)).join("")
    : `<div class="muted">还没设置提醒,用下面三个按钮加</div>`;
  const annHtml = renderAnnouncements(p.announcements || []);
  return `
    <tr class="pos-detail" data-pos-detail="${p.id}">
      <td colspan="10">
        <div class="rungs-section">
          <span class="kicker">档位标尺(纯展示)</span>
          <div class="rungs">
            ${rungsHtml}
          </div>
          <div class="rung-anchor">成本 ¥${fmtPrice(p.avgCost)}</div>
        </div>
        <div class="rules-section">
          <div class="rules-header">
            <span class="kicker">我设的提醒</span>
            <button class="link-btn" data-pos-add-rule="${p.id}" data-kind="take_profit">+ 加止盈位</button>
            <button class="link-btn" data-pos-add-rule="${p.id}" data-kind="stop_loss">+ 加止损位</button>
            <button class="link-btn" data-pos-add-rule="${p.id}" data-kind="daily">+ 当日涨跌阈值</button>
          </div>
          <div class="rules-list">${ruleListHtml}</div>
        </div>
        ${annHtml}
        ${renderSellSimulator(p)}
      </td>
    </tr>
  `;
}

function renderSellSimulator(p) {
  const q = p.quote;
  const curPrice = q ? q.last : p.avgCost;
  const defaultBuyShares = Math.ceil(p.shares / 2 / 100) * 100;
  const defaultSellShares = Math.max(100, Math.floor(p.shares / 4 / 100) * 100);
  return `
    <div class="sim-section" id="sim-${p.id}">
      <span class="kicker">补仓速算</span>
      <div class="sim-row">
        <label class="sim-label">买入价</label>
        <input class="sim-price" data-sim-price="${p.id}" type="number" step="0.001" min="0.001"
               value="${curPrice}" placeholder="${fmtPrice(curPrice)}">
        <label class="sim-label">加仓股数</label>
        <input class="sim-shares" data-sim-shares="${p.id}" type="number" step="100" min="100"
               value="${defaultBuyShares}" placeholder="100">
      </div>
      <div class="sim-quick">
        <button class="quick-btn" data-sim-quick="${p.id}" data-fraction="0.25">¼ 仓</button>
        <button class="quick-btn" data-sim-quick="${p.id}" data-fraction="0.333">⅓ 仓</button>
        <button class="quick-btn" data-sim-quick="${p.id}" data-fraction="0.5">半仓</button>
        <button class="quick-btn" data-sim-quick="${p.id}" data-fraction="0.667">⅔ 仓</button>
        <button class="quick-btn" data-sim-quick="${p.id}" data-fraction="0.75">¾ 仓</button>
        <button class="quick-btn" data-sim-quick="${p.id}" data-fraction="1">全仓</button>
        <button class="quick-btn cash" data-sim-quick="${p.id}" data-cash="10000">¥1万</button>
      </div>
      <div class="sim-result" id="sim-result-${p.id}">
        ${calcBuySim(p, curPrice, defaultBuyShares)}
      </div>
    </div>
    <div class="sim-section" id="sell-sim-${p.id}">
      <span class="kicker">卖出模拟</span>
      <div class="sim-row">
        <label class="sim-label">卖出价</label>
        <input class="sim-price" data-sell-price="${p.id}" type="number" step="0.001" min="0.001"
               value="${curPrice}" placeholder="${fmtPrice(curPrice)}">
        <label class="sim-label">卖出股数</label>
        <input class="sim-shares" data-sell-shares="${p.id}" type="number" step="100" min="100"
               value="${defaultSellShares}" placeholder="100">
      </div>
      <div class="sim-quick">
        <button class="quick-btn" data-sell-quick="${p.id}" data-fraction="0.25">¼ 仓</button>
        <button class="quick-btn" data-sell-quick="${p.id}" data-fraction="0.333">⅓ 仓</button>
        <button class="quick-btn" data-sell-quick="${p.id}" data-fraction="0.5">半仓</button>
        <button class="quick-btn" data-sell-quick="${p.id}" data-fraction="0.667">⅔ 仓</button>
        <button class="quick-btn" data-sell-quick="${p.id}" data-fraction="0.75">¾ 仓</button>
        <button class="quick-btn" data-sell-quick="${p.id}" data-fraction="1">全仓</button>
        <button class="quick-btn cash" data-sell-quick="${p.id}" data-cash="10000">¥1万</button>
      </div>
      <div class="sim-result" id="sell-sim-result-${p.id}">
        ${calcSellSim(p, curPrice, defaultSellShares)}
      </div>
    </div>
  `;
}

// ---- Fee rates ----
// Commission: stock 万0.86, ETF 万0.5, both min ¥5.
// ETFs: SH codes starting with 5, SZ codes starting with 1.
// Stamp tax (sell only): stocks 万5, ETFs exempt.
// Transfer fee: SH only, 万0.1, min ¥1.
function getFeeConfig(symbol, exchange) {
  const isETF = (exchange === "sh" && symbol.startsWith("5"))
    || (exchange === "sz" && symbol.startsWith("1"));
  return {
    commRate: isETF ? 0.00005 : 0.000086,
    stampTaxRate: isETF ? 0 : 0.0005,
    isETF,
  };
}

function calcBuySim(p, addPrice, addShares) {
  const oldCost = p.shares * p.avgCost;
  const addGross = addPrice * addShares;
  const fc = getFeeConfig(p.symbol, p.exchange);
  const commission = Math.max(addGross * fc.commRate, 5);
  const transfer = p.exchange === "sh" ? Math.max(addGross * 0.00001, 1) : 0;
  const addCost = addGross + commission + transfer;
  const newShares = p.shares + addShares;
  const newTotalCost = oldCost + addCost;
  const newAvg = newTotalCost / newShares;
  const diff = newAvg - p.avgCost;
  const cls = diff > 0 ? "down" : diff < 0 ? "up" : "";
  // Estimated P&L at current market price
  const curPrice = p.quote?.last ?? p.avgCost;
  const newMv = newShares * curPrice;
  const newPnl = newMv - newTotalCost;
  const newPnlPct = newTotalCost > 0 ? (newPnl / newTotalCost) * 100 : 0;
  const pnlCls = newPnl >= 0 ? "up" : "down";
  return `
    <div class="sim-numbers">
      <span>当前成本 <strong>¥${fmtPrice(p.avgCost)}</strong></span>
      <span>加仓后成本 <strong class="${cls}">¥${fmtPrice(newAvg)}</strong></span>
      <span>成本变化 <strong class="${cls}">${diff >= 0 ? "+" : ""}${fmtPrice(diff)}</strong></span>
      <span>新总仓位 <strong>${newShares.toLocaleString("zh-CN")}股 / ¥${fmtMoney(newTotalCost)}</strong></span>
    </div>
    <div class="sim-numbers" style="margin-top:6px">
      <span>现价市值 <strong>¥${fmtMoney(newMv)}</strong></span>
      <span>模拟盈亏 <strong class="${pnlCls}">${newPnl >= 0 ? "+" : ""}¥${fmtMoney(newPnl)} (${newPnlPct.toFixed(2)}%)</strong></span>
    </div>
    <div class="sim-fee-detail">
      <span>加仓金额 ¥${fmtMoney(addGross)}</span>
      <span>佣金 ¥${fmtMoney(commission)}</span>
      ${p.exchange === "sh" ? `<span>过户费 ¥${fmtMoney(transfer)}</span>` : ""}
      <span>实付 ¥${fmtMoney(addCost)}</span>
    </div>
  `;
}

function calcSellSim(p, sellPrice, sellShares) {
  const sellGross = sellPrice * sellShares;
  const fc = getFeeConfig(p.symbol, p.exchange);
  const commission = Math.max(sellGross * fc.commRate, 5);
  const stampTax = sellGross * fc.stampTaxRate;
  const transfer = p.exchange === "sh" ? Math.max(sellGross * 0.00001, 1) : 0;
  const totalFees = commission + stampTax + transfer;
  const netProceeds = sellGross - totalFees;
  // Cost basis of the sold portion
  const costOfSold = p.avgCost * sellShares;
  const realizedPnl = netProceeds - costOfSold;
  const realizedPnlPct = costOfSold > 0 ? (realizedPnl / costOfSold) * 100 : 0;
  // Remaining position
  const remainingShares = p.shares - sellShares;
  const remainingCost = p.avgCost * remainingShares;
  const remainingAvg = remainingShares > 0 ? remainingCost / remainingShares : 0;
  // Remaining P&L at current market
  const curPrice = p.quote?.last ?? p.avgCost;
  const remainingMv = remainingShares * curPrice;
  const remainingPnl = remainingMv - remainingCost;
  const remainingPnlPct = remainingCost > 0 ? (remainingPnl / remainingCost) * 100 : 0;
  const pnlCls = realizedPnl >= 0 ? "up" : "down";
  const holdCls = remainingPnl >= 0 ? "up" : "down";
  return `
    <div class="sim-numbers">
      <span>卖出前持仓 <strong>${p.shares.toLocaleString("zh-CN")}股 / 成本 ¥${fmtMoney(p.shares * p.avgCost)}</strong></span>
      <span>卖出后持仓 <strong>${remainingShares.toLocaleString("zh-CN")}股 / 成本 ¥${fmtMoney(remainingCost)}</strong></span>
      <span>卖出后均价 <strong>¥${fmtPrice(remainingAvg)}</strong></span>
    </div>
    <div class="sim-numbers" style="margin-top:6px">
      <span>卖出金额 <strong>¥${fmtMoney(sellGross)}</strong></span>
      <span>手续费 <strong>¥${fmtMoney(totalFees)}</strong></span>
      <span>到手 <strong>¥${fmtMoney(netProceeds)}</strong></span>
    </div>
    <div class="sim-numbers" style="margin-top:6px">
      <span>卖出部分成本 <strong>¥${fmtMoney(costOfSold)}</strong></span>
      <span>实现盈亏 <strong class="${pnlCls}">${realizedPnl >= 0 ? "+" : ""}¥${fmtMoney(realizedPnl)} (${realizedPnlPct.toFixed(2)}%)</strong></span>
      <span>剩余浮盈亏 <strong class="${holdCls}">${remainingPnl >= 0 ? "+" : ""}¥${fmtMoney(remainingPnl)} (${remainingPnlPct.toFixed(2)}%)</strong></span>
    </div>
    <div class="sim-fee-detail">
      <span>佣金 ¥${fmtMoney(commission)}</span>
      <span>印花税 ¥${fmtMoney(stampTax)}</span>
      ${p.exchange === "sh" ? `<span>过户费 ¥${fmtMoney(transfer)}</span>` : ""}
      <span>合计费用 ¥${fmtMoney(totalFees)}</span>
    </div>
  `;
}

function renderAnnouncements(items) {
  if (!items || items.length === 0) {
    return `
      <div class="ann-section">
        <span class="kicker">新闻与公告</span>
        <div class="muted">暂无数据</div>
      </div>
    `;
  }
  const HOT = ["回购","减持","增持","问询函","重大资产","股权激励","业绩预告","立案","ST","退市","停牌","复牌"];
  const rows = items.map((a) => {
    const hot = HOT.find((kw) => (a.title || "").includes(kw));
    const summary = a.summary || "";
    const url = a.url || "";
    const titleHtml = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="ann-link">${escapeHtml(a.title)}</a>`
      : `<span class="ann-title">${escapeHtml(a.title)}</span>`;
    return `<li class="ann-item${hot ? " hot" : ""}">
      <span class="ann-source">${escapeHtml(a.sourceLabel || "")}</span>
      <span class="ann-time">${escapeHtml(a.publishedAt || "")}</span>
      ${hot ? `<span class="ann-tag">${escapeHtml(hot)}</span>` : ""}
      <div class="ann-body">${titleHtml}</div>
    </li>`;
  }).join("");
  return `
    <div class="ann-section">
      <span class="kicker">新闻与公告 (${items.length} 条)</span>
      <ul class="ann-list">${rows}</ul>
    </div>
  `;
}

function renderRule(positionId, r) {
  const target = priceLabelForRule(r);
  return `
    <div class="rule-row${r.enabled ? "" : " disabled"}">
      <strong>${escapeHtml(r.label || "规则")}</strong>
      <span class="muted">${escapeHtml(target)} · 冷却 ${r.cooldownMin} 分钟 · ${formatChannels(r.channels)}</span>
      ${r.lastFiredAt ? `<span class="muted">上次 ${fmtTime(r.lastFiredAt)} @ ¥${fmtPrice(r.lastFiredPrice)}</span>` : ""}
      <button class="link-btn" data-rule-toggle="${positionId}:${r.id}" data-enabled="${r.enabled ? "1" : "0"}">${r.enabled ? "关" : "开"}</button>
      <button class="link-btn danger" data-rule-delete="${positionId}:${r.id}">删</button>
    </div>
  `;
}

const CHANNEL_LABELS = {
  browser: "浏览器通知",
  telegram: "Telegram",
  log_only: "仅日志",
};
function formatChannels(channels) {
  if (!channels || channels.length === 0) return "无通道";
  return channels.map((c) => CHANNEL_LABELS[c] || c).join(" + ");
}

function priceLabelForRule(r) {
  if (r.kind === "pct_from_cost" && r.pct != null) return `成本 ${r.pct >= 0 ? "+" : ""}${r.pct}%`;
  if (r.kind === "absolute" && r.price != null) return `¥${fmtPrice(r.price)}`;
  if (r.kind === "daily_change_pct" && r.dailyPct != null) return `当日 ${r.dailyPct >= 0 ? "+" : ""}${r.dailyPct}%`;
  return "";
}

function renderRecentAlerts(events) {
  if (!events.length) return "";
  const items = events
    .slice(-10)
    .reverse()
    .map(
      (e) =>
        `<li><span class="muted">${fmtTime(e.ts)}</span>
          <strong>${e.symbol} ${escapeHtml(e.name || "")}</strong>
          触发 <em>${escapeHtml(e.ruleLabel)}</em>
          @ ¥${fmtPrice(e.currPrice)} (${fmtPct(e.dailyChangePct)})</li>`,
    )
    .join("");
  return `
    <details class="recent-alerts" open>
      <summary>最近告警 (${events.length})</summary>
      <ul>${items}</ul>
    </details>
  `;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---- handlers ----

function bindPositionsHandlers() {
  // Add position
  els.content.querySelector("[data-pos-add]")?.addEventListener("click", () => openPositionDialog());
  // Test push
  els.content.querySelector("[data-pos-test-push]")?.addEventListener("click", triggerTestPush);
  // Notification toggle
  els.content.querySelector("[data-notif-toggle]")?.addEventListener("click", requestNotifPermission);
  // Star
  els.content.querySelectorAll("[data-pos-star]").forEach((b) =>
    b.addEventListener("click", () => toggleStar(b.dataset.posStar))
  );
  // Toggle row
  els.content.querySelectorAll("[data-pos-toggle]").forEach((b) =>
    b.addEventListener("click", () => toggleExpand(b.dataset.posToggle))
  );
  // Delete position
  els.content.querySelectorAll("[data-pos-delete]").forEach((b) =>
    b.addEventListener("click", () => deletePosition(b.dataset.posDelete))
  );
  // Edit position
  els.content.querySelectorAll("[data-pos-edit]").forEach((b) => {
    const pos = getPositionById(b.dataset.posEdit);
    if (pos) b.addEventListener("click", () => openPositionDialog(pos));
  });
  // Sell simulator inputs
  els.content.querySelectorAll("[data-sim-price]").forEach((inp) => {
    const id = inp.dataset.simPrice;
    const update = () => {
      const pos = getPositionById(id);
      if (!pos) return;
      const price = Number(document.querySelector(`[data-sim-price="${id}"]`)?.value) || (pos.quote?.last ?? pos.avgCost);
      const shares = Number(document.querySelector(`[data-sim-shares="${id}"]`)?.value) || pos.shares;
      const resultEl = document.getElementById(`sim-result-${id}`);
      if (resultEl) resultEl.innerHTML = calcBuySim(pos, price, shares);
    };
    inp.addEventListener("input", update);
    document.querySelector(`[data-sim-shares="${id}"]`)?.addEventListener("input", update);
  });
  // Sell simulator - sell side
  els.content.querySelectorAll("[data-sell-price]").forEach((inp) => {
    const id = inp.dataset.sellPrice;
    const update = () => {
      const pos = getPositionById(id);
      if (!pos) return;
      const price = Number(document.querySelector(`[data-sell-price="${id}"]`)?.value) || (pos.quote?.last ?? pos.avgCost);
      const shares = Number(document.querySelector(`[data-sell-shares="${id}"]`)?.value) || 100;
      const resultEl = document.getElementById(`sell-sim-result-${id}`);
      if (resultEl) resultEl.innerHTML = calcSellSim(pos, price, shares);
    };
    inp.addEventListener("input", update);
    document.querySelector(`[data-sell-shares="${id}"]`)?.addEventListener("input", update);
  });
  // Buy quick-select buttons
  els.content.querySelectorAll("[data-sim-quick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.simQuick;
      const pos = getPositionById(id);
      if (!pos) return;
      const sharesEl = document.querySelector(`[data-sim-shares="${id}"]`);
      if (!sharesEl) return;
      let lots;
      if (btn.dataset.cash) {
        const cash = Number(btn.dataset.cash);
        const priceEl = document.querySelector(`[data-sim-price="${id}"]`);
        const price = Number(priceEl?.value) || (pos.quote?.last ?? pos.avgCost);
        lots = Math.max(100, Math.floor(cash / price / 100) * 100);
      } else {
        const fraction = Number(btn.dataset.fraction);
        lots = Math.max(100, Math.floor(pos.shares * fraction / 100) * 100);
      }
      sharesEl.value = lots;
      sharesEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  // Sell quick-select buttons
  els.content.querySelectorAll("[data-sell-quick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.sellQuick;
      const pos = getPositionById(id);
      if (!pos) return;
      const sharesEl = document.querySelector(`[data-sell-shares="${id}"]`);
      if (!sharesEl) return;
      let lots;
      if (btn.dataset.cash) {
        const cash = Number(btn.dataset.cash);
        const priceEl = document.querySelector(`[data-sell-price="${id}"]`);
        const price = Number(priceEl?.value) || (pos.quote?.last ?? pos.avgCost);
        lots = Math.max(100, Math.floor(cash / price / 100) * 100);
      } else {
        const fraction = Number(btn.dataset.fraction);
        lots = Math.max(100, Math.floor(pos.shares * fraction / 100) * 100);
      }
      sharesEl.value = lots;
      sharesEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  // Add rule
  els.content.querySelectorAll("[data-pos-add-rule]").forEach((b) =>
    b.addEventListener("click", () => openAddRuleDialog(b.dataset.posAddRule, b.dataset.kind))
  );
  // Toggle rule
  els.content.querySelectorAll("[data-rule-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const [pid, rid] = b.dataset.ruleToggle.split(":");
      const enabled = b.dataset.enabled !== "1";
      toggleRule(pid, rid, enabled);
    })
  );
  // Delete rule
  els.content.querySelectorAll("[data-rule-delete]").forEach((b) =>
    b.addEventListener("click", () => {
      const [pid, rid] = b.dataset.ruleDelete.split(":");
      deleteRule(pid, rid);
    })
  );
}

async function refreshPositions(force = false) {
  try {
    const url = force ? "/api/tabs/positions/refresh" : "/api/positions";
    const method = force ? "POST" : "GET";
    const { res, json } = await fetchJson(url, { method });
    if (!res.ok) throw new Error(json.error || "刷新失败");
    const snap = force ? json?.meta?.snapshot : json;
    if (!snap) return;
    setPositionsSnapshot(snap);
    if (state.active === "positions") { const sv = saveSimInputs(); renderPositions(snap); restoreSimInputs(sv); }
  } catch (err) {
    console.warn("[positions] refresh failed", err);
  }
}

function openPositionDialog(pos) {
  const dialog = document.querySelector("[data-add-position-dialog]");
  const form = dialog.querySelector("[data-add-position-form]");
  const titleEl = dialog.querySelector("h3");
  const submitBtn = dialog.querySelector("[type=submit]");
  const symbolInput = form.querySelector("[name=symbol]");
  const errorEl = dialog.querySelector("[data-form-error]");
  if (!dialog || !form) return;

  const isEdit = Boolean(pos);
  form.reset();
  errorEl.hidden = true;
  errorEl.textContent = "";
  if (isEdit) {
    titleEl.textContent = "修改仓位";
    submitBtn.textContent = "保存修改";
    symbolInput.value = pos.symbol;
    symbolInput.readOnly = true;
    form.querySelector("[name=shares]").value = pos.shares;
    form.querySelector("[name=avgCost]").value = pos.avgCost;
    if (pos.openedAt) form.querySelector("[name=openedAt]").value = pos.openedAt;
    if (pos.note) form.querySelector("[name=note]").value = pos.note;
    dialog.dataset.editId = pos.id;
  } else {
    titleEl.textContent = "加新仓位";
    submitBtn.textContent = "添加";
    symbolInput.readOnly = false;
    delete dialog.dataset.editId;
  }
  dialog.showModal();

  if (dialog.dataset.bound) return;
  dialog.dataset.bound = "1";

  dialog.querySelector("[data-add-position-cancel]")?.addEventListener("click", (e) => {
    e.preventDefault();
    dialog.close();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const editId = dialog.dataset.editId;
    errorEl.hidden = true;
    errorEl.textContent = "";
    const fd = new FormData(form);
    const payload = {
      shares: Number(fd.get("shares")),
      avgCost: Number(fd.get("avgCost")),
      openedAt: String(fd.get("openedAt") || "") || undefined,
      note: String(fd.get("note") || "") || undefined,
    };
    if (!editId) {
      const symbol = String(fd.get("symbol") || "").trim();
      if (!/^[0-9]{6}$/.test(symbol)) {
        errorEl.textContent = "股票代码必须是 6 位数字";
        errorEl.hidden = false;
        return;
      }
      payload.symbol = symbol;
    }
    if (!Number.isFinite(payload.shares) || payload.shares <= 0) {
      errorEl.textContent = "股数必须是正整数";
      errorEl.hidden = false;
      return;
    }
    if (!Number.isFinite(payload.avgCost) || payload.avgCost <= 0) {
      errorEl.textContent = "平均成本必须 > 0";
      errorEl.hidden = false;
      return;
    }
    try {
      if (editId) {
        await fetchJson(`/api/positions/${editId}`, { method: "PATCH", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
      } else {
        await fetchJson("/api/positions", { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
      }
      dialog.close();
      await refreshPositions(true);
    } catch (e) {
      errorEl.textContent = e.message || "保存失败";
      errorEl.hidden = false;
    }
  });
}

function openAddRuleDialog(positionId, kind) {
  const dialog = document.querySelector("[data-add-rule-dialog]");
  if (!dialog) return;
  const form = dialog.querySelector("[data-add-rule-form]");
  const title = dialog.querySelector("[data-rule-dialog-title]");
  const subtitle = dialog.querySelector("[data-rule-dialog-subtitle]");
  const inputLabel = dialog.querySelector("[data-rule-input-label]");
  const valueInput = form.elements["value"];
  const priceInput = form.elements["priceValue"];   // may be undefined if server HTML not yet updated
  const cooldownInput = form.elements["cooldownMin"];
  const hint = dialog.querySelector("[data-rule-input-hint]");
  const errorEl = dialog.querySelector("[data-rule-form-error]");
  const modeToggle = dialog.querySelector("[data-rule-mode-toggle]");
  const modeBtns = modeToggle?.querySelectorAll("[data-rule-mode]");
  const hasPriceInput = Boolean(priceInput);

  // Stash context on the dialog for the submit handler.
  dialog.dataset.positionId = positionId;
  dialog.dataset.kind = kind;

  // Pre-fill from snapshot for nicer hints (current price, target price).
  const snap = getPositionsSnapshot();
  const pos = snap?.positions.find((p) => p.id === positionId);
  const cost = pos?.avgCost ?? 0;
  const last = pos?.quote?.last;
  subtitle.textContent = pos
    ? `${pos.symbol} ${pos.name || ""} · 成本 ¥${fmtPrice(cost)}${last != null ? ` · 现价 ¥${fmtPrice(last)}` : ""}`
    : "";

  cooldownInput.value = "60";
  errorEl.hidden = true;
  errorEl.textContent = "";

  // Reset inputs and mode toggle.
  valueInput.value = "";
  valueInput.hidden = false;
  valueInput.required = true;
  if (hasPriceInput) {
    priceInput.value = "";
    priceInput.hidden = true;
    priceInput.required = false;
  }
  const isTpSl = kind === "take_profit" || kind === "stop_loss";
  const hasPriceMode = isTpSl || kind === "daily";
  if (modeToggle) modeToggle.hidden = !hasPriceMode;

  // Current active mode — "pct" or "price". Falls back to pct if the
  // price-input HTML hasn't been deployed yet (old server template).
  const getMode = () => {
    if (!hasPriceInput) return "pct";
    const active = modeToggle?.querySelector(".mode-btn.active");
    return active?.dataset.ruleMode || "pct";
  };
  const setMode = (m) => {
    const cost = pos?.avgCost ?? 0;
    for (const b of modeBtns || []) b.classList.toggle("active", b.dataset.ruleMode === m);
    if (m === "price" && hasPriceInput) {
      valueInput.hidden = true;
      valueInput.required = false;
      priceInput.hidden = false;
      priceInput.required = true;
      if (kind === "take_profit") priceInput.value = cost ? fmtPrice(cost * 1.05) : "";
      else if (kind === "stop_loss") priceInput.value = cost ? fmtPrice(cost * 0.93) : "";
      else if (kind === "daily") {
        const ref = pos?.quote?.last ?? cost;
        priceInput.value = ref ? fmtPrice(ref) : "";
      }
      updateHint();
      setTimeout(() => priceInput.select(), 0);
    } else {
      valueInput.hidden = false;
      valueInput.required = true;
      if (hasPriceInput) {
        priceInput.hidden = true;
        priceInput.required = false;
      }
      if (kind !== "daily") valueInput.min = "0.01";
      valueInput.value = kind === "take_profit" ? "5" : kind === "stop_loss" ? "7" : "-5";
      updateHint();
      setTimeout(() => valueInput.select(), 0);
    }
  };

  const updateHint = () => {
    const m = getMode();
    const cost = pos?.avgCost ?? 0;
    const prevClose = pos?.quote?.prevClose;
    if (kind === "daily") {
      if (m === "price" && hasPriceInput) {
        const p = Number(priceInput.value);
        if (!p || !prevClose) {
          hint.textContent = prevClose
            ? `输入触发价 · 昨日收盘 ¥${fmtPrice(prevClose)}`
            : `输入触发价 · 暂无昨收数据`;
        } else {
          const dailyPct = ((p - prevClose) / prevClose * 100);
          hint.textContent = `触发价 ¥${fmtPrice(p)} · 相当于当日 ${dailyPct >= 0 ? "+" : ""}${dailyPct.toFixed(2)}% · 现价穿越后只触发一次`;
        }
      } else {
        const v = Number(valueInput.value);
        if (!Number.isFinite(v) || v === 0) {
          hint.textContent = prevClose
            ? `例:输入 -5 → 昨日收盘 ¥${fmtPrice(prevClose)} · 跌 5% 触发价为 ¥${fmtPrice(prevClose * 0.95)}`
            : `例:输入 -5 · 负数下跌触发，正数上涨触发`;
        } else {
          hint.textContent = prevClose
            ? `当日 ${v >= 0 ? "+" : ""}${v}% · 昨收 ¥${fmtPrice(prevClose)} → 触发价 ¥${fmtPrice(prevClose * (1 + v / 100))}`
            : `当日 ${v >= 0 ? "+" : ""}${v}% 时触发`;
        }
      }
      return;
    }
    if (m === "price" && hasPriceInput) {
      const p = Number(priceInput.value);
      if (!p || !cost) {
        hint.textContent = kind === "take_profit"
          ? `输入高于成本价 (¥${fmtPrice(cost)}) 的触发价`
          : `输入低于成本价 (¥${fmtPrice(cost)}) 的触发价`;
      } else {
        const pct = ((p - cost) / cost * 100);
        hint.textContent = `触发价 ¥${fmtPrice(p)} · 相当于成本 ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · 现价穿越后只触发一次`;
      }
    } else {
      const v = Number(valueInput.value);
      if (!v || v <= 0 || !cost) {
        hint.textContent = kind === "take_profit"
          ? `例:输入 5 → 触发价 ¥${fmtPrice(cost * 1.05)} · 现价穿越后只触发一次,冷却时间内不重发`
          : `例:输入 7 → 触发价 ¥${fmtPrice(cost * 0.93)} · 现价跌破后只触发一次`;
      } else {
        const trigger = kind === "take_profit" ? cost * (1 + v / 100) : cost * (1 - v / 100);
        hint.textContent = `触发价 ¥${fmtPrice(trigger)} · 现价${kind === "take_profit" ? "穿越" : "跌破"}后只触发一次`;
      }
    }
  };

  if (kind === "take_profit") {
    title.textContent = "加止盈位";
    inputLabel.textContent = "止盈设置";
    setMode("pct");
  } else if (kind === "stop_loss") {
    title.textContent = "加止损位";
    inputLabel.textContent = "止损设置";
    setMode("pct");
  } else {
    // daily change pct — also supports price mode (absolute-price alert)
    title.textContent = "加当日涨跌阈值";
    inputLabel.textContent = "当日涨跌设置";
    setMode("pct"); // default to pct, resets stale state
    valueInput.removeAttribute("min");
  }

  // Mode toggle buttons
  for (const b of modeBtns || []) {
    b.onclick = () => setMode(b.dataset.ruleMode);
  }

  // Live hint update as user types (use oninput to auto-replace stale handlers)
  valueInput.oninput = updateHint;
  if (hasPriceInput) priceInput.oninput = updateHint;

  dialog.showModal();
  if (isTpSl) setTimeout(() => valueInput.select(), 0);

  if (dialog.dataset.bound) return;
  dialog.dataset.bound = "1";

  dialog.querySelector("[data-add-rule-cancel]")?.addEventListener("click", (e) => {
    e.preventDefault();
    dialog.close();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const fd = new FormData(form);
    const cooldownMin = Number(fd.get("cooldownMin")) || 60;
    const k = dialog.dataset.kind;
    const pid = dialog.dataset.positionId;
    const isTpSl = k === "take_profit" || k === "stop_loss";
    const hasPriceMode = isTpSl || k === "daily";
    // Fresh-query from DOM (NOT closure) — the toggle may not have existed
    // when the submit handler was first bound.
    const freshToggle = dialog.querySelector("[data-rule-mode-toggle]");
    const m = hasPriceMode
      ? (freshToggle?.querySelector(".mode-btn.active")?.dataset.ruleMode || "pct")
      : "pct";
    // Likewise fresh-query form elements — they may have been added later.
    const priceEl = form.elements["priceValue"];
    const valEl = form.elements["value"];
    // Re-derive cost from current snapshot at submit time.
    const snapNow = getPositionsSnapshot();
    const posNow = snapNow?.positions.find((p) => p.id === pid);
    const costNow = posNow?.avgCost ?? 0;

    let payload;
    if (k === "take_profit" || k === "stop_loss") {
      if (m === "price" && priceEl) {
        const price = Number(priceEl.value);
        if (!Number.isFinite(price) || price <= 0) {
          errorEl.textContent = "价格必须是正数";
          errorEl.hidden = false;
          return;
        }
        if (k === "take_profit" && price <= costNow) {
          errorEl.textContent = `止盈价必须高于成本 ¥${fmtPrice(costNow)}`;
          errorEl.hidden = false;
          return;
        }
        if (k === "stop_loss" && price >= costNow) {
          errorEl.textContent = `止损价必须低于成本 ¥${fmtPrice(costNow)}`;
          errorEl.hidden = false;
          return;
        }
        payload = { kind: "absolute", price, cooldownMin };
      } else {
        const value = Number(fd.get("value"));
        if (!Number.isFinite(value) || value <= 0) {
          errorEl.textContent = "百分比必须是大于 0 的数字";
          errorEl.hidden = false;
          return;
        }
        const pct = k === "take_profit" ? Math.abs(value) : -Math.abs(value);
        payload = { kind: "pct_from_cost", pct, cooldownMin };
      }
    } else {
      // daily
      if (m === "price" && priceEl) {
        const price = Number(priceEl.value);
        if (!Number.isFinite(price) || price <= 0) {
          errorEl.textContent = "价格必须是正数";
          errorEl.hidden = false;
          return;
        }
        payload = { kind: "absolute", price, cooldownMin };
      } else {
        const value = Number(fd.get("value"));
        if (!Number.isFinite(value)) {
          errorEl.textContent = "阈值必须是数字";
          errorEl.hidden = false;
          return;
        }
        if (value === 0) {
          errorEl.textContent = "阈值不能为 0";
          errorEl.hidden = false;
          return;
        }
        payload = { kind: "daily_change_pct", dailyPct: value, cooldownMin };
      }
    }
    payload.channels = positions.telegramReady ? ["browser", "telegram"] : ["browser"];
    try {
      await postJson(`/api/positions/${pid}/rules`, payload);
      dialog.close();
      await refreshPositions(false);
    } catch (e) {
      errorEl.textContent = e.message || "添加失败";
      errorEl.hidden = false;
    }
  });
}

async function toggleStar(positionId) {
  const snap = getPositionsSnapshot();
  const pos = snap?.positions.find((p) => p.id === positionId);
  if (!pos) return;
  await fetchJson(`/api/positions/${positionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ starred: !pos.starred }),
  });
  refreshPositions(false);
}

function toggleExpand(positionId) {
  if (positions.expanded.has(positionId)) positions.expanded.delete(positionId);
  else positions.expanded.add(positionId);
  // Pure client-side state — no fetch needed, just re-render.
  const saved = saveSimInputs();
  const snap = getPositionsSnapshot();
  if (snap) { renderPositions(snap); restoreSimInputs(saved); }
}

async function deletePosition(positionId) {
  if (!confirm("确认删除该仓位?")) return;
  // Optimistic UI: remove the row locally first so the user sees instant
  // feedback, then network call, then a non-forced refresh to update totals.
  const cached = getPositionsSnapshot();
  if (cached?.positions) {
    cached.positions = cached.positions.filter((p) => p.id !== positionId);
    cached.recentAlerts = (cached.recentAlerts || []).filter((a) => a.positionId !== positionId);
    // Recompute totals locally so the summary bar reflects the change too.
    const totals = cached.positions.reduce(
      (acc, p) => {
        acc.cost += p.shares * p.avgCost;
        acc.marketValue += p.marketValue ?? p.shares * p.avgCost;
        acc.todayPnL += p.todayPnL ?? 0;
        return acc;
      },
      { cost: 0, marketValue: 0, todayPnL: 0 },
    );
    cached.totals = {
      cost: totals.cost,
      marketValue: totals.marketValue,
      floatingPnL: totals.marketValue - totals.cost,
      floatingPnLPct: totals.cost ? ((totals.marketValue - totals.cost) / totals.cost) * 100 : 0,
      todayPnL: totals.todayPnL,
    };
    renderPositions(cached);
  }
  positions.expanded.delete(positionId);
  try {
    await fetchJson(`/api/positions/${positionId}`, { method: "DELETE" });
  } catch (e) {
    alert(`删除失败:${e.message}`);
  }
  // Quiet sync afterwards (no force; uses cached quote, fast).
  refreshPositions(false);
}

async function deleteRule(positionId, ruleId) {
  await fetchJson(`/api/positions/${positionId}/rules/${ruleId}`, { method: "DELETE" });
  refreshPositions(false);
}

async function toggleRule(positionId, ruleId, enabled) {
  await fetchJson(`/api/positions/${positionId}/rules/${ruleId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  refreshPositions(false);
}

async function postJson(url, body) {
  const { res, json } = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---- SSE stream ----

function ensurePositionsStream() {
  if (positions.sse) return;
  try {
    const es = new EventSource("/api/positions/stream");
    es.addEventListener("snapshot", (ev) => applySnapshot(JSON.parse(ev.data)));
    es.addEventListener("quotes", (ev) => applyQuotes(JSON.parse(ev.data)));
    es.addEventListener("alerts", (ev) => {
      const events = JSON.parse(ev.data);
      events.forEach(showBrowserNotification);
      const snap = getPositionsSnapshot();
      if (snap) {
        snap.recentAlerts = [...(snap.recentAlerts || []), ...events].slice(-50);
        if (state.active === "positions") { const sv = saveSimInputs(); renderPositions(snap); restoreSimInputs(sv); }
      }
    });
    es.addEventListener("error", () => {
      // Auto-reconnect handled by EventSource itself; do nothing.
    });
    // Full refresh every 5 min to pick up T4 data / announcements.
    positions.fullRefreshTimer = setInterval(() => {
      if (state.active === "positions") refreshPositions(false);
    }, 5 * 60_000);
    positions.sse = es;
  } catch (e) {
    console.warn("[positions] SSE not available", e);
  }
}

function saveSimInputs() {
  const vals = {};
  document.querySelectorAll("[data-sim-price]").forEach((inp) => {
    vals[inp.dataset.simPrice] = { price: inp.value, shares: document.querySelector(`[data-sim-shares="${inp.dataset.simPrice}"]`)?.value };
  });
  document.querySelectorAll("[data-sell-price]").forEach((inp) => {
    const key = "sell_" + inp.dataset.sellPrice;
    vals[key] = { price: inp.value, shares: document.querySelector(`[data-sell-shares="${inp.dataset.sellPrice}"]`)?.value };
  });
  return vals;
}
function restoreSimInputs(vals) {
  for (const [id, v] of Object.entries(vals)) {
    if (id.startsWith("sell_")) {
      const posId = id.slice(5);
      const priceEl = document.querySelector(`[data-sell-price="${posId}"]`);
      const sharesEl = document.querySelector(`[data-sell-shares="${posId}"]`);
      if (priceEl && v.price) priceEl.value = v.price;
      if (sharesEl && v.shares) sharesEl.value = v.shares;
      priceEl?.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const priceEl = document.querySelector(`[data-sim-price="${id}"]`);
      const sharesEl = document.querySelector(`[data-sim-shares="${id}"]`);
      if (priceEl && v.price) priceEl.value = v.price;
      if (sharesEl && v.shares) sharesEl.value = v.shares;
      priceEl?.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

function applyQuotes(quotes) {
  // Patch quotes into the in-memory snapshot — no HTTP call needed.
  const saved = saveSimInputs();
  const snap = getPositionsSnapshot();
  if (!snap || !snap.positions) return;
  const byQual = {};
  for (const q of quotes) byQual[q.qualified] = q;
  let totalMarket = 0, totalToday = 0;
  for (const p of snap.positions) {
    const q = byQual[p.exchange + p.symbol];
    if (!q) continue;
    p.quote = q;
    const cost = p.shares * p.avgCost;
    const mv = p.shares * q.last;
    p.marketValue = mv;
    p.floatingPnL = mv - cost;
    p.todayPnL = p.shares * (q.last - q.prevClose);
    p.pctFromCost = cost > 0 ? ((q.last - p.avgCost) / p.avgCost) * 100 : 0;
    // Update rungs.
    p.rungs = RUNG_PCTS_FRONT.map((pct) => {
      const price = p.avgCost * (1 + pct / 100);
      const reached = q.last > price ? "above" : q.last < price ? "below" : "at";
      return { pct, price, reached };
    });
    totalMarket += mv;
    totalToday += p.shares * (q.last - q.prevClose);
  }
  const totalCost = snap.totals.cost;
  snap.totals.marketValue = totalMarket;
  snap.totals.floatingPnL = totalMarket - totalCost;
  snap.totals.floatingPnLPct = totalCost > 0 ? ((totalMarket - totalCost) / totalCost) * 100 : 0;
  snap.totals.todayPnL = totalToday;
  if (state.active === "positions") { renderPositions(snap); restoreSimInputs(saved); }
}

function applySnapshot(snap) {
  setPositionsSnapshot(snap);
  if (state.active === "positions") { const sv = saveSimInputs(); renderPositions(snap); restoreSimInputs(sv); }
}

// ---- browser notifications ----

async function triggerTestPush() {
  const btn = els.content.querySelector("[data-pos-test-push]");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "推送中…";
  }
  try {
    const { res, json } = await fetchJson("/api/positions/test-push", { method: "POST" });
    if (res.ok && json.ok) {
      alert(`✅ 推送成功 — 已发到 chat_id ${json.chatIds?.join(", ") ?? "?"}`);
    } else {
      alert(`❌ 推送失败:${json.error || "unknown"}`);
    }
  } catch (e) {
    alert(`❌ 请求失败:${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "测试推送";
    }
  }
}

async function requestNotifPermission() {
  if (!("Notification" in window)) {
    alert("浏览器不支持通知 API");
    return;
  }
  if (Notification.permission === "granted") {
    positions.notifEnabled = true;
    refreshPositions(false);
    return;
  }
  const result = await Notification.requestPermission();
  positions.notifEnabled = result === "granted";
  refreshPositions(false);
}

function showBrowserNotification(event) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = `🔔 ${event.symbol} ${event.ruleLabel}`;
  const body = `${event.name || ""}  现价 ¥${event.currPrice?.toFixed(2)}  当日 ${(event.dailyChangePct ?? 0).toFixed(2)}%`;
  try {
    const notif = new Notification(title, { body, tag: `pos-${event.positionId}-${event.ruleId}` });
    notif.onclick = () => { window.focus(); notif.close(); };
  } catch (e) {
    console.warn("notification failed", e);
  }
}

// Initialize notifEnabled flag on load.
if ("Notification" in window) {
  positions.notifEnabled = Notification.permission === "granted";
}
