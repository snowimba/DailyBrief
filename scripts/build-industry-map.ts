// One-shot builder for `data/industry-map.json` — the local industry lookup
// the 盯盘助手 tab uses. Shells to the SilverM-quant Python venv (which has
// baostock) so we don't need a separate Python install in DailyBrief.
//
// Run weekly or after a market reshuffle:
//   npx tsx scripts/build-industry-map.ts

import "./_env";

import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../lib/web/run-command";

const QUANT_PYTHON =
  process.env.QUANT_PYTHON ?? "/data/SilverM-quant/.venv/bin/python";

const OUTPUT_FILE = path.join(process.cwd(), "data", "industry-map.json");

const PYTHON_SCRIPT = `
import json
import sys
import baostock as bs

bs.login()
try:
    rs = bs.query_stock_industry()
    if rs.error_code != '0':
        print(f"baostock error {rs.error_code}: {rs.error_msg}", file=sys.stderr)
        sys.exit(1)
    rows = []
    while rs.next():
        rows.append(rs.get_row_data())
    fields = rs.fields
finally:
    bs.logout()

# fields: ['updateDate', 'code', 'code_name', 'industry', 'industryClassification']
out = {}
for r in rows:
    rec = dict(zip(fields, r))
    code_full = rec.get('code', '')
    if not code_full or '.' not in code_full:
        continue
    market, num = code_full.split('.', 1)
    if len(num) != 6:
        continue
    industry = (rec.get('industry') or '').strip()
    if not industry:
        continue
    out[num] = industry

print(json.dumps({
    'updatedAt': rows[0][0] if rows else None,
    'source': 'baostock query_stock_industry',
    'classification': rows[0][4] if rows else None,
    'count': len(out),
    'map': out,
}, ensure_ascii=False, indent=2))
`;

/**
 * Trim the verbose CSRC label down to something fit for a UI pill.
 *
 *   "C15酒、饮料和精制茶制造业" → "酒、饮料"
 *   "J66货币金融服务"           → "货币金融"
 *   "B07石油和天然气开采业"     → "石油天然气开采"
 */
function shortLabel(verbose: string): string {
  // Strip leading code: 1 letter + 1-2 digits (e.g. "C15", "J66", "I63", "S90").
  let s = verbose.replace(/^[A-Z]\d{1,2}/, "").trim();
  // Drop boilerplate suffix words.
  s = s
    .replace(/制造业$/, "制造")
    .replace(/服务业$/, "服务")
    .replace(/加工业$/, "加工")
    .replace(/和精制茶/g, "")
    .replace(/和其他/g, "")
    .replace(/业$/, "");
  // If the result is too long, take everything before the first "和" or first 6 chars.
  if (s.length > 8) {
    const cut = s.indexOf("和");
    if (cut > 0 && cut <= 8) s = s.slice(0, cut);
    else s = s.slice(0, 8);
  }
  return s || verbose;
}

async function main(): Promise<void> {
  console.log(`[industry-map] running baostock query via ${QUANT_PYTHON}…`);
  const result = await runCommand(QUANT_PYTHON, ["-c", PYTHON_SCRIPT], {
    cwd: process.cwd(),
    timeoutMs: 120_000,
  });
  // Python script may emit baostock's "login success!" / "logout success!"
  // banners on stdout before the JSON. Find the first '{' to start parsing.
  const out = result.stdout;
  const jsonStart = out.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(`no JSON in baostock output. raw:\n${out.slice(0, 400)}`);
  }
  const parsed = JSON.parse(out.slice(jsonStart)) as {
    updatedAt: string;
    source: string;
    classification: string;
    count: number;
    map: Record<string, string>;
  };

  // Convert verbose CSRC labels into short forms.
  const shortMap: Record<string, string> = {};
  for (const [code, verbose] of Object.entries(parsed.map)) {
    shortMap[code] = shortLabel(verbose);
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  const payload = {
    updatedAt: parsed.updatedAt,
    source: parsed.source,
    classification: parsed.classification,
    count: parsed.count,
    map: shortMap,
    rawSampleByCode: Object.fromEntries(
      Object.entries(parsed.map).slice(0, 5),
    ),
  };
  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  console.log(
    `[industry-map] wrote ${parsed.count} entries to ${OUTPUT_FILE} ` +
      `(updateDate ${parsed.updatedAt})`,
  );
  // Pretty sanity-check sample.
  const samples = ["600519", "000001", "000333", "600999", "002594"];
  for (const code of samples) {
    if (shortMap[code]) {
      console.log(`  ${code}: ${shortMap[code]}  (raw: ${parsed.map[code]})`);
    }
  }
}

main().catch((e) => {
  console.error(`[industry-map] FAILED:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
