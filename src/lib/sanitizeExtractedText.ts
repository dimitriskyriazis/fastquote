/**
 * Clean up text extracted from a PDF (or other lossy source).
 *
 * PDF extraction frequently mangles codes that wrap across two lines: the hyphen at the break
 * comes through as a soft hyphen, a replacement character, or an embedded-font private-use
 * glyph - all of which render as a box in Excel. e.g. "TPC-ANDROID<box>PHONE" should be
 * "TPC-ANDROID-PHONE". This normalises those cases and strips zero-width / control noise.
 *
 * Character classes are built via new RegExp("\\uXXXX") so the source stays pure ASCII.
 */

// Hyphen / dash variants that should all become a plain ASCII hyphen.
const DASH_VARIANTS = new RegExp("[\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212]", "g");
// Zero-width and BOM-style characters that should simply be removed.
const ZERO_WIDTH = new RegExp("[\\u200B\\u200C\\u200D\\uFEFF]", "g");
// C0/C1 control characters (tab / CR / LF are handled separately as whitespace).
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
  "g",
);
// "Box" glyphs: soft hyphen, replacement/object chars, private-use area, noncharacters.
const BOX_GLYPHS = "\\u00AD\\uE000-\\uF8FF\\uFFFC-\\uFFFF";
// A box glyph between two alphanumerics is almost always a hyphen lost at a line break.
const BOX_BETWEEN_ALNUM = new RegExp(`([A-Za-z0-9])[${BOX_GLYPHS}]+([A-Za-z0-9])`, "g");
const BOX_ANY = new RegExp(`[${BOX_GLYPHS}]`, "g");

export const sanitizeExtractedCell = (value: string): string => {
  let out = value
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL_CHARS, "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(DASH_VARIANTS, "-");
  out = out.replace(BOX_BETWEEN_ALNUM, "$1-$2").replace(BOX_ANY, "");
  return out.replace(/ {2,}/g, " ").trim();
};
