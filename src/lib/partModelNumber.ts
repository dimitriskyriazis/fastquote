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
