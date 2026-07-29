import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import type { ConnectionPool } from "mssql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import { Semaphore } from "../../../../lib/concurrency";
import { normalizeId } from "../../../../lib/normalize";
import { proposeWebLinks } from "../../../../lib/webLinkProposer";
import { searchIndexCandidates, type IndexHit } from "../../../../lib/webLinkIndexSearch";
import { renderPage, isRenderingEnabled } from "../../../../lib/webLinkRender";
import { findInSitemap } from "../../../../lib/webLinkSitemap";
import OpenAI from "openai";
import {
  isRealWebLink,
  normalizeIdentifier,
  hostMatchesDomain,
  isEnglishSegment,
  localePrefixIndex,
  PREFERRED_ENGLISH_LOCALES,
  EUROPEAN_REGIONS,
  parseRegionLangPrefix,
  buildRegionLangEnglishCandidates,
  extractPageContent,
  looksLikeSoftNotFound,
  looksLikeAccessWall,
  isHomepageLanding,
  pageMatchStrength,
  isArticleOrNewsPath,
  isHelpPortalHost,
  hasHeadlineSlug,
  looksLikeArticlePage,
  pageLanguage,
  isEnglishResult,
  urlLanguageIsNonEnglish,
  parentDocSectionUrl,
  extractPartPrefix,
  stripPartOrderSuffix,
  stripPartLanguageSuffix,
  matchSpecificity,
  extractProductNameFromDescription,
  englishAlternates,
  deriveUrlTemplate,
  applyUrlTemplate,
  type UrlTemplate,
  extractSpecTokens,
  identifierAppearsInText,
  identifierMatchesAsToken,
  isDistinctiveIdentifier,
  strongMatchSource,
  isContentlessShell,
  classifyShellCandidate,
  mergeCandidates,
  buildLeafSwapCandidates,
  excerptAroundIdentifier,
  stripTrackingParams,
  normalizedUrlKey,
  isBetterVerification,
  type ExtractedPage,
  type WebLinkStatus,
  type WebLinkVerification,
} from "../../../../lib/webLinkResolution";

export const runtime = "nodejs";

// This route follows the enhance-descriptions three-phase contract:
//   POST { productIds, dryRun: true }            → SEARCH ONLY. Finds and verifies links,
//                                                  returns per-product proposals. Never writes
//                                                  product data (it may persist a VERIFIED brand
//                                                  domain to dbo.Brands.WebDomain — see below).
//   POST { applyPrecomputed: [{productId, webLink}] } → writes reviewed links.
//   PUT  { items: [{productId, webLink|null}] }  → revert helper for client-side undo.
// dryRun is REQUIRED for search so that stale client bundles built against the old contract
// (where POST { productIds } wrote links directly) fail loudly instead of silently searching.

const MAX_PRODUCT_IDS = 200;
const PER_PRODUCT_TIME_BUDGET_MS = 90_000;

// Model for the per-product web-search proposal (see lib/webLinkProposer.ts). The proposal
// stage finds candidate URLs; the fetch-and-verify pipeline below gates every one.
const WEBLINK_SEARCH_MODEL = process.env.WEBLINK_SEARCH_MODEL || "gpt-5.4-mini";
// Model for the page judge (is this page THIS model's page, its family's, or unrelated?). It is the
// last line of defence on readable pages, so it is no longer pinned to the old gpt-4o-mini.
const WEBLINK_JUDGE_MODEL = process.env.WEBLINK_JUDGE_MODEL || "gpt-5.4-mini";
// Window of page text handed to the judge, centred on the product mention.
const JUDGE_EXCERPT_CHARS = 3_000;
// Candidates checked per product, and the quota per source. Two sources now feed one merged,
// rank-ordered list (proposal + search index): the split guarantees the index cannot crowd out the
// proposer (which is the only source that works for conventional, server-rendered sites) and vice
// versa. PER_PRODUCT_TIME_BUDGET_MS stops the loop first when pages are slow.
const MAX_CANDIDATES_PER_TIER = 8;
const MAX_INDEX_CANDIDATES = 5;
const MAX_PROPOSAL_CANDIDATES = 3;
const MAX_SITEMAP_CANDIDATES = 3;
const SITEMAP_WAIT_MS = 2_500;
// Hosts that must never be adopted as a brand's "other storefront", however we arrive at them.
const MARKETPLACE_HOST =
  /(^|\.)(amazon|ebay|aliexpress|alibaba|walmart|bestbuy|newegg|etsy|rakuten|mercadolibre|google|facebook|instagram|youtube|linkedin|x|twitter)\./i;
const PAGE_FETCH_TIMEOUT_MS = 12_000;
const FETCH_RETRY_DELAY_MS = 1_500;
// Longest the route waits for the search-index tier before proceeding without it. Also skipped
// entirely when too little of the per-product budget is left to use the results.
const INDEX_SEARCH_WAIT_MS = 10_000;
const INDEX_SEARCH_MIN_BUDGET_MS = 20_000;
// Whole-request ceiling. The client sends 10 products per request and IIS/ARR in front of the app
// gives up at ~120s; a request that outlives the proxy is reported to the user as a failed chunk
// while the server keeps working, so every product's clock is also bounded by this. 100s keeps a
// 20s margin under the proxy while leaving room for one slow agentic search plus verification.
const REQUEST_DEADLINE_MS = 100_000;
// Ceiling for the agentic web-search proposal specifically (see proposeWebLinks): it runs several
// searches, so it is an order of magnitude slower than the judge calls.
const PROPOSAL_TIMEOUT_MS = 70_000;
// Ceiling for a single OpenAI call. Without it the SDK default (600s, plus its own retries) can
// pin a permit of the module-global openaiSemaphore for far longer than any request lives.
const OPENAI_TIMEOUT_MS = 60_000;
// The page judge answers one word, so it has no business spending a minute. It used to inherit the
// client's 60s ceiling and, being fail-closed, a single slow call both rejected its candidate AND ate
// the budget the constructed-URL stage needed — measured on the biamp MASK6C-W row, twice.
const JUDGE_TIMEOUT_MS = 20_000;
// Headless rendering of a JS-only catalog page costs 7-30s in practice, so it only runs with real
// budget to spare (measured on products.biamp.com, 2026-07-28).
// Whole render allowance. products.biamp.com has needed 21s+ just to paint its product name, so this
// is deliberately close to the ceiling — but not past it: at 34s a 4-product chunk ran into the 100s
// request deadline and lost two products that had resolved a run earlier. The settle wait inside
// (26s) is what actually decides whether the product appears.
const RENDER_MAX_MS = 28_000;
// Minimum budget before a render is attempted at all. Kept LOW on purpose: a render that runs out of
// time is simply a rejection, so a short attempt costs nothing but a chance, while refusing to start
// one costs the answer. At 34s (RENDER_MAX + slack) the late stages were skipping every render with
// "33702ms left" and giving up on products whose page a browser would have confirmed.
const RENDER_MIN_BUDGET_MS = 12_000;
const PAGE_BYTE_CAP = 500_000;

// Bound concurrent outgoing work. Module-global so simultaneous requests share the caps.
// Sized to the client's chunk size (10), NOT smaller: at 4 the ten proposals of a chunk ran in three
// waves, so the last products started their 60-70s agentic search with barely any budget left and
// died on a timeout. The calls are independent and the proposal stage is the long pole, so they must
// overlap.
const openaiSemaphore = new Semaphore(10);
// Sized >= the client chunk size (10) so a chunk runs as a single wave and one HTTP
// request stays comfortably inside the IIS/ARR proxy timeout.
const productSemaphore = new Semaphore(10);

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type ProductRow = {
  ID: number;
  Brand: string | null;
  BrandID: number | null;
  BrandWebDomain: string | null;
  ModelNumber: string | null;
  PartNumber: string | null;
  Description: string | null;
  WebLink: string | null;
};

type ProductResult = {
  productId: number;
  brand: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  oldWebLink: string | null;
  webLink: string | null;
  status: WebLinkStatus;
  verification?: WebLinkVerification;
  note?: string;
};

// --- Outbound call wrappers -------------------------------------------------

/** OpenAI call through a shared semaphore with retry on 429/5xx. Throws on final failure —
 *  callers decide whether that fails open (domain resolution → skip) or closed (validation → reject).
 *
 *  Sampling params are sent ONLY to models that accept them: gpt-5.x rejects `temperature`
 *  outright (the same constraint lib/webLinkProposer.ts documents), so passing it unconditionally
 *  would turn every judge call into an error — which, fail-closed, silently rejects every page. */
const openaiText = async (
  openai: OpenAI,
  model: string,
  input: string,
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<string> => {
  const MAX_RETRIES = 3;
  const acceptsTemperature = /^gpt-4/i.test(model);
  await openaiSemaphore.acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await openai.responses.create(
          {
            model,
            input,
            ...(acceptsTemperature ? { temperature: 0 } : {}),
            stream: false,
          },
          { timeout: timeoutMs },
        );
        return res.output_text?.trim() ?? "";
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        if ((status === 429 || (status !== undefined && status >= 500)) && attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    openaiSemaphore.release();
  }
};

// --- Page fetching -----------------------------------------------------------

type FetchedPage =
  | { kind: "ok"; finalUrl: string; status: number; page: ExtractedPage }
  | { kind: "not_found" }
  | { kind: "not_html" }
  | { kind: "blocked"; status: number | null };

/** GET the candidate page with a browser UA, following redirects, capping the body size.
 *  Distinguishes hard not-founds, bot-blocks/network failures, and readable pages.
 *
 *  Retries ONCE on a pure network failure (connect timeout / reset). Manufacturer sites throttle a
 *  server that checks several products at a time — measured against products.biamp.com, which starts
 *  refusing connections under a burst — and a dropped connection would otherwise be reported to the
 *  user as "no link found" for a product whose page is perfectly fine. An HTTP status (403/500) is
 *  NOT retried: that is an answer, not a lost packet. */
const fetchPage = async (url: string): Promise<FetchedPage> => {
  const first = await fetchPageOnce(url);
  if (first.kind !== "blocked" || first.status !== null) return first;
  await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
  const second = await fetchPageOnce(url);
  if (second.kind !== "blocked" || second.status !== null) {
    console.log(`[weblink] ${url} succeeded on retry after a network failure`);
  }
  return second;
};

const fetchPageOnce = async (url: string): Promise<FetchedPage> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if ([404, 410, 451].includes(res.status)) return { kind: "not_found" };
    if (!res.ok) return { kind: "blocked", status: res.status };

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      return { kind: "not_html" };
    }

    let html = "";
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (bytes >= PAGE_BYTE_CAP) {
          void reader.cancel().catch(() => {});
          break;
        }
      }
    } else {
      html = (await res.text()).slice(0, PAGE_BYTE_CAP);
    }

    return { kind: "ok", finalUrl: res.url || url, status: res.status, page: extractPageContent(html) };
  } catch {
    return { kind: "blocked", status: null };
  } finally {
    clearTimeout(timer);
  }
};

// --- Shared write helper --------------------------------------------------------

/** Single write path for apply and revert, so audit semantics can't drift between them.
 *  Returns true when a row was updated. */
const updateProductWebLink = async (
  pool: ConnectionPool,
  auditUserId: string | null,
  productId: number,
  webLink: string | null,
): Promise<boolean> => {
  const updateReq = pool.request();
  updateReq.input("ProductID", sql.Int, productId);
  updateReq.input("WebLink", sql.NVarChar(2000), webLink);
  updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
  const result = await updateReq.query(`
    UPDATE dbo.Products
    SET WebLink = @WebLink,
        ModifiedOn = SYSUTCDATETIME(),
        ModifiedBy = @ModifiedBy
    WHERE ID = @ProductID
  `);
  return (result.rowsAffected?.[0] ?? 0) > 0;
};

const validateItemCount = (count: number): NextResponse | null => {
  if (count === 0) {
    return NextResponse.json({ ok: false, error: "No items provided." }, { status: 400 });
  }
  if (count > MAX_PRODUCT_IDS) {
    return NextResponse.json(
      { ok: false, error: `Cannot process more than ${MAX_PRODUCT_IDS} products at once.` },
      { status: 400 },
    );
  }
  return null;
};

// --- Request handlers ---------------------------------------------------------

export async function POST(req: NextRequest) {
  logRequest(req, "/api/products/add-weblinks");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json();

    if (Array.isArray(body?.applyPrecomputed)) {
      return await handleApply(req, body.applyPrecomputed as unknown[]);
    }
    if (body?.dryRun !== true) {
      // Old clients POSTed { productIds } expecting a direct write; refuse loudly rather
      // than silently searching (they would show "Updated undefined web link(s)").
      return NextResponse.json(
        { ok: false, error: "The Add web links feature was updated — please hard-refresh the page (Ctrl+F5) and try again." },
        { status: 400 },
      );
    }
    return await handleSearch(req, body?.productIds);
  } catch (err) {
    console.error("Failed to add web links", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** Revert helper used by client-side undo: restores previous WebLink values. */
export async function PUT(req: NextRequest) {
  logRequest(req, "/api/products/add-weblinks");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const rawItems: unknown = body?.items;
    if (!Array.isArray(rawItems)) {
      return NextResponse.json({ ok: false, error: "No items provided." }, { status: 400 });
    }
    const countError = validateItemCount(rawItems.length);
    if (countError) return countError;

    const items = rawItems
      .map((raw) => {
        const productId = normalizeId((raw as { productId?: unknown })?.productId);
        const webLinkRaw = (raw as { webLink?: unknown })?.webLink;
        const webLink = typeof webLinkRaw === "string" && webLinkRaw.trim() ? webLinkRaw.slice(0, 2000) : null;
        return productId !== null ? { productId, webLink } : null;
      })
      .filter((x): x is { productId: number; webLink: string | null } => x !== null);

    if (items.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid items provided." }, { status: 400 });
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();
    let revertedCount = 0;
    for (const item of items) {
      if (await updateProductWebLink(pool, auditUserId, item.productId, item.webLink)) revertedCount++;
    }

    return NextResponse.json({ ok: true, revertedCount });
  } catch (err) {
    console.error("Failed to revert web links", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// --- Apply mode ----------------------------------------------------------------

async function handleApply(req: NextRequest, rawItems: unknown[]) {
  const countError = validateItemCount(rawItems.length);
  if (countError) return countError;

  const items = rawItems
    .map((raw) => {
      const productId = normalizeId((raw as { productId?: unknown })?.productId);
      const webLink = (raw as { webLink?: unknown })?.webLink;
      if (productId === null || !isRealWebLink(webLink)) return null;
      return { productId, webLink: webLink.trim().slice(0, 2000) };
    })
    .filter((x): x is { productId: number; webLink: string } => x !== null);

  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: "No valid links provided." }, { status: 400 });
  }

  const auditUserId = resolveAuditUserId(req);
  const pool = await getPool();

  const results: Array<{ productId: number; status: "updated" | "error" }> = [];
  for (const item of items) {
    try {
      const updated = await updateProductWebLink(pool, auditUserId, item.productId, item.webLink);
      results.push({ productId: item.productId, status: updated ? "updated" : "error" });
    } catch (err) {
      console.error(`Failed to apply web link for product ${item.productId}:`, err);
      results.push({ productId: item.productId, status: "error" });
    }
  }

  const updatedCount = results.filter((r) => r.status === "updated").length;
  const errorCount = results.filter((r) => r.status === "error").length;
  return NextResponse.json({ ok: true, updatedCount, errorCount, results });
}

// --- Search mode (never writes product data) --------------------------------------

async function handleSearch(req: NextRequest, rawIds: unknown) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ ok: false, error: "No product IDs provided." }, { status: 400 });
  }

  const productIds = rawIds.map(normalizeId).filter((id): id is number => id !== null);
  if (productIds.length === 0) {
    return NextResponse.json({ ok: false, error: "No valid product IDs provided." }, { status: 400 });
  }
  if (productIds.length > MAX_PRODUCT_IDS) {
    return NextResponse.json(
      { ok: false, error: `Cannot process more than ${MAX_PRODUCT_IDS} products at once.` },
      { status: 400 },
    );
  }

  const auditUserId = resolveAuditUserId(req);
  const pool = await getPool();
  const fetchReq = pool.request();
  const fetchResult = await fetchReq.query<ProductRow>(`
    SELECT p.ID, b.Name AS Brand, p.BrandID, b.WebDomain AS BrandWebDomain,
           p.ModelNumber, p.PartNumber, p.Description, p.WebLink
    FROM dbo.Products p
    LEFT JOIN dbo.Brands b ON b.ID = p.BrandID
    WHERE p.ID IN (${productIds.join(",")})
  `);

  // Missing IDs are reported per-product below (never a blanket 404 — a chunk of stale
  // grid rows must not abort the client's whole chunked run).
  const products = fetchResult.recordset;

  // Explicit timeout and no SDK-level retries: the route implements its own retry policy, and the
  // SDK's default 600s timeout would hold a shared semaphore permit long past the request's life.
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: 0,
  });

  // Whole-request clock, so a chunk cannot outlive the proxy in front of the app.
  const requestStartedAt = Date.now();
  const requestTimeLeft = () => REQUEST_DEADLINE_MS - (Date.now() - requestStartedAt);

  // Brand → domain memoization for this batch: one resolution per brand, not per product.
  const domainCache = new Map<string, Promise<string | null>>();

  // URL templates LEARNED from links that verified during this request, keyed by domain. When one
  // product of a brand resolves to a URL containing its part number, that reveals where the brand's
  // other products live — so the rest of the batch can be resolved by construction and a single
  // fetch instead of another paid search. Self-improving and brand-agnostic: nothing is hardcoded.
  const learnedTemplates = new Map<string, UrlTemplate[]>();
  const rememberTemplate = (domain: string, url: string, partNumber: string) => {
    const tpl = deriveUrlTemplate(url, partNumber);
    if (!tpl) return;
    const list = learnedTemplates.get(domain) ?? [];
    if (list.some((t) => t.template === tpl.template && t.transform === tpl.transform)) return;
    list.push(tpl);
    learnedTemplates.set(domain, list.slice(0, 4));
    console.log(`[weblink] learned URL template for ${domain}: ${tpl.template} (${tpl.transform})`);
  };

  // Probe a resolved/proposed domain (any HTTP response — even 403 — proves it exists;
  // DNS/network failure on bare and www forms rejects it), then persist to Brands.WebDomain
  // ONLY when the homepage was readable and actually mentions the brand — an unverifiable
  // guess stays batch-local instead of becoming a curated-looking domain. Never clobbers
  // an existing value.
  const verifyAndPersistDomain = async (
    domain: string,
    brand: string,
    brandId: number | null,
  ): Promise<string | null> => {
    let probe = await fetchPage(`https://${domain}/`);
    if (probe.kind === "blocked" && probe.status === null) {
      probe = await fetchPage(`https://www.${domain}/`);
      if (probe.kind === "blocked" && probe.status === null) {
        console.warn(`[weblink] resolved domain "${domain}" for brand "${brand}" does not respond — discarding`);
        return null;
      }
    }

    let brandVerified = false;
    if (probe.kind === "ok" && !looksLikeAccessWall(probe.page)) {
      const haystack = `${probe.page.title} ${probe.page.metaDescription} ${probe.page.bodyText.slice(0, 5000)}`;
      const brandTokens = Array.from(new Set([brand, brand.split(/\s+/)[0]]))
        .filter((t) => t && normalizeIdentifier(t).length >= 3);
      brandVerified = brandTokens.some((t) => identifierAppearsInText(haystack, t));
    }
    if (brandVerified && brandId !== null) {
      try {
        const persistReq = pool.request();
        persistReq.input("BrandID", sql.Int, brandId);
        persistReq.input("WebDomain", sql.NVarChar(255), domain);
        persistReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await persistReq.query(`
          UPDATE dbo.Brands
          SET WebDomain = @WebDomain,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @BrandID AND (WebDomain IS NULL OR LTRIM(RTRIM(WebDomain)) = '')
        `);
        console.log(`[weblink] persisted WebDomain "${domain}" for brand "${brand}" (homepage mentions brand)`);
      } catch (err) {
        console.warn(`[weblink] failed to persist WebDomain for brand "${brand}":`, err);
      }
    } else {
      console.log(`[weblink] domain "${domain}" for brand "${brand}" used for this batch only (not verified against homepage)`);
    }
    return domain;
  };

  // Legacy (serper-mode) domain resolution: GPT answers from memory, then the domain is
  // probed/verified like any other. Websearch mode skips this entirely — the proposer
  // identifies the domain by actually searching (catches rebrands GPT can't know about).
  // Memoize per brand, but NEVER memoize failures — a transient probe timeout under batch
  // load must not poison every remaining product of that brand in the run.
  const memoizeDomain = (key: string, resolve: () => Promise<string | null>): Promise<string | null> => {
    let cached = domainCache.get(key);
    if (!cached) {
      cached = resolve().then((result) => {
        if (result === null) domainCache.delete(key);
        return result;
      });
      domainCache.set(key, cached);
    }
    return cached;
  };

  // Verify (and persist) the domain the proposer identified, memoized per brand so 10
  // products of one brand don't re-probe it 10 times.
  const verifyProposedDomain = (
    brand: string,
    brandId: number | null,
    domain: string,
  ): Promise<string | null> =>
    memoizeDomain(brand.toLowerCase(), () => verifyAndPersistDomain(domain, brand, brandId));

  const requestedIds = new Set(productIds);
  const foundIds = new Set(products.map((p) => p.ID));

  const settled = await Promise.allSettled(
    products.map(async (product): Promise<ProductResult> => {
      const base = {
        productId: product.ID,
        brand: product.Brand,
        partNumber: product.PartNumber,
        modelNumber: product.ModelNumber,
        oldWebLink: product.WebLink,
      };

      await productSemaphore.acquire();
      const startedAt = Date.now();
      // Whichever runs out first: this product's own budget, or the whole request's (the products
      // of a chunk run concurrently, so the request deadline is the one that protects the proxy).
      const timeLeft = () =>
        Math.min(PER_PRODUCT_TIME_BUDGET_MS - (Date.now() - startedAt), requestTimeLeft());
      try {
        const brand = product.Brand?.trim() ?? "";
        const modelNumber = product.ModelNumber?.trim() ?? "";
        const partNumber = product.PartNumber?.trim() ?? "";
        const description = product.Description?.trim() ?? "";

        if (!brand && !modelNumber && !partNumber && !description) {
          return { ...base, webLink: null, status: "not_found", note: "Product has no searchable data." };
        }

        // partCore drops a trailing order suffix ("8660.034-RT" → "8660.034"). Used both as the
        // preferred SEARCH term (the suffix is usually absent from manufacturer pages and skews
        // search toward distributors) and as an extra match identifier during verification.
        // A price-list language suffix ("…_EN") is not part of the manufacturer's code and finds
        // nothing; strip it before it becomes a search term. Then drop a trailing order/packaging
        // suffix as before.
        const partSearchable = stripPartLanguageSuffix(partNumber) || partNumber;
        // The catalog's ModelNumber column is empty for most brands, so mine the description for the
        // product's real name and use it as a SEARCH TERM (never as verification evidence).
        const descriptionName = extractProductNameFromDescription(description);
        // A ModelNumber that merely repeats the part number is not a name — Avid's rows carry
        // "2550-00020-00" in both columns, and searching an internal code that appears nowhere on the
        // web found nothing, while the description ("WG433 ACSR MediaCentral …") names the product.
        const modelIsJustThePart =
          !!modelNumber && normalizeIdentifier(modelNumber) === normalizeIdentifier(partNumber);
        const searchName = modelIsJustThePart ? descriptionName || modelNumber : modelNumber || descriptionName;
        const partCore = stripPartOrderSuffix(partSearchable) || (partSearchable !== partNumber ? partSearchable : "");

        // Step 1: propose candidate URLs. One agentic web-search call per product finds
        // candidate product pages (scoped to the curated Brands.WebDomain when set) and, when
        // we don't have a domain, identifies the manufacturer's official site by searching.
        const curatedDomain = product.BrandWebDomain?.trim().toLowerCase().replace(/^www\./, "") || null;
        let domain: string | null = curatedDomain;
        let proposedCandidates: Array<{ link: string }> = [];

        // Second candidate source, started here so it overlaps the (much slower) proposal call:
        // the search index (see lib/webLinkIndexSearch.ts for why both are needed). Only possible
        // up-front when the brand has a curated domain; otherwise it runs once the proposer has
        // identified one.
        const indexSearchFor = (target: string) =>
          searchIndexCandidates({
            brand,
            modelNumber: searchName,
            partNumber: partSearchable,
            partNumberCore: partCore,
            partPrefix: extractPartPrefix(partSearchable),
            domain: target,
            tag: `weblink p${product.ID}`,
          }).catch((err) => {
            console.warn(`[weblink] product ${product.ID}: index search failed:`, err);
            return [] as IndexHit[];
          });
        const earlyIndexHits = curatedDomain ? indexSearchFor(curatedDomain) : null;

        // Third candidate source: the brand's OWN sitemap. Free, exact (the part number is either in
        // a published URL or it is not) and equally applicable to every brand — unlike the other two,
        // which each have blind spots. Fetched once per domain and cached, so a batch of one brand
        // pays for it once.
        const sitemapSearchFor = (target: string) =>
          findInSitemap({ domain: target, identifiers: [partSearchable, partCore].filter(Boolean) }).catch((err) => {
            console.warn(`[weblink] product ${product.ID}: sitemap lookup failed:`, err);
            return [];
          });
        const earlySitemapHits = curatedDomain ? sitemapSearchFor(curatedDomain) : null;

        try {
          await openaiSemaphore.acquire();
          let proposal;
          try {
            proposal = await proposeWebLinks(
              openai,
              WEBLINK_SEARCH_MODEL,
              {
                brand,
                partNumber,
                partNumberCore: partCore,
                // Fall back to the name mined from the description when ModelNumber is empty.
                modelNumber: searchName,
                description,
              },
              domain,
              {
                // Give the search as much of this product's remaining budget as we can spare,
                // capped — but never the client's tight default, which killed 5 of 10 products in
                // the 2026-07-29 measurement batch with "Request timed out".
                timeoutMs: Math.max(20_000, Math.min(PROPOSAL_TIMEOUT_MS, timeLeft() - 15_000)),
                timeLeftMs: timeLeft,
              },
            );
          } finally {
            openaiSemaphore.release();
          }
          proposedCandidates = proposal.candidates.map((url) => ({ link: url }));
          if (!domain && proposal.resolvedDomain && brand) {
            domain = await verifyProposedDomain(brand, product.BrandID, proposal.resolvedDomain);
            // The probe can time out transiently under batch load. The domain came from
            // real search results (not model memory) and every candidate is fetch-verified
            // below anyway — so still use it batch-locally; it just isn't persisted.
            if (!domain) domain = proposal.resolvedDomain;
          }
        } catch (err) {
          console.error(`[weblink] product ${product.ID}: web-search proposal failed:`, err);
          return { ...base, webLink: null, status: "error", note: "Web search failed — please retry." };
        }

        if (!domain) {
          console.log(`[weblink] product ${product.ID} (${brand}): domain not resolved`);
          return {
            ...base,
            webLink: null,
            status: "not_found",
            note: brand
              ? `Could not resolve a website domain for brand "${brand}". Set it on the Brands page and retry.`
              : "Product has no brand — cannot pick a manufacturer site.",
          };
        }
        console.log(`[weblink] product ${product.ID} (${brand}): domain=${domain}${curatedDomain ? " (curated)" : ""}`);

        // Search-index hits for this product, and the lookup used to answer "did the index
        // actually list this URL?" — the only existence proof available for pages that render
        // nothing server-side.
        //
        // Bounded wait: a whole chunk's index queries share the serper module's semaphore, so a
        // slow provider could otherwise spend the time budget before a single page has been
        // fetched. Giving up yields [] (the proposal candidates still run) rather than an error, and
        // when too little budget is left we don't even start a serial index search.
        const indexBudget = Math.min(INDEX_SEARCH_WAIT_MS, timeLeft() - INDEX_SEARCH_MIN_BUDGET_MS);
        const indexHits =
          indexBudget <= 0
            ? []
            : await Promise.race([
                earlyIndexHits ?? indexSearchFor(domain),
                new Promise<IndexHit[]>((resolve) => {
                  const timer = setTimeout(() => resolve([]), indexBudget);
                  timer.unref?.();
                }),
              ]);
        if (indexBudget <= 0) {
          console.warn(`[weblink] product ${product.ID}: skipped the search-index tier (only ${timeLeft()}ms left)`);
        }
        // Deliberately a SHORT wait: the sitemap is a bonus source, and it is cached per domain, so
        // the first product of a brand should not spend its verification budget waiting for a
        // multi-megabyte file — the rest of the batch gets it for free once it lands.
        const sitemapHits = await Promise.race([
          earlySitemapHits ?? sitemapSearchFor(domain),
          new Promise<Array<{ link: string; matched: string }>>((resolve) => {
            const timer = setTimeout(() => resolve([]), SITEMAP_WAIT_MS);
            timer.unref?.();
          }),
        ]);
        if (sitemapHits.length) {
          console.log(
            `[weblink] product ${product.ID}: sitemap hits=${sitemapHits.length} first=${sitemapHits[0].link}`,
          );
        }

        const indexByUrl = new Map<string, IndexHit>();
        for (const hit of indexHits) indexByUrl.set(normalizedUrlKey(hit.link), hit);
        const indexHitFor = (...urls: string[]): IndexHit | null => {
          for (const url of urls) {
            const hit = indexByUrl.get(normalizedUrlKey(url));
            if (hit) return hit;
          }
          return null;
        };
        console.log(
          `[weblink] product ${product.ID}: index hits=${indexHits.length}${indexHits[0] ? ` first=${indexHits[0].link}` : ""}`,
        );

        const partPrefix = extractPartPrefix(partNumber);
        const identifiers = [partNumber, partCore, modelNumber, partPrefix].filter(Boolean);
        // Identifiers precise enough to judge a search-result title by. The part PREFIX is
        // deliberately excluded — it is a family-level code, so it would confirm a sibling.
        const titleIdentifiers = [partNumber, partCore, modelNumber].filter(Boolean);
        // Distinguishing specs (sizes/ratings/counts) so the LLM judge can reject a same-type
        // page at the wrong variant (e.g. a 600mm trim panel when we want the 800mm one).
        const specTokens = extractSpecTokens(description);

        // Hosts the brand's OWN site has pointed us at — a redirect target or a declared hreflang
        // alternate. They count as in-scope even though they are a different registrable domain,
        // because the manufacturer's own routing is what sent us there. Measured need: with the brand
        // domain set to thomann.de, every English storefront (thomann.co.uk, thomann.ie,
        // thomannmusic.com) was rejected as "off-domain" and the product ended as German-only; QSC's
        // real product pages likewise live on qsys.com while its brand domain says qsc.com.
        const aliasHosts = new Set<string>();
        const learnAlias = (from: string, to: string) => {
          try {
            const fromHost = new URL(from).hostname.toLowerCase();
            const toHost = new URL(to).hostname.toLowerCase();
            if (fromHost === toHost || MARKETPLACE_HOST.test(toHost)) return;
            if (!hostMatchesDomain(fromHost, domain) && !aliasHosts.has(fromHost)) return;
            if (aliasHosts.has(toHost)) return;
            aliasHosts.add(toHost);
            console.log(`[weblink] product ${product.ID}: ${domain} points at ${toHost} — treating it as the same site`);
          } catch {
            /* ignore unparseable */
          }
        };
        /** An hreflang alternate is the site's own statement that this other host serves the same
         *  content, so it is in scope for this product. `from` is the page that declared it. */
        const declaredAlias = (from: string, href: string) => learnAlias(from, href);
        const inScope = (host: string) =>
          hostMatchesDomain(host, domain) || [...aliasHosts].some((alias) => hostMatchesDomain(host, alias));

        // Per-product page cache: locale/EU swaps and overlapping tiers must not re-fetch
        // the same URL.
        const pageCache = new Map<string, Promise<FetchedPage>>();
        const fetchPageCached = (url: string): Promise<FetchedPage> => {
          let cached = pageCache.get(url);
          if (!cached) {
            cached = fetchPage(url);
            pageCache.set(url, cached);
          }
          return cached;
        };

        // Hard-filter: only keep URLs on the manufacturer's domain, excluding staging
        // subdomains, non-product pages, and document files.
        const domainFilter = (r: { link: string }) => {
          try {
            const parsed = new URL(r.link);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            const subdomain = host.split(".")[0];
            if (/stage|staging|rhythm|dev|test|sandbox/.test(subdomain)) return false;
            // Help/knowledge portals, identified by host as well as by path: the same QSC licensing
            // article reappeared as q-syshelp.qsc.com/Content/… once its /help/ path was rejected.
            if (isHelpPortalHost(host)) return false;
            if (/\/shop\/|\/brand-filter\/|\/cart\/|\/checkout\/|\/account\//.test(path)) return false;
            if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|zip)(\?[^/]*)?$/i.test(path)) return false;
            // Knowledge-base articles / news / community posts are never the product page —
            // reject by path pattern and by headline-style slugs (blog/press titles).
            if (isArticleOrNewsPath(path) || hasHeadlineSlug(r.link)) return false;
            return inScope(host);
          } catch {
            return false;
          }
        };

        // Ask GPT-4o-mini whether a fetched page is a useful product page for THIS product, and
        // crucially WHICH KIND: this model's own page, or merely the family/range page it belongs
        // to. The old prompt lumped both into one YES, so one family page was returned as an
        // equally-confident "AI judged" match for every SKU in the family — two different Voltera
        // part numbers got byte-identical links. Family pages are now a separate, weaker tier.
        // FAIL CLOSED: any LLM error rejects the candidate (a wrong link proposed for saving is
        // worse than a missing one — the old fail-open default proposed junk during outages).
        const validatePageForProduct = async (
          url: string,
          page: ExtractedPage,
          opts?: { bodyMatchHint?: boolean },
        ): Promise<"specific" | "family" | null> => {
          try {
            const reply = await openaiText(openai, WEBLINK_JUDGE_MODEL, [
              `You are validating a candidate manufacturer web page for a specific product.`,
              `Product brand: ${brand || "(unknown)"}`,
              `Part number: ${partNumber || "(none)"}`,
              `Model number: ${modelNumber || "(none)"}`,
              `Product description: ${description.slice(0, 300) || "(none)"}`,
              ``,
              `Candidate URL: ${url}`,
              `Page title: ${page.title || "(empty)"}`,
              `Page heading: ${page.h1 || "(empty)"}`,
              `Meta description: ${page.metaDescription || "(empty)"}`,
              // Centred on the first mention of the product, not the top of the page: nav, cookie
              // banners and hero copy used to fill the whole window on long pages.
              `Page text excerpt: ${excerptAroundIdentifier(page.bodyText, identifiers, JUDGE_EXCERPT_CHARS) || "(empty)"}`,
              ``,
              ...(opts?.bodyMatchHint
                ? [
                    `Note: the part number appears somewhere in the page text, but that alone does NOT`,
                    `prove this is the right page — accessory part numbers are often listed on the PARENT`,
                    `product's page (accessories/related-products sections).`,
                    ``,
                  ]
                : []),
              `Answer with exactly one word:`,
              `- YES    — this page is the page for THIS SPECIFIC product/model: a product detail page`,
              `           or spec page that names this model (or a page whose main subject is this`,
              `           model). Manufacturers often use different internal codes in URLs than`,
              `           customer-facing part numbers, so judge by product NAME and TYPE, not by`,
              `           exact code matching.`,
              `- FAMILY — the page is about the product FAMILY, SERIES or RANGE this product belongs`,
              `           to (it covers several models, or names only the family), so it does not`,
              `           identify this specific model. Say FAMILY even if the family is clearly the`,
              `           right one — do not say YES for it.`,
              `- NO     — a broad category listing, search results, support/news/blog page, a`,
              `           homepage, or clearly a DIFFERENT product or product type than described.`,
              `           Documentation, help-centre, manual, release-notes, licensing and pricing/`,
              `           configurator pages are NO even when they name the product correctly — the`,
              `           link must point at the product's own page, not at instructions about it.`,
              `In particular: if the product description is an ACCESSORY (bracket, mount, adapter, cable,`,
              `case, rigging, cover), the page must be about that accessory itself — a page whose title`,
              `names the main product the accessory attaches to is NO.`,
              ...(specTokens.length
                ? [
                    ``,
                    `This product has these distinguishing specifications: ${specTokens.join(", ")}.`,
                    `Manufacturers list many size/rating/length/configuration variants of the same product.`,
                    `The page must be for the variant matching these specs. If the page is the same product`,
                    `TYPE but a DIFFERENT size, rating, wattage, length, channel/port count, or`,
                    `configuration, reply NO. If it covers several of those variants together, reply FAMILY.`,
                  ]
                : []),
              ``,
              `Reply with one word only: YES, FAMILY or NO.`,
            ].join("\n"));
            const verdict = reply.toUpperCase().startsWith("YES")
              ? "specific"
              : reply.toUpperCase().startsWith("FAMILY")
                ? "family"
                : null;
            console.log(`[weblink] product ${product.ID}: url=${url} llm_page_verdict=${verdict ?? "no"}`);
            return verdict;
          } catch (err) {
            console.warn(`[weblink] product ${product.ID}: page validation failed (rejecting candidate):`, err);
            return null;
          }
        };

        type Accepted = {
          link: string;
          verification: WebLinkVerification;
          pageLang: string;
          /** True when the page named only the suffix-stripped part number, so it may be a sibling
           *  variant's page. Triggers the exact-variant probe after acceptance. */
          viaCoreOnly?: boolean;
        };

        // Rendering is expensive (7-30s of real page load for a catalog SPA), so it is rationed:
        // only for candidates that cannot be settled any other way, and never more than this many
        // per product.
        const MAX_RENDERS_PER_PRODUCT = 2;
        // One of the two is reserved: the candidate loop may spend a single render, so the
        // constructed-URL stage — where rendering is the ONLY possible evidence — always has one
        // left. Without the reservation, two unconvincing shells early in the list would silently
        // disable the last-resort path.
        const RENDERS_DURING_CANDIDATE_LOOP = 1;
        let rendersUsed = 0;

        /**
         * Load a URL in a headless browser and accept it ONLY if the rendered page names this
         * product in its own title/h1/meta. This is what makes a JS-only catalog page verifiable
         * without a search index — and it is the only evidence that may justify a CONSTRUCTED URL,
         * because a non-existent SKU renders "<part> - ITEM NOT FOUND OR NOT AVAILABLE" instead of a
         * product name. Returns null whenever rendering is unavailable, too slow, or unconvincing.
         */
        /** "read-rejected" = the browser DID load the page and it is not this product's page. That is
         *  a real answer, and it must not be softened into an "unverified, open to check" guess —
         *  which is how an Avid training course and a Barco "End of life" notice were proposed in a
         *  measured run. `null` means we never managed to read it. */
        type RenderOutcome = Accepted | "read-rejected" | null;

        const verifyByRendering = async (
          url: string,
          opts?: {
            limit?: number;
            /** Let the page judge decide when the rendered page does not name the product in its
             *  own title/h1/meta. Allowed for REAL candidates (an index or proposal hit, where a
             *  vague title is just a vague title) and forbidden for CONSTRUCTED ones, whose only
             *  licence to exist is the page naming the product outright. */
            allowJudge?: boolean;
          },
        ): Promise<RenderOutcome> => {
          const limit = opts?.limit ?? MAX_RENDERS_PER_PRODUCT;
          if (!isRenderingEnabled() || rendersUsed >= Math.min(limit, MAX_RENDERS_PER_PRODUCT)) return null;
          // Leave room for the render itself plus a little slack; otherwise skip it.
          if (timeLeft() < RENDER_MIN_BUDGET_MS) {
            console.log(`[weblink] product ${product.ID}: skipping render of ${url} (${timeLeft()}ms left)`);
            return null;
          }
          rendersUsed++;
          // Give the render whatever is left minus a small margin for extraction and the response.
          const rendered = await renderPage(url, Math.min(Math.max(timeLeft() - 4_000, 5_000), RENDER_MAX_MS));
          if (!rendered) return null;

          const page = extractPageContent(rendered.html);
          // Strict, token-bounded match against the page's OWN words: "Desono MASK6C-W" must not be
          // satisfied by "Desono MASK6CT-W". Computed up front because the checks below need to know
          // whether the page identifies the product before deciding what its silence means.
          const pageWords = `${page.title} ${page.h1} ${page.ogTitle} ${page.metaDescription} ${page.structuredIds.join(" ")}`;
          const names = titleIdentifiers.some(
            (id) => isDistinctiveIdentifier(id) && identifierMatchesAsToken(pageWords, id),
          );

          // The app never finished rendering AND the page says nothing about this product. That is NOT
          // a verdict — an early snapshot of a client-rendered catalog is indistinguishable from "this
          // page is about something else", which is how one biamp URL came back h1="Desono MASK6C-W"
          // in one run and h1="" in the next. Report inconclusive (null) so the caller keeps its other
          // options. A page that DOES name the product is judged below, however sparse it is.
          if (!names && isContentlessShell(page) && !page.h1) {
            console.log(
              `[weblink] product ${product.ID}: render of ${rendered.finalUrl} never settled (no heading) — inconclusive, not a rejection`,
            );
            return null;
          }

          // Order is load-bearing: a dead SKU's heading contains the very part number we searched
          // for, so the soft-404 check must run before any identifier matching.
          if (looksLikeSoftNotFound(page)) {
            console.log(`[weblink] product ${product.ID}: rendered ${rendered.finalUrl} says the item does not exist — rejected`);
            return "read-rejected";
          }
          if (looksLikeAccessWall(page)) {
            console.log(`[weblink] product ${product.ID}: rendered ${rendered.finalUrl} is still a bot wall — rejected`);
            return "read-rejected";
          }
          if (!domainFilter({ link: rendered.finalUrl }) || isHomepageLanding(url, rendered.finalUrl)) {
            console.log(`[weblink] product ${product.ID}: rendered ${rendered.finalUrl} left the product area — rejected`);
            return "read-rejected";
          }
          const renderedLang = pageLanguage(page);
          if (!isEnglishResult(rendered.finalUrl, renderedLang)) {
            console.log(`[weblink] product ${product.ID}: rendered ${rendered.finalUrl} is not English — rejected`);
            return "read-rejected";
          }
          if (names) {
            console.log(
              `[weblink] product ${product.ID}: ${rendered.finalUrl} verified by rendering (h1=${JSON.stringify(page.h1 || page.title)})`,
            );
            return { link: rendered.finalUrl, verification: "content", pageLang: renderedLang };
          }
          // The page rendered but does not name the product in its own headings. For a real search
          // hit that is inconclusive rather than damning (plenty of product pages are titled
          // "Overview"), so let the judge read the text — it is the same gate every readable page
          // goes through. A constructed URL gets no such benefit.
          if (opts?.allowJudge && !looksLikeArticlePage(page, rendered.finalUrl)) {
            const verdict = await validatePageForProduct(rendered.finalUrl, page, { bodyMatchHint: true });
            if (verdict === "specific") return { link: rendered.finalUrl, verification: "llm", pageLang: renderedLang };
            if (verdict === "family") return { link: rendered.finalUrl, verification: "family", pageLang: renderedLang };
          }
          console.log(
            `[weblink] product ${product.ID}: rendered ${rendered.finalUrl} does not name this product (title=${JSON.stringify(page.title)}, h1=${JSON.stringify(page.h1)}) — rejected`,
          );
          return "read-rejected";
        };
        let sawBlockedCandidate = false;
        // Highest-scored on-domain candidate we couldn't fetch to verify (bot-protected site).
        // If nothing verifies, this is offered as an "unverified" row for human review rather
        // than dropped — the URL passed domainFilter + scoring (so it's a plausible non-article
        // product page) and isn't detectably non-English by its URL.
        let bestBlockedCandidate: string | null = null;

        // Full verification of one candidate URL: fetch the page, reject hard/soft 404s and
        // homepage redirects, then verify by content (part/model on the page) or by LLM
        // judgment of the page text. A page we cannot read is never proposed.
        const acceptCandidate = async (
          url: string,
          opts?: { skipIfFinalUrl?: string },
        ): Promise<Accepted | null> => {
          const fetched = await fetchPageCached(url);
          if (fetched.kind === "not_found") {
            console.log(`[weblink] product ${product.ID}: url=${url} rejected (not_found)`);
            return null;
          }
          if (fetched.kind === "blocked" || fetched.kind === "not_html") {
            // We can't read the page (bot-block, challenge page, or non-HTML). A 403 also masks
            // whether the URL is actually a 404, so accepting it on URL shape alone produced
            // dead links (e.g. Keenfinity /us/en/… that 404 in a browser). Only propose pages we
            // could actually fetch and verify — otherwise report "not found".
            //
            // But "our fetch was blocked" is not the same as "this page is unreadable": a real
            // browser executes the challenge, carries a full header set and keeps cookies, so it
            // gets through much of what blocks a bare fetch. Try that before giving up — this is
            // the difference between a verified link and an amber "open to check" guess for
            // Cloudflare-fronted brands. (Not for not_html: rendering a PDF yields no DOM.)
            if (fetched.kind === "blocked") {
              const outcome = await verifyByRendering(url, {
                limit: RENDERS_DURING_CANDIDATE_LOOP,
                allowJudge: true,
              });
              if (outcome && outcome !== "read-rejected") {
                console.log(`[weblink] product ${product.ID}: url=${url} was fetch-blocked but rendered fine`);
                return outcome;
              }
              // The browser DID read it and it is not this product's page. That is an answer, so the
              // page must NOT also be offered as an "unverified — open to check" guess: doing so put
              // an Avid training course and a Barco "End of life" notice in front of the user, both
              // pre-selected. Only genuinely unreadable pages earn that fallback.
              if (outcome === "read-rejected") return null;
            }
            sawBlockedCandidate = true;
            // Remember the first (best-scored) blocked candidate whose URL isn't obviously
            // non-English, as a human-review fallback. Only real search/proposal candidates
            // reach here before an acceptance; guessed locale swaps run post-acceptance.
            if (!bestBlockedCandidate && !urlLanguageIsNonEnglish(url)) bestBlockedCandidate = url;
            console.log(`[weblink] product ${product.ID}: url=${url} unreadable (${fetched.kind}) — rejected`);
            return null;
          }

          if (opts?.skipIfFinalUrl && fetched.finalUrl === opts.skipIfFinalUrl) {
            // Redirected onto the already-accepted page — no better variant here.
            return null;
          }
          if (isHomepageLanding(url, fetched.finalUrl)) {
            console.log(`[weblink] product ${product.ID}: url=${url} redirected to homepage — rejected`);
            return null;
          }
          if (looksLikeSoftNotFound(fetched.page)) {
            console.log(`[weblink] product ${product.ID}: url=${url} looks like a soft 404 — rejected`);
            return null;
          }
          // HTTP 200 with a bot wall (Cloudflare's interstitial answers 200 as often as 403). It is
          // not content — but a real browser usually clears it, so try that before giving up.
          if (looksLikeAccessWall(fetched.page)) {
            const outcome = await verifyByRendering(url, {
              limit: RENDERS_DURING_CANDIDATE_LOOP,
              allowJudge: true,
            });
            if (outcome && outcome !== "read-rejected") {
              console.log(`[weblink] product ${product.ID}: url=${url} was behind a bot wall but rendered fine`);
              return outcome;
            }
            if (outcome === "read-rejected") return null;
            sawBlockedCandidate = true;
            if (!bestBlockedCandidate && !urlLanguageIsNonEnglish(url)) bestBlockedCandidate = url;
            console.log(`[weblink] product ${product.ID}: url=${url} is a bot wall we could not clear — rejected`);
            return null;
          }
          // A redirect can leave the manufacturer's site entirely (or land on an article path);
          // every gate below reasons about the page we would STORE, so re-check the destination.
          if (!domainFilter({ link: fetched.finalUrl })) {
            // The site itself redirected us here, so if the request started on the brand's domain the
            // destination is the brand's other storefront, not a third party. Remember it and re-check.
            learnAlias(url, fetched.finalUrl);
            if (!domainFilter({ link: fetched.finalUrl })) {
              console.log(
                `[weblink] product ${product.ID}: url=${url} redirected off-domain or onto a non-product path (${fetched.finalUrl}) — rejected`,
              );
              return null;
            }
          }

          const lang = pageLanguage(fetched.page);
          const matchStrength = pageMatchStrength(fetched.page, fetched.finalUrl, identifiers);
          const matchSource = strongMatchSource(fetched.page, fetched.finalUrl, identifiers);

          // The page's OWN words name the product — the strongest evidence there is. Accepted even
          // if og:type says "article" (many product CMSs default to og:type=article, which would
          // otherwise wrongly reject legit pages, e.g. Rittal).
          //
          // But WHICH identifier matched decides how much it proves (see matchSpecificity): a
          // family-prefix match is a base-code page, and a suffix-stripped "core" match may be a
          // sibling variant's page — which is exactly how a Corner-mount bracket was proposed for a
          // Surface-mount part. Core matches are flagged so the caller can probe for the exact page.
          if (matchSource === "page") {
            const pageWords = `${fetched.page.title} ${fetched.page.h1} ${fetched.page.ogTitle} ${fetched.page.metaDescription}`;
            const specificity = matchSpecificity(pageWords, {
              partNumber,
              modelNumber,
              partCore,
              partPrefix,
            });
            // A match on a descriptive ModelNumber ("RJ-11 / RJ-45 Bezel Kit") is a NAME match, not a
            // code match: it is only conclusive because that page happens to hold one SKU. When no
            // code appears anywhere on the page — not in the title, not in JSON-LD — let the judge
            // read it rather than stamping the top tier on a name.
            const codeOnPage = [partNumber, partCore, partSearchable].some(
              (id) => id && identifierAppearsInText(pageWords, id),
            );
            const nameHasNoCode =
              !!modelNumber && !/\d/.test(modelNumber) && modelNumber.trim().split(/\s+/).length >= 2;
            const nameOnly = specificity === "exact" && !codeOnPage && nameHasNoCode;

            if (specificity === "prefix") {
              console.log(
                `[weblink] product ${product.ID}: url=${url} only matches the family prefix (${partPrefix}) — treating as a family page`,
              );
              return { link: fetched.finalUrl, verification: "family", pageLang: lang };
            }
            if (nameOnly) {
              // Fall through to the judge instead of returning: it reads the page text and can tell a
              // single-SKU page from a range page that shares the same descriptive name.
              console.log(
                `[weblink] product ${product.ID}: url=${url} matches the descriptive name only (no code on the page) — asking the judge`,
              );
            } else {
              console.log(`[weblink] product ${product.ID}: url=${url} verified by page content (${specificity})`);
              return {
                link: fetched.finalUrl,
                verification: "content",
                pageLang: lang,
                viaCoreOnly: specificity === "core",
              };
            }
          }

          // Past this point the only identifier evidence, if any, is the URL itself — which is
          // whatever we asked for. It can never carry the top tier alone: JS-only catalogs serve an
          // identical shell for a real SKU and for a made-up one (999-99999-99999 included) and
          // echo the requested path back into <link rel="canonical">, so a URL pattern-filled from
          // our part number would "verify" against itself.

          // Unreadable shell. Cheapest sufficient evidence first: the search index listing this
          // exact URL with a title that names the product. Look it up by the URL that would be
          // STORED (a redirect may have moved us), then by what we requested.
          if (isContentlessShell(fetched.page)) {
            const indexHit = indexHitFor(fetched.finalUrl, url);
            const verdict = classifyShellCandidate({
              indexHit,
              identifiers: titleIdentifiers,
              url: fetched.finalUrl,
            });
            if (verdict === "index") {
              console.log(
                `[weblink] product ${product.ID}: url=${fetched.finalUrl} confirmed via search index (title=${JSON.stringify(indexHit?.title ?? "")})`,
              );
              return { link: fetched.finalUrl, verification: "index", pageLang: lang };
            }
            // No usable witness — but the index is incomplete and its titles go stale (a biamp SKU
            // whose indexed title reads "item not found" actually renders as a live product). Run a
            // real browser: the DOM settles the question either way.
            const outcome = await verifyByRendering(url, {
              limit: RENDERS_DURING_CANDIDATE_LOOP,
              allowJudge: true,
            });
            if (outcome && outcome !== "read-rejected") return outcome;
            console.log(
              `[weblink] product ${product.ID}: url=${fetched.finalUrl} unreadable shell rejected (${verdict}` +
                `${indexHit ? `, index title=${JSON.stringify(indexHit.title)}` : ""})`,
            );
            return null;
          }
          // No strong identifier match → now the article/blog signal matters. News/blog/press
          // posts carry the model number in body text but are never the product page. (URL-path
          // and headline-slug articles were already dropped by domainFilter; this catches the
          // og:type/blog cases.)
          if (looksLikeArticlePage(fetched.page, fetched.finalUrl)) {
            console.log(`[weblink] product ${product.ID}: url=${fetched.finalUrl} looks like an article/blog post — rejected`);
            return null;
          }
          // A readable page whose only identifier is in the URL, and body-only matches, both need
          // corroboration from the page's actual text: accessory part numbers are routinely listed
          // on the PARENT product's page (a bracket's code in the loudspeaker's accessories
          // section), and a URL match proves nothing by itself.
          const verdict = await validatePageForProduct(url, fetched.page, {
            bodyMatchHint: matchStrength === "body" || matchSource === "url",
          });
          if (verdict === "specific") return { link: fetched.finalUrl, verification: "llm", pageLang: lang };
          if (verdict === "family") {
            // A family page must at least NAME the thing it supposedly covers. Without this, the
            // judge's "FAMILY" became a catch-all: d&b's U-Series loudspeaker page was proposed for a
            // subwoofer BRACKET (part Z5815.001) with zero occurrences of "Z5815" or "bracket" on it.
            const mentions = pageMatchStrength(fetched.page, fetched.finalUrl, identifiers) !== "none";
            if (!mentions) {
              console.log(
                `[weblink] product ${product.ID}: url=${fetched.finalUrl} judged FAMILY but never mentions this product — rejected`,
              );
              return null;
            }
            return { link: fetched.finalUrl, verification: "family", pageLang: lang };
          }
          return null;
        };

        // Try the proposer's candidates in the order it returned them (best-first). We do NOT
        // apply URL-heuristic scoring/cutoffs here: the proposer already returns a small, ranked,
        // on-domain list, and the fetch-and-verify pipeline (below) is the real gate. The old
        // score cutoff wrongly discarded valid pages whose path carries category/SKU codes that
        // aren't the part number (e.g. Rittal's /PG…/PRO…?variantId=… URLs scored −7).
        const triedUrls = new Set<string>();
        // Verify candidates in order and keep the BEST verification tier, rather than stopping at
        // the first candidate that passes anything. First-pass-wins is how a product-family page
        // (weakest tier) beat a per-model page that was one candidate further down the list.
        // Stops early on "content"/"index" — hard evidence that cannot be improved on.
        const tryVerifyCandidates = async (candidateList: Array<{ link: string }>): Promise<Accepted | null> => {
          const ordered = candidateList
            .filter((c, i, arr) => arr.findIndex((x) => x.link === c.link) === i && !triedUrls.has(c.link))
            .slice(0, MAX_CANDIDATES_PER_TIER);
          let best: Accepted | null = null;
          for (const candidate of ordered) {
            if (timeLeft() <= 0) {
              console.warn(`[weblink] product ${product.ID}: time budget exhausted`);
              break;
            }
            triedUrls.add(candidate.link);
            const accepted = await acceptCandidate(candidate.link);
            if (accepted && (!best || isBetterVerification(accepted.verification, best.verification))) {
              best = accepted;
            }
            if (best && (best.verification === "content" || best.verification === "index")) break;
          }
          return best;
        };

        // Two candidate sources, merged: the web-search proposal and the search index. Neither is
        // sufficient alone — the proposer's index lacks client-rendered catalog pages entirely, and
        // the index search has no notion of which brand site is official. The domain filter and the
        // full fetch-and-verify pipeline gate every candidate from either source; mergeCandidates
        // decides only the ORDER and the per-source quota (see lib/webLinkResolution.ts).
        const indexCandidates = indexHits
          .map((hit) => ({ link: hit.link, title: hit.title }))
          .filter(domainFilter);
        const proposalCandidates = proposedCandidates.filter(domainFilter);
        // Sitemap hits lead: they come from the manufacturer's own published index AND their path
        // already carries this part number, which is the strongest pre-fetch evidence available.
        const sitemapCandidates = sitemapHits
          .map((hit) => ({ link: hit.link, title: "", fromIndex: true }))
          .filter(domainFilter)
          .slice(0, MAX_SITEMAP_CANDIDATES);
        const rankedRest = mergeCandidates({
          indexHits: indexCandidates,
          proposals: proposalCandidates,
          identifiers: titleIdentifiers,
          maxIndex: MAX_INDEX_CANDIDATES,
          maxProposals: MAX_PROPOSAL_CANDIDATES,
          max: MAX_CANDIDATES_PER_TIER,
        });
        const mergedSeen = new Set<string>();
        const merged = [...sitemapCandidates, ...rankedRest]
          .filter((c) => {
            const key = normalizedUrlKey(c.link);
            if (mergedSeen.has(key)) return false;
            mergedSeen.add(key);
            return true;
          })
          .slice(0, MAX_CANDIDATES_PER_TIER);

        console.log(
          `[weblink] product ${product.ID}: proposals=${proposedCandidates.length} on-domain=${proposalCandidates.length}` +
            ` index=${indexHits.length} on-domain=${indexCandidates.length} merged=${merged.length}`,
        );

        let accepted: Accepted | null = null;
        if (merged.length > 0) {
          accepted = await tryVerifyCandidates(merged);
        }

        /**
         * Verify a URL we CONSTRUCTED ourselves (never one a search returned). The licence to try a
         * made-up URL at all is that acceptance here is far stricter than anywhere else: the page's
         * OWN title/h1/meta must name this exact part or model, token-bounded. A 404, a generic
         * landing page, a family page or a sibling all fail that test, so a wrong guess cannot be
         * stored. Plain fetch first (cheap, and enough for server-rendered sites like Sennheiser and
         * Soundtube); the browser only when the fetch is blocked or renders nothing.
         */
        const verifyConstructed = async (candidate: string): Promise<Accepted | null> => {
          const fetched = await fetchPageCached(candidate);
          if (fetched.kind === "ok" && !isContentlessShell(fetched.page)) {
            const page = fetched.page;
            const readable =
              !looksLikeSoftNotFound(page) &&
              !looksLikeAccessWall(page) &&
              domainFilter({ link: fetched.finalUrl }) &&
              !isHomepageLanding(candidate, fetched.finalUrl);
            if (readable) {
              const words = `${page.title} ${page.h1} ${page.ogTitle} ${page.metaDescription}`;
              const exact = [partNumber, modelNumber].some(
                (id) => id && isDistinctiveIdentifier(id) && identifierMatchesAsToken(words, id),
              );
              const langOk = isEnglishResult(fetched.finalUrl, pageLanguage(page));
              if (exact && langOk) {
                console.log(`[weblink] product ${product.ID}: constructed ${fetched.finalUrl} verified by fetch`);
                return { link: fetched.finalUrl, verification: "content", pageLang: pageLanguage(page) };
              }
              console.log(
                `[weblink] product ${product.ID}: constructed ${fetched.finalUrl} does not name this product — rejected`,
              );
              return null;
            }
          }
          // Unreadable by fetch (blocked, or a JS-only shell): the browser is the only witness.
          const outcome = await verifyByRendering(candidate, { allowJudge: false });
          return outcome && outcome !== "read-rejected" ? outcome : null;
        };

        // (a) EXACT-VARIANT PROBE. The accepted page named only the suffix-stripped part number, so
        // it may belong to a sibling: Soundtube's "-S"/"-C"/"-R" are Surface/Corner/Rear mounts with
        // separate pages, while Neutrik's "-D" is bulk packaging and the site 301s the full code onto
        // the base page. Ask the site which it is by trying the full part number's own URL.
        if (accepted?.viaCoreOnly && partNumber && timeLeft() > 15_000) {
          for (const candidate of buildLeafSwapCandidates({
            indexedUrls: [accepted.link],
            partNumber,
            max: 1,
          })) {
            if (triedUrls.has(candidate)) continue;
            triedUrls.add(candidate);
            console.log(`[weblink] product ${product.ID}: probing the exact-part URL ${candidate}`);
            const exact = await verifyConstructed(candidate);
            // A 301 back onto the accepted page means the suffix was packaging — keep the base page.
            if (exact && normalizedUrlKey(exact.link) !== normalizedUrlKey(accepted.link)) {
              console.log(`[weblink] product ${product.ID}: exact variant found, ${accepted.link} → ${exact.link}`);
              accepted = exact;
            }
            break;
          }
        }

        // (b) Last resort for incomplete search indexes: a sibling SKU's real URL shows where this
        // product's page must live, so try that shape with our own part number. This is what
        // recovers a live page no crawler ever visited.
        if (
          (!accepted || accepted.verification === "family") &&
          indexCandidates.length > 0 &&
          timeLeft() > 20_000
        ) {
          const constructed = buildLeafSwapCandidates({
            indexedUrls: indexCandidates.map((c) => c.link),
            partNumber,
            partNumberCore: partCore,
          }).filter((link) => !triedUrls.has(link));
          for (const candidate of constructed) {
            if (timeLeft() <= 15_000) break;
            triedUrls.add(candidate);
            console.log(`[weblink] product ${product.ID}: trying constructed URL ${candidate}`);
            const outcome = await verifyConstructed(candidate);
            if (outcome && (!accepted || isBetterVerification(outcome.verification, accepted.verification))) {
              accepted = outcome;
              break;
            }
          }
        }

        // (c) A template LEARNED from another product of this brand in this same batch. Costs one
        // fetch and no search at all, which is what makes whole-catalog coverage affordable: once
        // Belden's ".../fiber-patch-cords/{part}" shape is known, its other 20,000 products need no
        // paid search. Verified exactly like any other constructed URL — the page must name the part.
        if (!accepted || accepted.verification === "family") {
          const templates = learnedTemplates.get(domain) ?? [];
          for (const tpl of templates) {
            if (timeLeft() <= 15_000) break;
            const candidate = applyUrlTemplate(tpl, partSearchable);
            if (!candidate || triedUrls.has(candidate) || !domainFilter({ link: candidate })) continue;
            triedUrls.add(candidate);
            console.log(`[weblink] product ${product.ID}: trying learned template ${candidate}`);
            const outcome = await verifyConstructed(candidate);
            if (outcome && (!accepted || isBetterVerification(outcome.verification, accepted.verification))) {
              accepted = outcome;
              break;
            }
          }
        }

        // Teach the rest of the batch: a page that verified AND carries the part number in its URL
        // reveals this brand's URL shape.
        if (accepted && accepted.verification === "content") {
          rememberTemplate(domain, accepted.link, partSearchable);
        }

        if (!accepted) {
          const timedOut = timeLeft() <= 0;
          console.log(`[weblink] product ${product.ID}: no verifiable URL found`);
          // Bot-protected site: nothing verified, but we found a plausible on-domain candidate
          // we couldn't fetch. Offer it for human review (unchecked by default in the dialog)
          // rather than dropping it — the user's browser can reach what our server can't.
          if (!timedOut && bestBlockedCandidate) {
            return {
              ...base,
              webLink: bestBlockedCandidate,
              status: "unverified",
              note: "The manufacturer site blocked automated verification. Open the link to confirm it is the right page before saving.",
            };
          }
          return {
            ...base,
            webLink: null,
            status: timedOut ? "error" : "not_found",
            note: timedOut
              ? "Search timed out before all candidates were checked."
              : sawBlockedCandidate
                ? "Could not fetch a working English page (candidate pages were unreachable or non-English)."
                : undefined,
          };
        }

        let webLink = accepted.link;
        let verification = accepted.verification;
        let pageLang = accepted.pageLang;

        // Normalize the chosen URL to an English-language page. Two failure modes:
        //   (a) Only the locale prefix is localized (e.g. /fr/products/...) — a prefix swap works.
        //   (b) The whole path is localized (e.g. Shure /it-IT/prodotti/accessori/sbc220) — the
        //       English page must be re-searched via the locale-neutral product slug.
        // Swapped/re-searched URLs go through the same full verification as the original.
        try {
          const parsed = new URL(webLink);
          const segs = parsed.pathname.split("/").filter(Boolean);
          const localeIdx = localePrefixIndex(segs);
          // Skip when this is a /{region}/{language}/ URL — its first segment can look like a
          // single-locale code (e.g. "de" in /de/en/); the dedicated region/lang block handles it.
          const isNonEnglishLocale =
            !parseRegionLangPrefix(segs) && localeIdx >= 0 && !isEnglishSegment(segs[localeIdx]);

          if (isNonEnglishLocale && timeLeft() > 0) {
            const rest = segs.slice(localeIdx + 1);
            const prefix = segs.slice(0, localeIdx);
            let fixed: Accepted | null = null;

            // Ask the page where its English version is, before guessing. Regionalised sites publish
            // <link rel="alternate" hreflang="en-GB"> etc., which beats inventing path segments —
            // guessing missed a Sennheiser product whose English page existed all along.
            const declared = await (async () => {
              const page = await fetchPageCached(webLink);
              return page.kind === "ok" ? englishAlternates(page.page, webLink) : [];
            })();
            for (const candidate of declared.slice(0, 3)) declaredAlias(webLink, candidate);
            for (const candidate of declared.slice(0, 3)) {
              if (timeLeft() <= 0) break;
              const result = await acceptCandidate(candidate, { skipIfFinalUrl: webLink });
              if (result && isEnglishResult(result.link, result.pageLang)) {
                fixed = result;
                console.log(`[weblink] product ${product.ID}: followed declared hreflang → ${result.link}`);
                break;
              }
            }

            // European English first (the company is EU-based) — Sennheiser serves the same product
            // at /en-gb/ and /en-ie/ but not /en-US/, and a run that only tried en-US reported
            // "only a non-English page was found" for a product whose English page existed.
            const swaps = Array.from(
              new Set([
                `${parsed.origin}/${[...prefix, "en-GB", ...rest].join("/")}${parsed.search}`,
                `${parsed.origin}/${[...prefix, "en-IE", ...rest].join("/")}${parsed.search}`,
                `${parsed.origin}/${[...prefix, "en-US", ...rest].join("/")}${parsed.search}`,
                `${parsed.origin}/${[...prefix, "en", ...rest].join("/")}${parsed.search}`,
                `${parsed.origin}/global/en/${rest.join("/")}${parsed.search}`,
                `${parsed.origin}/${rest.join("/")}${parsed.search}`,
              ]),
            );
            for (const candidate of fixed ? [] : swaps) {
              if (candidate === webLink) continue;
              if (timeLeft() <= 0) break;
              const result = await acceptCandidate(candidate, { skipIfFinalUrl: webLink });
              // Only adopt a swap that actually lands on an English page — some sites
              // geo-redirect a locale swap back to the original localized page.
              if (result && isEnglishResult(result.link, result.pageLang)) {
                fixed = result;
                break;
              }
            }

            if (fixed && isEnglishResult(fixed.link, fixed.pageLang)) {
              console.log(`[weblink] product ${product.ID}: localized → English ${webLink} → ${fixed.link}`);
              webLink = fixed.link;
              verification = fixed.verification;
              pageLang = fixed.pageLang;
            } else {
              console.log(`[weblink] product ${product.ID}: no English variant found for ${webLink}, keeping original`);
            }
          }
        } catch {
          /* ignore */
        }

        // Prefer the EU/UK English site over other English regions, verified like any other
        // candidate. PREFERRED_ENGLISH_LOCALES keeps this gate in sync with the scorer.
        try {
          const parsed = new URL(webLink);
          const segs = parsed.pathname.split("/").filter(Boolean);
          const localeIdx = localePrefixIndex(segs);
          const loc = localeIdx >= 0 ? segs[localeIdx].toLowerCase() : "";
          if (loc && isEnglishSegment(loc) && !PREFERRED_ENGLISH_LOCALES.test(loc) && timeLeft() > 0) {
            for (const target of ["en-EU", "en-GB"]) {
              const swapped = [...segs];
              swapped[localeIdx] = target;
              const candidate = `${parsed.origin}/${swapped.join("/")}${parsed.search}`;
              if (candidate === webLink) continue;
              if (timeLeft() <= 0) break;
              const result = await acceptCandidate(candidate, { skipIfFinalUrl: webLink });
              // Never downgrade a working English page: a locale swap that geo-redirects to a
              // non-English page must not be adopted.
              if (result && isEnglishResult(result.link, result.pageLang)) {
                console.log(`[weblink] product ${product.ID}: preferring EU English ${webLink} → ${result.link}`);
                webLink = result.link;
                verification = result.verification;
                pageLang = result.pageLang;
                break;
              }
            }
          }
        } catch {
          /* ignore */
        }

        // /{region}/{language}/ commerce sites (e.g. Keenfinity /tw/en/, /tw/tw/, /au/en/):
        // normalize the language to English and prefer a European market. Each candidate is
        // re-verified, so a non-existent variant is skipped and the original is kept.
        try {
          const parsed = new URL(webLink);
          const rl = parseRegionLangPrefix(parsed.pathname.split("/").filter(Boolean));
          const needsFix = rl && (rl.lang !== "en" || !EUROPEAN_REGIONS.has(rl.region));
          if (needsFix && timeLeft() > 0) {
            for (const candidate of buildRegionLangEnglishCandidates(webLink)) {
              if (timeLeft() <= 0) break;
              const result = await acceptCandidate(candidate, { skipIfFinalUrl: webLink });
              // Adopt only when the swap lands on a genuinely English page that actually exists.
              // Keenfinity bot-blocks fetches, so a guessed /eu/en/ URL can't be read/confirmed
              // and acceptCandidate rejects it rather than inventing a 404.
              if (result && isEnglishResult(result.link, result.pageLang)) {
                console.log(`[weblink] product ${product.ID}: region/lang → English/EU ${webLink} → ${result.link}`);
                webLink = result.link;
                verification = result.verification;
                pageLang = result.pageLang;
                break;
              }
            }
          }
        } catch {
          /* ignore */
        }

        // Prefer a documentation section's landing page over a deep sub-tab: e.g. a chosen
        // .../Air/hardware-specifications becomes .../Air (the product overview). The child page
        // already established this doc section is the right product, so the parent (its general
        // view) only needs to LOAD and be English — we don't re-run the product-match check,
        // which would wrongly reject the general Overview for an accessory (e.g. a battery).
        try {
          const parent = parentDocSectionUrl(webLink);
          if (parent && parent !== webLink && timeLeft() > 0) {
            const fetched = await fetchPageCached(parent);
            if (
              fetched.kind === "ok" &&
              !isHomepageLanding(parent, fetched.finalUrl) &&
              !looksLikeSoftNotFound(fetched.page)
            ) {
              const parentLang = pageLanguage(fetched.page);
              if (isEnglishResult(fetched.finalUrl, parentLang)) {
                console.log(`[weblink] product ${product.ID}: doc sub-tab → landing ${webLink} → ${fetched.finalUrl}`);
                webLink = fetched.finalUrl;
                pageLang = parentLang;
              }
            }
          }
        } catch {
          /* ignore */
        }

        // English-only guard: after all normalization, if the page is still not English —
        // by its URL language segment or its declared <html lang>/og:locale — reject it.
        // Better "no link" than a foreign-language page.
        if (!isEnglishResult(webLink, pageLang)) {
          console.log(`[weblink] product ${product.ID}: only a non-English page found (${webLink}, lang=${pageLang || "?"}) — skipping`);
          return {
            ...base,
            webLink: null,
            status: "not_found",
            note: "Only a non-English page was found; skipped (English pages only).",
          };
        }

        // Search results routinely carry someone else's click id (?fbclid=…, ?utm_source=…) on an
        // otherwise perfect product URL; don't store campaign junk.
        const cleanedLink = stripTrackingParams(webLink);

        return {
          ...base,
          webLink: cleanedLink.slice(0, 2000),
          status: "previewed",
          verification,
          // A family page is the weak last resort: it is the right product RANGE but does not
          // identify this model, so every sibling SKU would get the same link. Say so, and let the
          // dialog leave it unselected.
          note:
            verification === "family"
              ? "Only the product family/range page was found — it does not identify this specific model. Check it before saving."
              : undefined,
        };
      } finally {
        productSemaphore.release();
      }
    }),
  );

  const results: ProductResult[] = settled.map((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;
    console.error(`Failed to find web link for product ${products[i].ID}:`, outcome.reason);
    return {
      productId: products[i].ID,
      brand: products[i].Brand,
      partNumber: products[i].PartNumber,
      modelNumber: products[i].ModelNumber,
      oldWebLink: products[i].WebLink,
      webLink: null,
      status: "error",
      note: outcome.reason instanceof Error ? outcome.reason.message : "Unexpected error.",
    };
  });

  // Requested IDs that don't exist in dbo.Products must not silently vanish from the accounting.
  for (const id of requestedIds) {
    if (!foundIds.has(id)) {
      results.push({
        productId: id,
        brand: null,
        partNumber: null,
        modelNumber: null,
        oldWebLink: null,
        webLink: null,
        status: "error",
        note: "Product not found in database.",
      });
    }
  }

  const foundCount = results.filter((r) => r.status === "previewed").length;
  const notFoundCount = results.filter((r) => r.status === "not_found").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  return NextResponse.json({ ok: true, foundCount, notFoundCount, errorCount, results });
}
