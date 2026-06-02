import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import {
  PRODUCT_DESCRIPTION_SYSTEM_PROMPT,
  buildDescriptionUserMessage,
  stripModelPartTokens,
} from "../../../../lib/productDescriptionPrompt";
import OpenAI from "openai";

export const runtime = "nodejs";

const MAX_ITEMS = 200;

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

const openaiSemaphore = new Semaphore(5);
const serperSemaphore = new Semaphore(5);

const normalizeId = (value: unknown): number | null => {
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
  WebLink: string | null;
  Category: string | null;
  SubCategory: string | null;
};

type EnhanceResult = {
  productId: number;
  offerDetailId?: number;   // single id for backward-compat (first one)
  offerDetailIds?: number[]; // all ids updated
  oldDescription: string | null;
  oldOfferDescription?: string | null;
  newDescription: string | null;
  status: "updated" | "previewed" | "skipped" | "error";
  brand?: string | null;
  partNumber?: string | null;
  modelNumber?: string | null;
};

const serperSearch = async (
  q: string,
  productId: number,
): Promise<Array<{ title: string; snippet: string }>> => {
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
        body: JSON.stringify({ q, num: 5, hl: "en", gl: "us" }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          organic?: Array<{ title?: string; snippet?: string }>;
        };
        return (data.organic ?? [])
          .slice(0, 3)
          .map((r) => ({
            title: r.title ?? "",
            snippet: r.snippet ?? "",
          }))
          .filter((r) => r.title || r.snippet);
      }

      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[enhance-desc] Serper ${res.status} for product ${productId}, ` +
            `attempt ${attempt + 1}/${MAX_RETRIES}, retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      console.error(`[enhance-desc] Serper API error for product ${productId}: ${res.status}`);
      return [];
    }
    return [];
  } finally {
    serperSemaphore.release();
  }
};

export async function POST(req: NextRequest) {
  logRequest(req, "/api/products/enhance-descriptions");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json();

    // dryRun: generate descriptions but do NOT write to DB — used for preview
    const dryRun: boolean = body?.dryRun === true;

    // applyPrecomputed: skip OpenAI and directly apply already-generated descriptions
    // Shape: { productId, newDescription, offerDetailIds? }[]
    const rawApplyPrecomputed: unknown = body?.applyPrecomputed;
    if (Array.isArray(rawApplyPrecomputed) && rawApplyPrecomputed.length > 0) {
      const auditUserId = resolveAuditUserId(req);
      const pool = await getPool();
      let updatedCount = 0;

      for (const item of rawApplyPrecomputed) {
        const productId = normalizeId((item as { productId?: unknown })?.productId);
        const newDescription = typeof (item as { newDescription?: unknown })?.newDescription === "string"
          ? (item as { newDescription: string }).newDescription
          : null;
        const rawOdIds: unknown = (item as { offerDetailIds?: unknown })?.offerDetailIds;
        const odIds: number[] = Array.isArray(rawOdIds)
          ? rawOdIds.map(normalizeId).filter((x): x is number => x !== null)
          : [];

        if (productId === null || newDescription === null) continue;

        const updateReq = pool.request();
        updateReq.input("ProductID", sql.Int, productId);
        updateReq.input("Description", sql.NVarChar(2000), newDescription.slice(0, 2000));
        updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await updateReq.query(`
          UPDATE dbo.Products
          SET Description = @Description,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @ProductID
        `);
        updatedCount++;

        for (const odId of odIds) {
          const odUpdateReq = pool.request();
          odUpdateReq.input("OfferDetailID", sql.Int, odId);
          odUpdateReq.input("ProductDescription", sql.NVarChar(2000), newDescription.slice(0, 2000));
          odUpdateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
          await odUpdateReq.query(`
            UPDATE dbo.OfferDetails
            SET ProductDescription = @ProductDescription,
                ModifiedOn = SYSUTCDATETIME(),
                ModifiedBy = @ModifiedBy
            WHERE ID = @OfferDetailID
          `);
        }
      }

      return NextResponse.json({ ok: true, updatedCount, failedCount: 0, results: [] });
    }

    // Two modes:
    // 1. productIds: number[] — from Products page, update master only
    // 2. offerDetailIds: { offerDetailId: number, productId: number }[] — from Offer Products page, update both
    const rawProductIds: unknown = body?.productIds;
    const rawOfferDetailIds: unknown = body?.offerDetailIds;

    let productIds: number[] = [];
    // productId -> all offerDetailIds (supports multiple offer rows with same product)
    let offerDetailPairsMap: Map<number, number[]> | null = null;

    if (Array.isArray(rawOfferDetailIds) && rawOfferDetailIds.length > 0) {
      offerDetailPairsMap = new Map();
      for (const entry of rawOfferDetailIds) {
        const pid = normalizeId((entry as { productId?: unknown })?.productId);
        const odId = normalizeId((entry as { offerDetailId?: unknown })?.offerDetailId);
        if (pid !== null && odId !== null) {
          if (!offerDetailPairsMap.has(pid)) {
            productIds.push(pid);
            offerDetailPairsMap.set(pid, []);
          }
          offerDetailPairsMap.get(pid)!.push(odId);
        }
      }
    } else if (Array.isArray(rawProductIds) && rawProductIds.length > 0) {
      productIds = rawProductIds.map(normalizeId).filter((id): id is number => id !== null);
    }

    if (productIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid product IDs provided." }, { status: 400 });
    }

    // Deduplicate
    productIds = [...new Set(productIds)];

    if (productIds.length > MAX_ITEMS) {
      return NextResponse.json(
        { ok: false, error: `Cannot process more than ${MAX_ITEMS} products at once.` },
        { status: 400 },
      );
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();

    // Fetch product data
    const idList = productIds.join(",");
    const fetchReq = pool.request();
    const fetchResult = await fetchReq.query<ProductRow>(`
      SELECT p.ID, b.Name AS Brand, p.ModelNumber, p.PartNumber, p.Description,
             p.WebLink, c.Name AS Category, sc.Name AS SubCategory
      FROM dbo.Products p
      LEFT JOIN dbo.Brands b ON b.ID = p.BrandID
      LEFT JOIN dbo.ProductCategories c ON c.ID = p.CategoryID
      LEFT JOIN dbo.ProductSubCategories sc ON sc.ID = p.SubCategoryID
      WHERE p.ID IN (${idList})
    `);

    const products = fetchResult.recordset;
    if (products.length === 0) {
      return NextResponse.json({ ok: false, error: "No matching products found." }, { status: 404 });
    }

    // If updating offer details too, fetch old offer descriptions
    let offerDescriptions: Map<number, string | null> | null = null;
    if (offerDetailPairsMap && offerDetailPairsMap.size > 0) {
      offerDescriptions = new Map();
      const odIds = [...offerDetailPairsMap.values()].flat().join(",");
      const odFetchReq = pool.request();
      const odResult = await odFetchReq.query<{ ID: number; ProductDescription: string | null }>(`
        SELECT ID, ProductDescription FROM dbo.OfferDetails WHERE ID IN (${odIds})
      `);
      for (const row of odResult.recordset) {
        offerDescriptions.set(row.ID, row.ProductDescription);
      }
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const settled = await Promise.allSettled(
      products.map(async (product): Promise<EnhanceResult> => {
        const brand = product.Brand?.trim() ?? "";
        const modelNumber = product.ModelNumber?.trim() ?? "";
        const partNumber = product.PartNumber?.trim() ?? "";
        const description = product.Description?.trim() ?? "";
        const category = product.Category?.trim() ?? "";
        const subCategory = product.SubCategory?.trim() ?? "";
        const offerDetailIds = offerDetailPairsMap?.get(product.ID) ?? undefined;
        const offerDetailId = offerDetailIds?.[0]; // first for backward-compat

        if (!brand && !modelNumber && !partNumber && !description) {
          return {
            productId: product.ID,
            offerDetailId,
            offerDetailIds,
            oldDescription: product.Description,
            oldOfferDescription: offerDetailId && offerDescriptions
              ? offerDescriptions.get(offerDetailId) ?? null
              : undefined,
            newDescription: null,
            status: "skipped",
            brand: product.Brand,
            partNumber: product.PartNumber,
            modelNumber: product.ModelNumber,
          };
        }

        // Step 1: Serper search for web context
        let webSnippets = "";
        try {
          const searchTerms = [brand, modelNumber || partNumber, "product specifications"]
            .filter(Boolean)
            .join(" ");
          if (searchTerms.trim()) {
            const snippets = await serperSearch(searchTerms, product.ID);
            if (snippets.length > 0) {
              webSnippets = snippets
                .map((s) => `- ${s.title}: ${s.snippet}`)
                .join("\n");
            }
          }
        } catch (err) {
          console.warn(`[enhance-desc] Serper search failed for product ${product.ID}:`, err);
        }

        // Step 3: OpenAI enhancement
        await openaiSemaphore.acquire();
        let enhanced: string;
        try {
          const categoryInfo = [category, subCategory].filter(Boolean).join(" > ");
          const res = await openai.responses.create({
            model: "gpt-4o-mini",
            temperature: 0,
            input: [
              { role: "system", content: PRODUCT_DESCRIPTION_SYSTEM_PROMPT },
              {
                role: "user",
                content: buildDescriptionUserMessage({
                  brand,
                  modelNumber,
                  partNumber,
                  category: categoryInfo,
                  description,
                  webSnippets,
                }),
              },
            ],
            stream: false,
          });

          enhanced = res.output_text?.trim() ?? "";
        } finally {
          openaiSemaphore.release();
        }

        // Post-process: the product's own model/part number is never kept in the output
        // (the Model/Part fields are for spec lookup only), so strip any that leaked in —
        // e.g. from the web context snippets. See the MODEL NUMBER RULE in the shared prompt.
        if (enhanced) {
          enhanced = stripModelPartTokens(enhanced, modelNumber, partNumber);
        }

        if (!enhanced) {
          console.warn(`[enhance-desc] Empty response from OpenAI for product ${product.ID}`);
          return {
            productId: product.ID,
            offerDetailId,
            offerDetailIds,
            oldDescription: product.Description,
            oldOfferDescription: offerDetailId && offerDescriptions
              ? offerDescriptions.get(offerDetailId) ?? null
              : undefined,
            newDescription: null,
            status: "skipped",
            brand: product.Brand,
            partNumber: product.PartNumber,
            modelNumber: product.ModelNumber,
          };
        }

        // Truncate to DB column limit
        const newDescription = enhanced.slice(0, 2000);

        // In dry-run mode skip all DB writes
        let oldOfferDescription: string | null | undefined = undefined;
        if (!dryRun) {
          // Step 3: Update dbo.Products (master)
          const updateReq = pool.request();
          updateReq.input("ProductID", sql.Int, product.ID);
          updateReq.input("Description", sql.NVarChar(2000), newDescription);
          updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
          await updateReq.query(`
            UPDATE dbo.Products
            SET Description = @Description,
                ModifiedOn = SYSUTCDATETIME(),
                ModifiedBy = @ModifiedBy
            WHERE ID = @ProductID
          `);

          // Step 4: Update ALL matching dbo.OfferDetails rows (product may appear multiple times)
          if (offerDetailIds && offerDetailIds.length > 0 && offerDetailPairsMap) {
            oldOfferDescription = offerDescriptions?.get(offerDetailIds[0]) ?? null;
            for (const odId of offerDetailIds) {
              const odUpdateReq = pool.request();
              odUpdateReq.input("OfferDetailID", sql.Int, odId);
              odUpdateReq.input("ProductDescription", sql.NVarChar(2000), newDescription);
              odUpdateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
              await odUpdateReq.query(`
                UPDATE dbo.OfferDetails
                SET ProductDescription = @ProductDescription,
                    ModifiedOn = SYSUTCDATETIME(),
                    ModifiedBy = @ModifiedBy
                WHERE ID = @OfferDetailID
              `);
            }
          }
        } else if (offerDetailIds && offerDetailIds.length > 0) {
          oldOfferDescription = offerDescriptions?.get(offerDetailIds[0]) ?? null;
        }

        console.log(
          `[enhance-desc]${dryRun ? " [dry-run]" : ""} product ${product.ID}${offerDetailIds ? ` (${offerDetailIds.length} offer row(s))` : ""}: "${description}" → "${newDescription.slice(0, 80)}..."`,
        );

        return {
          productId: product.ID,
          offerDetailId,
          offerDetailIds,
          oldDescription: product.Description,
          oldOfferDescription,
          newDescription,
          status: dryRun ? "previewed" : "updated",
          brand: product.Brand,
          partNumber: product.PartNumber,
          modelNumber: product.ModelNumber,
        } as EnhanceResult;
      }),
    );

    const results: EnhanceResult[] = settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") return outcome.value;
      console.error(`[enhance-desc] Failed for product ${products[i].ID}:`, outcome.reason);
      return {
        productId: products[i].ID,
        oldDescription: products[i].Description,
        newDescription: null,
        status: "error",
        brand: products[i].Brand,
        partNumber: products[i].PartNumber,
        modelNumber: products[i].ModelNumber,
      };
    });

    const updatedCount = results.filter((r) => r.status === "updated").length;
    const failedCount = results.filter((r) => r.status !== "updated").length;

    return NextResponse.json({ ok: true, updatedCount, failedCount, results });
  } catch (err) {
    console.error("[enhance-desc] Failed to enhance descriptions", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// PUT handler for reverting descriptions (used by undo)
export async function PUT(req: NextRequest) {
  logRequest(req, "/api/products/enhance-descriptions [revert]");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const items: unknown[] = body?.items;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ ok: false, error: "No items provided." }, { status: 400 });
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();
    let updatedCount = 0;

    for (const item of items) {
      const productId = normalizeId((item as { productId?: unknown })?.productId);
      const offerDetailId = normalizeId((item as { offerDetailId?: unknown })?.offerDetailId);
      const description = typeof (item as { description?: unknown })?.description === "string"
        ? (item as { description: string }).description
        : null;
      const offerDescription = typeof (item as { offerDescription?: unknown })?.offerDescription === "string"
        ? (item as { offerDescription: string }).offerDescription
        : null;

      if (productId !== null && description !== null) {
        const updateReq = pool.request();
        updateReq.input("ProductID", sql.Int, productId);
        updateReq.input("Description", sql.NVarChar(2000), description.slice(0, 2000));
        updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await updateReq.query(`
          UPDATE dbo.Products
          SET Description = @Description,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @ProductID
        `);
        updatedCount++;
      }

      if (offerDetailId !== null && offerDescription !== null) {
        const odUpdateReq = pool.request();
        odUpdateReq.input("OfferDetailID", sql.Int, offerDetailId);
        odUpdateReq.input("ProductDescription", sql.NVarChar(2000), offerDescription.slice(0, 2000));
        odUpdateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await odUpdateReq.query(`
          UPDATE dbo.OfferDetails
          SET ProductDescription = @ProductDescription,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @OfferDetailID
        `);
      }
    }

    return NextResponse.json({ ok: true, updatedCount });
  } catch (err) {
    console.error("[enhance-desc] Failed to revert descriptions", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
