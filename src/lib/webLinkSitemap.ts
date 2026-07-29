// Sitemap candidate source for the add-weblinks feature.
//
// WHY: a manufacturer's sitemap is its own authoritative index of its own pages — no LLM, no Google,
// no cost. Where a site puts the part number in the URL slug (measured on Belden, Legrand AV,
// Soundtube, Sennheiser) a sitemap lookup answers the whole question with one HTTP fetch, and the
// answer is exact rather than ranked. It is also the only source that is equally good for every
// brand, which the other two are not: the OpenAI index misses client-rendered catalogs entirely, and
// Google's coverage is patchy per site.
//
// It is emphatically NOT always available — biamp's sitemap (checked 2026-07-28) lists layouts and
// category pages but not a single product URL. So this is one tier among three, never a replacement.
//
// Cost control: sitemaps are fetched ONCE PER DOMAIN and cached for the process, because a batch of
// 10 products usually shares one brand. Everything is bounded — total bytes, file count, and time.

import { gunzipSync } from "node:zlib";
import { containsIdentifier, normalizeHaystack, normalizeIdentifier } from "./webLinkResolution";

export type SitemapHit = { link: string; matched: string };

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 10_000;
/** Per-file and total byte ceilings — some product sitemaps are tens of megabytes. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** How many child sitemaps of an index to read, product-looking ones first. */
const MAX_CHILD_SITEMAPS = 6;
const MAX_URLS = 200_000;
const CACHE_TTL_MS = 30 * 60_000;

type CacheEntry = { at: number; urls: string[] };
const cache = new Map<string, Promise<CacheEntry>>();

const fetchText = async (url: string): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml,text/plain,*/*" },
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_BYTES) return null;
    const bytes = Buffer.from(buffer);
    // .xml.gz is common, and some servers gzip regardless of the extension.
    const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    return (isGzip ? gunzipSync(bytes) : bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const locsIn = (xml: string): string[] =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, "&").trim(),
  );

/** Sitemap URLs declared by robots.txt, plus the conventional fallbacks. */
const discoverSitemaps = async (domain: string): Promise<string[]> => {
  const found: string[] = [];
  for (const host of [`https://www.${domain}`, `https://${domain}`]) {
    const robots = await fetchText(`${host}/robots.txt`);
    if (robots) {
      for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) found.push(m[1].trim());
      if (found.length) break;
      // robots.txt existed but declared nothing — try the conventions on this host.
      found.push(`${host}/sitemap.xml`, `${host}/sitemap_index.xml`);
      break;
    }
  }
  if (!found.length) found.push(`https://www.${domain}/sitemap.xml`, `https://${domain}/sitemap.xml`);
  return Array.from(new Set(found)).slice(0, 4);
};

/** Product-looking sitemaps first: on big sites the index lists dozens of files and only some carry
 *  products, so this decides what fits in the file budget. */
const childPriority = (url: string): number => {
  const u = url.toLowerCase();
  if (/product|item|catalog|sku|shop/.test(u)) return 0;
  if (/page|content|category/.test(u)) return 2;
  return 1;
};

const loadUrls = async (domain: string): Promise<CacheEntry> => {
  const urls: string[] = [];
  let totalBytes = 0;
  const roots = await discoverSitemaps(domain);

  for (const root of roots) {
    const xml = await fetchText(root);
    if (!xml) continue;
    totalBytes += xml.length;
    const locs = locsIn(xml);
    const isIndex = /<sitemapindex/i.test(xml);
    if (!isIndex) {
      urls.push(...locs);
    } else {
      const children = locs.sort((a, b) => childPriority(a) - childPriority(b)).slice(0, MAX_CHILD_SITEMAPS);
      for (const child of children) {
        if (totalBytes > MAX_TOTAL_BYTES || urls.length > MAX_URLS) break;
        const childXml = await fetchText(child);
        if (!childXml) continue;
        totalBytes += childXml.length;
        urls.push(...locsIn(childXml));
      }
    }
    if (urls.length > MAX_URLS) break;
  }

  console.log(`[weblink] sitemap ${domain}: ${urls.length} URLs from ${roots.length} root(s)`);
  return { at: Date.now(), urls: urls.slice(0, MAX_URLS) };
};

const getUrls = (domain: string): Promise<CacheEntry> => {
  const cached = cache.get(domain);
  if (cached) {
    // Re-check freshness without blocking: a stale entry is replaced on the next call.
    void cached.then((entry) => {
      if (Date.now() - entry.at > CACHE_TTL_MS) cache.delete(domain);
    });
    return cached;
  }
  const pending = loadUrls(domain).catch((err) => {
    console.warn(`[weblink] sitemap ${domain} failed:`, err instanceof Error ? err.message : err);
    cache.delete(domain);
    return { at: Date.now(), urls: [] as string[] };
  });
  cache.set(domain, pending);
  return pending;
};

/**
 * URLs from the brand's own sitemap whose PATH carries one of this product's identifiers. Exact by
 * construction — no ranking, no model judgement — so the caller can try these first. Never throws;
 * an unavailable or product-free sitemap yields [].
 */
export const findInSitemap = async (opts: {
  domain: string;
  /** Per-model identifiers, most specific first (part number, then core). No family prefixes. */
  identifiers: string[];
  max?: number;
}): Promise<SitemapHit[]> => {
  const { domain, identifiers, max = 3 } = opts;
  if (!domain) return [];
  const needles = identifiers
    .map((id) => ({ raw: id, needle: normalizeIdentifier(id ?? "") }))
    .filter((n) => n.needle.length >= 5);
  if (!needles.length) return [];

  const { urls } = await getUrls(domain);
  if (!urls.length) return [];

  const hits: SitemapHit[] = [];
  for (const { raw, needle } of needles) {
    for (const url of urls) {
      let path = "";
      try {
        path = new URL(url).pathname;
      } catch {
        continue;
      }
      if (!containsIdentifier(normalizeHaystack(path), needle)) continue;
      if (hits.some((h) => h.link === url)) continue;
      hits.push({ link: url, matched: raw });
      if (hits.length >= max) return hits;
    }
    // Only fall back to a less specific identifier when the more specific one found nothing.
    if (hits.length) break;
  }
  return hits;
};
