import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import {
  CAPITALISATION_SINGLE_SYSTEM_PROMPT,
  CAPITALISATION_SYSTEM_PROMPT,
  buildCapitalisationUserMessage,
  isCaseOnlyRewrite,
  parseCapitalisationResponse,
} from "../../../../lib/descriptionCapitalisation";
import OpenAI from "openai";

export const runtime = "nodejs";

// Hard cap per single request — batching makes this comfortably large
const MAX_ITEMS = 5000;

// How many descriptions to send in a single OpenAI call.
// 20 keeps the prompt compact and the JSON response reliable.
const BATCH_SIZE = 20;

// How many OpenAI batch-calls to run in parallel
const OPENAI_CONCURRENCY = 8;

// A hung call would otherwise hold a semaphore slot forever and the route would
// never respond, leaving the caller's progress toast up with no way to tell
// whether the writes landed.
const OPENAI_TIMEOUT_MS = 60_000;

const OPENAI_MODEL = "gpt-4o-mini";

// dbo.Products.Description and dbo.OfferDetails.ProductDescription are NVARCHAR(2000)
const MAX_DESCRIPTION_LENGTH = 2000;

// Ceiling on the one-at-a-time repair pass. If the batched pass fails wholesale
// (bad key, model outage, prompt regression) then retrying thousands of rows
// individually just burns tokens, so the overflow is reported as skipped instead.
const MAX_REPAIR_ITEMS = 500;

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

const openaiSemaphore = new Semaphore(OPENAI_CONCURRENCY);

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
  Description: string | null;
};

type FixCapStatus = "updated" | "unchanged" | "previewed" | "skipped" | "error";

type FixCapResult = {
  productId: number;
  offerDetailId?: number;
  oldDescription: string | null;
  oldOfferDescription?: string | null;
  newDescription: string | null;
  status: FixCapStatus;
};

export async function POST(req: NextRequest) {
  logRequest(req, "/api/products/fix-capitalisation");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "AI capitalisation is not configured on this server (no OPENAI_API_KEY)." },
        { status: 503 },
      );
    }

    const body = await req.json();

    // Two modes:
    // 1. productIds: number[] — from Products page, update master only
    // 2. offerDetailIds: { offerDetailId, productId }[] — from Offer Products page, update both
    const rawProductIds: unknown = body?.productIds;
    const rawOfferDetailIds: unknown = body?.offerDetailIds;

    // dryRun: work out the fixes but write nothing, so a caller can show a
    // before/after review first. Matches the sibling enhance-descriptions route.
    const dryRun: boolean = body?.dryRun === true;

    let productIds: number[] = [];
    let offerDetailMap: Map<number, number> | null = null; // productId -> offerDetailId

    if (Array.isArray(rawOfferDetailIds) && rawOfferDetailIds.length > 0) {
      offerDetailMap = new Map();
      for (const entry of rawOfferDetailIds) {
        const pid = normalizeId((entry as { productId?: unknown })?.productId);
        const odId = normalizeId((entry as { offerDetailId?: unknown })?.offerDetailId);
        if (pid !== null && odId !== null) {
          productIds.push(pid);
          offerDetailMap.set(pid, odId);
        }
      }
    } else if (Array.isArray(rawProductIds) && rawProductIds.length > 0) {
      productIds = rawProductIds.map(normalizeId).filter((id): id is number => id !== null);
    }

    if (productIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid product IDs provided." }, { status: 400 });
    }

    productIds = [...new Set(productIds)];

    if (productIds.length > MAX_ITEMS) {
      return NextResponse.json(
        { ok: false, error: `Cannot process more than ${MAX_ITEMS} products at once.` },
        { status: 400 },
      );
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();

    // Fetch product descriptions — chunk large ID lists to stay within SQL parameter limits
    const products: ProductRow[] = [];
    const ID_CHUNK = 900;
    for (let i = 0; i < productIds.length; i += ID_CHUNK) {
      const chunk = productIds.slice(i, i + ID_CHUNK);
      const fetchReq = pool.request();
      const paramNames = chunk.map((id, idx) => {
        fetchReq.input(`pid_${i}_${idx}`, sql.Int, id);
        return `@pid_${i}_${idx}`;
      });
      const result = await fetchReq.query<ProductRow>(
        `SELECT ID, Description FROM dbo.Products WHERE ID IN (${paramNames.join(",")})`,
      );
      products.push(...result.recordset);
    }

    if (products.length === 0) {
      return NextResponse.json({ ok: false, error: "No matching products found." }, { status: 404 });
    }

    // Fetch offer descriptions if needed
    let offerDescriptions: Map<number, string | null> | null = null;
    if (offerDetailMap && offerDetailMap.size > 0) {
      offerDescriptions = new Map();
      const odIds = [...offerDetailMap.values()];
      for (let i = 0; i < odIds.length; i += ID_CHUNK) {
        const chunk = odIds.slice(i, i + ID_CHUNK);
        const odFetchReq = pool.request();
        const paramNames = chunk.map((id, idx) => {
          odFetchReq.input(`odid_${i}_${idx}`, sql.Int, id);
          return `@odid_${i}_${idx}`;
        });
        const odResult = await odFetchReq.query<{ ID: number; ProductDescription: string | null }>(
          `SELECT ID, ProductDescription FROM dbo.OfferDetails WHERE ID IN (${paramNames.join(",")})`,
        );
        for (const row of odResult.recordset) {
          offerDescriptions.set(row.ID, row.ProductDescription);
        }
      }
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: OPENAI_TIMEOUT_MS,
      maxRetries: 2,
    });

    // ── Build per-product work items ──────────────────────────────────────────
    type WorkItem = {
      product: ProductRow;
      offerDetailId: number | undefined;
      offerDesc: string | null;
      descriptionToFix: string; // the text we actually send to OpenAI
    };

    const workItems: WorkItem[] = [];
    const skippedResults: FixCapResult[] = [];

    for (const product of products) {
      const offerDetailId = offerDetailMap?.get(product.ID) ?? undefined;
      const offerDesc =
        offerDetailId && offerDescriptions ? (offerDescriptions.get(offerDetailId) ?? null) : null;
      const masterDesc = product.Description?.trim() ?? "";
      const descriptionToFix = offerDesc !== null ? offerDesc.trim() : masterDesc;

      if (!descriptionToFix) {
        skippedResults.push({
          productId: product.ID,
          offerDetailId,
          oldDescription: product.Description,
          oldOfferDescription: offerDesc,
          newDescription: null,
          status: "skipped",
        });
        continue;
      }

      workItems.push({ product, offerDetailId, offerDesc, descriptionToFix });
    }

    // ── Resolve the fixes ─────────────────────────────────────────────────────
    //
    // Every answer has to survive isCaseOnlyRewrite before it is allowed anywhere
    // near the database. Fixing capitalisation may only change letter case, and
    // that is checkable, so a model that loses its place in a 20-line batch, copies
    // an example out of its own prompt, or invents a plausible-sounding product
    // description is caught here instead of stamping one product's text onto
    // another. Rejected and unanswered lines get one more try on their own, where
    // there is no batch to misalign.
    const accepted: (string | null)[] = new Array(workItems.length).fill(null);
    let guardRejections = 0;

    const accept = (index: number, candidate: string | null): void => {
      if (!candidate) return;
      const original = workItems[index].descriptionToFix;
      if (!isCaseOnlyRewrite(original, candidate)) {
        guardRejections++;
        console.warn(
          `[fix-cap] discarded answer for product ${workItems[index].product.ID}: not a pure re-casing. ` +
            `"${original.slice(0, 80)}" vs "${candidate.slice(0, 80)}"`,
        );
        return;
      }
      accepted[index] = candidate.slice(0, MAX_DESCRIPTION_LENGTH);
    };

    const askBatch = async (descriptions: string[]): Promise<(string | null)[]> => {
      await openaiSemaphore.acquire();
      try {
        const res = await openai.responses.create({
          model: OPENAI_MODEL,
          temperature: 0,
          input: [
            { role: "system", content: CAPITALISATION_SYSTEM_PROMPT },
            { role: "user", content: buildCapitalisationUserMessage(descriptions) },
          ],
          stream: false,
        });
        return parseCapitalisationResponse(res.output_text ?? "", descriptions.length);
      } finally {
        openaiSemaphore.release();
      }
    };

    const askSingle = async (description: string): Promise<string | null> => {
      await openaiSemaphore.acquire();
      try {
        const res = await openai.responses.create({
          model: OPENAI_MODEL,
          temperature: 0,
          input: [
            { role: "system", content: CAPITALISATION_SINGLE_SYSTEM_PROMPT },
            { role: "user", content: description.replace(/\s+/gu, " ").trim() },
          ],
          stream: false,
        });
        return res.output_text?.trim() || null;
      } finally {
        openaiSemaphore.release();
      }
    };

    const batchStarts: number[] = [];
    for (let i = 0; i < workItems.length; i += BATCH_SIZE) batchStarts.push(i);

    await Promise.all(
      batchStarts.map(async (start) => {
        const slice = workItems.slice(start, start + BATCH_SIZE);
        try {
          const answers = await askBatch(slice.map((item) => item.descriptionToFix));
          answers.forEach((answer, offset) => accept(start + offset, answer));
        } catch (err) {
          console.error(`[fix-cap] batch at offset ${start} failed:`, err);
        }
      }),
    );

    const unresolved = workItems.map((_, index) => index).filter((index) => accepted[index] === null);
    const toRepair = unresolved.slice(0, MAX_REPAIR_ITEMS);
    if (unresolved.length > 0) {
      console.warn(
        `[fix-cap] retrying ${toRepair.length} of ${unresolved.length} unresolved description(s) one at a time` +
          (unresolved.length > toRepair.length
            ? `; ${unresolved.length - toRepair.length} left unfixed (repair cap ${MAX_REPAIR_ITEMS})`
            : ""),
      );
    }
    await Promise.all(
      toRepair.map(async (index) => {
        try {
          accept(index, await askSingle(workItems[index].descriptionToFix));
        } catch (err) {
          console.error(`[fix-cap] retry failed for product ${workItems[index].product.ID}:`, err);
        }
      }),
    );

    // ── Write the accepted fixes ──────────────────────────────────────────────
    // All AI work is finished by this point, so a request that dies mid-flight
    // leaves nothing half-written.
    const results: FixCapResult[] = [...skippedResults];

    for (let index = 0; index < workItems.length; index++) {
      const { product, offerDetailId, offerDesc, descriptionToFix } = workItems[index];
      const newDescription = accepted[index];

      if (!newDescription) {
        results.push({
          productId: product.ID,
          offerDetailId,
          oldDescription: product.Description,
          oldOfferDescription: offerDesc,
          newDescription: null,
          status: "skipped",
        });
        continue;
      }

      if (dryRun) {
        results.push({
          productId: product.ID,
          offerDetailId,
          oldDescription: product.Description,
          oldOfferDescription: offerDesc,
          newDescription,
          status: "previewed",
        });
        continue;
      }

      // Descriptions that were already right come back byte for byte identical, so
      // writing them would only churn ModifiedOn/ModifiedBy and drown the real
      // changes in the audit trail.
      //
      // In offer mode the text that was re-cased is the offer line's own snapshot.
      // The master row only follows when it carries the same wording; if the offer
      // line was reworded for that customer, re-casing it must not push those words
      // into the catalogue. The master can be fixed from the Products page.
      const masterDescription = product.Description ?? "";
      const masterNeedsUpdate =
        newDescription !== masterDescription && isCaseOnlyRewrite(masterDescription, newDescription);
      const offerNeedsUpdate = offerDetailId !== undefined && newDescription !== (offerDesc ?? "");

      if (!masterNeedsUpdate && !offerNeedsUpdate) {
        results.push({
          productId: product.ID,
          offerDetailId,
          oldDescription: product.Description,
          oldOfferDescription: offerDesc,
          newDescription,
          status: "unchanged",
        });
        continue;
      }

      // When both rows change they go in one transaction, so a failure on the
      // second UPDATE cannot leave a re-cased master row that the returned
      // "error" status (and therefore the caller's undo) knows nothing about.
      const transaction = masterNeedsUpdate && offerNeedsUpdate ? new sql.Transaction(pool) : null;
      const requestFor = () => (transaction ? transaction.request() : pool.request());

      try {
        if (transaction) await transaction.begin();

        if (masterNeedsUpdate) {
          const updateReq = requestFor();
          updateReq.input("ProductID", sql.Int, product.ID);
          updateReq.input("Description", sql.NVarChar(MAX_DESCRIPTION_LENGTH), newDescription);
          updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
          await updateReq.query(`
            UPDATE dbo.Products
            SET Description = @Description,
                ModifiedOn = SYSUTCDATETIME(),
                ModifiedBy = @ModifiedBy
            WHERE ID = @ProductID
          `);
        }

        if (offerNeedsUpdate && offerDetailId !== undefined) {
          const odUpdateReq = requestFor();
          odUpdateReq.input("OfferDetailID", sql.Int, offerDetailId);
          odUpdateReq.input(
            "ProductDescription",
            sql.NVarChar(MAX_DESCRIPTION_LENGTH),
            newDescription,
          );
          odUpdateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
          await odUpdateReq.query(`
            UPDATE dbo.OfferDetails
            SET ProductDescription = @ProductDescription,
                ModifiedOn = SYSUTCDATETIME(),
                ModifiedBy = @ModifiedBy
            WHERE ID = @OfferDetailID
          `);
        }

        if (transaction) await transaction.commit();

        console.log(
          `[fix-cap] product ${product.ID}: "${descriptionToFix.slice(0, 50)}" → "${newDescription.slice(0, 50)}"`,
        );

        results.push({
          productId: product.ID,
          offerDetailId,
          oldDescription: product.Description,
          oldOfferDescription: offerDetailId !== undefined ? offerDesc : undefined,
          newDescription,
          status: "updated",
        });
      } catch (dbErr) {
        if (transaction) await transaction.rollback().catch(() => {});
        console.error(`[fix-cap] DB update failed for product ${product.ID}:`, dbErr);
        results.push({
          productId: product.ID,
          offerDetailId,
          oldDescription: product.Description,
          oldOfferDescription: offerDesc,
          newDescription: null,
          status: "error",
        });
      }
    }

    const countOf = (status: FixCapStatus) => results.filter((r) => r.status === status).length;
    const updatedCount = countOf("updated");
    const unchangedCount = countOf("unchanged");
    const previewedCount = countOf("previewed");
    // "failed" means the description still needs fixing. A line that was already
    // correct is not a failure, so it must not be counted as one.
    const failedCount = countOf("skipped") + countOf("error");

    if (guardRejections > 0) {
      console.warn(
        `[fix-cap] ${guardRejections} answer(s) discarded for changing more than capitalisation`,
      );
    }

    return NextResponse.json({
      ok: true,
      updatedCount,
      unchangedCount,
      previewedCount,
      failedCount,
      guardRejections,
      dryRun,
      results,
    });
  } catch (err) {
    console.error("[fix-cap] Failed to fix capitalisation", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// PUT handler for reverting (undo)
export async function PUT(req: NextRequest) {
  logRequest(req, "/api/products/fix-capitalisation [revert]");
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
      const description =
        typeof (item as { description?: unknown })?.description === "string"
          ? (item as { description: string }).description
          : null;
      const offerDescription =
        typeof (item as { offerDescription?: unknown })?.offerDescription === "string"
          ? (item as { offerDescription: string }).offerDescription
          : null;

      if (productId !== null && description !== null) {
        const updateReq = pool.request();
        updateReq.input("ProductID", sql.Int, productId);
        updateReq.input(
          "Description",
          sql.NVarChar(MAX_DESCRIPTION_LENGTH),
          description.slice(0, MAX_DESCRIPTION_LENGTH),
        );
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
        odUpdateReq.input(
          "ProductDescription",
          sql.NVarChar(MAX_DESCRIPTION_LENGTH),
          offerDescription.slice(0, MAX_DESCRIPTION_LENGTH),
        );
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
    console.error("[fix-cap] Failed to revert capitalisation", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
