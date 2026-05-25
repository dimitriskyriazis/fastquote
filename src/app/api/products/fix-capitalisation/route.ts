import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import OpenAI from "openai";

export const runtime = "nodejs";

// Hard cap per single request — batching makes this comfortably large
const MAX_ITEMS = 5000;

// How many descriptions to send in a single OpenAI call.
// 20 keeps the prompt compact and the JSON response reliable.
const BATCH_SIZE = 20;

// How many OpenAI batch-calls to run in parallel
const OPENAI_CONCURRENCY = 8;

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

type FixCapResult = {
  productId: number;
  offerDetailId?: number;
  oldDescription: string | null;
  oldOfferDescription?: string | null;
  newDescription: string | null;
  status: "updated" | "skipped" | "error";
};

const SYSTEM_PROMPT = [
  "Fix the capitalisation of the numbered product descriptions below.",
  "Output ONLY a valid JSON array of strings — one fixed description per input line, in the same order.",
  "Do NOT include explanations, numbering, markdown, or any other text outside the JSON array.",
  "",
  "RULES:",
  "- Convert ALL-CAPS text to proper title case.",
  "- Major words (nouns, verbs, adjectives, adverbs) should be Title Case.",
  "- Minor words (a, an, the, and, but, or, nor, for, so, yet, at, by, in, of, on, to, up, as, if, it, is, with, from, into, onto) should be lowercase UNLESS they are the first or last word.",
  "- Preserve known acronyms and technical abbreviations exactly: EU, UK, US, EMEA, HD, 4K, 8K, HDMI, VGA, USB, USB-C, IP, AV, IT, LED, LCD, OLED, AC, DC, RF, IR, DECT, DANTE, PoE, SDI, NDI, HEVC, MJPEG, H.264, H.265, SFP, RJ45, XLR, TRS, WiFi, Wi-Fi, Bluetooth, UHF, VHF, UHD, QHD, FHD, WXGA, WUXGA, SXGA, XGA, SVGA, LAN, WAN, VLAN, HTTP, HTTPS, TCP, UDP, DNS, DHCP, SNMP, OSC.",
  "- Preserve brand-specific capitalisation: ClickShare, BrightSign, ClearOne, QSC, Biamp, Crestron, AMX, Extron, Shure, Sennheiser, Beyerdynamic, Crown, JBL, Bose, Barco, Christie, NEC, Epson, Panasonic, Sony, LG, Samsung, Cisco, Polycom, Logitech, Microsoft, Huddly, Yealink, Zoom.",
  "- Numbers and units stay unchanged (e.g. 4K, 1080p, 2.4GHz, 50W, 3m, 8-port).",
  "- Preserve part numbers, model numbers, and alphanumeric codes exactly.",
  "- Preserve all punctuation (hyphens, commas, slashes, brackets) exactly.",
  "- If a description is already correctly capitalised, return it unchanged.",
  "- Do NOT add, remove, or rearrange any words.",
  "",
  "EXAMPLE INPUT:",
  "1. CLICKSHARE HUB PRO EU WITH 2 BUTTONS",
  "2. BARCO G60-W10 SINGLE LAMP PROJECTOR 10000 LUMEN WUXGA",
  "3. 4K HDMI DISTRIBUTION AMPLIFIER 1X4 WITH EDID",
  "4. ClickShare Hub Pro EU with 2 Buttons",
  "",
  'EXAMPLE OUTPUT: ["ClickShare Hub Pro EU with 2 Buttons","Barco G60-W10 Single Lamp Projector 10000 Lumen WUXGA","4K HDMI Distribution Amplifier 1x4 with EDID","ClickShare Hub Pro EU with 2 Buttons"]',
].join("\n");

export async function POST(req: NextRequest) {
  logRequest(req, "/api/products/fix-capitalisation");
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json();

    // Two modes:
    // 1. productIds: number[] — from Products page, update master only
    // 2. offerDetailIds: { offerDetailId, productId }[] — from Offer Products page, update both
    const rawProductIds: unknown = body?.productIds;
    const rawOfferDetailIds: unknown = body?.offerDetailIds;

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

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

    // ── Split work items into batches of BATCH_SIZE ───────────────────────────
    const batches: WorkItem[][] = [];
    for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
      batches.push(workItems.slice(i, i + BATCH_SIZE));
    }

    // ── Process batches concurrently (controlled by semaphore) ────────────────
    const batchSettled = await Promise.allSettled(
      batches.map(async (batch): Promise<FixCapResult[]> => {
        const numberedList = batch
          .map((item, idx) => `${idx + 1}. ${item.descriptionToFix}`)
          .join("\n");

        await openaiSemaphore.acquire();
        let fixedArray: (string | null)[];
        try {
          const res = await openai.responses.create({
            model: "gpt-4o-mini",
            temperature: 0,
            input: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: numberedList },
            ],
            stream: false,
          });

          const raw = res.output_text?.trim() ?? "";
          try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              fixedArray = parsed.map((item) =>
                typeof item === "string" && item.trim() ? item.trim() : null,
              );
            } else {
              console.warn("[fix-cap] OpenAI returned non-array JSON, skipping batch");
              fixedArray = new Array(batch.length).fill(null) as null[];
            }
          } catch {
            console.warn("[fix-cap] Failed to parse OpenAI JSON response, skipping batch");
            fixedArray = new Array(batch.length).fill(null) as null[];
          }
        } finally {
          openaiSemaphore.release();
        }

        // ── Write results for this batch ──────────────────────────────────────
        const batchResults: FixCapResult[] = [];
        for (let idx = 0; idx < batch.length; idx++) {
          const { product, offerDetailId, offerDesc, descriptionToFix } = batch[idx];
          const fixed = fixedArray[idx] ?? null;

          if (!fixed) {
            console.warn(`[fix-cap] No result for product ${product.ID}, skipping`);
            batchResults.push({
              productId: product.ID,
              offerDetailId,
              oldDescription: product.Description,
              oldOfferDescription: offerDesc,
              newDescription: null,
              status: "skipped",
            });
            continue;
          }

          const newDescription = fixed.slice(0, 2000);

          try {
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

            let oldOfferDescription: string | null | undefined = undefined;
            if (offerDetailId && offerDetailMap) {
              oldOfferDescription = offerDescriptions?.get(offerDetailId) ?? null;
              const odUpdateReq = pool.request();
              odUpdateReq.input("OfferDetailID", sql.Int, offerDetailId);
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

            console.log(
              `[fix-cap] product ${product.ID}: "${descriptionToFix.slice(0, 50)}" → "${newDescription.slice(0, 50)}"`,
            );

            batchResults.push({
              productId: product.ID,
              offerDetailId,
              oldDescription: product.Description,
              oldOfferDescription,
              newDescription,
              status: "updated",
            });
          } catch (dbErr) {
            console.error(`[fix-cap] DB update failed for product ${product.ID}:`, dbErr);
            batchResults.push({
              productId: product.ID,
              offerDetailId,
              oldDescription: product.Description,
              oldOfferDescription: offerDesc,
              newDescription: null,
              status: "error",
            });
          }
        }

        return batchResults;
      }),
    );

    // ── Flatten all results ───────────────────────────────────────────────────
    const results: FixCapResult[] = [...skippedResults];
    for (let i = 0; i < batchSettled.length; i++) {
      const outcome = batchSettled[i];
      if (outcome.status === "fulfilled") {
        results.push(...outcome.value);
      } else {
        console.error(`[fix-cap] Batch ${i} failed entirely:`, outcome.reason);
        for (const item of batches[i]) {
          results.push({
            productId: item.product.ID,
            oldDescription: item.product.Description,
            newDescription: null,
            status: "error",
          });
        }
      }
    }

    const updatedCount = results.filter((r) => r.status === "updated").length;
    const failedCount = results.filter((r) => r.status !== "updated").length;

    return NextResponse.json({ ok: true, updatedCount, failedCount, results });
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
    console.error("[fix-cap] Failed to revert capitalisation", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
