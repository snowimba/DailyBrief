import "./_env";

import fs from "node:fs/promises";
import path from "node:path";
import { buildSnapshot } from "../lib/web/positions/provider";

const SNAPSHOT_DIR = path.join(process.cwd(), "data", "positions_snapshots");

async function main() {
  const snap = await buildSnapshot();
  if (snap.positions.length === 0) {
    console.log("[positions-snapshot] no positions, skipping");
    return;
  }

  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const date = snap.generatedAt.slice(0, 10);
  const file = path.join(SNAPSHOT_DIR, `${date}.json`);
  await fs.writeFile(file, JSON.stringify(snap, null, 2), "utf8");
  console.log(`[positions-snapshot] wrote ${date}.json (${snap.positions.length} positions, market ¥${snap.totals.marketValue.toFixed(2)})`);
}

main().catch((e) => {
  console.error("[positions-snapshot] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
