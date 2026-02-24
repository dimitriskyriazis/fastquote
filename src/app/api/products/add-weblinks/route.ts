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
                // If a different numeric code appears where ours should be, this is likely the wrong product
                const partPattern = /\d{3}[.\-]\d{4}[.\-]\d{3}|\d{6,}/g;
                const pathCodes = path.match(partPattern) ?? [];
                if (pathCodes.length > 0 && !pathCodes.some(c => normalize(c) === normPart)) score -= 8;
              }
            }
            if (segments.length >= 2) score += 1; // deeper path = more specific page
            const lastSeg = segments[segments.length - 1] ?? "";
            if (/search|results|catalog|category|products?$/.test(lastSeg)) score -= 4;
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

        // Hard-filter: only keep URLs on the manufacturer's domain, exclude staging subdomains and non-product pages.
        const domainFilter = (r: { link: string }) => {
          try {
            const parsed = new URL(r.link);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            const subdomain = host.split(".")[0];
            if (/stage|staging|rhythm|dev|test|sandbox/.test(subdomain)) return false;
            if (/\/shop\/|\/brand-filter\/|\/cart\/|\/checkout\/|\/account\//.test(path)) return false;
            return host.replace(/^www\./i, "").endsWith(domain!);
          } catch { return false; }
        };

        // Step 2a: Site-constrained search on the manufacturer's domain.
        const query2a = `site:${domain} ${effectiveTerms}`;
        let candidates = (await serperSearch(query2a)).filter(domainFilter);

        console.log(`[weblink] product ${product.ID}: query="${query2a}" candidates=${candidates.length}`);

        // Step 2b: If no results on the domain, broaden without site: constraint.
        if (candidates.length === 0) {
          const fallbackQuery = `${brand} ${effectiveTerms} product specifications`.trim();
          const fallbackResults = await serperSearch(fallbackQuery);
          candidates = fallbackResults.filter(domainFilter);
          console.log(`[weblink] product ${product.ID}: fallback query="${fallbackQuery}" candidates=${candidates.length}`);
        }

        if (candidates.length === 0) {
          console.log(`[weblink] product ${product.ID}: no candidate URL found`);
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

        // Try candidates in score order until one passes verifyUrl.
        // Discard candidates with strongly negative scores — they're almost certainly wrong pages.
        const sorted = candidates
          .map((c) => ({ ...c, score: scoreUrl(c.link) }))
          .filter((c) => c.score > -5)
          .sort((a, b) => b.score - a.score);
        let webLink: string | null = null;
        for (const candidate of sorted) {
          const reachable = await verifyUrl(candidate.link);
          console.log(`[weblink] product ${product.ID}: url=${candidate.link} reachable=${reachable}`);
          if (reachable) { webLink = candidate.link; break; }
        }

        if (!webLink) {
          console.log(`[weblink] product ${product.ID}: all candidates unreachable`);
          return { productId: product.ID, webLink: null, status: "not_found" };
        }

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
