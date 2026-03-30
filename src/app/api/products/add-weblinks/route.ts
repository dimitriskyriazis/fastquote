import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import OpenAI from "openai";

export const runtime = "nodejs";

const MAX_PRODUCT_IDS = 200;

// Limits concurrent outgoing Serper API calls to avoid 429 rate-limit errors.
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const serperSemaphore = new Semaphore(5);

// Hardcoded domain cache for brands where GPT-4o resolution is unreliable or slow.
// Keys are lowercase brand names; values are the canonical bare domain.
const KNOWN_BRAND_DOMAINS: Record<string, string> = {
  "grass valley": "grassvalley.com",
  "grassvalley": "grassvalley.com",
  "bosch": "commerce.keenfinity.tech",
};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};


type ProductRow = {
  ID: number;
  Brand: string | null;
  ModelNumber: string | null;
  PartNumber: string | null;
  Description: string | null;
};


// Verify a URL resolves to an existing page.
// Tries HEAD first; falls back to a minimal GET if the server doesn't allow HEAD.
// Accepts any 2xx or 3xx (after following redirects). Rejects 404/410/451.
const verifyUrl = async (url: string): Promise<boolean> => {
  // Use a realistic browser User-Agent — portal sites (e.g. community.grassvalley.com)
  // block bot-like UAs or return unexpected responses.
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const tryFetch = async (method: "HEAD" | "GET"): Promise<number | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
        },
      });
      return res.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const NOT_FOUND_STATUSES = new Set([404, 410, 451]);

  const headStatus = await tryFetch("HEAD");
  if (headStatus !== null) {
    if (NOT_FOUND_STATUSES.has(headStatus)) return false;
    if (headStatus === 405 || headStatus === 403) {
      // Server doesn't allow HEAD — fall back to GET
      const getStatus = await tryFetch("GET");
      if (getStatus === null) return true; // network error on GET, assume reachable
      return !NOT_FOUND_STATUSES.has(getStatus);
    }
    return true; // any other status (200, 301 after redirect, etc.)
  }

  // HEAD timed out / network error — try GET
  const getStatus = await tryFetch("GET");
  if (getStatus === null) return false;
  return !NOT_FOUND_STATUSES.has(getStatus);
};

export async function POST(req: NextRequest) {
  logRequest(req, "/api/products/add-weblinks");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const rawIds: unknown = body?.productIds;

    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No product IDs provided." }, { status: 400 });
    }

    const productIds = rawIds
      .map(normalizeProductId)
      .filter((id): id is number => id !== null);

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

    // Fetch product data from DB
    const idList = productIds.join(",");
    const fetchReq = pool.request();
    const fetchResult = await fetchReq.query<ProductRow>(`
      SELECT p.ID, b.Name AS Brand, p.ModelNumber, p.PartNumber, p.Description
      FROM dbo.Products p
      LEFT JOIN dbo.Brands b ON b.ID = p.BrandID
      WHERE p.ID IN (${idList})
    `);

    const products = fetchResult.recordset;
    if (products.length === 0) {
      return NextResponse.json({ ok: false, error: "No matching products found." }, { status: 404 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    type ProductResult = { productId: number; webLink: string | null; status: "updated" | "not_found" | "error" };

    const settled = await Promise.allSettled(
      products.map(async (product): Promise<ProductResult> => {
        const brand = product.Brand?.trim() ?? "";
        const modelNumber = product.ModelNumber?.trim() ?? "";
        const partNumber = product.PartNumber?.trim() ?? "";
        const description = product.Description?.trim() ?? "";

        if (!brand && !modelNumber && !partNumber && !description) {
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

        // Step 1: Resolve the manufacturer's domain.
        // Check the hardcoded cache first to avoid intermittent GPT-4o failures for known brands.
        let domain: string | null = null;
        if (brand) {
          const cached = KNOWN_BRAND_DOMAINS[brand.toLowerCase()];
          if (cached) {
            domain = cached;
            console.log(`[weblink] product ${product.ID} (${brand}): domain=${domain} (cached)`);
          }
        }
        if (!domain && brand) {
          const domainRes = await openai.responses.create({
            model: "gpt-4o",
            input:
              `What is the official website domain for the manufacturer "${brand}"?\n` +
              `Return ONLY the bare domain (e.g. extron.com, sony.com, yamaha.com). ` +
              `No www prefix, no https://, no path, no explanation.\n` +
              `If you are not certain, respond exactly: NOT_FOUND`,
            stream: false,
          });
          const raw = domainRes.output_text?.trim() ?? "";
          if (raw && raw !== "NOT_FOUND") {
            try {
              const host = raw.includes("://") ? new URL(raw).hostname : raw.split("/")[0];
              const cleaned = host.replace(/^www\./i, "").toLowerCase();
              if (cleaned.includes(".")) domain = cleaned;
            } catch {
              // ignore malformed response
            }
          }
        }

        if (!domain) {
          console.log(`[weblink] product ${product.ID} (${brand}): domain not resolved`);
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

        console.log(`[weblink] product ${product.ID} (${brand}): domain=${domain}`);

        // Score a candidate URL — higher is better.
        // Prefers URLs whose path contains the model/part number over generic category pages.
        const scoreUrl = (link: string): number => {
          let score = 0;
          try {
            const parsed = new URL(link);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            const segments = path.split("/").filter(Boolean);
            // Penalise staging, auth, or non-production subdomains
            if (/stage|staging|auth|dev|test|sandbox/.test(host)) score -= 10;
            // Penalise shop/cart/brand-filter pages — not product spec pages
            if (/shop|cart|brand-filter|checkout|account/.test(path)) score -= 6;
            // Exact part/model number in URL path — strong signal this is the right product page
            const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, "");
            if (modelNumber) {
              const normModel = normalize(modelNumber);
              if (path.replace(/[\s\-_]+/g, "").includes(normModel)) score += 5;
            }
            if (partNumber) {
              const normPart = normalize(partNumber);
              const normPrefix = usePartPrefix ? normalize(partPrefix) : "";
              // Full exact match of part number in path (e.g. ecom-item/911.1520.900)
              if (path.includes(partNumber.toLowerCase())) score += 6;
              else if (path.replace(/[\s\-_]+/g, "").includes(normPart)) score += 3;
              // Part number prefix in URL path (e.g. Z5012 from Z5012.500 matches /accessories/z5012/)
              else if (normPrefix && path.includes(normPrefix)) score += 4;
              else {
                // If a different numeric product code appears in the URL path, this is likely the wrong product.
                // Skip UUID-like segments to avoid false positives from GUID-based category filters
                // (e.g. /category/327C3621-DB53-... or pipe-joined GUIDs like UUID|UUID|UUID).
                const isUuidLike = (s: string) =>
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ||
                  s.includes("|") ||
                  (s.length > 20 && /^[0-9a-f\-]+$/.test(s));
                const partPattern = /\d{3}[.\-]\d{4}[.\-]\d{3}|\d{6,}/g;
                const pathCodes = segments
                  .filter(s => !isUuidLike(s))
                  .flatMap(s => s.match(partPattern) ?? []);
                if (pathCodes.length > 0 && !pathCodes.some(c => normalize(c) === normPart)) score -= 8;
              }
            }
            if (segments.length >= 2) score += 1; // deeper path = more specific page
            const lastSeg = segments[segments.length - 1] ?? "";
            if (/search|results|catalog|category|products?$/.test(lastSeg)) score -= 4;
            // Prefer English/canonical URLs over locale-specific variants (e.g. /nb/, /zh/, /es-LATAM/)
            const localePattern = /^[a-z]{2}(-[a-zA-Z]{2,8})?$/;
            const firstSeg = segments[0] ?? "";
            const secondSeg = segments[1] ?? "";
            const locSeg = localePattern.test(firstSeg) ? firstSeg
              : (/^(global|region|site)$/i.test(firstSeg) && localePattern.test(secondSeg)) ? secondSeg
              : null;
            if (locSeg && locSeg !== "en" && !locSeg.startsWith("en-")) score -= 3;
            // Penalise documentation, guide, and support paths — prefer product listing/spec pages.
            // Exception: /support/s/portalproduct/ (e.g. community.grassvalley.com) is a product page.
            if (/\/support\/s\/portalproduct\//.test(path)) { /* no penalty — this is a product portal page */ }
            else if (/\/docs\/|\/guide\/|\/guides\/|\/support\/|\/kb\/|\/faq\/|\/help\/|\/articulos\//.test(path)) score -= 5;
          } catch { /* ignore */ }
          return score;
        };

        const serperSearch = async (q: string): Promise<Array<{ link: string }>> => {
          const MAX_RETRIES = 3;
          const BASE_DELAY_MS = 1000;

          await serperSemaphore.acquire();
          try {
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              const res = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: {
                  "X-API-KEY": process.env.SERPER_API_KEY ?? "",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ q, num: 10, hl: "en", gl: "us" }),
              });

              if (res.ok) {
                const data = await res.json() as { organic?: Array<{ link: string }> };
                return data.organic ?? [];
              }

              if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES - 1) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                console.warn(
                  `[weblink] Serper ${res.status} for product ${product.ID}, ` +
                  `attempt ${attempt + 1}/${MAX_RETRIES}, retrying in ${delay}ms`
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
              }

              console.error(`Serper API error for product ${product.ID}: ${res.status}`);
              return [];
            }
            return [];
          } finally {
            serperSemaphore.release();
          }
        };

        // Build multiple sets of search terms with decreasing specificity:
        // 1. Quoted part number (exact match for precision)
        // 2. Unquoted part number (for recall when exact match fails)
        // 3. Part number prefix — some manufacturers use shortened codes in URLs
        //    (e.g. d&b audiotechnik: Z5012.500 → /accessories/z5012/)
        const quotedPartNumber = partNumber ? `"${partNumber}"` : "";
        const searchTermsQuoted = [modelNumber, quotedPartNumber].filter(Boolean).join(" ");
        const searchTermsUnquoted = [modelNumber, partNumber].filter(Boolean).join(" ");
        // Extract part number prefix (before first dot) if it's meaningful (4+ chars)
        const partPrefix = partNumber ? partNumber.split(".")[0] : "";
        const usePartPrefix = partPrefix.length >= 4 && partPrefix !== partNumber;
        const searchTermsPrefix = usePartPrefix
          ? [modelNumber, partPrefix].filter(Boolean).join(" ")
          : "";
        // Always include description words — part numbers alone (e.g. "910-001390-00") rarely
        // appear in URLs, but the description contains the human-readable product name that does.
        const descWords = description ? description.split(/\s+/).slice(0, 10).join(" ") : "";
        const effectiveTermsQuoted = [searchTermsQuoted, descWords].filter(Boolean).join(" ").trim();
        const effectiveTermsUnquoted = [searchTermsUnquoted, descWords].filter(Boolean).join(" ").trim();
        const effectiveTermsPrefix = searchTermsPrefix
          ? [searchTermsPrefix, descWords].filter(Boolean).join(" ").trim()
          : "";

        if (!effectiveTermsUnquoted) {
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

        // Hard-filter: only keep URLs on the manufacturer's domain, excluding staging subdomains,
        // non-product pages, and document files (PDFs, datasheets, etc.).
        const domainFilter = (r: { link: string }) => {
          try {
            const parsed = new URL(r.link);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            const subdomain = host.split(".")[0];
            if (/stage|staging|rhythm|dev|test|sandbox/.test(subdomain)) return false;
            if (/\/shop\/|\/brand-filter\/|\/cart\/|\/checkout\/|\/account\//.test(path)) return false;
            // Reject document/file URLs — we want product web pages, not PDFs or downloads
            if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|zip)(\?[^/]*)?$/i.test(path)) return false;
            return host.replace(/^www\./i, "").endsWith(domain!);
          } catch { return false; }
        };

        // Ask GPT-4o-mini to confirm the URL is an individual product detail page,
        // not a category, family overview, or search results page.
        // The LLM does NOT try to match the part number — it has no web access and
        // manufacturers often use different numbering schemes in URLs (e.g. biamp maps
        // 912.1946.900 → 920-01946-00001). The heuristic scoring handles product matching;
        // the LLM's job is only to catch generic/non-product pages that pass the score filter.
        const validateUrlForProduct = async (url: string): Promise<boolean> => {
          try {
            const res = await openai.responses.create({
              model: "gpt-4o-mini",
              input: [
                `Evaluate whether this URL is a useful product page for finding specifications of a specific product.`,
                `Manufacturer domain: ${domain}`,
                `URL: ${url}`,
                ``,
                `Reply YES if the URL appears to be ANY of the following:`,
                `- A page for one specific product (product detail, spec sheet, datasheet page)`,
                `- A product family or product line page that lists individual product variants with their specifications`,
                `- A product configuration page showing different models or SKUs within a product series`,
                ``,
                `Reply NO if the URL is:`,
                `- A top-level category or catalog page listing many unrelated product families`,
                `- A search results page`,
                `- A brand, company, or support homepage`,
                `- A news, blog, or press release page`,
                `- A generic "all products" listing with no specific product details`,
                ``,
                `The key distinction: YES if the page shows specs/details for a specific product or a closely related`,
                `group of product variants. NO if it is a broad listing or navigation page with no product-level detail.`,
                ``,
                `Do NOT try to match the URL to a specific model or part number — manufacturers`,
                `often use internal codes in URLs that differ from customer-facing part numbers.`,
                ``,
                `Reply YES or NO only.`,
              ].join("\n"),
              stream: false,
            });
            const valid = (res.output_text?.trim().toUpperCase() ?? "").startsWith("YES");
            console.log(`[weblink] product ${product.ID}: url=${url} llm_valid=${valid}`);
            return valid;
          } catch {
            return true; // if LLM call fails, don't block the URL
          }
        };

        // For domains resolved from the hardcoded cache we trust Google results
        // even when our server-side fetch can't reach the page (e.g. Salesforce portals
        // like community.grassvalley.com that block Node.js fetch but work in browsers).
        const isCachedDomain = !!KNOWN_BRAND_DOMAINS[brand.toLowerCase()];

        const tryVerifyCandidates = async (candidateList: Array<{ link: string }>): Promise<string | null> => {
          const sorted = candidateList
            .map((c) => ({ ...c, score: scoreUrl(c.link) }))
            .filter((c) => c.score > -5)
            .sort((a, b) => b.score - a.score);
          for (const candidate of sorted) {
            const reachable = await verifyUrl(candidate.link);
            console.log(`[weblink] product ${product.ID}: url=${candidate.link} reachable=${reachable}`);
            if (!reachable && !isCachedDomain) continue;
            if (!reachable && isCachedDomain) {
              console.log(`[weblink] product ${product.ID}: trusting Google result for cached domain despite verify failure`);
            }
            if (await validateUrlForProduct(candidate.link)) return candidate.link;
          }
          return null;
        };

        // Step 2a: Site-constrained search — try quoted part number first for precision,
        // then retry unquoted if quoting yields no results (some sites don't index exact part numbers).
        let candidates: Array<{ link: string }> = [];
        const query2aQuoted = `site:${domain} ${effectiveTermsQuoted}`;
        candidates = (await serperSearch(query2aQuoted)).filter(domainFilter);
        console.log(`[weblink] product ${product.ID}: query="${query2aQuoted}" candidates=${candidates.length}`);

        if (candidates.length === 0 && effectiveTermsQuoted !== effectiveTermsUnquoted) {
          const query2aUnquoted = `site:${domain} ${effectiveTermsUnquoted}`;
          candidates = (await serperSearch(query2aUnquoted)).filter(domainFilter);
          console.log(`[weblink] product ${product.ID}: unquoted query="${query2aUnquoted}" candidates=${candidates.length}`);
        }

        // Try with part number prefix — covers manufacturers that use shortened codes in URLs
        if (candidates.length === 0 && effectiveTermsPrefix) {
          const query2aPrefix = `site:${domain} ${effectiveTermsPrefix}`;
          candidates = (await serperSearch(query2aPrefix)).filter(domainFilter);
          console.log(`[weblink] product ${product.ID}: prefix query="${query2aPrefix}" candidates=${candidates.length}`);
        }

        let webLink: string | null = null;

        if (candidates.length > 0) {
          webLink = await tryVerifyCandidates(candidates);
          if (!webLink) {
            console.log(`[weblink] product ${product.ID}: site-constrained candidates failed, trying fallback`);
          }
        }

        // Step 2b: If no results or all unreachable, broaden without site: constraint.
        if (!webLink) {
          const fallbackQuery = `${brand} ${effectiveTermsUnquoted} product specifications`.trim();
          const fallbackResults = await serperSearch(fallbackQuery);
          const fallbackCandidates = fallbackResults.filter(domainFilter);
          console.log(`[weblink] product ${product.ID}: fallback query="${fallbackQuery}" candidates=${fallbackCandidates.length}`);
          if (fallbackCandidates.length > 0) {
            webLink = await tryVerifyCandidates(fallbackCandidates);
          }
        }

        // Step 2c: Last-resort — search with just the part or model number.
        if (!webLink) {
          const identifier = partNumber || modelNumber;
          if (identifier) {
            // Try quoted first for precision
            const lastResortQuery = `${brand} "${identifier}" product specifications`.trim();
            const lastResortResults = await serperSearch(lastResortQuery);
            let lastResortCandidates = lastResortResults.filter(domainFilter);
            console.log(
              `[weblink] product ${product.ID}: last-resort query="${lastResortQuery}" candidates=${lastResortCandidates.length}`
            );
            // Fall back to unquoted if quoted yields nothing
            if (lastResortCandidates.length === 0) {
              const unquotedQuery = `${brand} ${identifier} product specifications`.trim();
              const unquotedResults = await serperSearch(unquotedQuery);
              lastResortCandidates = unquotedResults.filter(domainFilter);
              console.log(
                `[weblink] product ${product.ID}: last-resort unquoted query="${unquotedQuery}" candidates=${lastResortCandidates.length}`
              );
            }
            if (lastResortCandidates.length > 0) {
              webLink = await tryVerifyCandidates(lastResortCandidates);
            }
          }
        }

        if (!webLink) {
          console.log(`[weblink] product ${product.ID}: no reachable URL found`);
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

        // Normalize URL to English. Handles common locale patterns:
        //   Pattern 1: /{locale}/rest/of/path       (e.g. /fr/products/..., /es-LATAM/productos/...)
        //   Pattern 2: /{prefix}/{locale}/rest       (e.g. /global/de/produkte/..., /global/ru/...)
        //   Pattern 3: /{country}/{lang}/rest        (e.g. /jp/ja/products/... → /global/en/products/...)
        try {
          const parsed = new URL(webLink);
          const segs = parsed.pathname.split("/").filter(Boolean);
          const isLocale = (s: string) => /^[a-z]{2}(-[a-zA-Z]{2,8})?$/.test(s);
          const isEnglish = (s: string) => s === "en" || s.startsWith("en-");

          // Detect how many leading segments are locale-like
          // Pattern 3: two consecutive locales (country + language), e.g. /jp/ja/...
          // Pattern 2: prefix + locale, e.g. /global/de/...
          // Pattern 1: single locale, e.g. /fr/...
          const hasDoubleLocale = segs.length > 2 && isLocale(segs[0]) && isLocale(segs[1]);
          const hasPrefixLocale = !hasDoubleLocale && segs.length > 2
            && /^(global|region|site)$/i.test(segs[0]) && isLocale(segs[1]);
          const hasSingleLocale = !hasDoubleLocale && !hasPrefixLocale
            && segs.length > 1 && isLocale(segs[0]);

          // Build English URL candidates to try, in order of preference
          const rest = hasDoubleLocale ? segs.slice(2)
            : hasPrefixLocale ? segs.slice(2)
            : hasSingleLocale ? segs.slice(1)
            : [];

          const needsFix = (hasDoubleLocale && !(isEnglish(segs[0]) || isEnglish(segs[1])))
            || (hasPrefixLocale && !isEnglish(segs[1]))
            || (hasSingleLocale && !isEnglish(segs[0]));

          if (needsFix && rest.length > 0) {
            // Try multiple English URL patterns in order
            const candidates = [
              `${parsed.origin}/global/en/${rest.join("/")}`,
              `${parsed.origin}/en/${rest.join("/")}`,
              `${parsed.origin}/${rest.join("/")}`,
            ];
            for (const candidate of candidates) {
              if (candidate === webLink) continue;
              if (await verifyUrl(candidate)) {
                console.log(`[weblink] product ${product.ID}: localized to English ${webLink} → ${candidate}`);
                webLink = candidate;
                break;
              }
            }
          }
        } catch { /* ignore */ }

        const updateReq = pool.request();
        updateReq.input("ProductID", sql.Int, product.ID);
        updateReq.input("WebLink", sql.NVarChar(2000), webLink.slice(0, 2000));
        updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await updateReq.query(`
          UPDATE dbo.Products
          SET WebLink = @WebLink,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @ProductID
        `);

        return { productId: product.ID, webLink, status: "updated" };
      }),
    );

    const results: ProductResult[] = settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") return outcome.value;
      console.error(`Failed to get web link for product ${products[i].ID}:`, outcome.reason);
      return { productId: products[i].ID, webLink: null, status: "error" };
    });

    const updatedCount = results.filter((r) => r.status === "updated").length;
    const failedCount = results.filter((r) => r.status !== "updated").length;

    return NextResponse.json({ ok: true, updatedCount, failedCount, results });
  } catch (err) {
    console.error("Failed to add web links", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
