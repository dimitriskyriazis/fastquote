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
  scoreCandidateUrl,
  extractPageContent,
  looksLikeSoftNotFound,
  isHomepageLanding,
  pageMatchStrength,
  isArticleOrNewsPath,
  hasHeadlineSlug,
  looksLikeArticlePage,
  pageLanguage,
  isEnglishResult,
  urlLanguageIsNonEnglish,
  parentDocSectionUrl,
  extractPartPrefix,
  identifierAppearsInText,
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
const MAX_CANDIDATES_PER_TIER = 6;
const PAGE_FETCH_TIMEOUT_MS = 12_000;
const PAGE_BYTE_CAP = 500_000;

// Bound concurrent outgoing work. Module-global so simultaneous requests share the caps.
const openaiSemaphore = new Semaphore(4);
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
 *  callers decide whether that fails open (domain resolution → skip) or closed (validation → reject). */
const openaiText = async (openai: OpenAI, model: string, input: string): Promise<string> => {
  const MAX_RETRIES = 3;
  await openaiSemaphore.acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await openai.responses.create({ model, input, temperature: 0, stream: false });
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
 *  Distinguishes hard not-founds, bot-blocks/network failures, and readable pages. */
const fetchPage = async (url: string): Promise<FetchedPage> => {
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

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Brand → domain memoization for this batch: one resolution per brand, not per product.
  const domainCache = new Map<string, Promise<string | null>>();

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
    if (probe.kind === "ok") {
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
      const timeLeft = () => PER_PRODUCT_TIME_BUDGET_MS - (Date.now() - startedAt);
      try {
        const brand = product.Brand?.trim() ?? "";
        const modelNumber = product.ModelNumber?.trim() ?? "";
        const partNumber = product.PartNumber?.trim() ?? "";
        const description = product.Description?.trim() ?? "";

        if (!brand && !modelNumber && !partNumber && !description) {
          return { ...base, webLink: null, status: "not_found", note: "Product has no searchable data." };
        }

        // Step 1: propose candidate URLs. One agentic web-search call per product finds
        // candidate product pages (scoped to the curated Brands.WebDomain when set) and, when
        // we don't have a domain, identifies the manufacturer's official site by searching.
        const curatedDomain = product.BrandWebDomain?.trim().toLowerCase().replace(/^www\./, "") || null;
        let domain: string | null = curatedDomain;
        let proposedCandidates: Array<{ link: string }> = [];

        try {
          await openaiSemaphore.acquire();
          let proposal;
          try {
            proposal = await proposeWebLinks(
              openai,
              WEBLINK_SEARCH_MODEL,
              { brand, partNumber, modelNumber, description },
              domain,
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

        const partPrefix = extractPartPrefix(partNumber);
        const identifiers = [partNumber, modelNumber, partPrefix].filter(Boolean);
        const scoreIds = { modelNumber, partNumber, partPrefix };

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
            if (/\/shop\/|\/brand-filter\/|\/cart\/|\/checkout\/|\/account\//.test(path)) return false;
            if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|zip)(\?[^/]*)?$/i.test(path)) return false;
            // Knowledge-base articles / news / community posts are never the product page —
            // reject by path pattern and by headline-style slugs (blog/press titles).
            if (isArticleOrNewsPath(path) || hasHeadlineSlug(r.link)) return false;
            return hostMatchesDomain(host, domain);
          } catch {
            return false;
          }
        };

        // Ask GPT-4o-mini whether a fetched page is a useful product page for THIS product.
        // FAIL CLOSED: any LLM error rejects the candidate (a wrong link proposed for saving is
        // worse than a missing one — the old fail-open default proposed junk during outages).
        const validatePageForProduct = async (
          url: string,
          page: ExtractedPage,
          opts?: { bodyMatchHint?: boolean },
        ): Promise<boolean> => {
          try {
            const reply = await openaiText(openai, "gpt-4o-mini", [
              `You are validating a candidate manufacturer web page for a specific product.`,
              `Product brand: ${brand || "(unknown)"}`,
              `Part number: ${partNumber || "(none)"}`,
              `Model number: ${modelNumber || "(none)"}`,
              `Product description: ${description.slice(0, 300) || "(none)"}`,
              ``,
              `Candidate URL: ${url}`,
              `Page title: ${page.title || "(empty)"}`,
              `Meta description: ${page.metaDescription || "(empty)"}`,
              `Page text excerpt: ${page.bodyText.slice(0, 1200) || "(empty)"}`,
              ``,
              ...(opts?.bodyMatchHint
                ? [
                    `Note: the part number appears somewhere in the page text, but that alone does NOT`,
                    `prove this is the right page — accessory part numbers are often listed on the PARENT`,
                    `product's page (accessories/related-products sections).`,
                    ``,
                  ]
                : []),
              `Reply YES if this page is a product detail page, spec page, or a product family page`,
              `that plausibly covers this specific product. Manufacturers often use different internal`,
              `codes in URLs than customer-facing part numbers, so judge by product NAME and TYPE,`,
              `not by exact code matching.`,
              `Reply NO if the page is a broad category listing, search results, support/news/blog page,`,
              `a homepage, or clearly a DIFFERENT product type than the description above.`,
              `In particular: if the product description is an ACCESSORY (bracket, mount, adapter, cable,`,
              `case, rigging, cover), the page must be about that accessory itself — a page whose title`,
              `names the main product the accessory attaches to is NO.`,
              ``,
              `Reply YES or NO only.`,
            ].join("\n"));
            const valid = reply.toUpperCase().startsWith("YES");
            console.log(`[weblink] product ${product.ID}: url=${url} llm_page_valid=${valid}`);
            return valid;
          } catch (err) {
            console.warn(`[weblink] product ${product.ID}: page validation failed (rejecting candidate):`, err);
            return false;
          }
        };

        type Accepted = { link: string; verification: WebLinkVerification; pageLang: string };
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
          // News/blog/press posts often carry the model number in their title/slug (so they'd
          // pass the "strong" content match) but are never the product page — reject outright.
          if (looksLikeArticlePage(fetched.page, fetched.finalUrl)) {
            console.log(`[weblink] product ${product.ID}: url=${fetched.finalUrl} looks like an article/blog post — rejected`);
            return null;
          }
          const lang = pageLanguage(fetched.page);
          const matchStrength = pageMatchStrength(fetched.page, fetched.finalUrl, identifiers);
          if (matchStrength === "strong") {
            // Identifier in the title/meta/URL — this page is ABOUT the product.
            console.log(`[weblink] product ${product.ID}: url=${url} verified by content`);
            return { link: fetched.finalUrl, verification: "content", pageLang: lang };
          }
          // Body-only matches are NOT trusted on their own: accessory part numbers are
          // routinely listed on the PARENT product's page (e.g. a bracket's part number in
          // the loudspeaker's accessories section) — the LLM must corroborate.
          if (await validatePageForProduct(url, fetched.page, { bodyMatchHint: matchStrength === "body" })) {
            return { link: fetched.finalUrl, verification: "llm", pageLang: lang };
          }
          return null;
        };

        // URLs that were actually fetched/attempted — never pre-poisoned by score cutoffs
        // or per-tier caps, so a URL sliced off in one tier can still be tried in a later one.
        const triedUrls = new Set<string>();
        const tryVerifyCandidates = async (candidateList: Array<{ link: string }>): Promise<Accepted | null> => {
          const sorted = candidateList
            .filter((c, i, arr) => arr.findIndex((x) => x.link === c.link) === i && !triedUrls.has(c.link))
            .map((c) => ({ ...c, score: scoreCandidateUrl(c.link, scoreIds) }))
            .filter((c) => c.score > -5)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_CANDIDATES_PER_TIER);
          for (const candidate of sorted) {
            if (timeLeft() <= 0) {
              console.warn(`[weblink] product ${product.ID}: time budget exhausted`);
              return null;
            }
            triedUrls.add(candidate.link);
            const accepted = await acceptCandidate(candidate.link);
            if (accepted) return accepted;
          }
          return null;
        };

        // Candidates came from the web-search proposal above. The domain filter and the full
        // fetch-and-verify pipeline still gate every proposal — the model only proposes.
        let accepted: Accepted | null = null;
        const filtered = proposedCandidates.filter(domainFilter);
        console.log(
          `[weblink] product ${product.ID}: proposals=${proposedCandidates.length} on-domain=${filtered.length}`,
        );
        if (filtered.length > 0) {
          accepted = await tryVerifyCandidates(filtered);
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

            const swaps = Array.from(
              new Set([
                `${parsed.origin}/${[...prefix, "en-US", ...rest].join("/")}${parsed.search}`,
                `${parsed.origin}/${[...prefix, "en", ...rest].join("/")}${parsed.search}`,
                `${parsed.origin}/global/en/${rest.join("/")}${parsed.search}`,
                `${parsed.origin}/${rest.join("/")}${parsed.search}`,
              ]),
            );
            for (const candidate of swaps) {
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

        return { ...base, webLink: webLink.slice(0, 2000), status: "previewed", verification };
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
