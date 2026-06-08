import "./_env";

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { getProvider, getProviders } from "../lib/web/providers";
import { bjIso } from "../lib/utils";
import { latestState } from "../lib/web/state-store";
import {
  buildSnapshot,
  registerSseClient,
  startPositionsDaemon,
} from "../lib/web/positions/provider";
import {
  addPosition,
  addRule,
  deletePosition,
  deleteRule,
  loadPositions,
  patchPosition,
  toggleRule,
} from "../lib/web/positions/store";
import { fetchQuotes, qualified } from "../lib/web/positions/quote-source";
import { sendTestMessage } from "../lib/web/positions/telegram";
import type { RefreshResult } from "../lib/web/types";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const activeRefreshes = new Map<string, Promise<RefreshResult>>();

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function contentType(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DailyBrief Web</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="kicker">DailyBrief Web</p>
        <h1>每日简报</h1>
      </div>
      <div class="actions">
        <button class="refresh-button" data-refresh>刷新</button>
        <span class="status" data-status>启动中</span>
      </div>
    </header>

    <div class="layout">
      <nav class="side-nav" data-tabs aria-label="日报分类"></nav>
      <section class="content-panel">
        <header class="panel-head">
          <div class="panel-head-row">
            <div class="panel-head-text">
              <h2 data-title>载入中</h2>
              <p class="summary" data-summary></p>
            </div>
            <div class="history-control" data-history-wrap hidden>
              <label for="history-select">历史日期</label>
              <select id="history-select" data-history></select>
            </div>
          </div>
          <div class="meta-row" data-meta></div>
        </header>
        <div class="tab-content" data-content></div>
      </section>
    </div>
  </main>

  <dialog class="pos-dialog" data-add-position-dialog>
    <form method="dialog" data-add-position-form>
      <h3>加新仓位</h3>
      <div class="form-grid">
        <label>
          股票代码
          <input name="symbol" required pattern="[0-9]{6}" placeholder="例:600519" inputmode="numeric" autofocus>
          <small>6 位数字。沪市 6/9 开头,深市 0/2/3 开头,北交所 4/8。</small>
        </label>
        <label>
          持有股数
          <input name="shares" type="number" min="1" step="1" required placeholder="100">
        </label>
        <label>
          平均成本(元)
          <input name="avgCost" type="number" min="0.001" step="0.001" required placeholder="例 1300.00 / ETF 可到 0.001">
        </label>
        <label>
          建仓日期(可空)
          <input name="openedAt" type="date">
          <small>用于显示持有天数。</small>
        </label>
        <label class="span-2">
          备注(可空)
          <textarea name="note" rows="2" placeholder="策略 / 风险点 / 计划"></textarea>
        </label>
      </div>
      <p class="form-error" data-form-error hidden></p>
      <div class="form-actions">
        <button type="button" class="link-btn" data-add-position-cancel>取消</button>
        <button type="submit" class="primary-btn">添加</button>
      </div>
    </form>
  </dialog>

  <dialog class="pos-dialog" data-add-rule-dialog>
    <form method="dialog" data-add-rule-form>
      <h3 data-rule-dialog-title>加止盈位</h3>
      <p class="dialog-subtitle muted" data-rule-dialog-subtitle></p>
      <div class="form-grid">
        <label class="span-2">
          <span data-rule-input-label>止盈百分比</span>
          <div class="rule-mode-toggle" data-rule-mode-toggle hidden>
            <button type="button" class="mode-btn active" data-rule-mode="pct">百分比</button>
            <button type="button" class="mode-btn" data-rule-mode="price">价格</button>
          </div>
          <input name="value" type="number" step="0.01" required autofocus>
          <input name="priceValue" type="number" step="0.001" min="0.001" hidden>
          <small data-rule-input-hint></small>
        </label>
        <label>
          冷却时间(分钟)
          <input name="cooldownMin" type="number" min="1" step="1" value="60">
          <small>同条规则触发后多久内不再重发</small>
        </label>
      </div>
      <p class="form-error" data-rule-form-error hidden></p>
      <div class="form-actions">
        <button type="button" class="link-btn" data-add-rule-cancel>取消</button>
        <button type="submit" class="primary-btn">添加</button>
      </div>
    </form>
  </dialog>
  <script src="/assets/app.js"></script>
</body>
</html>`;
}

async function handleTabs(res: http.ServerResponse): Promise<void> {
  const tabs = await Promise.all(
    getProviders().map(async (provider) => {
      const state = await latestState<RefreshResult>(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        description: provider.description,
        refreshLabel: provider.refreshLabel,
        cached: Boolean(state),
        cachedDate: state?.date,
        cachedAt: state?.refreshedAt,
      };
    }),
  );
  sendJson(res, 200, { tabs });
}

async function loadTab(
  id: string,
  res: http.ServerResponse,
  date?: string,
): Promise<void> {
  const provider = getProvider(id);
  if (!provider) {
    sendJson(res, 404, { error: `unknown tab: ${id}` });
    return;
  }
  // Specific date: bypass the cache, ask the provider directly.
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { error: `invalid date: ${date}` });
      return;
    }
    if (!provider.loadDate) {
      sendJson(res, 400, { error: `${provider.label} 不支持按日期查询` });
      return;
    }
    const result = await provider.loadDate(date);
    if (!result) {
      sendJson(res, 404, { error: `${provider.label} 没有 ${date} 的数据` });
      return;
    }
    sendJson(res, 200, result);
    return;
  }
  const cached = await latestState<RefreshResult>(provider.id);
  const latest = await provider.loadLatest();
  // Use whichever is newer (scheduled runs may have produced a fresher report
  // than what's in the web_state cache).
  const result = (!cached || (latest && latest.date > cached.date)) ? latest : cached;
  if (!result) {
    sendJson(res, 404, { error: `${provider.label} 暂无可用数据` });
    return;
  }
  sendJson(res, 200, result);
}

async function historyTab(id: string, res: http.ServerResponse): Promise<void> {
  const provider = getProvider(id);
  if (!provider) {
    sendJson(res, 404, { error: `unknown tab: ${id}` });
    return;
  }
  if (!provider.listDates) {
    sendJson(res, 200, { dates: [] });
    return;
  }
  const dates = await provider.listDates();
  sendJson(res, 200, { dates });
}

// Store active refresh promises and their results, keyed by tab id.
const refreshState = new Map<string, { promise: Promise<unknown>; result?: RefreshResult; error?: string }>();

function refreshStatus(id: string): "idle" | "running" | "done" | "error" {
  const s = refreshState.get(id);
  if (!s) return "idle";
  if (s.result) return "done";
  if (s.error) return "error";
  return "running";
}

async function refreshTab(id: string, res: http.ServerResponse): Promise<void> {
  const provider = getProvider(id);
  if (!provider) {
    sendJson(res, 404, { error: `unknown tab: ${id}` });
    return;
  }
  const status = refreshStatus(id);
  if (status === "running") {
    sendJson(res, 202, { status: "running", message: `${provider.label} 正在刷新中…` });
    return;
  }
  if (status === "done") {
    const result = refreshState.get(id)!.result!;
    sendJson(res, 200, result);
    refreshState.delete(id); // consume the result once
    return;
  }
  if (status === "error") {
    const err = refreshState.get(id)!.error!;
    refreshState.delete(id);
    sendJson(res, 500, { error: err });
    return;
  }
  // status === "idle" — start a new refresh.
  const entry = { promise: null as unknown as Promise<unknown> };
  const promise = provider.refresh()
    .then((result) => { entry.result = result; })
    .catch((e) => { entry.error = e instanceof Error ? e.message : String(e); });
  entry.promise = promise;
  refreshState.set(provider.id, entry);
  // Clean up after 20 min (in case frontend never collects).
  setTimeout(() => { if (refreshState.get(provider.id) === entry) refreshState.delete(provider.id); }, 20 * 60_000);
  sendJson(res, 202, { status: "started", message: `${provider.label} 刷新已启动，预计 5-8 分钟完成。` });
}

async function handleAsset(asset: string, res: http.ServerResponse): Promise<void> {
  const file = path.join(process.cwd(), "web", asset);
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

// ----- positions API -----

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e instanceof Error ? e.message : e}`));
      }
    });
    req.on("error", reject);
  });
}

async function positionsHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const m = p.match(/^\/api\/positions(?:\/([^/]+)(?:\/(rules)(?:\/([^/]+))?)?)?$/);
  // Order matters; check leaf paths first.
  if (req.method === "GET" && p === "/api/positions") {
    const snap = await buildSnapshot();
    sendJson(res, 200, snap);
    return true;
  }
  if (req.method === "GET" && p === "/api/positions/quotes") {
    const symbols = (url.searchParams.get("symbols") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (symbols.length === 0) {
      sendJson(res, 400, { error: "symbols param required" });
      return true;
    }
    const quals = symbols.map((s) => {
      const c = s[0];
      const exch = c === "6" || c === "9" ? "sh" : c === "4" || c === "8" ? "bj" : "sz";
      return qualified(s, exch);
    });
    const quotes = await fetchQuotes(quals);
    sendJson(res, 200, { quotes });
    return true;
  }
  if (req.method === "GET" && p === "/api/positions/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    write("hello", { ts: bjIso() });
    const dispose = registerSseClient(write);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      dispose();
      res.end();
    });
    return true;
  }
  if (req.method === "POST" && p === "/api/positions/test-push") {
    const result = await sendTestMessage();
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }
  if (req.method === "POST" && p === "/api/positions") {
    const body = await readJsonBody(req);
    try {
      const created = await addPosition(body as never);
      sendJson(res, 201, created);
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  if (m && m[1] && !m[2]) {
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      try {
        const updated = await patchPosition(m[1], body as never);
        sendJson(res, 200, updated);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (req.method === "DELETE") {
      await deletePosition(m[1]);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  if (m && m[1] && m[2] === "rules") {
    if (req.method === "POST" && !m[3]) {
      const body = await readJsonBody(req);
      try {
        const rule = await addRule(m[1], body as never);
        sendJson(res, 201, rule);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (m[3] && req.method === "DELETE") {
      await deleteRule(m[1], m[3]);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (m[3] && req.method === "PATCH") {
      const body = await readJsonBody(req);
      const enabled = Boolean((body as { enabled?: boolean }).enabled);
      await toggleRule(m[1], m[3], enabled);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  return false;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, dashboardHtml());
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    await handleAsset(url.pathname.slice("/assets/".length), res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/tabs") {
    await handleTabs(res);
    return;
  }
  if (url.pathname.startsWith("/api/positions")) {
    const handled = await positionsHandler(req, res, url);
    if (handled) return;
  }
  const tabMatch = url.pathname.match(/^\/api\/tabs\/([^/]+)(\/refresh|\/history)?$/);
  if (tabMatch && req.method === "GET" && !tabMatch[2]) {
    const dateParam = url.searchParams.get("date") ?? undefined;
    await loadTab(tabMatch[1], res, dateParam);
    return;
  }
  if (tabMatch && req.method === "GET" && tabMatch[2] === "/history") {
    await historyTab(tabMatch[1], res);
    return;
  }
  if (tabMatch && req.method === "GET" && tabMatch[2] === "/refresh") {
    // Poll refresh status without starting a new one.
    const status = refreshStatus(tabMatch[1]);
    if (status === "done") {
      const result = refreshState.get(tabMatch[1])!.result!;
      refreshState.delete(tabMatch[1]);
      sendJson(res, 200, result);
    } else if (status === "error") {
      const err = refreshState.get(tabMatch[1])!.error!;
      refreshState.delete(tabMatch[1]);
      sendJson(res, 500, { error: err });
    } else {
      sendJson(res, 202, { status });
    }
    return;
  }
  if (tabMatch && req.method === "POST" && tabMatch[2] === "/refresh") {
    await refreshTab(tabMatch[1], res);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

const port = Number(argValue("--port") ?? process.env.WEB_PORT ?? DEFAULT_PORT);
const host = argValue("--host") ?? process.env.WEB_HOST ?? DEFAULT_HOST;

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
});

server.listen(port, host, () => {
  console.log(`[web] DailyBrief Web listening at http://${host}:${port}/`);
  startPositionsDaemon();
  console.log(`[web] positions tick loop started (5s trading / 60s off-hours)`);
});
