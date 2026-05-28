import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { bjIso } from "../../utils";
import type {
  AlertRule,
  AlertStateEntry,
  Exchange,
  NewPositionInput,
  NewRuleInput,
  PatchPositionInput,
  Position,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const POSITIONS_FILE = path.join(DATA_DIR, "positions.json");
const ALERT_STATE_FILE = path.join(DATA_DIR, "alert-state.json");

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return fallback;
    }
    throw e;
  }
}

export function inferExchange(symbol: string): Exchange {
  // A-share rules:
  //   6 / 9 → sh; 0 / 3 / 2 → sz; 4 / 8 → bj (selected new boards / 北交所).
  // Heuristic, mirrors what Sina/Tencent expects in the qualified prefix.
  const c = symbol[0];
  if (c === "6" || c === "9") return "sh";
  if (c === "4" || c === "8") return "bj";
  return "sz";
}

export function qualifiedSymbol(symbol: string, exchange: Exchange): string {
  return `${exchange}${symbol}`;
}

function normalizeSymbol(input: string): string {
  // Accept "600519", "sh600519", "600519.SH", "SH.600519" — return 6 digits.
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 6) {
    throw new Error(`invalid A-share symbol: ${input}`);
  }
  return digits;
}

// ---- positions ----

export async function loadPositions(): Promise<Position[]> {
  return readJsonOr<Position[]>(POSITIONS_FILE, []);
}

export async function savePositions(list: Position[]): Promise<void> {
  await writeJsonAtomic(POSITIONS_FILE, list);
}

export async function addPosition(input: NewPositionInput): Promise<Position> {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = inferExchange(symbol);
  if (!Number.isFinite(input.shares) || input.shares <= 0) {
    throw new Error("shares must be a positive number");
  }
  if (!Number.isFinite(input.avgCost) || input.avgCost <= 0) {
    throw new Error("avgCost must be a positive number");
  }
  const now = bjIso();
  const pos: Position = {
    id: randomUUID(),
    symbol,
    exchange,
    shares: input.shares,
    avgCost: input.avgCost,
    openedAt: input.openedAt,
    note: input.note,
    alertRules: [],
    createdAt: now,
    updatedAt: now,
  };
  const list = await loadPositions();
  // Prevent duplicate symbol entries — merge instead by erroring out so the
  // user notices and edits the existing one. They can always delete first.
  if (list.some((p) => p.symbol === symbol)) {
    throw new Error(`already tracking ${symbol}; edit the existing row instead`);
  }
  list.push(pos);
  await savePositions(list);
  return pos;
}

export async function patchPosition(
  id: string,
  patch: PatchPositionInput,
): Promise<Position> {
  const list = await loadPositions();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`unknown position: ${id}`);
  const next: Position = { ...list[idx], ...patch, updatedAt: bjIso() };
  if (next.shares !== undefined && (!Number.isFinite(next.shares) || next.shares <= 0)) {
    throw new Error("shares must be a positive number");
  }
  if (next.avgCost !== undefined && (!Number.isFinite(next.avgCost) || next.avgCost <= 0)) {
    throw new Error("avgCost must be a positive number");
  }
  list[idx] = next;
  await savePositions(list);
  return next;
}

export async function deletePosition(id: string): Promise<void> {
  const list = await loadPositions();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return;
  list.splice(idx, 1);
  await savePositions(list);
}

// ---- rules ----

function ruleLabelFromInput(input: NewRuleInput): string {
  if (input.label) return input.label;
  if (input.kind === "pct_from_cost" && input.pct !== undefined) {
    const sign = input.pct > 0 ? "+" : "";
    const what = input.pct > 0 ? "止盈位" : "止损位";
    return `${sign}${input.pct}% ${what}`;
  }
  if (input.kind === "absolute" && input.price !== undefined) {
    return `绝对价 ¥${input.price}`;
  }
  if (input.kind === "daily_change_pct" && input.dailyPct !== undefined) {
    const sign = input.dailyPct > 0 ? "+" : "";
    return `当日 ${sign}${input.dailyPct}%`;
  }
  return "规则";
}

function defaultTrigger(input: NewRuleInput): "cross_up" | "cross_down" | "any" {
  if (input.trigger) return input.trigger;
  if (input.kind === "pct_from_cost" && input.pct !== undefined) {
    return input.pct > 0 ? "cross_up" : "cross_down";
  }
  if (input.kind === "daily_change_pct" && input.dailyPct !== undefined) {
    return input.dailyPct > 0 ? "cross_up" : "cross_down";
  }
  return "any";
}

export async function addRule(positionId: string, input: NewRuleInput): Promise<AlertRule> {
  // Validate: exactly one of pct / price / dailyPct must be set per kind.
  if (input.kind === "pct_from_cost" && (input.pct === undefined || !Number.isFinite(input.pct))) {
    throw new Error("pct is required for pct_from_cost rule");
  }
  if (input.kind === "absolute" && (input.price === undefined || !Number.isFinite(input.price) || input.price <= 0)) {
    throw new Error("price (>0) is required for absolute rule");
  }
  if (input.kind === "daily_change_pct" && (input.dailyPct === undefined || !Number.isFinite(input.dailyPct))) {
    throw new Error("dailyPct is required for daily_change_pct rule");
  }
  const list = await loadPositions();
  const idx = list.findIndex((p) => p.id === positionId);
  if (idx < 0) throw new Error(`unknown position: ${positionId}`);
  const rule: AlertRule = {
    id: randomUUID(),
    kind: input.kind,
    pct: input.pct,
    price: input.price,
    dailyPct: input.dailyPct,
    trigger: defaultTrigger(input),
    cooldownMin: input.cooldownMin ?? 60,
    channels: input.channels ?? ["browser"],
    enabled: input.enabled ?? true,
    label: ruleLabelFromInput(input),
  };
  list[idx] = {
    ...list[idx],
    alertRules: [...list[idx].alertRules, rule],
    updatedAt: bjIso(),
  };
  await savePositions(list);
  return rule;
}

export async function deleteRule(positionId: string, ruleId: string): Promise<void> {
  const list = await loadPositions();
  const idx = list.findIndex((p) => p.id === positionId);
  if (idx < 0) return;
  list[idx] = {
    ...list[idx],
    alertRules: list[idx].alertRules.filter((r) => r.id !== ruleId),
    updatedAt: bjIso(),
  };
  await savePositions(list);
}

export async function toggleRule(
  positionId: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  const list = await loadPositions();
  const idx = list.findIndex((p) => p.id === positionId);
  if (idx < 0) return;
  list[idx] = {
    ...list[idx],
    alertRules: list[idx].alertRules.map((r) => (r.id === ruleId ? { ...r, enabled } : r)),
    updatedAt: bjIso(),
  };
  await savePositions(list);
}

// ---- alert state (separate file, written by engine, read by API) ----

export async function loadAlertState(): Promise<AlertStateEntry[]> {
  return readJsonOr<AlertStateEntry[]>(ALERT_STATE_FILE, []);
}

export async function saveAlertState(state: AlertStateEntry[]): Promise<void> {
  await writeJsonAtomic(ALERT_STATE_FILE, state);
}

export function findAlertState(
  state: AlertStateEntry[],
  positionId: string,
  ruleId: string,
): AlertStateEntry | undefined {
  return state.find((s) => s.positionId === positionId && s.ruleId === ruleId);
}

export function upsertAlertState(
  state: AlertStateEntry[],
  entry: AlertStateEntry,
): AlertStateEntry[] {
  const idx = state.findIndex(
    (s) => s.positionId === entry.positionId && s.ruleId === entry.ruleId,
  );
  if (idx < 0) return [...state, entry];
  const next = [...state];
  next[idx] = { ...next[idx], ...entry };
  return next;
}
