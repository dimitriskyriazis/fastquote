import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../lib/apiHelpers";
import OpenAI from "openai";

export const runtime = "nodejs";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

export async function POST(req: NextRequest) {
  logRequest(req, "/api/products/shorten-description");
  try {
    const { description, brand, partNumber } = (await req.json()) as {
      description?: string;
      brand?: string;
      partNumber?: string;
    };

    if (!description || description.trim().length === 0) {
      return NextResponse.json({ shortened: null });
    }

    // Already short enough — return as-is
    if (description.length <= 60) {
      return NextResponse.json({ shortened: description });
    }

    const res = await getOpenAI().responses.create({
      model: "gpt-4o-mini",
      temperature: 0,
      input: [
        {
          role: "system",
          content: [
            "Shorten the following product description to a MAXIMUM of 60 characters.",
            "Output ONLY the shortened description, nothing else.",
            "",
            "RULES:",
            "- Keep the most important technical specs and identifiers",
            "- Remove filler/marketing words",
            "- Do NOT repeat the part number or brand name",
            "- Use abbreviations where appropriate (e.g. 'Temperature' → 'Temp', 'Connector' → 'Conn')",
            "- Use commas to separate specs",
            "- Result MUST be 60 characters or fewer",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            brand ? `Brand: ${brand}` : "",
            partNumber ? `Part Number: ${partNumber}` : "",
            `Description: ${description}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      stream: false,
    });

    let shortened = res.output_text?.trim() ?? "";

    // Hard truncate as safety net
    if (shortened.length > 60) {
      shortened = shortened.slice(0, 57) + "...";
    }

    return NextResponse.json({ shortened: shortened || null });
  } catch (err) {
    console.error("[shorten-desc] Error:", err);
    // On failure, return null so caller can fall back to original description
    return NextResponse.json({ shortened: null });
  }
}
