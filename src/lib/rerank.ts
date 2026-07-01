import crypto from 'crypto';
import OpenAI from 'openai';

// Shared LLM reranker.  Takes a requested product spec + up to 50 candidate
// products and returns ProductIDs ordered by relevance (best first) with a
// synthesized score 0-100.  Called both from the thin /rerank HTTP endpoint
// (kept for debugging / backwards compat) and inline from the grid route —
// the latter eliminates the client-side "fetch grid → fetch /rerank →
// refetch grid with order" double-roundtrip on first-page loads.

export type RerankCandidate = {
  productId: number;
  brand: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
};

export type RerankInput = {
  requestedBrand?: string | null;
  requestedPartNumber?: string | null;
  requestedModelNumber?: string | null;
  requestedDescription?: string | null;
  requestedDescription2?: string | null;
  requestedDescription3?: string | null;
  candidates?: RerankCandidate[];
};

export type RankedEntry = { productId: number; score: number };

const SYSTEM_PROMPT = `You are a product-catalog matching assistant.  Given a REQUESTED product spec and a list of CANDIDATE products, score EVERY candidate 0-100 for how well it matches the requested item.  Always return all candidates — the user needs to see the best available match even if no candidate is a perfect fit.

Scoring rubric:
- 90-100: exact or effectively-identical product (same brand + model + key spec).
- 70-89: same product family, equivalent capability, different variant (e.g. size / color / bundle).
- 50-69: same category and comparable spec but not a direct equivalent.
- 30-49: same broad category but a different product type (e.g. accessory vs main unit, panel vs cord, cable vs connector).
- 10-29: adjacent category — wrong product type but related domain (e.g. a patch cable for a patch panel query).
- 0-9: wrong category entirely (e.g. a projector ceiling lift for a patch panel query).

Logic-based judgment — not just word overlap:
- A "patch panel" is NOT a "patch cord", "patch cable", "control panel", "SmartPanel", "wall panel", or any accessory/component.  Score cross-category matches LOW even if they share words.
- When the REQUESTED line names a specific brand (e.g. "Lanberg"), candidates from that brand get a strong boost.  Candidates from unrelated brands max out around 50 unless they're known OEM equivalents for that model family.
- When REQUESTED names a category (e.g. "CAT.7 FTP patch panel"), prefer candidates that are a functional equivalent of that exact category over candidates that merely contain overlapping keywords.
- Accessories (crimp tools, die sets, mounting brackets, cable organizers sold separately) are NEVER the right match for a main-product query.

Your job is RANKING, not filtering — always return ALL candidates in best-to-worst order.

Return JSON: { "ordered": [<id1>, <id2>, ..., <idN>] } where id1 is the best match and idN is the worst.  Plain integer IDs only, no "#" prefix, no scores, no objects.  Must include every candidate ID you were given exactly once.`;

function buildUserPrompt(input: RerankInput): string {
  const lines: string[] = [];
  const push = (label: string, v: string | null | undefined) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t) lines.push(`${label}: ${t}`);
  };
  lines.push('REQUESTED:');
  push('  Brand', input.requestedBrand);
  push('  Part Number', input.requestedPartNumber);
  push('  Model Number', input.requestedModelNumber);
  push('  Description', input.requestedDescription);
  push('  Description 2', input.requestedDescription2);
  push('  Description 3', input.requestedDescription3);
  lines.push('');
  lines.push('CANDIDATES:');
  (input.candidates ?? []).forEach((c) => {
    const parts: string[] = [`id=${c.productId}`];
    if (c.brand?.trim()) parts.push(`brand=${c.brand.trim()}`);
    if (c.partNumber?.trim()) parts.push(`part=${c.partNumber.trim()}`);
    if (c.modelNumber?.trim()) parts.push(`model=${c.modelNumber.trim()}`);
    if (c.description?.trim()) {
      const d = c.description.trim();
      // 400 chars: product-category distinctions ("patch panel" vs
      // "control panel" vs "patch cable") are often near the end of long
      // descriptions, not in the first 200 chars.
      parts.push(`desc=${d.length > 400 ? `${d.slice(0, 400)}…` : d}`);
    }
    lines.push(`- ${parts.join(' | ')}`);
  });
  return lines.join('\n');
}

type CachedRerank = { ranked: RankedEntry[]; expiresAt: number };
const RERANK_CACHE_TTL_MS = 15 * 60 * 1000;
const RERANK_CACHE_MAX = 500;
const rerankCache = new Map<string, CachedRerank>();
const rerankInflight = new Map<string, Promise<RankedEntry[]>>();

function cacheKeyFor(input: RerankInput): string {
  const payload = JSON.stringify({
    b: input.requestedBrand,
    p: input.requestedPartNumber,
    m: input.requestedModelNumber,
    d: input.requestedDescription,
    d2: input.requestedDescription2,
    d3: input.requestedDescription3,
    c: (input.candidates ?? []).map((c) => c.productId).sort((a, b) => a - b),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function getCached(key: string): CachedRerank | null {
  const hit = rerankCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    rerankCache.delete(key);
    return null;
  }
  rerankCache.delete(key);
  rerankCache.set(key, hit);
  return hit;
}

function setCached(key: string, ranked: RankedEntry[]): void {
  if (rerankCache.size >= RERANK_CACHE_MAX) {
    const oldest = rerankCache.keys().next().value;
    if (oldest) rerankCache.delete(oldest);
  }
  rerankCache.set(key, { ranked, expiresAt: Date.now() + RERANK_CACHE_TTL_MS });
}

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

export async function performRerank(input: RerankInput): Promise<RankedEntry[]> {
  const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 50) : [];
  if (candidates.length === 0) return [];
  const normalized: RerankInput = { ...input, candidates };
  const key = cacheKeyFor(normalized);
  const cached = getCached(key);
  if (cached) return cached.ranked;
  const inflight = rerankInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    const started = Date.now();
    const prompt = buildUserPrompt(normalized);
    let parsed: Record<string, unknown> = {};
    let modelLatency = 0;
    try {
      const modelStart = Date.now();
      const completion = await getOpenAI().chat.completions.create({
        // gpt-5-mini: stronger reasoning than 4.1-mini at comparable
        // latency/cost for this size of prompt.  The rerank rubric has
        // real category-vs-category judgment calls (patch panel vs
        // SmartPanel vs patch cord) so a reasoning-tier model pays off.
        //
        // gpt-5 family rejects the legacy `max_tokens` param — it only
        // accepts `max_completion_tokens`.  CRITICAL: that budget is
        // SHARED between reasoning tokens and visible output — it is NOT a
        // separate "output only" cap.  At the default reasoning effort a
        // "hdmi cable" rerank burned the entire 2000-token budget on
        // reasoning (~20s), leaving ZERO tokens for the JSON, so the call
        // returned empty content (rankedCount 0) after 20s and we silently
        // fell back to keyword order — pure latency with no benefit.
        //
        // reasoning_effort:'low' collapses the reasoning spend so the model
        // actually emits the ranking, and does so in ~3-5s instead of 20s.
        // The raised budget leaves comfortable headroom for the JSON output
        // even if low-effort reasoning runs a little long.
        model: 'gpt-5-mini',
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        // gpt-5 family only supports the default temperature (1); sending
        // temperature: 0 400's the call and rerank falls back to keyword order.
        max_completion_tokens: 4000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      modelLatency = Date.now() - modelStart;
      const raw = completion.choices?.[0]?.message?.content ?? '{}';
      console.log('[rerank raw response]', raw.slice(0, 500));
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Truncated / malformed JSON — salvage whatever integer IDs the model
        // emitted before the cutoff, otherwise we'd discard useful partial
        // rankings and fall back to keyword order.
        const salvaged: Array<{ id: number; score: number }> = [];
        const orderedMatch = raw.match(/"ordered"\s*:\s*\[([\s\S]*)/);
        if (orderedMatch) {
          const idRx = /(\d+)/g;
          let m: RegExpExecArray | null;
          while ((m = idRx.exec(orderedMatch[1])) !== null) {
            const id = Number(m[1]);
            if (Number.isFinite(id)) salvaged.push({ id, score: 0 });
          }
        } else {
          const rx = /"id"\s*:\s*"?#?(\d+)"?[^}]*?"score"\s*:\s*(\d+(?:\.\d+)?)/g;
          let m: RegExpExecArray | null;
          while ((m = rx.exec(raw)) !== null) {
            const id = Number(m[1]);
            const score = Number(m[2]);
            if (Number.isFinite(id) && Number.isFinite(score)) salvaged.push({ id, score });
          }
        }
        if (salvaged.length > 0) {
          console.log(`[rerank] salvaged ${salvaged.length} entries from truncated JSON`);
          parsed = { ordered: salvaged.map((s) => s.id) };
        } else {
          parsed = {};
        }
      }
    } catch (err) {
      console.warn('Rerank LLM call failed — keyword ordering retained', err);
      parsed = {};
    }
    const candidateIds = new Set(candidates.map((c) => c.productId));
    let orderedIds: unknown[] = Array.isArray(parsed.ordered) ? parsed.ordered : [];
    let isObjectFormat = false;
    if (orderedIds.length === 0 && Array.isArray(parsed.ranked)) {
      orderedIds = parsed.ranked;
      isObjectFormat = true;
    }
    if (orderedIds.length === 0) {
      for (const [, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length > 0) {
          orderedIds = v;
          isObjectFormat = typeof v[0] === 'object' && v[0] !== null;
          break;
        }
      }
    }
    const seen = new Set<number>();
    const ranked: RankedEntry[] = [];
    orderedIds.forEach((entry, rankIdx) => {
      let idRaw: unknown;
      let scoreRaw: unknown;
      if (isObjectFormat && entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        idRaw = obj.id ?? obj.productId ?? obj.product_id ?? obj.productID ?? obj.ID;
        scoreRaw = obj.score ?? obj.relevance ?? obj.relevanceScore ?? obj.rank;
      } else {
        idRaw = entry;
        scoreRaw = Math.max(50, 100 - rankIdx * 2);
      }
      const idStr = typeof idRaw === 'string' ? idRaw.replace(/^#/, '') : idRaw;
      const id = typeof idStr === 'number' ? idStr : Number(idStr);
      const score = typeof scoreRaw === 'number' ? scoreRaw : Number(scoreRaw);
      if (!Number.isFinite(id) || !candidateIds.has(id)) return;
      if (seen.has(id)) return;
      seen.add(id);
      ranked.push({ productId: id, score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 50 });
    });
    const top5 = ranked.slice(0, 5).map((r) => {
      const c = candidates.find((x) => x.productId === r.productId);
      return {
        id: r.productId,
        score: r.score,
        brand: c?.brand ?? null,
        part: c?.partNumber ?? null,
        desc: c?.description ? c.description.slice(0, 60) : null,
      };
    });
    console.log('[rerank debug]', JSON.stringify({
      totalLatencyMs: Date.now() - started,
      modelLatencyMs: modelLatency,
      model: 'gpt-5-mini',
      requested: {
        brand: input.requestedBrand,
        part: input.requestedPartNumber,
        model: input.requestedModelNumber,
        desc: input.requestedDescription?.slice(0, 80) ?? null,
      },
      candidatesCount: candidates.length,
      rankedCount: ranked.length,
      top5,
    }));
    setCached(key, ranked);
    return ranked;
  })();
  rerankInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    rerankInflight.delete(key);
  }
}
