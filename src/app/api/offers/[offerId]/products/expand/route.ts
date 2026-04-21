import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../../lib/authz';
import OpenAI from 'openai';

export const runtime = 'nodejs';

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

type ExpandInput = {
  requestedBrand?: string | null;
  requestedModelNumber?: string | null;
  requestedPartNumber?: string | null;
  requestedDescription?: string | null;
  requestedDescription2?: string | null;
  requestedDescription3?: string | null;
  prompt?: string | null;
};

type ExpandResponse = {
  brand: string[];
  partNumber: string[];
  modelNumber: string[];
  description: string[];
};

const trim = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const SYSTEM_PROMPT = `You translate a product search spec into short alternate search keywords so a keyword-based product database can find matching items despite synonyms, abbreviations, localisation, or typos.

Rules:
- Return ONLY JSON with keys: brand, partNumber, modelNumber, description. Each is an array of strings.
- Each returned keyword should be substring-searchable against a product catalog (short, concrete, no marketing fluff, no punctuation except when part of a recognised form like "Cat-6" or "RJ-45").
- Include abbreviations <-> expansions ("HP" <-> "Hewlett Packard"), industry shorthand ("CAT6" <-> "Category 6"), unit forms ("55\\"" <-> "55 inch"), and common alternate spellings.
- Do NOT invent part numbers you aren't confident about. If the input has an obvious brand prefix mixed with a part number (e.g. "VX 5308813"), return just the part number fragment too ("5308813").
- NEVER include the original raw strings — they are already searched.
- Keep each array to at most 8 entries. Omit arrays entirely if you have no good expansions.
- If the input is effectively empty, return empty arrays.`;

const buildUserPrompt = (input: ExpandInput) => {
  // Free-text prompt takes precedence — the user typed exactly what they're
  // looking for, which is a richer signal than the raw requested fields.
  const promptText = trim(input.prompt);
  if (promptText) return `User query: ${promptText}`;
  const lines: string[] = [];
  const b = trim(input.requestedBrand);
  const pn = trim(input.requestedPartNumber);
  const mn = trim(input.requestedModelNumber);
  const d = [input.requestedDescription, input.requestedDescription2, input.requestedDescription3]
    .map(trim)
    .filter((v): v is string => v != null);
  if (b) lines.push(`Brand: ${b}`);
  if (pn) lines.push(`Part Number: ${pn}`);
  if (mn) lines.push(`Model Number: ${mn}`);
  d.forEach((desc, i) => lines.push(`Description${d.length > 1 ? ` ${i + 1}` : ''}: ${desc}`));
  return lines.join('\n');
};

const sanitizeArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 12) break;
  }
  return out;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/expand');

  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  try {
    const { offerId: offerIdRaw } = await params;
    const offerId = Number.parseInt(offerIdRaw, 10);
    if (!Number.isFinite(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid offerId' }, { status: 400 });
    }

    const body = (await req.json()) as ExpandInput;
    const userPrompt = buildUserPrompt(body);
    if (!userPrompt) {
      const empty: ExpandResponse = { brand: [], partNumber: [], modelNumber: [], description: [] };
      return NextResponse.json({ ok: true, expansions: empty });
    }

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content ?? '{}';
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = {}; }

    const expansions: ExpandResponse = {
      brand: sanitizeArray(parsed.brand),
      partNumber: sanitizeArray(parsed.partNumber),
      modelNumber: sanitizeArray(parsed.modelNumber),
      description: sanitizeArray(parsed.description),
    };
    return NextResponse.json({ ok: true, expansions });
  } catch (err) {
    console.error('Failed to expand filters', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
