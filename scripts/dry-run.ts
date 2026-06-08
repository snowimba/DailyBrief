import "./_env";

import { sources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import type { ArticleInput } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";
import { loadCachedFetch, saveCachedFetch } from "../lib/sources/fetch-cache";

// Source-fetch sanity check only — does NOT call the LLM. For the full
// ingest → digest → write-to-disk pipeline use `npm run daily` instead.
async function main() {
  const date = todayKey();
  const useCache = !process.argv.includes("--no-cache") && process.env.CI !== "true";
  console.log(`Fetching from sources${useCache ? " (cache enabled)" : " (cache disabled)"}…\n`);
  const articles: ArticleInput[] = [];
  let fromCache = 0;
  let fresh = 0;
  let failed = 0;

  const enabled = sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    if (useCache) {
      const cached = loadCachedFetch(source.id, date);
      if (cached) {
        console.log(`  ${source.id.padEnd(20)} ${String(cached.articles.length).padStart(4)}  (cached, ${cached.ageMinutes}m old)`);
        articles.push(...cached.articles.map((it) => ({ ...it, source: source.name })));
        fromCache++;
        continue;
      }
    }

    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${String(items.length).padStart(4)}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
      saveCachedFetch(source.id, date, items);
      fresh++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
      failed++;
    }
  }

  if (useCache) {
    console.log(`\nfetch summary: ${fromCache} from cache, ${fresh} fresh, ${failed} failed`);
  }
  console.log(`\nTotal articles: ${articles.length}`);
  console.log("\nTop 10 articles:");
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
