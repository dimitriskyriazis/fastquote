import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { logRequest } from "../../../../../lib/apiHelpers";
import { requirePermission } from "../../../../../lib/authz";
import { sanitizeExtractedCell } from "../../../../../lib/sanitizeExtractedText";

export const runtime = "nodejs";

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB

const EXTRACT_PROMPT = [
  "You extract a product price list from a PDF into a table.",
  'Return ONLY a JSON object of the form: {"headers": string[], "rows": string[][]}.',
  "- headers: the column names exactly as they appear (e.g. \"Part Number\", \"Model\", \"Description\", \"List Price\", \"Cost\"). Keep the source language.",
  "- rows: one array per product row, with cells aligned to headers (same length as headers).",
  "Rules:",
  "- Include EVERY product row. Do not summarize, sample, or skip rows.",
  "- Do NOT invent values. Copy text and numbers exactly as printed, keeping currency symbols and number formatting (e.g. \"1.234,56\", \"357 EUR\", \"CALL\").",
  "- Skip page headers/footers, category banner rows, and totals — only real product rows.",
  "- Part numbers and codes are often split across two lines in the PDF; join them into ONE code and use a plain ASCII hyphen '-' for the break (e.g. a code shown as \"TPC-ANDROID-\" then \"PHONE\" is \"TPC-ANDROID-PHONE\"). Use only standard characters (A-Z, 0-9, -, ., /, space) in codes; never output replacement characters, soft hyphens, or box/control glyphs.",
  '- If a cell is empty, use "".',
  "Output JSON only — no prose, no markdown code fences.",
].join("\n");

type ExtractedTable = { headers: unknown; rows: unknown };

const toCellString = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return sanitizeExtractedCell(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return sanitizeExtractedCell(String(value));
  }
  return "";
};

export async function POST(req: NextRequest) {
  logRequest(req, "/api/price-lists/cleanup/parse-pdf");
  try {
    const auth = await requirePermission(req, "cleanupPriceLists");
    if (!auth.ok) return auth.response;

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No PDF file provided." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ ok: false, error: "The PDF is empty." }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json(
        { ok: false, error: "PDF is too large (max 20 MB)." },
        { status: 400 },
      );
    }

    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      temperature: 0,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: file.name || "pricelist.pdf",
              file_data: `data:application/pdf;base64,${base64}`,
            },
            { type: "input_text", text: EXTRACT_PROMPT },
          ],
        },
      ],
      stream: false,
    });

    const rawText = res.output_text?.trim() ?? "";
    const jsonText = rawText
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();

    let parsed: ExtractedTable;
    try {
      parsed = JSON.parse(jsonText) as ExtractedTable;
    } catch {
      console.error("[parse-pdf] could not parse model output as JSON");
      return NextResponse.json(
        { ok: false, error: "Could not extract a table from this PDF. Try an Excel/CSV export." },
        { status: 422 },
      );
    }

    const headers = Array.isArray(parsed.headers) ? parsed.headers.map(toCellString) : [];
    const dataRows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const aoa: string[][] = [
      headers,
      ...dataRows
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r) => r.map(toCellString)),
    ];

    if (aoa.length <= 1 || headers.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No product rows were found in this PDF." },
        { status: 422 },
      );
    }

    return NextResponse.json({ ok: true, aoa, rowCount: aoa.length - 1 });
  } catch (err) {
    console.error("[parse-pdf] failed", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
