/**
 * Per-source fetch cache.
 *
 * Stores each source's raw fetch result as a JSON file keyed by
 * (sourceId, date). Subsequent pipeline runs within the staleness
 * window skip the network call and replay the cached articles.
 *
 * Cache lives at `data/fetch-cache/<sourceId>/<date>.json` and is
 * git-ignored via the `data/` rule in .gitignore.
 */
import fs from "node:fs";
import path from "node:path";
import type { RawArticle } from "./types";

export const FETCH_CACHE_DIR = "data/fetch-cache";

/** Default staleness window: 10 minutes. */
export const FETCH_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

interface CacheEntry {
  fetchedAt: string; // ISO timestamp
  articleCount: number;
  articles: RawArticle[];
}

function cachePath(sourceId: string, date: string): string {
  return path.join(FETCH_CACHE_DIR, sourceId, `${date}.json`);
}

/**
 * Load a cached fetch result. Returns null if the file is missing,
 * corrupt, or older than `maxAgeMs`.
 */
export function loadCachedFetch(
  sourceId: string,
  date: string,
  maxAgeMs: number = FETCH_CACHE_MAX_AGE_MS,
): { articles: RawArticle[]; fetchedAt: string; ageMinutes: number } | null {
  const file = cachePath(sourceId, date);
  if (!fs.existsSync(file)) return null;

  try {
    const raw = fs.readFileSync(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry.fetchedAt || !Array.isArray(entry.articles)) return null;

    const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
    if (ageMs > maxAgeMs) return null;

    // Rehydrate publishedAt from ISO strings to Date objects.
    const articles = entry.articles.map((a) => ({
      ...a,
      publishedAt: a.publishedAt ? new Date(a.publishedAt as unknown as string) : undefined,
    }));

    return {
      articles,
      fetchedAt: entry.fetchedAt,
      ageMinutes: Math.round(ageMs / 60_000),
    };
  } catch {
    return null; // corrupt file → treat as cache miss
  }
}

/**
 * Persist a fetch result to the cache.
 */
export function saveCachedFetch(
  sourceId: string,
  date: string,
  articles: RawArticle[],
): void {
  const dir = path.join(FETCH_CACHE_DIR, sourceId);
  fs.mkdirSync(dir, { recursive: true });

  const entry: CacheEntry = {
    fetchedAt: new Date().toISOString(),
    articleCount: articles.length,
    articles,
  };

  fs.writeFileSync(
    path.join(dir, `${date}.json`),
    JSON.stringify(entry, null, 2),
    "utf8",
  );
}
