import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ASTOCK_REPORT_DIR =
  "/data/SilverM-quant/reports/stock_selection";

export interface AstockDeepResearch {
  status?: string;
  records?: unknown[];
  summary_path?: string;
}

export interface AstockResearchTarget {
  code: string;
  name?: string;
}

export interface AstockMetadata {
  source?: string;
  candidate_count?: number;
  generated_at?: string;
  holdings?: string[];
  holdings_in_signal_pool?: string[];
  holdings_missing_signal?: string[];
  deep_research_targets?: AstockResearchTarget[];
  deep_research_mode?: string;
  deep_research?: AstockDeepResearch;
  strategy?: string;
}

export interface AstockRecord {
  code: string;
  name: string;
  industry?: string;
  market?: string;
  close?: number;
  change_pct?: number;
  amount?: number;
  signal_count?: number;
  sell_signal_count?: number;
  final_score?: number;
  tier_pre_research?: string;
  pool?: string;
  signals: string[];
  risk_tags: string[];
  is_holding?: boolean;
  holding_note?: string;
}

export interface AstockReport {
  trade_date: string;
  generated_at?: string;
  metadata: AstockMetadata;
  records: AstockRecord[];
  sourcePath: string;
  markdownPath?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((x): x is string => typeof x === "string");
}

function normalizeMetadata(value: unknown): AstockMetadata {
  const m = asObject(value);
  const targets = Array.isArray(m.deep_research_targets)
    ? m.deep_research_targets
        .map((item) => {
          const t = asObject(item);
          const code = asString(t.code);
          if (!code) return null;
          const name = asString(t.name);
          return name ? { code, name } : { code };
        })
        .filter((x): x is AstockResearchTarget => x !== null)
    : undefined;
  return {
    source: asString(m.source),
    candidate_count: asNumber(m.candidate_count),
    generated_at: asString(m.generated_at),
    holdings: asStringArray(m.holdings),
    holdings_in_signal_pool: asStringArray(m.holdings_in_signal_pool),
    holdings_missing_signal: asStringArray(m.holdings_missing_signal),
    deep_research_targets: targets,
    deep_research_mode: asString(m.deep_research_mode),
    deep_research: asObject(m.deep_research) as AstockDeepResearch,
    strategy: asString(m.strategy),
  };
}

function normalizeRecord(value: unknown): AstockRecord | null {
  const r = asObject(value);
  const code = asString(r.code);
  const name = asString(r.name) ?? "";
  if (!code) return null;
  const signalMap: Array<[string, string]> = [
    ["signal_buy_b1", "B1"],
    ["signal_buy_b2", "B2"],
    ["signal_buy_blk", "BLK"],
    ["signal_buy_dz30", "DZ30"],
    ["signal_buy_scb", "SCB"],
    ["signal_buy_blkB2", "BLKB2"],
  ];
  const signals = signalMap
    .filter(([key]) => r[key] === true)
    .map(([, label]) => {
      const score = asNumber(r[`score_${label === "BLKB2" ? "blkB2" : label.toLowerCase()}`]);
      return score === undefined ? label : `${label}(${score.toFixed(1)})`;
    });
  return {
    code,
    name,
    industry: asString(r.industry),
    market: asString(r.market),
    close: asNumber(r.close),
    change_pct: asNumber(r.change_pct),
    amount: asNumber(r.amount),
    signal_count: asNumber(r.signal_count),
    sell_signal_count: asNumber(r.sell_signal_count),
    final_score: asNumber(r.final_score),
    tier_pre_research: asString(r.tier_pre_research),
    pool: asString(r.pool),
    signals,
    risk_tags: asStringArray(r.risk_tags) ?? [],
    is_holding: typeof r.is_holding === "boolean" ? r.is_holding : undefined,
    holding_note: asString(r.holding_note),
  };
}

function pickLatestFile(files: string[], reportDate?: string): string | undefined {
  const sorted = [...files].sort((a, b) => b.localeCompare(a));
  if (!reportDate) return sorted[0];
  return sorted.find((f) => f.slice(0, 10) <= reportDate) ?? sorted[0];
}

export function loadLatestAstockReport(reportDate?: string): AstockReport | null {
  const dir = process.env.ASTOCK_REPORT_DIR ?? DEFAULT_ASTOCK_REPORT_DIR;
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-astock\.json$/.test(f));
  const file = pickLatestFile(files, reportDate);
  if (!file) return null;

  const sourcePath = path.join(dir, file);
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
    const root = asObject(parsed);
    const tradeDate = asString(root.trade_date) ?? file.slice(0, 10);
    const markdownPath = path.join(dir, `${tradeDate}-astock.md`);
    const records = Array.isArray(root.records)
      ? root.records
          .map(normalizeRecord)
          .filter((x): x is AstockRecord => x !== null)
      : [];
    return {
      trade_date: tradeDate,
      generated_at: asString(root.generated_at),
      metadata: normalizeMetadata(root.metadata),
      records,
      sourcePath,
      markdownPath: fs.existsSync(markdownPath) ? markdownPath : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[astock] failed to load ${sourcePath}: ${msg}`);
    return null;
  }
}
