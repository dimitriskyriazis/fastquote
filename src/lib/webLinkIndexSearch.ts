// Search-index candidate source for the add-weblinks feature.
//
// Why this exists alongside the OpenAI web_search proposer (lib/webLinkProposer.ts): the two
// indexes are not equivalent. Manufacturers increasingly keep their per-SKU pages on a
// client-rendered commerce subdomain, and those pages are absent from the proposer's index —
// measured 2026-07-28 on biamp: 21 web_search calls across 7 products (part-led and model-led,
// with and without the domain filter) never returned a single deep products.biamp.com URL, only
// the site root and marketing family pages. Google (via Serper) returned the exact per-SKU page
// as the top on-domain hit for 6 of those 7 products.
//
// Worse, when the proposer IS pushed toward such a subdomain it fills the URL template with our
// part number and returns a URL that does not exist. Those sites answer HTTP 200 with an
// identical shell for any SKU, so the route cannot tell a fabricated URL from a real one — but a
// search index only lists pages it actually crawled and rendered, and it hands back the rendered
// title. That makes an index hit both a candidate AND the existence proof for pages we can't read
// (see the "index" tier in WebLinkVerification).
//
// Best-effort by design: no SERPER_API_KEY, an API error or a timeout yields [] and the route
// falls back to the proposer's candidates alone.

import { serperSearchOrganic } from "./serper";
import {
  buildIndexSearchQueries,
  dedupeByUrlLeaf,
  hostMatchesDomain,
  normalizedUrlKey,
  stripTrackingParams,
} from "./webLinkResolution";

export type IndexHit = {
  /** Result URL, tracking parameters stripped. */
  link: string;
  /** The index's title for the page — rendered by the crawler, so it carries the real product
   *  name even when our own fetch of the page returns an empty JS shell. */
  title: string;
  snippet: string;
  /** The query that surfaced this hit (logging/diagnostics only). */
  query: string;
};

/** How many results to request per query, and how many hits to hand back to the route. */
const RESULTS_PER_QUERY = 10;
const MAX_HITS = 6;

// Short-lived cache of NON-EMPTY results, keyed by the product identity that produced them.
// Two reasons: a re-run over the same rows (the natural reaction to a "no link found") should not
// re-bill the same queries, and a transient provider failure should not be sticky — failures are
// never cached, so the next attempt really retries.
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; hits: IndexHit[] }>();

const cacheKey = (opts: { brand: string; modelNumber: string; partNumber: string; domain: string }) =>
  [opts.domain, opts.brand, opts.modelNumber, opts.partNumber].map((s) => s.trim().toLowerCase()).join("|");

const cacheGet = (key: string): IndexHit[] | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.hits;
};

const cacheSet = (key: string, hits: IndexHit[]) => {
  if (hits.length === 0) return; // never cache a miss or a provider failure
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), hits });
};

/**
 * Runs the model-name-led index queries for one product and returns the on-domain hits,
 * deduped (by URL and by product leaf segment) and cleaned. Never throws.
 */
export const searchIndexCandidates = async (opts: {
  brand: string;
  modelNumber: string;
  partNumber: string;
  partNumberCore?: string;
  /** Family-level code, searched last — sometimes the only page a manufacturer publishes. */
  partPrefix?: string;
  domain: string;
  tag?: string;
}): Promise<IndexHit[]> => {
  const { domain, tag } = opts;
  if (!domain) return [];
  const queries = buildIndexSearchQueries(opts);
  if (queries.length === 0) return [];

  const key = cacheKey({ ...opts, domain });
  const cached = cacheGet(key);
  if (cached) return cached;

  // Queries are independent; the serper wrapper's own semaphore bounds real concurrency.
  const perQuery = await Promise.all(
    queries.map(async (query) => {
      try {
        const organic = await serperSearchOrganic(query, { num: RESULTS_PER_QUERY, tag: tag ?? "weblink" });
        return organic.map((r) => ({
          link: stripTrackingParams(r.link),
          title: r.title ?? "",
          snippet: r.snippet ?? "",
          query,
        }));
      } catch {
        return [] as IndexHit[];
      }
    }),
  );

  // Keep query order (site:-scoped model search first) so the route's ordering sees the most
  // trustworthy hits first.
  const seen = new Set<string>();
  const hits: IndexHit[] = [];
  for (const hit of perQuery.flat()) {
    if (!hostMatchesDomain(safeHost(hit.link), domain)) continue;
    const key = normalizedUrlKey(hit.link);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  const result = dedupeByUrlLeaf(hits).slice(0, MAX_HITS);
  cacheSet(key, result);
  return result;
};

const safeHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
