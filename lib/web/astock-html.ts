import type { AstockRecord, AstockReport } from "../astock/report";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtNum(value: number | undefined, dp = 2): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(dp);
}

function fmtPct(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtAmount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(0)}万`;
  return value.toFixed(0);
}

function tierStats(records: AstockRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    const tier = record.tier_pre_research ?? "B";
    out[tier] = (out[tier] ?? 0) + 1;
  }
  return out;
}

function sortRecords(records: AstockRecord[]): AstockRecord[] {
  return [...records].sort(
    (a, b) => (b.final_score ?? -Infinity) - (a.final_score ?? -Infinity),
  );
}

function chips(values: string[], cls: string): string {
  if (values.length === 0) return `<span class="muted">-</span>`;
  return values
    .slice(0, 4)
    .map((value) => `<span class="${cls}">${escapeHtml(value)}</span>`)
    .join("");
}

function tierLabel(tier: string): string {
  if (tier === "S") return "重点研究";
  if (tier === "A") return "候选池";
  if (tier === "X") return "排除 / 暂缓";
  return "观察池";
}

function renderFocusCard(record: AstockRecord, index: number): string {
  const pctClass = (record.change_pct ?? 0) >= 0 ? "up" : "down";
  return `<article class="stock-focus-card">
    <div class="stock-focus-top">
      <span>#${index}</span>
      <span class="tier tier-${escapeHtml((record.tier_pre_research ?? "B").toLowerCase())}">${escapeHtml(record.tier_pre_research ?? "B")}</span>
      <strong>${fmtNum(record.final_score)}</strong>
    </div>
    <h3>${escapeHtml(record.code)} ${escapeHtml(record.name)}</h3>
    <div class="stock-focus-grid">
      <div><span>收盘</span><strong>${fmtNum(record.close)}</strong></div>
      <div><span>涨跌幅</span><strong class="${pctClass}">${fmtPct(record.change_pct)}</strong></div>
      <div><span>成交额</span><strong>${fmtAmount(record.amount)}</strong></div>
    </div>
    <div class="chip-row">${chips(record.signals, "signal-chip")}</div>
    ${record.risk_tags.length ? `<div class="chip-row">${chips(record.risk_tags, "risk-chip")}</div>` : ""}
  </article>`;
}

function renderTierTable(tier: string, records: AstockRecord[]): string {
  const rows = sortRecords(records)
    .slice(0, 10)
    .map((record, index) => {
      const pctClass = (record.change_pct ?? 0) >= 0 ? "up" : "down";
      return `<tr>
        <td>${index + 1}</td>
        <td><strong>${escapeHtml(record.code)}</strong><span>${escapeHtml(record.name)}</span></td>
        <td>${fmtNum(record.close)}</td>
        <td class="${pctClass}">${fmtPct(record.change_pct)}</td>
        <td>${fmtAmount(record.amount)}</td>
        <td>${chips(record.signals, "signal-chip")}</td>
        <td>${chips(record.risk_tags, "risk-chip")}</td>
        <td>${fmtNum(record.final_score)}</td>
      </tr>`;
    })
    .join("");
  if (!rows) return "";
  return `<section class="stock-tier">
    <h3><span class="tier tier-${tier.toLowerCase()}">${tier}</span>${tierLabel(tier)}</h3>
    <div class="stock-table-wrap">
      <table class="stock-table">
        <thead><tr><th>#</th><th>股票</th><th>收盘</th><th>涨跌幅</th><th>成交额</th><th>信号</th><th>风险</th><th>分数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

export function renderAstockWebHtml(report: AstockReport): string {
  const stats = tierStats(report.records);
  const focus = sortRecords(
    report.records.filter((r) => ["S", "A"].includes(r.tier_pre_research ?? "")),
  ).slice(0, 3);
  const candidates = report.metadata.candidate_count ?? report.records.length;
  const holdingsMissing = report.metadata.holdings_missing_signal ?? [];
  const riskCount = report.records.filter((r) => r.risk_tags.length > 0).length;
  const topNames = focus.map((r) => `${r.code} ${r.name}`).join("、") || "暂无";
  const targets = report.metadata.deep_research_targets ?? [];

  return `<div class="stock-report">
    <section class="stock-hero">
      <div>
        <p class="section-kicker">A股日报</p>
        <h2>${escapeHtml(report.trade_date)} 盘后选股</h2>
        <p>共筛出 ${candidates} 条候选，S 级 ${stats.S ?? 0} 只、A 级 ${stats.A ?? 0} 只。重点关注：${escapeHtml(topNames)}。带风险标签 ${riskCount} 条；持仓未触发买入信号：${escapeHtml(holdingsMissing.join("、") || "无")}。</p>
      </div>
      <div class="stock-metrics">
        <div><span>交易日</span><strong>${escapeHtml(report.trade_date)}</strong></div>
        <div><span>候选记录</span><strong>${candidates}</strong></div>
        <div><span>分层统计</span><strong>S ${stats.S ?? 0} / A ${stats.A ?? 0} / B ${stats.B ?? 0} / X ${stats.X ?? 0}</strong></div>
        <div><span>持仓跟踪</span><strong>${escapeHtml((report.metadata.holdings ?? []).join("、") || "-")}</strong></div>
      </div>
    </section>

    <section>
      <div class="section-heading"><h2>重点研究</h2></div>
      <div class="stock-focus-list">${focus.map((record, index) => renderFocusCard(record, index + 1)).join("")}</div>
    </section>

    <section>
      <div class="section-heading"><h2>分层榜单</h2></div>
      ${["S", "A", "B", "X"].map((tier) => renderTierTable(tier, report.records.filter((record) => (record.tier_pre_research ?? "B") === tier))).join("")}
    </section>

    ${
      targets.length
        ? `<section><div class="section-heading"><h2>深研任务</h2></div><div class="research-pills">${targets
            .slice(0, 6)
            .map((target) => `<span>${escapeHtml(target.name ? `${target.code} ${target.name}` : target.code)}</span>`)
            .join("")}</div></section>`
        : ""
    }

    <p class="risk-note">本报告仅用于研究和复核，不构成投资建议。</p>
  </div>`;
}
