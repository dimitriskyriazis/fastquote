/**
 * Group "very similar" pricelist rows so the AI description step can rewrite a whole family in a
 * single call and keep the wording consistent across product variants (the same line in different
 * colours / sizes / capacities / regions). Pure — no React/DOM/IO; unit-tested.
 *
 * Two rows are treated as variants of one another when EITHER:
 *   - they share the same base model number (the model/part with a recognised variant suffix —
 *     e.g. a colour or region code — stripped) AND their descriptions are broadly similar, OR
 *   - their description "signatures" are identical (the description reduced to its word skeleton,
 *     with colours, sizes, numbers and units removed). This catches variants whose model bases
 *     differ, e.g. the same display offered in two sizes.
 *
 * Grouping is conservative on purpose: forcing genuinely different products into one call would
 * homogenise descriptions that should stay distinct. Rows that match nothing remain singletons
 * and are described independently, exactly as before.
 */

export type SimilarityRow = {
  partNumber?: string | null;
  modelNumber?: string | null;
  description?: string | null;
};

/**
 * Largest family sent to a single LLM call. Bigger families are split into consecutive chunks of
 * this size so one request never balloons (and stays within the per-batch row budget).
 */
export const MAX_SIMILAR_GROUP = 12;

// Jaccard gate applied to two same-base-model rows before they are linked. Variants share almost
// their entire skeleton (colours/sizes/numbers are stripped), so this only rejects a base-model
// collision between genuinely unrelated products.
const DESC_SIM_THRESHOLD = 0.4;

// Description-only grouping needs a non-trivial skeleton, so a single generic word ("cable")
// never merges a whole catalogue.
const MIN_SIGNATURE_TOKENS = 2;

// Cap on the all-pairs skeleton comparison inside one base-model bucket. The comparison runs over
// one representative per DISTINCT skeleton, so this is only reached when a single base is shared by
// many genuinely different products (a base collision); beyond the cap we skip the cross-skeleton
// merge and keep only the exact-skeleton grouping, bounding Phase A's cost.
const MAX_BASE_BUCKET_REPS = 48;

// Colour / finish words removed from a description's signature: they are exactly the attribute
// that varies between siblings, so dropping them lets variants collapse to the same skeleton.
const COLOUR_WORDS = new Set([
  "white", "black", "silver", "grey", "gray", "red", "blue", "green", "beige", "ivory", "bronze",
  "gold", "tan", "brown", "anthracite", "graphite", "charcoal", "chrome", "titanium", "walnut",
  "oak", "maple", "cherry", "mahogany", "blanc", "noir", "weiss", "schwarz", "bianco", "nero",
]);

// Unit words removed from a signature for the same reason — the magnitude (which they qualify)
// is already dropped as a number, and the unit alone shouldn't keep two siblings apart.
const UNIT_WORDS = new Set([
  "mm", "cm", "m", "w", "watt", "watts", "ohm", "ohms", "v", "kv", "hz", "khz", "mhz", "ghz", "db",
  "kg", "lb", "lbs", "inch", "inches", "in", "ft", "va", "kva",
]);

const NOISE_WORDS = new Set<string>([...COLOUR_WORDS, ...UNIT_WORDS]);

// Trailing model segments that denote a variant rather than a different product: colour codes and
// region codes. Only a recognised trailing segment is stripped, so distinct models keep distinct
// bases. Compared upper-cased.
const MODEL_VARIANT_SUFFIXES = new Set([
  // colour codes
  "W", "WH", "WHT", "WT", "WE", "B", "BL", "BLK", "BK", "K", "S", "SI", "SIL", "SV", "GR", "GRY",
  "GY", "RD", "R", "BU", "BLU", "GN", "BG", "IV", "BR", "BZ", "AN", "CH",
  // region codes
  "EU", "EUR", "US", "USA", "UK", "AU", "NA", "ROW", "INT", "CN", "JP",
]);

// Region codes that may be glued onto a part/model number without a separator (e.g.
// "R9400810EU" / "R9400810UK"). Longest-first so "EUR"/"USA" win over "EU"/"US".
const GLUED_REGION_CODES = ["EUR", "USA", "UAE", "EU", "US", "UK", "ROW", "INT"];

// Strip a region code glued onto the end of a segment, but only when a digit precedes it
// (so "R9400810EU" → "R9400810" while a word like "PLUS" or "MENU" is left alone).
const stripGluedRegion = (segment: string): string => {
  for (const code of GLUED_REGION_CODES) {
    if (segment.length > code.length + 1 && segment.endsWith(code)) {
      const head = segment.slice(0, -code.length);
      if (/\d$/.test(head)) return head;
    }
  }
  return segment;
};

const splitModelSegments = (raw: string): string[] =>
  raw.toUpperCase().trim().split(/[\s\-_/.]+/).filter(Boolean);

/**
 * Reduce a model (or, when absent, part) number to its family base by stripping a trailing variant
 * marker: a separated colour/region code, a short pure-digit sequence/pack code, or a region code
 * glued onto the final segment without a separator. Variants of one product line therefore share a
 * base while genuinely different models stay distinct.
 */
export const normalizeModelBase = (model?: string | null, part?: string | null): string => {
  const source = (model && model.trim()) || (part && part.trim()) || "";
  const segments = splitModelSegments(source);
  if (segments.length === 0) return "";
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    const prev = segments[segments.length - 2];
    // Strip a recognised colour/region code, or a short pure-digit sequence/pack code — but only
    // strip a pure-digit segment when the preceding segment also carries a digit (the "1105-1" /
    // "910-00337-1" sequence-code shape). A trailing model identifier like "AMP 480" or "CX 100"
    // keeps its number so genuinely different models stay distinct.
    const isVariant =
      MODEL_VARIANT_SUFFIXES.has(last) || (/^\d{1,3}$/.test(last) && /\d/.test(prev));
    if (isVariant) segments.pop();
  }
  // Strip a region code glued onto the (now) final segment, e.g. R9400810EU / R9400810UK → R9400810.
  segments[segments.length - 1] = stripGluedRegion(segments[segments.length - 1]);
  return segments.join(" ");
};

const tokenize = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/**
 * The "skeleton" of a description: its words minus single characters, anything containing a digit
 * (sizes, specs, model fragments) and colour/unit words. De-duplicated, original order preserved.
 */
export const descriptionSignatureTokens = (description?: string | null): string[] => {
  const desc = (description ?? "").trim();
  if (!desc) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(desc)) {
    if (token.length < 2) continue;
    if (/\d/.test(token)) continue;
    if (NOISE_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
};

/** Order-independent key for the signature — equal keys mean identical skeletons. */
export const descriptionSignatureKey = (description?: string | null): string =>
  [...descriptionSignatureTokens(description)].sort().join(" ");

const jaccard = (a: string[], b: string[]): number => {
  if (a.length === 0 && b.length === 0) return 1; // two empty skeletons count as a match
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

// Union-find with the smallest index as the component root, so output order tracks file order.
class DisjointSet {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

/**
 * Partition rows into families of variants. Returns an array of groups, each a list of indices
 * into the input. Every index appears in exactly one group; rows with no sibling are length-1
 * groups (singletons). Groups are ordered by their smallest index, and families larger than
 * {@link MAX_SIMILAR_GROUP} are split into consecutive chunks of that size.
 */
export const groupSimilarRows = (rows: SimilarityRow[]): number[][] => {
  const n = rows.length;
  if (n === 0) return [];

  const bases = rows.map((r) => normalizeModelBase(r.modelNumber, r.partNumber));
  const sigTokens = rows.map((r) => descriptionSignatureTokens(r.description));
  const sigKeys = sigTokens.map((tokens) => [...tokens].sort().join(" "));
  const dsu = new DisjointSet(n);

  // Phase A — same base model + similar description. Within a base bucket, rows are first grouped
  // by identical skeleton (linear), then near-identical skeletons are merged across sub-buckets
  // working over ONE representative per distinct skeleton. So a base shared by hundreds of colour/
  // size SKUs costs O(rows) for the exact grouping plus O(distinct-skeletons²) — not O(rows²).
  const byBase = new Map<string, number[]>();
  bases.forEach((base, i) => {
    if (base.length < 2) return; // a 0–1 char base is too weak to group on
    const arr = byBase.get(base);
    if (arr) arr.push(i);
    else byBase.set(base, [i]);
  });
  for (const [base, idxs] of byBase) {
    if (idxs.length < 2) continue;
    // A "strong" base is a substantial alphanumeric core (contains a digit, length ≥ 4): rows that
    // share it differ only by a recognised colour/region/sequence suffix, so they are the same
    // product line. Group them unconditionally — supplier source descriptions for such variants are
    // often inconsistent, which is precisely the case this feature exists to fix, so requiring the
    // descriptions to already match would defeat the purpose.
    if (base.length >= 4 && /\d/.test(base)) {
      for (let k = 1; k < idxs.length; k += 1) dsu.union(idxs[0], idxs[k]);
      continue;
    }
    // Weak/ambiguous base (short or digit-free): require description evidence before grouping, so a
    // coincidental base collision between unrelated products doesn't merge them.
    // Union rows sharing an identical skeleton (incl. an empty one), keeping a representative each.
    const bySig = new Map<string, number[]>();
    for (const i of idxs) {
      const arr = bySig.get(sigKeys[i]);
      if (arr) arr.push(i);
      else bySig.set(sigKeys[i], [i]);
    }
    const reps: number[] = [];
    for (const sub of bySig.values()) {
      for (let k = 1; k < sub.length; k += 1) dsu.union(sub[0], sub[k]);
      reps.push(sub[0]);
    }
    // Merge near-identical (but not identical) skeletons across sub-buckets. Bounded by a rep cap
    // so a base collision among many unrelated products can't blow up.
    if (reps.length >= 2 && reps.length <= MAX_BASE_BUCKET_REPS) {
      for (let a = 0; a < reps.length; a += 1) {
        for (let b = a + 1; b < reps.length; b += 1) {
          if (jaccard(sigTokens[reps[a]], sigTokens[reps[b]]) >= DESC_SIM_THRESHOLD) {
            dsu.union(reps[a], reps[b]);
          }
        }
      }
    }
  }

  // Phase B — identical description skeleton (links variants whose model bases differ).
  const byKey = new Map<string, number[]>();
  sigTokens.forEach((tokens, i) => {
    if (tokens.length < MIN_SIGNATURE_TOKENS) return;
    const arr = byKey.get(sigKeys[i]);
    if (arr) arr.push(i);
    else byKey.set(sigKeys[i], [i]);
  });
  for (const idxs of byKey.values()) {
    for (let k = 1; k < idxs.length; k += 1) dsu.union(idxs[0], idxs[k]);
  }

  // Collect connected components (members stay ascending since i grows monotonically).
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = dsu.find(i);
    const arr = components.get(root);
    if (arr) arr.push(i);
    else components.set(root, [i]);
  }

  const groups: number[][] = [];
  for (const root of [...components.keys()].sort((a, b) => a - b)) {
    const members = components.get(root)!;
    if (members.length <= MAX_SIMILAR_GROUP) {
      groups.push(members);
    } else {
      for (let i = 0; i < members.length; i += MAX_SIMILAR_GROUP) {
        groups.push(members.slice(i, i + MAX_SIMILAR_GROUP));
      }
    }
  }
  return groups;
};
