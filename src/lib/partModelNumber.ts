// ---------------------------------------------------------------------------
// Part/model number normalization.
//
// ONE rule, one purpose: fold a part or model number down to a comparison key
// so the same product is recognized however it is written. Stored in
// PartNumberCleared / ModelNumberCleared / LegacyPartNoCleaned, and applied to
// user input before comparing against them.
//
// The key is used for two things:
//   - SEARCH: grids, product lookup, offer population, ERP matching.
//   - DUPLICATE DETECTION: on manual product creation and price-list import,
//     a new product whose cleaned key already exists in the same brand is
//     surfaced to the user before it is created. The key is deliberately greedy
//     so this catches every spelling variant (a dropped hyphen, an underscore
//     instead of a dash, an extra space). It is NOT unique: genuinely different
//     products can share a key (Belden XDR8419-312W vs XDR8419-312-W, Neutrik
//     NO24FDW-A vs NO2-4FDW-A), which is why detection asks the user rather
//     than blocking outright.
//
// Stored values are compared DIRECTLY against a folded needle (no SQL wrapper
// functions), so the index on the cleared columns can actually be used. Wrapping
// them made every equality a 118k-row scan at ~540ms; a direct comparison is
// ~6ms.
//
// NOTE ON 'x': an earlier rule stripped x between digits ("2x250" -> "2250").
// Removed 2026-08-31 after an audit: it mangled 778 products whose x is part of
// the SKU (AKG 3354X00010, Klotz LX2-3X2N2-02.0, Belden 7502A G7X1000, Legrand
// AV LBM2X2U video walls, RG8X coax) and ZERO same-brand pairs in the catalog
// differed only by an x, so it never once helped. Its removal also deleted the
// nine-way inlined PATINDEX/STUFF expression responsible for the 540ms.
//
// NOTE ON '=': added 2026-08-31. It had been forgotten, leaving 546 Shure
// products (MXW1X/O=-Z11 and friends) unfindable unless the user typed the '='.
// ---------------------------------------------------------------------------

const COMBINING_MARKS_REGEX = /[̀-ͯ]/g;

// Everything that is formatting noise inside a part number. Note 'x' is NOT
// here (it is part of real SKUs) and accents are folded separately via NFKD.
const CLEAR_PART_MODEL_REGEX = /[-_\s/\\,()"'&+=.–—’]+/g;

export const clearPartModelNumber = (value: string): string =>
  value.normalize("NFKD").replace(COMBINING_MARKS_REGEX, "").replace(CLEAR_PART_MODEL_REGEX, "");

export const clearPartModelNumberUpper = (value: string): string =>
  clearPartModelNumber(value).toUpperCase();

// ---------------------------------------------------------------------------
// Same product, or two different products that happen to share a key?
//
// Two part numbers with the same cleaned key can be either. The discriminator
// that held across the whole catalog is separator POSITION:
//
//   same positions, different characters -> one product, two spellings
//     GP_12LDLD002MX / GP-12LDLD002MX      (Belden's 2024/25 double-import)
//     XLRK3M.SYU -   / XLRK3M.SYU          (a stray trailing separator)
//
//   different positions -> may be genuinely different products, ask a human
//     XDR8419-312W   / XDR8419-312-W       (welded 1243.47 vs white 585.00)
//     NO24FDW-A      / NO2-4FDW-A          (opticalCON MTP24 vs DUO)
//     ALIF1102 T     / ALIF1102T           (was a duplicate, but only a human
//                                           could know that)
//
// So import may auto-match the first kind, and must ask about the second.
// ---------------------------------------------------------------------------

// ONLY true separators count as positional noise here. '.', '+' and '=' are
// deliberately EXCLUDED: they are SKU-significant (Shure SLXD vs SLXD+, Ross
// KIVA vs KIVA+, Belden H126T01.01500 vs H126T01+01500, Klotz RCBEE0.75 vs
// RCBEE075), so they must be treated as CONTENT and compared, not collapsed.
// Getting this wrong is the worst available outcome: including '+' here made
// "SLXD15-S50" and "SLXD15+-S50" look like one product, because "+-" collapsed
// into a single separator at the same position.
const POSITIONAL_SEPARATOR_REGEX = /[-_\s/\\,()"'&–—’]/;

type SpellingShape = { content: string; separators: string };

/**
 * Splits a part number into the characters that carry meaning and the positions
 * of the separators between them. Runs collapse and leading/trailing separators
 * are dropped, since neither changes the reading ("XLRK3M.SYU -" is the same
 * spelling as "XLRK3M.SYU").
 */
const spellingShape = (value: string): SpellingShape => {
  const positions: number[] = [];
  let content = "";
  for (const ch of value.normalize("NFKD").replace(COMBINING_MARKS_REGEX, "")) {
    if (POSITIONAL_SEPARATOR_REGEX.test(ch)) {
      if (positions[positions.length - 1] !== content.length) positions.push(content.length);
    } else {
      content += ch;
    }
  }
  return {
    content: content.toUpperCase(),
    separators: positions.filter((pos) => pos > 0 && pos < content.length).join(","),
  };
};

/** Separator positions only. Exported for tests and diagnostics. */
export const partModelSeparatorSignature = (value: string): string => spellingShape(value).separators;

/**
 * True when two part numbers are the same product written two ways: identical
 * meaningful content, and separators in the same places, differing only in WHICH
 * separator character was used ('_' vs '-' vs a space).
 *
 * Callers may auto-match on this. When it is false but the cleaned keys still
 * collide, the two may be genuinely different products, so ask the user.
 */
export const isSameProductSpelling = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const left = spellingShape(a);
  const right = spellingShape(b);
  // content already implies the cleaned keys match, since the cleaned key is
  // content minus '.', '+' and '='.
  return left.content === right.content && left.separators === right.separators;
};
