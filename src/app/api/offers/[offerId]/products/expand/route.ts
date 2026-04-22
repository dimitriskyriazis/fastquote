import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../../lib/authz';
import { embedSingle, getSemanticIndex } from '../../../../../../lib/productEmbeddings';
import OpenAI from 'openai';

export const runtime = 'nodejs';

// How many semantic neighbors we surface per query.  50 is enough to seed the
// score boost without drowning the filter pipeline in low-confidence matches;
// the client's keyword filters still bound the final result set.
const SEMANTIC_TOP_K = 50;
// Minimum cosine similarity to surface a candidate.  OpenAI embeddings
// typically produce 0.25-0.55 for loosely-related items and 0.55+ for tight
// matches.  Anything below 0.3 is almost always noise.
const SEMANTIC_MIN_SCORE = 0.3;

// In-memory cache for AI expansion results.  The structured auto-expand
// path (Match-Requested silent, Add-Products filter-change) hits the same
// input over and over — same requested row, same column filter typed
// twice, etc.  Caching by the exact prompt+model fingerprint eliminates
// redundant gpt-4o calls and keeps us well clear of the 30k TPM cap.
type CachedExpansion = {
  expansions: ExpandResponse;
  routed: PromptRouting | null;
  expiresAt: number;
};
const EXPAND_CACHE_TTL_MS = 15 * 60 * 1000;
const EXPAND_CACHE_MAX = 500;
const expandCache = new Map<string, CachedExpansion>();

function cacheKeyFor(userPrompt: string, model: string): string {
  return crypto.createHash('sha256').update(`${model}|${userPrompt}`).digest('hex');
}

function getCached(key: string): CachedExpansion | null {
  const hit = expandCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    expandCache.delete(key);
    return null;
  }
  // Move-to-end LRU.
  expandCache.delete(key);
  expandCache.set(key, hit);
  return hit;
}

function setCached(key: string, value: Omit<CachedExpansion, 'expiresAt'>): void {
  if (expandCache.size >= EXPAND_CACHE_MAX) {
    const oldest = expandCache.keys().next().value;
    if (oldest) expandCache.delete(oldest);
  }
  expandCache.set(key, { ...value, expiresAt: Date.now() + EXPAND_CACHE_TTL_MS });
}

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
  // Negative / anti-intent tokens.  Short words that strongly suggest a row
  // is the WRONG kind of product (accessories, cases, parts, stands when
  // searching for the actual product itself).  Server subtracts these from
  // relevance score when matched, so accessories sink below real matches.
  negativeDescription: string[];
};

// Classification of a free-text prompt into column-specific fragments.  Only
// returned when the caller sent a prompt (not for structured auto-expand on a
// requested row — there the fields are already classified).  priceMin /
// priceMax populate a ListPrice number filter when the prompt includes a
// price hint ("tv around 5000$", "projector under 10k").
type PromptRouting = {
  brand: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  priceMin: number | null;
  priceMax: number | null;
};

const trim = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const SYSTEM_PROMPT = `You translate a product search spec into short alternate search keywords so a keyword-based product database can find matching items — even when the user's words don't literally appear in how the product is listed in the catalog.

Rules:
- Return ONLY JSON. Always include keys: brand, partNumber, modelNumber, description, negativeDescription. Each is an array of strings.
- Each returned keyword should be substring-searchable against a product catalog (short, concrete, no marketing fluff, no punctuation except when part of a recognised form like "Cat-6" or "RJ-45").

## Negative tokens (IMPORTANT for precision)
- Populate \`negativeDescription\` with short single-word tokens that strongly suggest a catalog row is the WRONG KIND of product for this query — typically accessories, spare parts, carrying cases, or mounting hardware when the user actually wants the product itself.
- These are substring-matched against product descriptions and SUBTRACTED from the relevance score, so rows that match them sink below true matches. Do NOT include generic words that would also appear in the right product (e.g. never put "microphone" in negativeDescription when the user asked for a microphone).
- Examples:
  - Request "microphone" or "handheld mic" → negativeDescription: ["holder", "clip", "mount", "case", "pouch", "stand", "spare", "replacement", "earpad", "bag"]. (Do NOT include "cable" — wireless mic systems often include cables.)
  - Request "headset microphone" → negativeDescription: ["speaker", "loudspeaker", "earpad", "spare", "case", "pouch", "replacement", "portable pa"].
  - Request "earphone" or "earbuds" → negativeDescription: ["case", "pouch", "bag", "spare", "replacement", "earshell", "cable", "tip"] (the tips/shells are accessories not earphones).
  - Request "projector" → negativeDescription: ["lamp", "bulb", "mount", "bracket", "ceiling mount", "remote", "carrying case", "replacement", "filter"].
  - Request "speaker" or "loudspeaker" → negativeDescription: ["bracket", "cover", "grille", "mount", "stand", "case", "replacement", "spare"].
  - Request "camera" → negativeDescription: ["mount", "bracket", "tripod plate", "lens cap", "case", "bag", "strap", "battery"].
  - Request "cable" or "patch cord" → negativeDescription: ["connector only", "plug only", "tester", "stripper", "organizer", "labeller"].
- If the query is ambiguous, or the user is actually asking for one of these accessory items (e.g. "microphone stand"), leave negativeDescription empty — DO NOT negate "stand" when the user asked for stands.
- Keep to at most 12 entries; short words work best (each becomes a LIKE '%word%' predicate server-side).

## Synonym / abbreviation expansion
- Abbreviations <-> expansions ("HP" <-> "Hewlett Packard"), industry shorthand ("CAT6" <-> "Category 6"), unit forms ("55\\"" <-> "55 inch"), common alternate spellings.

## Product-family / series expansion (VERY IMPORTANT for recall)
- When the query identifies BOTH a brand AND a product category (e.g. "Barco projector", "HP printer", "Shure microphone", "Sony camera"), include that brand's known product FAMILY NAMES, SERIES NAMES, and SKU PREFIXES for that category in the description AND partNumber arrays. These are the tokens that actually appear in catalog descriptions and part numbers for that brand's products.
- Example: for "Barco projector" include terms like "QDX", "HDX", "UDX", "F80", "F90", "UDM", "F-Series", "G-Series", "Balder", "Galaxy" — Barco's real projector series names. A catalog row like "QDX N4K45 COMM+TOURING KIT" under brand "Barco" should be findable even though the word "projector" doesn't appear in it.
- Example: for "Shure microphone" include "SM57", "SM58", "Beta", "KSM", "MV", "ULX", "QLX", "BLX", "Axient".
- Example: for "HP printer" include "LaserJet", "OfficeJet", "DeskJet", "PageWide", "Color LaserJet", "Envy", "Neverstop".
- For each product-family / series name, also emit the series as-it-would-appear-in-a-SKU (usually a short code). Both the descriptive series name AND short code help catalog matches.
- Only return families you are confident the brand actually makes for that category. It is OK to return fewer hints if you're unsure.
- This rule exists because real catalogs list products by model family, not by the generic category word. Without these hints the search misses most relevant rows.

## Category expansion (when brand is unknown)
- If only the category is known (no brand), still include the category's common technical terms, sub-types, and standards (e.g. "projector" → "DLP", "LCD", "laser projector", "lumens", "4K projector", "UST").

## Constraints
- Do NOT invent specific part numbers you aren't confident about. If the input has an obvious brand prefix mixed with a part number (e.g. "VX 5308813"), return just the part number fragment too ("5308813").
- NEVER include the original raw strings in the expansion arrays — they are already searched.
- Keep each expansion array to at most 16 entries. Use empty arrays when no good expansions exist.

## Routing (ONLY for free-text "User query:" input, NOT structured Brand/Part/Model/Description lines)
- Also include a "routed" object with keys brand, partNumber, modelNumber, description, priceMin, priceMax.
  - brand: the manufacturer/brand name the user named (e.g. "Samsung", "HP", "Sony"), or null.
  - partNumber: an explicit SKU / part code the user wrote, or null.
  - modelNumber: a distinct model identifier the user wrote (only if clearly different from partNumber), or null.
  - description: the remaining descriptive phrase with brand / part / model / price words stripped out, or null.
  - priceMin: number (raw integer/float, no currency symbol) or null — lower bound of the price range.
  - priceMax: number (raw integer/float, no currency symbol) or null — upper bound of the price range.
- String routed values (brand / part / model / description) should be verbatim substrings of the user query (preserving casing). Put each fragment in exactly ONE slot.

### Price parsing rules
- "around 5000", "~5000", "about 5000", "approximately 5000 €", "close to 5000": priceMin ≈ 0.8 × value, priceMax ≈ 1.2 × value (so "around 5000" → priceMin 4000, priceMax 6000).
- "under 5000", "less than 5000", "below 5000", "max 5000", "up to 5000", "< 5000": priceMin null, priceMax 5000.
- "over 5000", "more than 5000", "above 5000", "min 5000", "at least 5000", "> 5000": priceMin 5000, priceMax null.
- "between 3000 and 5000", "3000-5000", "3000 to 5000": priceMin 3000, priceMax 5000.
- "5k" = 5000, "10k" = 10000, "2.5k" = 2500.
- Currency symbols ($, €, £, ¥) and words ("euros", "dollars") are stripped — numbers are raw.
- If no price hint appears in the query, both priceMin and priceMax MUST be null.
- Do NOT infer a price from product terms (a "TV" query without a number has no implicit price).

- For structured input (Brand: X lines), omit "routed" or set it to null — the fields are already classified and no price parsing is done.`;

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

// Extract one routing field.  Empty / whitespace / "null" / "none" → null.
const sanitizeRoutedField = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'null' || lower === 'none' || lower === 'n/a') return null;
  return trimmed;
};

const sanitizePrice = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /^(null|none|n\/a)$/i.test(trimmed)) return null;
    const parsed = Number.parseFloat(trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const sanitizeRouted = (value: unknown): PromptRouting | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const routed: PromptRouting = {
    brand: sanitizeRoutedField(source.brand),
    partNumber: sanitizeRoutedField(source.partNumber),
    modelNumber: sanitizeRoutedField(source.modelNumber),
    description: sanitizeRoutedField(source.description),
    priceMin: sanitizePrice(source.priceMin),
    priceMax: sanitizePrice(source.priceMax),
  };
  if (
    !routed.brand
    && !routed.partNumber
    && !routed.modelNumber
    && !routed.description
    && routed.priceMin == null
    && routed.priceMax == null
  ) return null;
  return routed;
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
    if (out.length >= 16) break;
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
    const isPrompt = Boolean(trim(body.prompt));
    const userPrompt = buildUserPrompt(body);
    if (!userPrompt) {
      const empty: ExpandResponse = {
        brand: [],
        partNumber: [],
        modelNumber: [],
        description: [],
        negativeDescription: [],
      };
      return NextResponse.json({ ok: true, expansions: empty, routed: null, semanticCandidates: [] });
    }

    // Model tiering — gpt-4o only for free-text prompts (user is actively
    // searching, product-family recall matters, volume is low).  Structured
    // auto-expand from requested-row fields or column filter edits happens
    // much more often (batch per offer, every filter debounce) so it runs
    // on gpt-4o-mini to stay under the 30k TPM cap.  Mini handles synonyms
    // + simple expansion fine; family-name recall is a luxury that only
    // user-typed prompts actually need.
    const model = isPrompt ? 'gpt-4o' : 'gpt-4o-mini';
    const cacheKey = cacheKeyFor(userPrompt, model);
    let expansions: ExpandResponse;
    let routed: PromptRouting | null;
    const cached = getCached(cacheKey);
    if (cached) {
      expansions = cached.expansions;
      routed = cached.routed;
    } else {
      const openai = getOpenAI();
      let parsed: Record<string, unknown> = {};
      try {
        const completion = await openai.chat.completions.create({
          model,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        });
        const raw = completion.choices?.[0]?.message?.content ?? '{}';
        try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = {}; }
      } catch (err) {
        // Rate-limit or transient OpenAI failure — degrade gracefully.
        // Keyword + semantic search still work without expansion tokens;
        // returning an empty expansion is much better than a 500 that
        // spams the user with "Failed to expand filters" errors.
        const status = (err as { status?: number } | null)?.status;
        const code = (err as { code?: string } | null)?.code;
        if (status === 429 || code === 'rate_limit_exceeded') {
          console.warn('OpenAI expand rate-limited — falling back to empty expansion');
        } else {
          console.error('OpenAI expand call failed', err);
        }
        parsed = {};
      }
      expansions = {
        brand: sanitizeArray(parsed.brand),
        partNumber: sanitizeArray(parsed.partNumber),
        modelNumber: sanitizeArray(parsed.modelNumber),
        description: sanitizeArray(parsed.description),
        negativeDescription: sanitizeArray(parsed.negativeDescription),
      };
      // Routing is only meaningful for free-text prompts — for structured
      // auto-expand the fields were already classified by the caller.
      routed = isPrompt ? sanitizeRouted(parsed.routed) : null;
      setCached(cacheKey, { expansions, routed });
    }

    // Semantic candidates: embed the query (or the requested-row context) and
    // rank every product by cosine similarity.  The top IDs flow through to
    // the grid as a score bonus so semantically-similar rows surface even when
    // the user's words don't literally appear in the product description.
    // Non-blocking: if the index isn't loaded (cold start) or embedding fails
    // the catalog search still works via keyword matching.
    let semanticCandidates: number[] = [];
    try {
      const queryVec = await embedSingle(userPrompt);
      const index = getSemanticIndex();
      await index.ensureLoaded();
      const hits = index.search(queryVec, SEMANTIC_TOP_K);
      semanticCandidates = hits
        .filter((h) => h.score >= SEMANTIC_MIN_SCORE)
        .map((h) => h.productId);
    } catch (err) {
      console.warn('Semantic search failed (keyword-only fallback)', err);
    }

    return NextResponse.json({ ok: true, expansions, routed, semanticCandidates });
  } catch (err) {
    console.error('Failed to expand filters', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
