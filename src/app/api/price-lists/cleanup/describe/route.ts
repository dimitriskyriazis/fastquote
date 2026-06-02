import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { logRequest } from "../../../../../lib/apiHelpers";
import { requirePermission } from "../../../../../lib/authz";
import { Semaphore } from "../../../../../lib/concurrency";
import { serperSearch } from "../../../../../lib/serper";
import {
  PRODUCT_DESCRIPTION_SYSTEM_PROMPT,
  buildDescriptionUserMessage,
  stripModelPartTokens,
} from "../../../../../lib/productDescriptionPrompt";

export const runtime = "nodejs";

// Generous safety ceiling (the UI confirms before large runs; there is no per-batch cap).
const MAX_ROWS = 5000;

type DescribeRequestRow = {
  id: number;
  partNumber?: string | null;
  modelNumber?: string | null;
  description?: string | null;
};

type DescribeResultRow = {
  id: number;
  newDescription: string | null;
  status: "ok" | "skipped" | "error";
};

const openaiSemaphore = new Semaphore(5);

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function POST(req: NextRequest) {
  logRequest(req, "/api/price-lists/cleanup/describe");
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const brand = str(body?.brand);
    const useWeb: boolean = body?.useWeb !== false; // default on
    const rawRows: unknown = body?.rows;

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows provided." }, { status: 400 });
    }
    if (rawRows.length > MAX_ROWS) {
      return NextResponse.json(
        { ok: false, error: `Too many rows (${rawRows.length}). Limit is ${MAX_ROWS}.` },
        { status: 400 },
      );
    }

    const rows: DescribeRequestRow[] = rawRows
      .map((r) => {
        const id = (r as { id?: unknown })?.id;
        if (typeof id !== "number" || !Number.isFinite(id)) return null;
        return {
          id,
          partNumber: str((r as { partNumber?: unknown }).partNumber),
          modelNumber: str((r as { modelNumber?: unknown }).modelNumber),
          description: str((r as { description?: unknown }).description),
        } as DescribeRequestRow;
      })
      .filter((r): r is DescribeRequestRow => r !== null);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const settled = await Promise.allSettled(
      rows.map(async (row): Promise<DescribeResultRow> => {
        const modelNumber = str(row.modelNumber);
        const partNumber = str(row.partNumber);
        const description = str(row.description);

        if (!description && !modelNumber && !partNumber) {
          return { id: row.id, newDescription: null, status: "skipped" };
        }

        // Optional web context (best-effort).
        let webSnippets = "";
        if (useWeb) {
          try {
            const terms = [brand, modelNumber || partNumber, "product specifications"]
              .filter(Boolean)
              .join(" ");
            if (terms.trim()) {
              const snippets = await serperSearch(terms, `desc:${row.id}`);
              if (snippets.length > 0) {
                webSnippets = snippets.map((s) => `- ${s.title}: ${s.snippet}`).join("\n");
              }
            }
          } catch {
            // ignore — web context is optional
          }
        }

        await openaiSemaphore.acquire();
        let enhanced = "";
        try {
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

        if (enhanced) {
          enhanced = stripModelPartTokens(enhanced, modelNumber, partNumber);
        }
        if (!enhanced) return { id: row.id, newDescription: null, status: "skipped" };

        return { id: row.id, newDescription: enhanced.slice(0, 2000), status: "ok" };
      }),
    );

    const results: DescribeResultRow[] = settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") return outcome.value;
      console.error(`[cleanup-describe] row ${rows[i].id} failed:`, outcome.reason);
      return { id: rows[i].id, newDescription: null, status: "error" };
    });

    const okCount = results.filter((r) => r.status === "ok").length;
    return NextResponse.json({ ok: true, okCount, results });
  } catch (err) {
    console.error("[cleanup-describe] failed", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
