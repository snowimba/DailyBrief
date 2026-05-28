# DailyBrief Refreshable Web Dashboard Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Convert DailyBrief from a static-only HTML generator into a small local refreshable web dashboard, with separate tabs that can refresh independently and a new A股日报 tab sourced from the existing `/data/SilverM-quant` stock-selection workflow.

**Architecture:** Keep the existing static report pipeline intact, then add a minimal Node HTTP server plus a small browser UI. Each tab is backed by a named data provider that can read the latest successful data from disk and optionally run a refresh command. Refreshes write into a per-day `state/<YYYY-MM-DD>/<tab>.json` file atomically, so each day keeps only the last successful result for each tab.

**Tech Stack:** Existing Node/TypeScript (`tsx`) plus Node built-ins (`http`, `child_process`, `fs`). No Next/Vite/React initially; use hand-written HTML/CSS/JS to stay aligned with the current project. Optional future upgrade to a framework can be considered after the data/provider model stabilizes.

---

## Requirements Restatement

1. Expose DailyBrief as a local Web dashboard instead of only generated static HTML files.
2. Keep tabs for the current DailyBrief content.
3. Add one separate tab for the A股股票日报.
4. Every tab can be refreshed independently from the browser.
5. Historical state should not accumulate multiple refresh versions: for each date and tab, keep only the latest successful data.
6. The project should be easy to extend later with more data tabs and changes to existing data.

## Key Design Decisions

### 1. Split “data refresh” from “presentation”

Current `npm run daily` fetches, enriches, and renders a complete HTML document. For a refreshable dashboard we should not treat the full HTML as the only source of truth. Instead:

- Existing DailyBrief tab initially displays the latest generated HTML inside an iframe or HTML container.
- A股 tab displays markdown converted to HTML, plus metadata from the workflow JSON.
- Future tabs should implement the same provider interface.

### 2. Provider interface

Create a provider registry:

```ts
export type TabId = "daily" | "stocks";

export interface RefreshResult {
  tabId: TabId;
  date: string;
  ok: true;
  refreshedAt: string;
  title: string;
  html: string;
  summary?: string;
  sourceFiles?: string[];
  meta?: Record<string, unknown>;
}

export interface TabProvider {
  id: TabId;
  label: string;
  description: string;
  loadLatest(): Promise<RefreshResult | null>;
  refresh(): Promise<RefreshResult>;
}
```

### 3. Per-day latest-success persistence

Use:

```text
web_state/
  2026-05-27/
    daily.json
    stocks.json
    manifest.json
```

Rules:

- Write to `*.tmp` first, then rename to final JSON.
- Failed refresh must not overwrite prior success.
- If the same tab refreshes five times today, `web_state/2026-05-27/<tab>.json` is overwritten five times; only the last successful data remains.
- `manifest.json` records tab statuses and update times for the UI.

### 4. Recommended endpoints

```text
GET  /                         dashboard shell
GET  /assets/app.js             browser JS
GET  /api/tabs                  tab list + latest status
GET  /api/tabs/:tabId           latest successful data for a tab
POST /api/tabs/:tabId/refresh   trigger one tab refresh
```

Refresh responses should be synchronous for the first version because current operations are short enough for local use, except `daily` full LLM refresh may take several minutes. The browser should show a spinner and keep the request open. Later we can add job IDs and polling.

### 5. Refresh behavior by tab

#### `daily` tab

- `loadLatest()` reads latest `daily_reports/<date>/<date>.html` and wraps it as tab content.
- `refresh()` runs `npm run daily`, then reads the newly generated report.
- Because `npm run daily` is expensive, the UI button text should say “刷新新闻日报（约 5-8 分钟）”.

#### `stocks` tab

- `loadLatest()` reads latest `/data/SilverM-quant/reports/stock_selection/<date>-astock.md` and corresponding JSON if present.
- `refresh()` runs:

```bash
/root/.hermes/scripts/stock_selection_workflow.sh
```

or directly:

```bash
/data/SilverM-quant/.venv/bin/python -m selection.run_selection_workflow --top 3 --holdings 600999 --skip-8501
```

- Render markdown tables and headings into safe HTML using a minimal markdown renderer initially; later can add a dependency like `marked` if needed.

## Implementation Tasks

### Task 1: Add web-server scripts to package.json

**Objective:** Add commands to run the local dashboard.

**Files:**
- Modify: `package.json`

**Change:**

Add scripts:

```json
"web": "tsx scripts/web-server.ts",
"web:dev": "tsx watch scripts/web-server.ts"
```

**Verification:**

Run:

```bash
npm run web -- --help
```

Expected: server script prints usage or starts without TypeScript errors once Task 5 is complete.

---

### Task 2: Create atomic state store helper

**Objective:** Provide safe read/write helpers for per-day latest-success JSON.

**Files:**
- Create: `lib/web/state-store.ts`

**Implementation sketch:**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { todayKey } from "../utils";

export const WEB_STATE_DIR = "web_state";

export async function statePath(tabId: string, date = todayKey()): Promise<string> {
  return path.join(WEB_STATE_DIR, date, `${tabId}.json`);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
```

**Verification:**

Add or run a simple `npx tsx -e` script that writes then reads `web_state/test/foo.json`.

---

### Task 3: Add provider types and registry

**Objective:** Define the extension point for current and future tabs.

**Files:**
- Create: `lib/web/types.ts`
- Create: `lib/web/providers/index.ts`

**Implementation sketch:**

```ts
export type TabId = "daily" | "stocks";

export interface RefreshResult {
  tabId: TabId;
  date: string;
  ok: true;
  refreshedAt: string;
  title: string;
  html: string;
  summary?: string;
  sourceFiles?: string[];
  meta?: Record<string, unknown>;
}

export interface TabProvider {
  id: TabId;
  label: string;
  description: string;
  loadLatest(): Promise<RefreshResult | null>;
  refresh(): Promise<RefreshResult>;
}
```

`providers/index.ts` should export `getProviders()` and `getProvider(id)`.

**Verification:**

`npx tsc --noEmit` passes.

---

### Task 4: Implement command runner helper

**Objective:** Safely run long refresh commands with timeout and captured logs.

**Files:**
- Create: `lib/web/run-command.ts`

**Implementation notes:**

- Use `spawn(command, args, { cwd, shell: process.platform === "win32" })`.
- Capture stdout/stderr into string with max length guard, e.g. last 200 KB.
- Use timeouts:
  - `daily`: 15 minutes
  - `stocks`: 5 minutes for `--skip-8501`
- Throw error with command, exit code, and tail logs.

**Verification:**

Run:

```bash
npx tsx -e "import { runCommand } from './lib/web/run-command'; runCommand('node',['-e','console.log(123)'],{cwd:process.cwd(),timeoutMs:5000}).then(r=>console.log(r.stdout.trim()))"
```

Expected: prints `123`.

---

### Task 5: Implement DailyBrief provider

**Objective:** Load and refresh existing news/market DailyBrief HTML.

**Files:**
- Create: `lib/web/providers/daily-provider.ts`

**Implementation details:**

- `findLatestReport()` scans `daily_reports/<YYYY-MM-DD>/<YYYY-MM-DD>.html` newest first.
- `loadLatest()` reads that HTML and returns a `RefreshResult`.
- `refresh()` runs `npm run daily`, then calls `loadLatest()`, writes `web_state/<date>/daily.json`, and returns the result.
- Add a small wrapper around the full document HTML so it can render cleanly inside the dashboard tab. For v1, use iframe `srcdoc` in the client instead of injecting arbitrary full HTML into a div.

**Acceptance criteria:**

- Without refreshing, the dashboard can show the last generated 2026-05-27 report.
- Refresh only overwrites `web_state/<today>/daily.json` after success.

---

### Task 6: Implement stock provider

**Objective:** Load and refresh the A股 stock-selection daily report.

**Files:**
- Create: `lib/web/providers/stocks-provider.ts`
- Create: `lib/web/markdown.ts`

**Implementation details:**

- Latest report path pattern:

```text
/data/SilverM-quant/reports/stock_selection/<YYYY-MM-DD>-astock.md
/data/SilverM-quant/reports/stock_selection/<YYYY-MM-DD>-astock.json
```

- `loadLatest()` finds newest markdown file, converts markdown to HTML, and reads JSON metadata if present.
- `refresh()` runs `/root/.hermes/scripts/stock_selection_workflow.sh`, then loads latest again and writes `web_state/<date>/stocks.json`.
- Minimal markdown renderer should support:
  - `#`, `##`, `###`
  - paragraphs
  - bullet lists
  - markdown tables
  - inline backticks
  - HTML escaping

**Acceptance criteria:**

- Stock tab shows the latest `/data/SilverM-quant/reports/stock_selection/2026-05-26-astock.md` content.
- Refreshing stock tab does not run the news DailyBrief pipeline.

---

### Task 7: Implement HTTP server

**Objective:** Serve dashboard HTML and API endpoints.

**Files:**
- Create: `scripts/web-server.ts`
- Create: `lib/web/http.ts` if helpers become useful

**Server behavior:**

- Port defaults to `4173`, override via `WEB_PORT` or `--port`.
- `GET /` returns dashboard shell.
- `GET /assets/app.js` returns client JS.
- `GET /api/tabs` returns provider metadata + whether cached state exists.
- `GET /api/tabs/:id` returns latest `RefreshResult` from state if present, otherwise provider `loadLatest()`.
- `POST /api/tabs/:id/refresh` runs exactly that provider's `refresh()`.
- Prevent concurrent refresh of the same tab with an in-memory lock:

```ts
const activeRefreshes = new Map<string, Promise<RefreshResult>>();
```

**Acceptance criteria:**

```bash
npm run web
curl http://127.0.0.1:4173/api/tabs
curl http://127.0.0.1:4173/api/tabs/stocks
curl -X POST http://127.0.0.1:4173/api/tabs/stocks/refresh
```

all behave as expected.

---

### Task 8: Implement browser dashboard UI

**Objective:** Provide tabbed UI with independent refresh buttons.

**Files:**
- Create: `web/app.js`
- Create: `web/styles.css` or inline CSS in server shell

**UI behavior:**

- Top nav tabs:
  - `综合日报`
  - `A股日报`
- Each tab has:
  - last refreshed timestamp
  - source date
  - refresh button
  - status text / error display
  - content area
- Clicking a tab loads only that tab data.
- Clicking refresh calls only `/api/tabs/<tab>/refresh`.
- Disable the tab's refresh button while its refresh is running.
- Other tabs remain usable while one tab refreshes.

**Acceptance criteria:**

Use browser or curl. Confirm refreshing stocks does not touch `daily_reports/<today>` and refreshing daily does not touch stock report files except dashboard state.

---

### Task 9: Add build-site compatibility option

**Objective:** Keep the existing static publishing path working.

**Files:**
- Modify: `scripts/build-site.mjs` only if needed

**Decision:** Do not replace current static build in v1. The web server is local-refreshable; static `daily_reports/index.html` remains a plain latest report for Pages/nginx.

Optional later: add `npm run web:export` that writes the dashboard shell into `daily_reports/dashboard.html`, but refresh buttons cannot work on a purely static host unless wired to a server.

---

### Task 10: Register or document runtime

**Objective:** Make it obvious how to run the dashboard.

**Files:**
- Modify: `README.md`
- Optional create: `docs/web-dashboard.md`

**Docs include:**

```bash
cd /data/DailyBrief
npm run web -- --host 127.0.0.1 --port 4173
```

Then open:

```text
http://127.0.0.1:4173/
```

If exposing publicly, put behind nginx and auth; refresh endpoints can trigger paid LLM calls and local stock workflows.

---

## Testing Matrix

### Static checks

```bash
npx tsc --noEmit
npm run sources:check
```

### Existing functionality

```bash
REPORT_TZ=Asia/Shanghai npm run dry-run
npm run render 2026-05-27
```

### Web API

```bash
npm run web
curl -s http://127.0.0.1:4173/api/tabs | jq
curl -s http://127.0.0.1:4173/api/tabs/daily | jq '.title,.date,.refreshedAt'
curl -s http://127.0.0.1:4173/api/tabs/stocks | jq '.title,.date,.refreshedAt'
```

### Refresh endpoints

```bash
curl -X POST http://127.0.0.1:4173/api/tabs/stocks/refresh
curl -X POST http://127.0.0.1:4173/api/tabs/daily/refresh
```

Expected:

- Stocks refresh updates only `web_state/<today>/stocks.json` plus SilverM report output.
- Daily refresh updates only `web_state/<today>/daily.json` plus DailyBrief report output.
- Failed refresh returns non-2xx JSON error and does not overwrite the previous `web_state` success file.

## Security / Operations Notes

1. Bind to `127.0.0.1` by default. Refresh endpoints can spend API quota and trigger local workflows.
2. If exposed through nginx, require basic auth or VPN-only access.
3. Log refresh command output to `logs/web-refresh-<tab>-<date>.log` for debugging.
4. Do not store API keys in state JSON or client responses.
5. Keep `.env.local` gitignored.

## Future Extension Pattern

To add a new tab later:

1. Add a provider file under `lib/web/providers/<new>-provider.ts`.
2. Add its ID to `TabId`.
3. Register it in `lib/web/providers/index.ts`.
4. The UI automatically picks it up from `/api/tabs`.

This lets future data sources be added without rewriting the dashboard shell.
