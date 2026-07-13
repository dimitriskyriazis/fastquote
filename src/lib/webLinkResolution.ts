// Pure helpers for the add-weblinks pipeline (src/app/api/products/add-weblinks/route.ts)
// and its client callers. No I/O here — everything is unit-testable (see __tests__/webLinkResolution.test.ts).

/** Result status of a web-link search proposal — single source of truth for the
 *  route, the client helper and the preview dialog.
 *  - previewed: a link was found and fully verified (fetched + content/English checks passed).
 *  - unverified: a candidate was found on the manufacturer's site but the page could not be
 *    fetched to verify (bot-protected); offered for human review, never auto-applied.
 *  - not_found / error: no usable candidate. */
export type WebLinkStatus = "previewed" | "unverified" | "not_found" | "error";

/** How a proposed link was verified: "content" = part/model found on the page,
 *  "llm" = page content judged relevant by the model, "url" = page unreachable from the
 *  server (bot-blocked) but the URL carries the product identifier on a curated domain. */
export type WebLinkVerification = "content" | "llm" | "url";

/** True when the value is a usable http(s) URL — filters out placeholder debris like the
 *  literal "Link"/"link" strings left behind by old Excel imports. */
export const isRealWebLink = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
};

/** Aggressive normalization for part/model numbers: lowercase, strip spaces, hyphens,
 *  underscores, dots and slashes so "911.1520.900", "911-1520-900" and "911 1520 900"
 *  all compare equal. */
export const normalizeIdentifier = (s: string): string =>
  s.toLowerCase().replace(/[\s\-_./]+/g, "");

/** Normalization for URL paths / page text used as match haystacks: strips the same
 *  separators as normalizeIdentifier but keeps "/" so path-segment boundaries survive. */
export const normalizeHaystack = (s: string): string =>
  s.toLowerCase().replace(/[\s\-_.]+/g, "");

/**
 * Digit-boundary-aware containment: does `haystack` (already normalized via normalizeHaystack)
 * contain `needle` (already normalized via normalizeIdentifier) without the match being a
 * substring of a longer digit run? Prevents model "X-100" from matching the sibling "X-1000"
 * page, and part "1100" from matching inside "21100". Letter neighbours are allowed because
 * variant suffixes ("hp1290i-wh") and merged file extensions ("hp1290i.html" → "hp1290ihtml")
 * are common and legitimate.
 */
export const containsIdentifier = (haystack: string, needle: string): boolean => {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const prev = idx > 0 ? haystack[idx - 1] : "";
    const next = idx + needle.length < haystack.length ? haystack[idx + needle.length] : "";
    if (!/\d/.test(prev) && !/\d/.test(next)) return true;
    from = idx + 1;
  }
};

/**
 * Does the identifier (part/model number) appear in the given raw text?
 * Long identifiers (normalized length >= 4) match separator-insensitively.
 * Short ones (e.g. "U3") only match as whole words in the raw text, to avoid
 * false positives from normalization.
 */
export const identifierAppearsInText = (rawText: string, identifier: string): boolean => {
  const needle = normalizeIdentifier(identifier);
  if (!needle) return false;
  if (needle.length >= 4) {
    return containsIdentifier(normalizeHaystack(rawText), needle);
  }
  const escaped = identifier.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(rawText);
};

/** Host-vs-domain check with a dot boundary, so "notsony.com" does NOT match "sony.com". */
export const hostMatchesDomain = (host: string, domain: string): boolean => {
  const h = host.toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
};

/**
 * Parse a model reply that should contain a bare manufacturer domain.
 * Returns null for refusals, chatty answers, or anything that doesn't look like a domain.
 */
export const parseDomainReply = (raw: string): string | null => {
  let text = raw.trim().replace(/^[`'"\s]+|[`'"\s.,;:!]+$/g, "");
  if (!text || /not[_\s-]?found/i.test(text)) return null;
  try {
    if (text.includes("://")) text = new URL(text).hostname;
  } catch {
    return null;
  }
  text = text.split(/[/\s]/)[0].replace(/^www\./i, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(text)) return null;
  return text;
};

// --- Locale helpers -------------------------------------------------------

// Bare two-letter segments are only treated as locales when they are common language
// codes — otherwise product paths like /tv/, /hp/ or /av/ get mistaken for locales
// (wrong scoring penalty + pointless English-variant swap attempts).
const COMMON_LANG_CODES = new Set([
  "en", "de", "fr", "it", "es", "pt", "nl", "pl", "sv", "da", "fi", "no", "nb", "cs",
  "sk", "hu", "ro", "bg", "el", "tr", "ru", "uk", "ja", "zh", "ko", "ar", "he", "th",
]);

export const isLocaleSegment = (s: string): boolean => {
  const lower = s.toLowerCase();
  if (/^[a-z]{2}-[a-z]{2,8}$/.test(lower)) return true;
  return /^[a-z]{2}$/.test(lower) && COMMON_LANG_CODES.has(lower);
};
export const isEnglishSegment = (s: string): boolean => s === "en" || s.toLowerCase().startsWith("en-");

/** English locales the company prefers (EU-based): used by scoring and by the route's
 *  post-acceptance regional swap — keep the two in sync via this single definition. */
export const PREFERRED_ENGLISH_LOCALES = /^en-(eu|gb|ie)$/;

// European market codes — the company is EU-based, so EU/UK sites carry the right
// pricing/availability (used for scoring's +2 English-region bonus).
export const EUROPEAN_REGIONS = new Set([
  "eu", "gb", "ie", "de", "nl", "fr", "it", "es",
  "be", "ch", "at", "se", "no", "dk", "fi", "pl", "cz", "pt", "gr", "hu", "ro", "sk",
  "bg", "hr", "si", "ee", "lv", "lt", "lu",
]);

// Region/market codes to try (in order) when rewriting a /{region}/{language}/ URL to English.
// Many enterprise commerce sites serve the same product under many regions but only some have a
// working English site — so we try European English first (the company is EU-based), then the
// vendor-neutral "international/export" English variants (e.g. Keenfinity's /xl/en/), then major
// English markets. Every candidate is re-fetched, so regions that 500/redirect/reset are skipped.
export const PREFERRED_ENGLISH_REGIONS = [
  "eu", "gb", "ie", "xl", "int", "ww", "global", "us", "ca", "au", "in", "sg", "nz",
];

// Country/region codes seen as the FIRST segment of enterprise commerce URLs that use a
// /{region}/{language}/ prefix (e.g. Keenfinity/Bosch /tw/en/, /au/en/, /tw/tw/). Kept broad;
// a false match is harmless because every rewritten URL is re-verified before use.
const REGION_CODES = new Set([
  ...EUROPEAN_REGIONS,
  "us", "ca", "mx", "br", "ar", "cl", "co", "au", "nz", "cn", "tw", "hk", "jp", "kr",
  "in", "sg", "my", "th", "ph", "id", "vn", "ae", "sa", "za", "tr", "il", "ru", "ua",
]);

export type RegionLangPrefix = { regionIdx: number; langIdx: number; region: string; lang: string; restIdx: number };

/** Detects a leading /{region}/{language}/ prefix — two 2-letter segments where the first is a
 *  known region OR the second is a known language (e.g. Keenfinity /tw/en/, /tw/tw/, /au/en/).
 *  Returns null for anything else (single-locale shapes are handled by localePrefixIndex). */
export const parseRegionLangPrefix = (segs: string[]): RegionLangPrefix | null => {
  if (segs.length < 2) return null;
  const region = segs[0].toLowerCase();
  const lang = segs[1].toLowerCase();
  if (!/^[a-z]{2}$/.test(region) || !/^[a-z]{2}$/.test(lang)) return null;
  if (!REGION_CODES.has(region) && !COMMON_LANG_CODES.has(lang)) return null;
  return { regionIdx: 0, langIdx: 1, region, lang, restIdx: 2 };
};

/** English variants of a /{region}/{language}/ URL, in PREFERRED_ENGLISH_REGIONS order (European
 *  English first, then international, then major English markets), then the original region in
 *  English — for normalizing e.g. /tw/tw/ or /it/it/ toward a working English site like /xl/en/.
 *  Excludes the original URL; empty when the URL has no region/language prefix. Each result is
 *  re-verified by the caller, so regions that 500/redirect/reset are simply skipped. */
export const buildRegionLangEnglishCandidates = (url: string): string[] => {
  try {
    const parsed = new URL(url);
    const segs = parsed.pathname.split("/").filter(Boolean);
    const p = parseRegionLangPrefix(segs);
    if (!p) return [];
    const rest = segs.slice(p.restIdx);
    const trail = parsed.pathname.endsWith("/") ? "/" : "";
    const make = (region: string, lang: string) =>
      `${parsed.origin}/${[region, lang, ...rest].join("/")}${trail}${parsed.search}`;
    const candidates = [...PREFERRED_ENGLISH_REGIONS.map((r) => make(r, "en")), make(p.region, "en")];
    return Array.from(new Set(candidates)).filter((c) => c !== url);
  } catch {
    return [];
  }
};

/** Index of the leading locale segment: segs[0], or segs[1] when prefixed by
 *  global/region/site. Returns -1 when the path has no locale prefix. */
export const localePrefixIndex = (segs: string[]): number => {
  if (segs.length > 1 && /^(global|region|site)$/i.test(segs[0]) && isLocaleSegment(segs[1])) return 1;
  if (segs.length > 0 && isLocaleSegment(segs[0])) return 0;
  return -1;
};

// --- URL classification -----------------------------------------------------

// Salesforce-community support app (e.g. community.grassvalley.com/support/s/...). Covers both
// the "portalproduct" service records (bare product/part + service-status fields, no specs) and
// knowledge-base articles. These are support content, NOT marketing/product pages — a general
// page on the manufacturer's main site is preferable, so they are never chosen.
export const isSupportCommunityPath = (path: string): boolean => /\/support\/s\//.test(path);

// Knowledge-base articles, community discussions, news and blog posts. These frequently mention
// a product's part number in their slug/body (release notes, how-tos, an accessory listed on a
// parent product's article) but are NOT the product page — they must never win.
export const isArticleOrNewsPath = (path: string): boolean =>
  isSupportCommunityPath(path) ||
  /\/article\/|\/articles\/|\/news\/|\/blog\/|\/press(-release)?\/|\/community\//.test(path);

// --- Page-content extraction and verification ------------------------------

export type ExtractedPage = {
  title: string;
  metaDescription: string;
  ogTitle: string;
  /** OpenGraph type — "article"/"blog" for news/blog posts, "product"/"website" otherwise. */
  ogType: string;
  /** <html lang="..."> value, lowercased (e.g. "en", "en-us", "it", "it-it"), or "". */
  htmlLang: string;
  /** og:locale meta, lowercased (e.g. "it_it"), or "". */
  ogLocale: string;
  canonicalUrl: string | null;
  bodyText: string;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");

const attrValue = (tag: string, attr: string): string | null => {
  const m = tag.match(new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3] ?? "") : null;
};

const findMetaContent = (html: string, keyAttr: "name" | "property", keyValue: string): string => {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const key = attrValue(tag, keyAttr);
    if (key && key.toLowerCase() === keyValue) {
      return decodeEntities(attrValue(tag, "content") ?? "").trim();
    }
  }
  return "";
};

/** Extract the parts of an HTML page relevant to product verification.
 *  Input is expected to be pre-capped by the caller (we re-cap defensively). */
export const extractPageContent = (html: string): ExtractedPage => {
  const capped = html.slice(0, 500_000);

  const titleMatch = capped.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

  const metaDescription = findMetaContent(capped, "name", "description");
  const ogTitle = findMetaContent(capped, "property", "og:title");
  const ogType = findMetaContent(capped, "property", "og:type").toLowerCase();
  const ogLocale = findMetaContent(capped, "property", "og:locale").toLowerCase();
  const htmlTag = capped.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const htmlLang = (attrValue(htmlTag, "lang") ?? "").trim().toLowerCase();

  let canonicalUrl: string | null = null;
  const linkTags = capped.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = attrValue(tag, "rel");
    if (rel && rel.toLowerCase().split(/\s+/).includes("canonical")) {
      canonicalUrl = attrValue(tag, "href");
      break;
    }
  }

  // Strip and collapse BEFORE entity-decoding, and pre-slice with headroom —
  // decoding 400KB of text that the final slice throws away is wasted CPU.
  const bodyText = decodeEntities(
    capped
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 110_000),
  ).slice(0, 100_000);

  return { title, metaDescription, ogTitle, ogType, htmlLang, ogLocale, canonicalUrl, bodyText };
};

/** The page's declared language code (from <html lang> or og:locale), lowercased and reduced to
 *  the language part (e.g. "en", "it"); "" when the page declares nothing. */
export const pageLanguage = (page: ExtractedPage): string =>
  (page.htmlLang || page.ogLocale || "").split(/[-_]/)[0];

/** True when a page positively declares a non-English language. Unknown/absent → false
 *  (we assume English rather than reject a page that simply omits the attribute). */
export const pageDeclaresNonEnglish = (page: ExtractedPage): boolean => {
  const lang = pageLanguage(page);
  return lang !== "" && lang !== "en";
};

/** True when the URL's own language segment is positively non-English — covers single-locale
 *  paths (/it/, /it-IT/) and /{region}/{language}/ paths (/it/it/, /tw/tw/). A URL with no
 *  locale segment (assumed English) or an English one returns false. */
export const urlLanguageIsNonEnglish = (url: string): boolean => {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const rl = parseRegionLangPrefix(segs);
    if (rl) return rl.lang !== "en";
    const idx = localePrefixIndex(segs);
    if (idx >= 0) return !isEnglishSegment(segs[idx]);
    return false;
  } catch {
    return false;
  }
};

/** True when the URL POSITIVELY declares English (an /en/, /en-GB/, or /{region}/en/ segment).
 *  A locale-less URL returns false (English is assumed but not declared). */
export const urlDeclaresEnglish = (url: string): boolean => {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const rl = parseRegionLangPrefix(segs);
    if (rl) return rl.lang === "en";
    const idx = localePrefixIndex(segs);
    if (idx >= 0) return isEnglishSegment(segs[idx]);
    return false;
  } catch {
    return false;
  }
};

/** Whether a resolved link should be treated as English. An explicitly-English URL is trusted
 *  even if the page mislabels its <html lang>; a non-English URL is always rejected; a
 *  locale-less URL falls back to the page's declared language (unknown → treated as English). */
export const isEnglishResult = (url: string, pageLang: string): boolean => {
  if (urlLanguageIsNonEnglish(url)) return false;
  if (urlDeclaresEnglish(url)) return true;
  return pageLang === "" || pageLang === "en";
};

// Grammatical stopwords that appear in headline/press-release slugs but essentially never in a
// product slug (which is a model code like "ldx-c110" or "teranex-mini").
const HEADLINE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "with", "from", "is", "are",
  "how", "why", "what", "your", "our", "best", "cost", "efficient", "demanding",
]);

/** A last path segment that reads like a sentence/headline (e.g.
 *  "ldx-110-and-ldx-c110-a-cost-efficient-camera-generation-...") — the signature of a blog or
 *  press-release post, not a product page. */
export const hasHeadlineSlug = (finalUrl: string): boolean => {
  try {
    const segs = new URL(finalUrl).pathname.split("/").filter(Boolean);
    let last = segs[segs.length - 1] ?? "";
    last = last.replace(/\.[a-z0-9]+$/i, "").replace(/-\d+$/, ""); // drop extension + WordPress "-2" suffix
    const tokens = last.toLowerCase().split(/[-_]/).filter(Boolean);
    if (tokens.length < 5) return false;
    const stopwordHits = tokens.filter((t) => HEADLINE_STOPWORDS.has(t)).length;
    return stopwordHits >= 2;
  } catch {
    return false;
  }
};

/** True when a fetched page is a news/blog/press article rather than a product page:
 *  OpenGraph type says so, or the URL slug reads like a headline. */
export const looksLikeArticlePage = (page: ExtractedPage, finalUrl: string): boolean =>
  /article|blog|news/.test(page.ogType) || hasHeadlineSlug(finalUrl);

/** Heuristic soft-404 detection: an HTTP-200 page whose title/heading says the product
 *  doesn't exist. Checked against the title and the first stretch of body text only. */
export const looksLikeSoftNotFound = (page: ExtractedPage): boolean => {
  const probe = `${page.title} ${page.bodyText.slice(0, 300)}`;
  return /page (was )?not found|page (is )?(currently )?unavailable|\b404\b|no longer available|does(n'?t| not) exist|niet gevonden|nicht gefunden|introuvable|non trovat/i.test(
    probe,
  );
};

/** Did a redirect land on the site root (optionally behind a locale prefix) when we asked
 *  for a deeper page? That's a soft-404 pattern ("product retired → redirect home"). */
export const isHomepageLanding = (requestedUrl: string, finalUrl: string): boolean => {
  try {
    const requested = new URL(requestedUrl);
    const finalParsed = new URL(finalUrl);
    const meaningful = (u: URL): number => {
      const segs = u.pathname.split("/").filter(Boolean);
      const li = localePrefixIndex(segs);
      return (li >= 0 ? segs.slice(li + 1) : segs).length + (u.search ? 1 : 0);
    };
    if (meaningful(finalParsed) > 0) return false;
    return meaningful(requested) > 0 || requested.hostname !== finalParsed.hostname;
  } catch {
    return false;
  }
};

export type PageMatchStrength = "strong" | "body" | "none";

/**
 * Content-level product verification with a strength grade.
 * "strong": an identifier appears in the page title/meta/og/canonical or the final URL —
 *           this page is ABOUT the product.
 * "body":   an identifier appears only in the body text — weak evidence: accessory part
 *           numbers are routinely listed on the PARENT product's page (e.g. a bracket's
 *           part number in the loudspeaker page's accessories section), so a body-only
 *           match needs further corroboration before it is trusted.
 * "none":   no identifier found anywhere.
 */
export const pageMatchStrength = (
  page: ExtractedPage,
  finalUrl: string,
  identifiers: string[],
): PageMatchStrength => {
  const ids = identifiers.filter((id) => id && id.trim().length > 0);
  const strongSources = [page.title, page.metaDescription, page.ogTitle, page.canonicalUrl ?? "", finalUrl];
  if (ids.some((id) => strongSources.some((src) => src && identifierAppearsInText(src, id)))) {
    return "strong";
  }
  if (ids.some((id) => page.bodyText && identifierAppearsInText(page.bodyText, id))) {
    return "body";
  }
  return "none";
};

/** True when any identifier appears anywhere on the page (any strength). */
export const pageMatchesProduct = (
  page: ExtractedPage,
  finalUrl: string,
  identifiers: string[],
): boolean => pageMatchStrength(page, finalUrl, identifiers) !== "none";

// --- Misc ------------------------------------------------------------------

// Documentation "sub-tab" segments — a product's doc page is usually split into tabs like
// .../Air/hardware-specifications, .../Air/release-notes. The product landing page is the
// parent (.../Air), which is a better link than a lone spec/notes tab.
const DOC_SUBTAB_SEGMENTS = new Set([
  "hardware-specifications", "specifications", "technical-specifications", "tech-specs", "specs",
  "hardware", "release-notes", "getting-started", "installation", "setup", "quick-start",
  "system-requirements", "getting-started-guide",
]);

/** If a URL's last path segment is a documentation sub-tab (hardware-specifications, release-notes,
 *  …), return its parent (the product landing page); otherwise null. Used to prefer .../Air over
 *  .../Air/hardware-specifications. */
export const parentDocSectionUrl = (url: string): string | null => {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length < 2) return null;
    if (!DOC_SUBTAB_SEGMENTS.has(segs[segs.length - 1].toLowerCase())) return null;
    return `${u.origin}/${segs.slice(0, -1).join("/")}${u.search}`;
  } catch {
    return null;
  }
};

/** Part-number prefix (before the first dot or hyphen) when it is meaningful on its own —
 *  some manufacturers use shortened codes in URLs (d&b: Z5012.500 → /accessories/z5012/). */
export const extractPartPrefix = (partNumber: string): string => {
  const prefix = partNumber.split(/[.\-]/)[0] ?? "";
  return prefix.length >= 4 && prefix !== partNumber ? prefix : "";
};

/**
 * The part number with a trailing order/variant suffix removed — e.g. Rittal "8660.034-RT" →
 * "8660.034" (manufacturer pages title it "8660034"), Shure "SM57-LCE" → "SM57". Only strips a
 * short PURE-ALPHA suffix after the final hyphen (so numeric variants like "PVA-2P500" and
 * band codes like "-K3E" are left intact), and only when the core is still specific (≥5
 * normalized chars). Returns "" when nothing safe to strip. Matching the core lands on the
 * exact product or its family page, which is what we want. */
export const stripPartOrderSuffix = (partNumber: string): string => {
  const core = partNumber.replace(/-[A-Za-z]{1,5}$/, "");
  return core !== partNumber && normalizeIdentifier(core).length >= 5 ? core : "";
};

/**
 * Distinguishing spec tokens from a product description — the measurements/ratings/counts that
 * separate one variant from its siblings (e.g. "H:100mm", "D:800mm", "2x500W", "5m", "8-channel",
 * "1U"). Used to make the LLM verification judge reject a same-TYPE page at the wrong SIZE/rating,
 * which a type-only judgement would otherwise accept. Returns [] when the description carries no
 * such tokens (then verification falls back to type matching, as before).
 */
export const extractSpecTokens = (description: string): string[] => {
  if (!description) return [];
  const tokens = new Set<string>();
  const add = (s: string) => tokens.add(s.replace(/\s+/g, "").replace(/×/g, "x").toLowerCase());
  // Not preceded by an alphanumeric — so "6" inside "CAT6" or a part number isn't treated as a spec.
  const NB = "(?<![A-Za-z0-9.])";
  // NxM configuration codes: "2x500", "4×8" (may carry a trailing unit like "2x500W").
  for (const m of description.matchAll(new RegExp(`${NB}\\d+\\s?[x×]\\s?\\d+`, "gi"))) add(m[0]);
  // number + unit ("mm" precedes "m" so "800 mm" captures "mm"); "u" handled separately below.
  const unit = new RegExp(
    `${NB}\\d+(?:[.,]\\d+)?\\s?(mm|cm|kw|kv|kg|khz|mhz|ghz|hz|db|inch(?:es)?|ohms?|ω|meters?|metres?|w|v|a|m)\\b`,
    "gi",
  );
  for (const m of description.matchAll(unit)) add(m[0]);
  // Rack units, attached only ("1U", "3U") — not "U/UTP".
  for (const m of description.matchAll(new RegExp(`${NB}\\d+u\\b`, "gi"))) add(m[0]);
  // "8-channel", "16 port", "3-way" counts.
  for (const m of description.matchAll(
    new RegExp(`${NB}\\d+[-\\s]?(channels?|ports?|way|cores?|pins?|poles?|bands?|zones?)\\b`, "gi"),
  )) {
    add(m[0]);
  }
  return Array.from(tokens).slice(0, 10);
};

export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};
