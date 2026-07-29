// Pure helpers for the add-weblinks pipeline (src/app/api/products/add-weblinks/route.ts)
// and its client callers. No I/O here — everything is unit-testable (see __tests__/webLinkResolution.test.ts).

/** Result status of a web-link search proposal — single source of truth for the
 *  route, the client helper and the preview dialog.
 *  - previewed: a link was found and fully verified (fetched + content/English checks passed).
 *  - unverified: a candidate was found on the manufacturer's site but the page could not be
 *    fetched to verify (bot-protected); offered for human review, never auto-applied.
 *  - not_found / error: no usable candidate. */
export type WebLinkStatus = "previewed" | "unverified" | "not_found" | "error";

/** How a proposed link was verified:
 *  - "content": part/model found in the page's own title/meta/og (the page is ABOUT the product).
 *  - "index":   the page renders nothing readable for us (JS-only catalog), but the search index
 *               returned this exact URL with a title naming this model. The index rendered the
 *               page; we didn't. This is the ONLY evidence that separates a real catalog URL from
 *               one pattern-filled from the part number — such sites answer HTTP 200 for any SKU.
 *  - "llm":     page content judged to be this specific product's page by the model.
 *  - "family":  page judged to be only the product FAMILY/range page, not this model's own page.
 *               Proposed as a weak last resort, never pre-selected in the review dialog.
 *  - "url":     legacy, no longer produced (page unreachable but URL carried the identifier). */
export type WebLinkVerification = "content" | "index" | "llm" | "family" | "url";

/** Verification tiers, best first — the route keeps searching for a better tier instead of
 *  accepting whatever the first candidate happens to score (which is how a product-family page
 *  won over a per-model page for every SKU in a family). */
export const VERIFICATION_RANK: Record<WebLinkVerification, number> = {
  content: 0,
  index: 1,
  llm: 2,
  family: 3,
  url: 4,
};

/** True when `a` is a strictly better verification tier than `b`. */
export const isBetterVerification = (a: WebLinkVerification, b: WebLinkVerification): boolean =>
  VERIFICATION_RANK[a] < VERIFICATION_RANK[b];

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

/**
 * Strict, token-bounded identifier match against raw text (typically a search-result title).
 * Unlike identifierAppearsInText, the match may NOT be followed or preceded by another
 * alphanumeric character — separators inside the identifier stay flexible.
 *
 * This is the guard for the "index" verification tier, where a search-result title is the only
 * evidence about a page we cannot read. The loose matcher deliberately allows letter neighbours
 * (variant suffixes like "hp1290i-wh"), which here would accept a SIBLING product: model
 * "IS6-112W" would match the title "Community IS6-112WR", and "MASK6C-W" must not match
 * "Desono MASK6CT-W". Those are different loudspeakers.
 */
export const identifierMatchesAsToken = (rawText: string, identifier: string): boolean => {
  const trimmed = identifier?.trim();
  if (!rawText || !trimmed || normalizeIdentifier(trimmed).length < 3) return false;
  // Build a pattern where a separator may appear at every letter↔digit boundary as well as wherever
  // the identifier already has one, so "IS6-112W" also matches "IS6 112W" / "IS6112W" and "QU5"
  // matches the site's "Qu-5" — a real miss: Allen & Heath titles the QU5 page "Qu-5 / Qu-5D", and
  // without this the product's own page was rejected as not naming it.
  //
  // This stays strict where it counts: digit runs are never split, and the trailing boundary below
  // still refuses "IS6-112WR" for "IS6-112W" and "MASK6CT-W" for "MASK6C-W".
  const pattern = trimmed
    .split(/[\s\-_./]+/)
    .filter(Boolean)
    .flatMap((chunk) => chunk.match(/\d+|[A-Za-z]+|[^A-Za-z0-9]+/g) ?? [chunk])
    .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\-_./]*");
  if (!pattern) return false;
  try {
    return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "i").test(rawText);
  } catch {
    return false;
  }
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
//
// Help-centre paths are included: a measured run accepted QSC's
// reflect.qsc.com/help/Content/Core_Management/Licensing.htm as a "family" match for a hardware
// part. Note /docs/ and /documentation/ are deliberately NOT here — for some brands a doc-site page
// IS the best available product page (Haivision's doc.haivision.com), which parentDocSectionUrl
// exists to tidy up.
export const isArticleOrNewsPath = (path: string): boolean =>
  isSupportCommunityPath(path) ||
  // Forum/discussion paths are here because "/community/" did not cover them: Avid's user forum
  // lives at duc.avid.com/home/forum/…, and a measured run offered the thread "post-facility-for-adr-
  // in-toronto" as a product link (the headline-slug heuristic missed it — only "for" counted).
  // "/t/<slug>/<id>" is Discourse's thread URL — the shape of every modern manufacturer forum, and
  // it contains none of the words above.
  /^\/t\/[^/]+\/\d+/.test(path) ||
  /\/article\/|\/articles\/|\/news\/|\/blog\/|\/press(-release)?\/|\/community\/|\/forums?\/|\/discussion|\/threads?\/|\/topic\/|\/board\/|showthread|viewtopic|\/help\/|\/faq\/|\/licens(e|ing)\//.test(
    path,
  );

/**
 * True when the HOST is a help portal or a user forum rather than the product site.
 *
 * Checking the path is not enough, twice over:
 *  - QSC's licensing article was rejected at reflect.qsc.com/help/… and came straight back as
 *    q-syshelp.qsc.com/Content/… — same content, "help" in the subdomain instead of the path.
 *  - a Discourse forum has no "/forum/" in its path at all: the reported false positive was
 *    forums.allen-heath.com/t/new-qu5-issues-with-recording-and-playback/30343, accepted as a
 *    product page because the thread happened to quote the part number.
 * Documentation hosts (doc./docs./pubs.) are deliberately NOT included: for some brands a doc-site
 * page is the best product page available.
 */
export const isHelpPortalHost = (host: string): boolean => {
  const labels = host.toLowerCase().split(".");
  // Only the subdomain labels are examined, never the registrable domain itself, so a brand called
  // "helpsystems.com" or "communityloudspeakers.com" is not condemned by its own name.
  return labels
    .slice(0, -2)
    .some((label) => /help|faq|knowledge|answers|customercare|forum|community|discuss/.test(label));
};

// --- Page-content extraction and verification ------------------------------

export type ExtractedPage = {
  title: string;
  metaDescription: string;
  ogTitle: string;
  /** First <h1>, collapsed. On rendered catalog pages this is the most reliable product-name
   *  carrier — and on a dead SKU it is where the site prints "… ITEM NOT FOUND OR NOT AVAILABLE"
   *  while <title> stays generic, so it is read for both purposes. */
  h1: string;
  /** OpenGraph type — "article"/"blog" for news/blog posts, "product"/"website" otherwise. */
  ogType: string;
  /** <html lang="..."> value, lowercased (e.g. "en", "en-us", "it", "it-it"), or "". */
  htmlLang: string;
  /** og:locale meta, lowercased (e.g. "it_it"), or "". */
  ogLocale: string;
  canonicalUrl: string | null;
  /** Identifiers published in the page's structured data (JSON-LD sku / mpn / productID / gtin).
   *  Many manufacturers put the real order code ONLY here — Extron's product pages are titled with a
   *  descriptive name and carry "sku": "70-201-01" in JSON-LD — so without reading it, a page can be
   *  accepted on a name match while the part number goes unchecked. */
  structuredIds: string[];
  /** <link rel="alternate" hreflang="…"> entries. Regionalised manufacturer sites publish these, so
   *  they are the site's own statement of where its English version lives — better evidence than
   *  guessing locale path segments. */
  alternates: Array<{ hreflang: string; href: string }>;
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

  const h1Match = capped.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1Match
    ? decodeEntities(h1Match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
    : "";

  // Structured data: the identity-bearing values from every JSON-LD block. Scanned with a regex
  // rather than JSON.parse because these blocks are routinely truncated by our byte cap or contain
  // invalid JSON, and one bad block must not cost us the rest.
  const structuredIds: string[] = [];
  const jsonLdBlocks =
    capped.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of jsonLdBlocks) {
    for (const m of block.matchAll(
      /"(?:sku|mpn|productID|gtin13|gtin12|gtin|model)"\s*:\s*"([^"]{2,64})"/gi,
    )) {
      const value = decodeEntities(m[1]).trim();
      if (value && !structuredIds.includes(value)) structuredIds.push(value);
    }
    if (structuredIds.length >= 40) break;
  }

  const metaDescription = findMetaContent(capped, "name", "description");
  const ogTitle = findMetaContent(capped, "property", "og:title");
  const ogType = findMetaContent(capped, "property", "og:type").toLowerCase();
  const ogLocale = findMetaContent(capped, "property", "og:locale").toLowerCase();
  const htmlTag = capped.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const htmlLang = (attrValue(htmlTag, "lang") ?? "").trim().toLowerCase();

  let canonicalUrl: string | null = null;
  const alternates: Array<{ hreflang: string; href: string }> = [];
  const linkTags = capped.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = attrValue(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!canonicalUrl && rel.includes("canonical")) {
      canonicalUrl = attrValue(tag, "href");
      continue;
    }
    if (rel.includes("alternate")) {
      const hreflang = (attrValue(tag, "hreflang") ?? "").trim().toLowerCase();
      const href = (attrValue(tag, "href") ?? "").trim();
      if (hreflang && href) alternates.push({ hreflang, href });
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

  return { title, metaDescription, ogTitle, h1, ogType, htmlLang, ogLocale, canonicalUrl, structuredIds, alternates, bodyText };
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

/**
 * The English alternates a page declares, best first — European English ahead of the rest, matching
 * the company's market. Resolved against the page's own URL so relative hrefs work.
 *
 * This replaces guesswork: the locale-swap ladder tries invented paths like /en-GB/…, which fails
 * whenever a site's English version lives somewhere structurally different. hreflang is the site
 * telling us the answer.
 */
export const englishAlternates = (page: ExtractedPage, pageUrl: string): string[] => {
  const rank = (rawHreflang: string): number => {
    // Lower-cased here rather than trusting the caller: extractPageContent normalizes, but a page
    // object built by hand (or a future extractor) must not silently fall to the bottom rank.
    const hreflang = (rawHreflang ?? "").trim().toLowerCase();
    if (/^en[-_](gb|ie|eu)$/.test(hreflang)) return 0;
    if (hreflang === "en" || hreflang === "x-default") return 1;
    if (/^en[-_](us|ca|au|nz|in|sg|za)$/.test(hreflang)) return 2;
    if (hreflang.startsWith("en")) return 3;
    return -1;
  };
  return page.alternates
    .map((alt) => ({ ...alt, r: rank(alt.hreflang) }))
    .filter((alt) => alt.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((alt) => {
      try {
        return new URL(alt.href, pageUrl).toString();
      } catch {
        return "";
      }
    })
    .filter((href) => href && href !== pageUrl);
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

/**
 * True when a page is a WAF / bot wall rather than site content: Cloudflare's interstitial, an
 * "Access Denied" notice, a captcha. Such a page still MENTIONS the brand (in its own domain name,
 * copyright line or the challenge text), so a naive "does the homepage mention the brand?" check
 * treats it as proof — which is how pro.sony's "Access Denied" page passed a hand-rolled probe.
 * Nothing may be concluded from a page like this except "we were not allowed to look".
 */
export const looksLikeAccessWall = (page: ExtractedPage): boolean => {
  const probe = `${page.title} ${page.h1}`;
  return /just a moment|access denied|attention required|are you a (human|robot)|verify (you are|your) human|checking your browser|request blocked|403 forbidden|unusual traffic/i.test(
    probe,
  );
};

/** True when a fetched page is a news/blog/press article rather than a product page:
 *  OpenGraph type says so, or the URL slug reads like a headline. */
export const looksLikeArticlePage = (page: ExtractedPage, finalUrl: string): boolean =>
  /article|blog|news/.test(page.ogType) || hasHeadlineSlug(finalUrl);

/**
 * Heuristic soft-404 detection: an HTTP-200 page that says the product doesn't exist.
 *
 * The <h1> is checked separately and strictly, because that is where client-rendered catalogs put
 * the bad news while <title> stays generic — a fabricated biamp SKU renders
 * title "Product Details - products.biamp.com" with h1 "999-99999-99999 - ITEM NOT FOUND OR NOT
 * AVAILABLE", and the phrase sits far past the first 300 characters of body text. This check MUST
 * run before any identifier matching: that h1 contains the part number we searched for, so a dead
 * page would otherwise look like a page that names our product.
 */
export const looksLikeSoftNotFound = (page: ExtractedPage): boolean => {
  if (page.h1 && titleLooksDead(page.h1)) return true;
  const probe = `${page.title} ${page.h1} ${page.bodyText.slice(0, 300)}`;
  return /page (was )?not found|page (is )?(currently )?unavailable|\b404\b|no longer available|does(n'?t| not) exist|niet gevonden|nicht gefunden|introuvable|non trovat/i.test(
    probe,
  );
};

/**
 * Soft-404 detection for a SEARCH-INDEX title/snippet rather than a fetched page.
 *
 * Needed because the "index" tier trusts the crawler's title for pages we cannot read — and search
 * indexes happily list DEAD catalog SKUs. Google returns products.biamp.com entries titled
 * "920-01955-00001 - item not found or not available", and one whose title is the site's raw i18n
 * key ("ecom.product_detail.description.item_dash_not_found"). Our own fetch of those URLs returns
 * the same empty shell as a live SKU, so without this check a retired part number whose code sits
 * in the URL would be accepted as index-verified.
 */
// Words that turn a title from "this IS the product" into "this is ABOUT/FOR the product" —
// accessory and compatibility listings name the model they attach to, and must not confirm it.
const COMPATIBILITY_MARKER = /\b(for|compatible|compatibility|accessor(y|ies)|spare|replacement|upgrade|vs\.?|versus|bundle|kit for)\b/i;

// Words that appear in the ModelNumber column but name a CATEGORY, not a product. Real data: 468 of
// Soundtube's 469 rows carry the model "Accessory", and two of them were "confirmed" by a search
// result titled "…Accessory…" — the match was real, the conclusion was nonsense. A generic word can
// never identify a product, however long it is.
const GENERIC_IDENTIFIER =
  /^(accessor(y|ies)|spare|spares|part|parts|various|misc(ellaneous)?|other|others|option|options|service|services|cable|cables|bracket|brackets|mount|mounts|adapter|adaptor|kit|kits|set|sets|module|modules|licen[cs]e|licen[cs]es|software|hardware|unknown|none|n\/?a|tbd|generic|standard|assembly|accessories kit)$/i;

/**
 * An identifier specific enough to carry the index tier on its own: not a generic category word,
 * and either containing a digit or being a reasonably long word. A bare short word ("Air", "One",
 * "Pro") names a range, not a model.
 */
export const isDistinctiveIdentifier = (identifier: string): boolean => {
  const trimmed = (identifier ?? "").trim();
  if (GENERIC_IDENTIFIER.test(trimmed)) return false;
  const normalized = normalizeIdentifier(trimmed);
  if (normalized.length < 3) return false;
  return /\d/.test(normalized) || normalized.length >= 5;
};

/**
 * Does a SEARCH-INDEX title establish that its page is about this product?
 *
 * Stricter than "the identifier appears somewhere in the title", because this is the sole evidence
 * for pages we cannot read:
 *  - the identifier must be distinctive (see isDistinctiveIdentifier),
 *  - it must match token-bounded (so MASK6C-W ≠ MASK6CT-W), and
 *  - it must appear in the title's LEADING segment (before "|", "–", " - ", etc.) and that segment
 *    must not read as a compatibility/accessory listing ("Wall mount for MASK6C-W").
 */
export const indexTitleConfirms = (title: string, identifiers: string[]): boolean => {
  const text = (title ?? "").trim();
  if (!text) return false;
  const lead = text.split(/\s[|–—·]\s|\s-\s|\||:/)[0].trim() || text;
  if (COMPATIBILITY_MARKER.test(lead)) return false;
  return identifiers.some((id) => isDistinctiveIdentifier(id) && identifierMatchesAsToken(lead, id));
};

export type ShellVerdict = "index" | "no-witness" | "dead-item" | "not-about-product";

/**
 * Decides whether a page that rendered NOTHING readable may still be proposed.
 *
 * The page itself is useless as evidence — such sites return an identical shell for a real SKU and
 * for a fabricated one, and echo the requested path into <link rel="canonical">. So acceptance
 * needs an independent witness: the search index listed this exact URL, its title is not a
 * dead-item placeholder, and either that title names this product or the indexed URL itself
 * carries a distinctive, token-bounded identifier.
 */
export const classifyShellCandidate = (opts: {
  /** The index entry for the exact URL being accepted, or null when the index never listed it. */
  indexHit: { title: string } | null;
  /** Per-model identifiers (part number, part core, model). NEVER a family-level prefix. */
  identifiers: string[];
  /** The URL that would be stored, for the identifier-in-URL half of the test. */
  url: string;
}): ShellVerdict => {
  const { indexHit, identifiers, url } = opts;
  if (!indexHit) return "no-witness";
  if (titleLooksDead(indexHit.title)) return "dead-item";
  if (indexTitleConfirms(indexHit.title, identifiers)) return "index";
  const urlNamesProduct = identifiers.some(
    (id) => isDistinctiveIdentifier(id) && identifierMatchesAsToken(url, id),
  );
  return urlNamesProduct ? "index" : "not-about-product";
};

export const titleLooksDead = (title: string): boolean => {
  const text = title.trim();
  if (!text) return false;
  // A bare dotted i18n key means the page rendered a missing-translation placeholder.
  if (/^[a-z0-9_]+(\.[a-z0-9_]+){2,}$/i.test(text)) return true;
  return /item[\s_-]*(dash[\s_-]*)?not[\s_-]*found|not\s*available|no longer available|discontinued|page (was )?not found|\b404\b/i.test(
    text,
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
  const strongSources = [page.title, page.h1, page.metaDescription, page.ogTitle, ...page.structuredIds, page.canonicalUrl ?? "", finalUrl];
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

/**
 * WHERE a strong match came from — the page's own words, or just a URL.
 * "page": the identifier is in the title/h1/meta/og:title, i.e. the site itself says this page is
 *         about the product. Callers MUST reject soft-404s first: a dead catalog SKU prints our own
 *         part number in its "… ITEM NOT FOUND" heading, which would otherwise read as page
 *         evidence (looksLikeSoftNotFound covers exactly that).
 * "url":  the identifier only appears in the final URL or the canonical link. That is far weaker
 *         evidence than it looks: a URL is whatever we asked for, and JS-only catalogs echo the
 *         requested path straight back into <link rel="canonical"> while rendering no product
 *         content at all — so a URL pattern-filled from our part number "matches" itself.
 * null:   no strong match.
 */
export type StrongMatchSource = "page" | "url" | null;

export const strongMatchSource = (
  page: ExtractedPage,
  finalUrl: string,
  identifiers: string[],
): StrongMatchSource => {
  const ids = identifiers.filter((id) => id && id.trim().length > 0);
  const pageSources = [page.title, page.h1, page.metaDescription, page.ogTitle, ...page.structuredIds];
  if (ids.some((id) => pageSources.some((src) => src && identifierAppearsInText(src, id)))) return "page";
  const urlSources = [finalUrl, page.canonicalUrl ?? ""];
  if (ids.some((id) => urlSources.some((src) => src && identifierAppearsInText(src, id)))) return "url";
  return null;
};

/** Body text below this length means the fetch returned page furniture only (nav, cookie banner)
 *  — a client-rendered shell. Biamp's catalog shells come back at ~560 chars; a real product page
 *  with any copy on it clears this easily (its family page: ~8,000). */
export const SHELL_BODY_TEXT_MAX = 900;

/** True when a fetched page carries no readable content — a JS-rendered shell. We cannot judge
 *  such a page, and (critically) it looks identical for a real SKU and a made-up one. */
export const isContentlessShell = (page: ExtractedPage): boolean =>
  page.bodyText.trim().length < SHELL_BODY_TEXT_MAX && !page.metaDescription.trim();

// --- Misc ------------------------------------------------------------------

// Documentation "sub-tab" segments — a product's doc page is usually split into tabs like
// .../Air/hardware-specifications, .../Air/release-notes. The product landing page is the
// parent (.../Air), which is a better link than a lone spec/notes tab.
const DOC_SUBTAB_SEGMENTS = new Set([
  "hardware-specifications", "specifications", "technical-specifications", "tech-specs", "specs",
  "hardware", "release-notes", "getting-started", "installation", "setup", "quick-start",
  "system-requirements", "getting-started-guide",
  // Trailing "resources"/"downloads" tabs: allen-heath.com/hardware/qu/qu-5-qu-5d/resources/ is the
  // downloads tab of a product whose own page is one level up. A salesperson wants the product.
  "resources", "downloads", "documentation", "documents", "software", "firmware", "manuals",
  "support", "faqs", "videos", "gallery",
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
 * The part number with a trailing LANGUAGE suffix removed — "2550-00020-00_EN" → "2550-00020-00".
 *
 * These come from price-list imports, not from the manufacturer: an underscore plus a two-letter
 * language code marks the language of the *line item*. Searching the raw string finds nothing
 * anywhere (measured: an Avid training SKU with "_EN" returned zero results while the same code
 * without it resolved), so it must never be used as the search term. Returns "" when there is
 * nothing to strip.
 */
export const stripPartLanguageSuffix = (partNumber: string): string => {
  const stripped = (partNumber ?? "").replace(
    /_(en|de|fr|it|es|nl|pt|pl|el|sv|da|fi|no|cs|hu|ro|ru|tr|zh|ja|ko|ar)$/i,
    "",
  );
  return stripped !== partNumber && normalizeIdentifier(stripped).length >= 4 ? stripped : "";
};

/**
 * How specifically a page identified the product — which of the product's identifiers actually
 * matched. The distinction matters because the identifiers are not equally trustworthy:
 *
 *  - "exact":  the full part number or the model number. Trustworthy.
 *  - "core":   only the part number with its trailing suffix stripped. AMBIGUOUS — for Neutrik
 *              "-D" is a bulk-packaging suffix and the manufacturer 301s the full code to the base
 *              page (so the base page is correct), while for Soundtube "-S"/"-C"/"-R" mean Surface
 *              vs Corner vs Rear mount, i.e. genuinely different products with their own pages. The
 *              caller must probe for the exact-part page before trusting a core match.
 *  - "prefix": only the family-level prefix (d&b "Z5012" from "Z5012.500"). That is a base-code /
 *              family page at best, never proof of this variant.
 */
export type MatchSpecificity = "exact" | "core" | "prefix" | null;

export const matchSpecificity = (
  haystack: string,
  ids: { partNumber?: string; modelNumber?: string; partCore?: string; partPrefix?: string },
): MatchSpecificity => {
  const hit = (id?: string) => !!id && identifierAppearsInText(haystack, id);
  if (hit(ids.partNumber) || hit(ids.modelNumber)) return "exact";
  if (hit(ids.partCore)) return "core";
  if (hit(ids.partPrefix)) return "prefix";
  return null;
};

// Words that start a description without naming the product ("Passive 10\" subwoofer…").
const DESCRIPTION_LEAD_NOISE =
  /^(the|a|an|new|passive|active|professional|premium|compact|universal|optional|includes?|including|for|with|set|kit)$/i;

/**
 * The product's NAME, mined from the front of its description.
 *
 * Why this matters more than it sounds: the ModelNumber column is empty for most of the catalog —
 * measured 2026-07-29, QSC 0 of 437 rows, Barco 0 of 683, Legrand AV 0 of 3,555, d&b 7 of 794 — so
 * for those products the only search term left is an internal order code that the manufacturer often
 * never publishes. The description almost always opens with the real name instead:
 *   "EW-DP ENG SET (U1/5) Portable digital wireless set. Includes…"  → "EW-DP ENG SET (U1/5)"
 *   "SM1001p Corner Mount Bracket"                                   → "SM1001p Corner Mount Bracket"
 *   "WG433 ACSR MediaCentral | Production Management System Support"  → "WG433 ACSR MediaCentral"
 * An adjudication panel found an Avid training course from exactly this text after its part number
 * returned zero results anywhere on the web.
 *
 * Deliberately used as a SEARCH TERM ONLY, never as verification evidence: it is a heuristic slice of
 * free text, and letting it confirm a page would trade away the content tier's measured precision.
 */
export const extractProductNameFromDescription = (description: string): string => {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Cut at the first structural break: a sentence end, or a separator that ends the name.
  const head = text.split(/(?:\.\s)|(?:\s[|;:–—]\s)|(?:,\s)|(?:\s-\s)/)[0].trim();
  const tokens = head.split(" ").filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    const bare = token.replace(/^[("']+|[)"',.]+$/g, "");
    if (!bare) break;
    if (kept.length === 0 && DESCRIPTION_LEAD_NOISE.test(bare)) continue;
    // A product's name is built from CODES, not from prose: something with a digit, an all-caps
    // abbreviation, an internal capital ("MediaCentral"), or a parenthesised band code. A plain
    // Title-case English word starts the marketing copy — "EW-DP ENG SET (U1/5) Portable digital
    // wireless set" is a name followed by a description, and only the first four tokens are the name.
    const isCode =
      /\d/.test(bare) ||
      /^[("]/.test(token) ||
      (bare === bare.toUpperCase() && /[A-Z]/.test(bare)) ||
      /[a-z][A-Z]/.test(bare);
    if (!isCode) break;
    kept.push(token);
    if (kept.length >= 6) break;
  }
  const name = kept.join(" ").replace(/[,;:]+$/, "").trim();
  if (!name) return "";
  const normalized = normalizeIdentifier(name);
  if (normalized.length < 4) return "";
  // A single generic word ("Accessory") is not a name; a code or a multi-word phrase is.
  if (kept.length === 1 && !/\d/.test(name) && GENERIC_IDENTIFIER.test(name)) return "";
  return name;
};

/**
 * A URL template learned from a link that VERIFIED, e.g.
 * "belden.com/products/…/fiber-patch-cords/fp5lulu002m" + part "FP5LULU002M"
 *   → { template: "…/fiber-patch-cords/{part}", transform: "lower" }
 * so the brand's other products can be resolved by construction instead of another paid search.
 * Returns null when the URL does not contain the part number in any recognisable form.
 */
export type UrlTemplate = { template: string; transform: "raw" | "lower" | "upper" | "strip" };

export const deriveUrlTemplate = (url: string, partNumber: string): UrlTemplate | null => {
  const part = (partNumber ?? "").trim();
  if (!url || normalizeIdentifier(part).length < 4) return null;
  const forms: Array<{ value: string; transform: UrlTemplate["transform"] }> = [
    { value: part, transform: "raw" },
    { value: part.toLowerCase(), transform: "lower" },
    { value: part.toUpperCase(), transform: "upper" },
    { value: normalizeIdentifier(part), transform: "strip" },
  ];
  for (const form of forms) {
    if (!form.value) continue;
    const idx = url.indexOf(form.value);
    if (idx === -1) continue;
    // Only the LAST occurrence is replaced, so a part number that also appears in a category
    // segment cannot corrupt the template.
    const last = url.lastIndexOf(form.value);
    return {
      template: `${url.slice(0, last)}{part}${url.slice(last + form.value.length)}`,
      transform: form.transform,
    };
  }
  return null;
};

export const applyUrlTemplate = (tpl: UrlTemplate, partNumber: string): string => {
  const part = (partNumber ?? "").trim();
  const value =
    tpl.transform === "lower"
      ? part.toLowerCase()
      : tpl.transform === "upper"
        ? part.toUpperCase()
        : tpl.transform === "strip"
          ? normalizeIdentifier(part)
          : part;
  return tpl.template.replace("{part}", value);
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

// Analytics/click-tracking query parameters. Search results routinely carry these (a Facebook
// or HubSpot click id on an otherwise perfect product URL); storing them would save a link that
// is both ugly and tied to someone else's campaign.
// Analytics and click-tracking, plus cart/quantity parameters: a manufacturer's own redirect can
// append ?quantity=1 (Soundtube does), which is shopping-basket state, not part of the page address.
const TRACKING_PARAM =
  /^(utm_|_ga$|_gac$|_hs|__hs|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|srsltid$|igshid$|yclid$|s_kwcid$|ef_id$|quantity$|qty$|add-to-cart$)/i;

/** The URL without analytics/tracking parameters (everything else — real routing params like
 *  ?variantId=… — is preserved). Returns the input unchanged when it isn't parseable. */
export const stripTrackingParams = (url: string): string => {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
    }
    let out = parsed.toString();
    if (out.endsWith("?")) out = out.slice(0, -1);
    return out;
  } catch {
    return url;
  }
};

/**
 * Identity key for "is this the same page?" comparisons: host (sans www) + path + the remaining
 * query parameters, sorted. Lowercased, trailing slash dropped.
 *
 * The query is PART of the identity, not noise: plenty of catalogs address a specific variant with
 * ?variantId=… or ?sku=…, so dropping it would (a) make two legitimately different per-variant
 * links look like one page shared across products, and (b) let an indexed sibling vouch for a URL
 * the index never listed. Tracking parameters are removed separately by stripTrackingParams before
 * a link gets this far.
 */
export const normalizedUrlKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    const params = [...parsed.searchParams.entries()]
      .map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`)
      .sort()
      .join("&");
    return params ? `${host}${path}?${params}` : `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
};

/** The last meaningful path segment (product slug / SKU), lowercased — "" when there is none. */
export const urlLeafSegment = (url: string): string => {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return (segs[segs.length - 1] ?? "").toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Search-index queries for one product, best first. Model-name-led on purpose: the part number
 * we hold is an internal order/distributor code. Searching by it returns either nothing or a
 * SIBLING variant's page (biamp "930-00641-00002" returns the SKU ...-00004, a different
 * loudspeaker), while the quoted model name lands on the product's own page.
 */
export const buildIndexSearchQueries = (opts: {
  brand: string;
  modelNumber: string;
  partNumber: string;
  partNumberCore?: string;
  /** Family-level code (d&b "Z5815" from "Z5815.001") — searched last, see below. */
  partPrefix?: string;
  domain: string;
}): string[] => {
  const { brand, modelNumber, partNumber, partNumberCore, domain } = opts;
  const model = modelNumber.trim();
  const part = partNumber.trim();
  const core = partNumberCore?.trim() ?? "";
  const prefix = opts.partPrefix?.trim() ?? "";
  const queries = [
    model && domain ? `site:${domain} "${model}"` : "",
    model && brand ? `${brand} "${model}"` : "",
    // The base part number outranks the full order code: the trailing order/region/colour suffix is
    // usually absent from the manufacturer's own pages (see stripPartOrderSuffix).
    core && core !== part && domain ? `site:${domain} "${core}"` : "",
    part && domain ? `site:${domain} "${part}"` : "",
    // The family-level prefix is the last resort, and sometimes the only thing published: d&b sells
    // Z5815.001 (white) and .000 (black) but publishes ONE page, /accessories/z5815/. Without this
    // query the pipeline found no candidate at all and fell back to an unrelated series page.
    prefix && prefix !== part && prefix !== core && domain ? `site:${domain} "${prefix}"` : "",
  ].filter(Boolean);
  return Array.from(new Set(queries)).slice(0, prefix ? 4 : 3);
};

/**
 * How many products a run gave each link. More than one product on the same page means the page
 * identifies a FAMILY, not a model — whatever tier verified it — so the dialog flags those rows and
 * leaves them unselected. Counted over the whole run because the search is chunked: the server sees
 * 10 products per request and cannot notice this itself.
 */
export const countProductsPerLink = (
  results: Array<{ productId: number; webLink: string | null }>,
): Map<string, number> => {
  const productsByKey = new Map<string, Set<number>>();
  for (const r of results) {
    if (!r.webLink) continue;
    const key = normalizedUrlKey(r.webLink);
    const set = productsByKey.get(key) ?? new Set<number>();
    set.add(r.productId);
    productsByKey.set(key, set);
  }
  return new Map([...productsByKey].map(([key, ids]) => [key, ids.size]));
};

// Documentation / support / download sections. A page here may share its leaf with the real
// product page (…/products/sm7b and …/guide/sm7b), so the two must never be collapsed into one.
const NON_PRODUCT_SECTION =
  /\/(docs?|guide|guides|manual|manuals|support|kb|knowledge|downloads?|assets|help|faq|training|forums?|discussions?|threads?|topic|board)\//i;

/**
 * Collapses candidates that address the SAME product page through different routes — enterprise
 * catalogs expose one SKU under many category paths (…/o/category/<uuid>|<uuid>/cn/Subwoofers/
 * ecom-item/910-01492 and …/o/cn/Subwoofers/d/Desono-SUB2201-BL/ecom-item/910-01492).
 *
 * Deliberately conservative, because "same leaf ⇒ same page" is false in general:
 *  - only within the same host (pubs.shure.com/guide/SM7B is not www.shure.com/…/sm7b),
 *  - only for a leaf specific enough to be a SKU (≥5 chars and containing a digit),
 *  - never across a docs/support/downloads section boundary,
 *  - and the FIRST (best-ranked) candidate always wins. Ranking carries relevance and language
 *    preference; picking the shortest string instead would quietly swap a ranked product page for
 *    an unranked twin.
 */
export const dedupeByUrlLeaf = <T extends { link: string }>(candidates: T[]): T[] => {
  const seenLeaf = new Set<string>();
  const out: T[] = [];
  for (const candidate of candidates) {
    const leaf = urlLeafSegment(candidate.link);
    let host = "";
    let path = "";
    try {
      const parsed = new URL(candidate.link);
      host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      path = parsed.pathname;
    } catch {
      out.push(candidate);
      continue;
    }
    const collapsible = leaf.length >= 5 && /\d/.test(leaf) && !NON_PRODUCT_SECTION.test(path);
    if (!collapsible) {
      out.push(candidate);
      continue;
    }
    const key = `${host}|${leaf}`;
    if (seenLeaf.has(key)) continue;
    seenLeaf.add(key);
    out.push(candidate);
  }
  return out;
};

/**
 * Candidate URLs built by taking a SIBLING product's real catalog URL and swapping its SKU segment
 * for this product's part number.
 *
 * This is URL construction, which the pipeline otherwise forbids outright — the proposer was caught
 * doing exactly this and producing pages that do not exist. It is allowed here under one condition,
 * enforced by the caller: a constructed URL may only be accepted after a HEADLESS RENDER shows the
 * page naming this product. That is a real verification, not a guess: an invented biamp SKU renders
 * `h1 = "999-99999-99999 - ITEM NOT FOUND OR NOT AVAILABLE"`, while a genuine one renders
 * `h1 = "Desono MASK6C-W"`.
 *
 * It exists because search indexes are incomplete: MASK6C-W's own catalog page is live and correct,
 * but Google never crawled it — only its MASK6CT/MASK4CT siblings — so no amount of searching finds
 * it, while its sibling's URL shows exactly where it lives.
 *
 * Shortest sibling URL first: fewer contextual segments (category UUIDs, stale product slugs) means
 * fewer ways for the swap to carry another product's context.
 */
export const buildLeafSwapCandidates = (opts: {
  /** Real, indexed URLs on the brand's domain (siblings of this product). */
  indexedUrls: string[];
  partNumber: string;
  partNumberCore?: string;
  max?: number;
}): string[] => {
  const { indexedUrls, partNumber, partNumberCore, max = 2 } = opts;
  const part = partNumber?.trim() ?? "";
  if (!part) return [];
  // Lower-case first: product URLs are overwhelmingly lower-case, and a site that answers the
  // mixed-case form usually does so via a redirect that a throttled fetch can miss (measured on
  // soundtube.com, where /AC-SM1001p-S worked one run and failed the next).
  const base = [part, partNumberCore?.trim() ?? ""].filter((r) => r && isDistinctiveIdentifier(r));
  const replacements = Array.from(new Set(base.flatMap((r) => [r.toLowerCase(), r])));
  if (replacements.length === 0) return [];

  const out: string[] = [];
  const seen = new Set(indexedUrls.map((u) => normalizedUrlKey(u)));
  const bySimplicity = [...indexedUrls].sort((a, b) => a.length - b.length);

  for (const url of bySimplicity) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const segs = parsed.pathname.split("/").filter(Boolean);
    const leaf = segs[segs.length - 1] ?? "";
    // Only a SKU-shaped leaf is swappable, and never one that is already this product.
    if (leaf.length < 5 || !/\d/.test(leaf)) continue;
    if (NON_PRODUCT_SECTION.test(parsed.pathname)) continue;
    if (replacements.some((r) => normalizeIdentifier(r) === normalizeIdentifier(leaf))) continue;

    for (const replacement of replacements) {
      // The query belongs to the sibling (variant ids, category filters) — drop it.
      const candidate = `${parsed.origin}/${[...segs.slice(0, -1), replacement].join("/")}`;
      const key = normalizedUrlKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= max) return out;
    }
  }
  return out;
};

/**
 * A slice of page text for the LLM judge, centred on where the product is actually mentioned.
 *
 * A fixed head-of-page excerpt is the wrong window: on a long product page the model number sits
 * well below the nav, cookie banner and hero copy, so the judge was routinely asked to decide
 * whether a page is about a product using text that never mentions it. When an identifier is found,
 * return the surrounding context; otherwise fall back to the head of the page (which is the right
 * answer for a category or family page — the thing we want it to say FAMILY/NO to).
 */
export const excerptAroundIdentifier = (
  bodyText: string,
  identifiers: string[],
  maxChars: number,
): string => {
  const text = bodyText ?? "";
  if (text.length <= maxChars) return text;
  const haystack = normalizeHaystack(text);
  let bestIdx = -1;
  for (const id of identifiers) {
    const needle = normalizeIdentifier(id ?? "");
    if (needle.length < 4) continue;
    const idx = haystack.indexOf(needle);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) return text.slice(0, maxChars);
  // Normalized offsets are shorter than raw ones (separators were stripped), so scale back into the
  // raw string and keep a generous window on both sides — this only needs to be roughly right.
  const approx = Math.min(text.length - 1, Math.round((bestIdx / Math.max(haystack.length, 1)) * text.length));
  const start = Math.max(0, approx - Math.floor(maxChars / 3));
  return text.slice(start, start + maxChars);
};

export type MergeableCandidate = { link: string; title?: string; fromIndex: boolean };

/**
 * Merges the two candidate sources into one list, best-first, with a quota per source.
 *
 * Ranking (verification stops at the first hard-evidence hit, so order decides the outcome):
 *   0. index hit whose URL carries a distinctive identifier — the index proves the page exists AND
 *      the URL says which product it is,
 *   1. proposal whose URL carries one — same strength of claim, but a proposer URL may have been
 *      pattern-filled from the part number, so it ranks below an indexed one,
 *   2. index hit whose crawled title names the product,
 *   3. remaining index hits,
 *   4. remaining proposals.
 *
 * The quota matters because the index can easily return more hits than the whole per-product
 * candidate budget: without it, category and sibling pages from the index would push every
 * proposal candidate out of the list, losing the source that works for conventional sites.
 */
export const mergeCandidates = (opts: {
  indexHits: Array<{ link: string; title?: string }>;
  proposals: Array<{ link: string }>;
  /** Per-model identifiers used for ranking (no family prefix). */
  identifiers: string[];
  maxIndex: number;
  maxProposals: number;
  max: number;
}): MergeableCandidate[] => {
  const { indexHits, proposals, identifiers, maxIndex, maxProposals, max } = opts;
  const urlNames = (link: string) =>
    identifiers.some((id) => isDistinctiveIdentifier(id) && identifierAppearsInText(link, id));
  const rank = (c: MergeableCandidate): number => {
    if (urlNames(c.link)) return c.fromIndex ? 0 : 1;
    if (c.fromIndex && indexTitleConfirms(c.title ?? "", identifiers)) return 2;
    return c.fromIndex ? 3 : 4;
  };

  const entries: MergeableCandidate[] = [
    ...indexHits.slice(0, maxIndex).map((h) => ({ link: h.link, title: h.title, fromIndex: true })),
    ...proposals.slice(0, maxProposals).map((p) => ({ link: p.link, fromIndex: false })),
  ];
  const seen = new Set<string>();
  return entries
    .map((c, i) => ({ c, r: rank(c), i }))
    // Stable: within a rank the source's own ordering (index query order, proposer ranking) wins.
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ c }) => c)
    .filter((c) => {
      const key = normalizedUrlKey(c.link);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
};

export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};
