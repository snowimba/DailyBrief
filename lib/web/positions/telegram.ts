import fs from "node:fs";
import path from "node:path";

import type { AlertEvent } from "./types";
import type { ChannelDispatcher } from "./alert-engine";

/**
 * Telegram alert dispatcher.
 *
 * Token + chat IDs are sourced in this order:
 *   1) .env.local: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS (comma-separated)
 *   2) /root/.openclaw/openclaw.json: channels.telegram.botToken / allowFrom
 *
 * If neither is configured, send() returns ok=false with a "not configured"
 * error. The alert engine treats this as a delivery failure for that channel
 * but still tries the others (browser, log_only).
 *
 * Telegram API limits are 30 msg/sec global + 1 msg/sec per chat — way
 * below anything our use case can produce, so no client-side throttling.
 */

const OPENCLAW_CONFIG = "/root/.openclaw/openclaw.json";
const SEND_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;

interface TelegramConfig {
  token: string;
  chatIds: number[];
  source: "env" | "openclaw" | "mixed";
}

interface OpenClawConfig {
  channels?: {
    telegram?: {
      botToken?: string;
      allowFrom?: number[];
    };
  };
}

let cachedConfig: TelegramConfig | "missing" | null = null;

function loadOpenClawTelegram(): { token?: string; chatIds: number[] } {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, "utf8");
    const parsed = JSON.parse(raw) as OpenClawConfig;
    const t = parsed.channels?.telegram;
    return {
      token: t?.botToken,
      chatIds: t?.allowFrom?.filter((n) => Number.isFinite(n)) ?? [],
    };
  } catch {
    return { chatIds: [] };
  }
}

function loadConfig(): TelegramConfig | null {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChatIds = (process.env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  const oc = loadOpenClawTelegram();
  const token = envToken || oc.token;
  const chatIds = envChatIds.length ? envChatIds : oc.chatIds;
  if (!token || chatIds.length === 0) return null;
  return {
    token,
    chatIds,
    source: envToken && envChatIds.length ? "env" : envToken || envChatIds.length ? "mixed" : "openclaw",
  };
}

export function getTelegramConfig(): TelegramConfig | null {
  if (cachedConfig === "missing") return null;
  if (cachedConfig) return cachedConfig;
  const cfg = loadConfig();
  if (!cfg) {
    cachedConfig = "missing";
    return null;
  }
  cachedConfig = cfg;
  return cfg;
}

export function refreshTelegramConfig(): void {
  cachedConfig = null;
}

/** Escape MarkdownV2 special chars (Telegram is strict about these). */
function mdEscape(s: string): string {
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function formatBody(event: AlertEvent): string {
  const lines: string[] = [];
  lines.push(`🔔 *${mdEscape(event.symbol)} ${mdEscape(event.name || "")}* — ${mdEscape(event.ruleLabel)}`);
  lines.push(`现价 ¥${mdEscape(event.currPrice.toFixed(3).replace(/0+$/, "0"))}  (` +
    `${event.pctFromCost >= 0 ? "\\+" : ""}${mdEscape(event.pctFromCost.toFixed(2))}% vs 成本)`);
  lines.push(`当日 ${event.dailyChangePct >= 0 ? "\\+" : ""}${mdEscape(event.dailyChangePct.toFixed(2))}%`);
  if (event.kind === "absolute") {
    lines.push(`触发价 ¥${mdEscape(event.targetPrice.toFixed(3).replace(/0+$/, "0"))}`);
  }
  lines.push(`时间 ${mdEscape(event.ts.replace("T", " ").slice(0, 19))} UTC`);
  return lines.join("\n");
}

interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  description?: string;
  result?: T;
  parameters?: { retry_after?: number };
}

async function sendMessageOnce(
  token: string,
  chatId: number,
  text: string,
): Promise<{ ok: boolean; status: number; retryAfter?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as TelegramApiResponse;
    if (json.ok) return { ok: true, status: res.status };
    if (res.status === 429 && json.parameters?.retry_after) {
      return { ok: false, status: 429, retryAfter: json.parameters.retry_after };
    }
    return {
      ok: false,
      status: res.status,
      error: json.description ?? `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await sendMessageOnce(token, chatId, text);
    if (r.ok) return { ok: true };
    if (r.retryAfter) {
      await new Promise((res) => setTimeout(res, (r.retryAfter ?? 1) * 1000));
      continue;
    }
    if (r.status >= 500) {
      // Retry server-side errors with exponential backoff.
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      lastError = r.error;
      continue;
    }
    // 4xx (other than 429): don't retry, that's a client mistake.
    return { ok: false, error: r.error };
  }
  return { ok: false, error: lastError ?? "max retries exceeded" };
}

export const telegramDispatcher: ChannelDispatcher = {
  async send(event: AlertEvent) {
    const cfg = getTelegramConfig();
    if (!cfg) {
      return { ok: false, error: "Telegram 未配置(需要 OpenClaw 的 channels.telegram 或 .env.local 中的 TELEGRAM_BOT_TOKEN)" };
    }
    const text = formatBody(event);
    const start = Date.now();
    const results = await Promise.all(
      cfg.chatIds.map((id) => sendMessage(cfg.token, id, text)),
    );
    const latencyMs = Date.now() - start;
    const allOk = results.every((r) => r.ok);
    if (allOk) return { ok: true, latencyMs };
    const firstErr = results.find((r) => !r.ok)?.error ?? "unknown";
    return { ok: false, latencyMs, error: firstErr };
  },
};

/** Used by the 测试推送 button to verify wiring without an actual alert. */
export async function sendTestMessage(): Promise<{ ok: boolean; error?: string; chatIds: number[] }> {
  const cfg = getTelegramConfig();
  if (!cfg) {
    return { ok: false, error: "Telegram 未配置", chatIds: [] };
  }
  const text =
    `🧪 *DailyBrief 盯盘助手* — 测试推送\n` +
    `如果你看到这条消息,说明 Telegram 推送链路正常。\n` +
    `时间 ${mdEscape(new Date().toISOString().replace("T", " ").slice(0, 19))} UTC`;
  const results = await Promise.all(
    cfg.chatIds.map((id) => sendMessage(cfg.token, id, text)),
  );
  const allOk = results.every((r) => r.ok);
  if (allOk) return { ok: true, chatIds: cfg.chatIds };
  const firstErr = results.find((r) => !r.ok)?.error ?? "unknown";
  return { ok: false, error: firstErr, chatIds: cfg.chatIds };
}
