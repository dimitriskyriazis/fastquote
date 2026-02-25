import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import OpenAI from "openai";

export const runtime = "nodejs";

const MAX_PRODUCT_IDS = 200;

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
  const UA = "Mozilla/5.0 (compatible; product-link-checker/1.0)";

  const tryFetch = async (method: "HEAD" | "GET"): Promise<number | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": UA, ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
      });
      return res.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
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

        // Step 1: Resolve the manufacturer's domain from the model's training knowledge.
        // No web search needed — the model knows most major AV/broadcast manufacturer domains.
        let domain: string | null = null;
        if (brand) {
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
              // Full exact match of part number in path (e.g. ecom-item/911.1520.900)
              if (path.includes(partNumber.toLowerCase())) score += 6;
              else if (path.replace(/[\s\-_]+/g, "").includes(normPart)) score += 3;
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
            // Prefer canonical/base-language URLs over locale-specific variants (e.g. /nb/, /zh/, /en-KY/)
            const firstSeg = segments[0] ?? "";
            if (/^[a-z]{2}(-[a-zA-Z]{2,4})?$/.test(firstSeg)) score -= 2;
            // Penalise documentation, guide, and support paths — prefer product listing/spec pages
            if (/\/docs\/|\/guide\/|\/guides\/|\/support\/|\/kb\/|\/faq\/|\/help\/|\/articulos\//.test(path)) score -= 5;
          } catch { /* ignore */ }
          return score;
        };

        const serperSearch = async (q: string): Promise<Array<{ link: string }>> => {
          const res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": process.env.SERPER_API_KEY ?? "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q, num: 10 }),
          });
          if (!res.ok) {
            console.error(`Serper API error for product ${product.ID}: ${res.status}`);
            return [];
          }
          const data = await res.json() as { organic?: Array<{ link: string }> };
          return data.organic ?? [];
        };

        const searchTerms = [modelNumber, partNumber].filter(Boolean).join(" ");
        // Always include description words — part numbers alone (e.g. "910-001390-00") rarely
        // appear in URLs, but the description contains the human-readable product name that does.
        const descWords = description ? description.split(/\s+/).slice(0, 6).join(" ") : "";
        const effectiveTerms = [searchTerms, descWords].filter(Boolean).join(" ").trim();

        if (!effectiveTerms) {
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
                `Is this URL a specific individual product detail or specification page?`,
                `Manufacturer domain: ${domain}`,
                `URL: ${url}`,
                ``,
                `Reply YES if the URL appears to be a page for one specific product (e.g. a product detail, spec, or listing page).`,
                `Reply NO if the URL is:`,
                `- A product family or product line overview (e.g. /products/families/voltera)`,
                `- A category, collection, or search results page`,
                `- A brand, company, or support homepage`,
                `- A news, blog, or press release page`,
                ``,
                `Do NOT try to match the URL to the specific model or part number — manufacturers`,
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

        const tryVerifyCandidates = async (candidateList: Array<{ link: string }>): Promise<string | null> => {
          const sorted = candidateList
            .map((c) => ({ ...c, score: scoreUrl(c.link) }))
            .filter((c) => c.score > -5)
            .sort((a, b) => b.score - a.score);
          for (const candidate of sorted) {
            const reachable = await verifyUrl(candidate.link);
            console.log(`[weblink] product ${product.ID}: url=${candidate.link} reachable=${reachable}`);
            if (!reachable) continue;
            if (await validateUrlForProduct(candidate.link)) return candidate.link;
          }
          return null;
        };

        // Step 2a: Site-constrained search on the manufacturer's domain.
        const query2a = `site:${domain} ${effectiveTerms}`;
        const candidates = (await serperSearch(query2a)).filter(domainFilter);
        console.log(`[weblink] product ${product.ID}: query="${query2a}" candidates=${candidates.length}`);

        let webLink: string | null = null;

        if (candidates.length > 0) {
          webLink = await tryVerifyCandidates(candidates);
          if (!webLink) {
            console.log(`[weblink] product ${product.ID}: site-constrained candidates failed, trying fallback`);
          }
        }

        // Step 2b: If no results or all unreachable, broaden without site: constraint.
        if (!webLink) {
          const fallbackQuery = `${brand} ${effectiveTerms} product specifications`.trim();
          const fallbackResults = await serperSearch(fallbackQuery);
          const fallbackCandidates = fallbackResults.filter(domainFilter);
          console.log(`[weblink] product ${product.ID}: fallback query="${fallbackQuery}" candidates=${fallbackCandidates.length}`);
          if (fallbackCandidates.length > 0) {
            webLink = await tryVerifyCandidates(fallbackCandidates);
          }
        }

        if (!webLink) {
          console.log(`[weblink] product ${product.ID}: no reachable URL found`);
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

        // If the accepted URL has a locale prefix (e.g. /nb/, /zh/, /en-KY/), try the
        // canonical version without it — a base-language URL is cleaner for end users.
        try {
          const parsed = new URL(webLink);
          const segs = parsed.pathname.split("/").filter(Boolean);
          if (segs.length > 1 && /^[a-z]{2}(-[a-zA-Z]{2,4})?$/.test(segs[0])) {
            const canonicalPath = "/" + segs.slice(1).join("/");
            const canonicalUrl = `${parsed.origin}${canonicalPath}`;
            if (await verifyUrl(canonicalUrl)) {
              console.log(`[weblink] product ${product.ID}: de-localized ${webLink} → ${canonicalUrl}`);
              webLink = canonicalUrl;
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
