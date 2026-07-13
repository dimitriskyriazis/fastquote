// Web-search-based candidate proposer for the add-weblinks feature.
//
// One agentic OpenAI Responses call per product: the model searches the web (scoped to the
// manufacturer's domain when known), reads the results, and proposes candidate product-page
// URLs. This is the sole candidate-search stage for add-weblinks.
//
// The proposer only PROPOSES. Every candidate still goes through the route's deterministic
// verification (fetch the page, English-only, part/model content match) and the user's
// review dialog — a model claim that a page exists/is English is never trusted directly.

import type OpenAI from "openai";
import { parseDomainReply } from "./webLinkResolution";

export type ProposerProduct = {
  brand: string;
  partNumber: string;
  /** Part number with the order/region suffix stripped (e.g. "8660.034" from "8660.034-RT"),
   *  when it differs — manufacturers usually index by this, so it's the better search term. */
  partNumberCore?: string;
  modelNumber: string;
  description: string;
};

export type ProposerResult = {
  /** Candidate product-page URLs, best first (validated http(s), deduped). */
  candidates: string[];
  /** Bare manufacturer domain the model identified (normalized), or null. */
  resolvedDomain: string | null;
};

/** Builds the search prompt. Exported for tests. */
export const buildProposerPrompt = (product: ProposerProduct, domain: string | null): string =>
  [
    `You are finding the official manufacturer web page for a product, to store as its catalog link.`,
    ``,
    `Product:`,
    `- Brand: ${product.brand || "(unknown)"}`,
    `- Part number: ${product.partNumber || "(none)"}`,
    ...(product.partNumberCore && product.partNumberCore !== product.partNumber
      ? [`- Base part number (search with this): ${product.partNumberCore}`]
      : []),
    `- Model number: ${product.modelNumber || "(none)"}`,
    `- Description: ${product.description || "(none)"}`,
    ``,
    domain
      ? `Search the web (use at most 5 searches) for this product's page on the manufacturer's official site: ${domain}.`
      : `Search the web (use at most 5 searches) to identify the manufacturer's official website and find this product's page on it.`,
    ``,
    `Rules:`,
    `- ONLY pages on the manufacturer's own website — never distributors, resellers, or marketplaces.`,
    `- The page must be in ENGLISH. When the site is regionalized, prefer European-English or international-English variants.`,
    `- Product or product-family pages only — never news/blog/press articles, knowledge-base or support articles, community/forum pages, store/checkout pages, or PDF/datasheet files.`,
    `- Match the EXACT part number, not a similar variant. Manufacturers list many size/length/colour/configuration variants of one product; the page must be for THIS exact part number, not a sibling. If the URL carries a variant/SKU/configuration code (e.g. ?variantId=..., /sku/..., a trailing product code), it must correspond to this part number — the part number often appears there with punctuation removed (e.g. "8660.034" → "8660034"). Do not settle for the right product family at the wrong variant.`,
    ...(product.partNumberCore && product.partNumberCore !== product.partNumber
      ? [
          `- When searching, use the BASE part number, not the full order code. The trailing order/region/colour suffix (the part after the base, e.g. "-RT") is usually absent from the manufacturer's own pages and skews results toward distributors. Use the full part number only to confirm you have the right product.`,
        ]
      : []),
    `- For accessories (brackets, mounts, adapters, cables, cases), the page must be about the accessory itself — not the main product it attaches to.`,
    ``,
    `Reply with ONLY a JSON object, no other text, in exactly this shape:`,
    `{"candidates": ["<best URL>", "<alternate URL>"], "official_domain": "<bare manufacturer domain like extron.com>", "not_found": false}`,
    `Include up to 3 candidate URLs, best first. If no suitable English manufacturer page exists, reply {"candidates": [], "official_domain": "<domain or empty>", "not_found": true}.`,
  ].join("\n");

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

/** Parses the model's reply into a ProposerResult. Lenient: tolerates fenced code blocks and
 *  stray prose around the JSON. Never throws — garbage yields an empty result. Exported for tests. */
export const parseProposerReply = (raw: string): ProposerResult => {
  const empty: ProposerResult = { candidates: [], resolvedDomain: null };
  if (!raw) return empty;

  let parsed: unknown = null;
  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  parsed = tryParse(raw.trim());
  if (parsed === null) {
    // Extract the outermost {...} span (covers ```json fences and surrounding prose).
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = tryParse(raw.slice(start, end + 1));
  }
  if (parsed === null || typeof parsed !== "object") return empty;

  const obj = parsed as { candidates?: unknown; official_domain?: unknown };
  const candidates = Array.isArray(obj.candidates)
    ? Array.from(new Set(obj.candidates.filter(isHttpUrl).map((u) => u.trim()))).slice(0, 5)
    : [];
  const resolvedDomain =
    typeof obj.official_domain === "string" && obj.official_domain.trim()
      ? parseDomainReply(obj.official_domain)
      : null;

  return { candidates, resolvedDomain };
};

/** Delay before the next retry: honor the server's retry-after header when present,
 *  else exponential backoff capped at 30s. Sustained-batch 429s need a long tail —
 *  short 1s/2s backoffs exhaust and surface as user-visible errors at the end of runs. */
const retryDelayMs = (err: unknown, attempt: number): number => {
  const headers = (err as { headers?: { get?: (name: string) => string | null } })?.headers;
  const retryAfter = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(2000 * Math.pow(2, attempt), 30_000);
};

/**
 * Runs one web-search proposal call. Retries on 429/5xx; throws on final failure (the route
 * treats that as a per-product error). Note: gpt-5.x models reject sampling params — send
 * only model/tools/input.
 */
export const proposeWebLinks = async (
  openai: OpenAI,
  model: string,
  product: ProposerProduct,
  domain: string | null,
): Promise<ProposerResult> => {
  const MAX_RETRIES = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await openai.responses.create({
        model,
        tools: [
          {
            type: "web_search",
            search_context_size: "low",
            ...(domain ? { filters: { allowed_domains: [domain] } } : {}),
          },
        ],
        input: buildProposerPrompt(product, domain),
      });
      return parseProposerReply(res.output_text ?? "");
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if ((status === 429 || (status !== undefined && status >= 500)) && attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(err, attempt)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};
