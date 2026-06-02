/**
 * Deterministic lifecycle / end-of-life marker detection for pricelist rows.
 *
 * Scans a row's text (typically its description) for end-of-life and related lifecycle
 * signals so the cleanup tool can warn the user and let them drop or annotate those rows —
 * no AI required. Urgency mirrors the Telmaco brief: HIGH = stop selling, MEDIUM = plan a
 * transition, LOW = informational.
 */

export type LifecycleUrgency = "high" | "medium" | "low";

export type LifecycleMarker = {
  /** The exact text that matched, e.g. "EOL Jan 2026" → "EOL". */
  match: string;
  urgency: LifecycleUrgency;
};

// Ordered most-urgent first; the first pattern that matches wins.
const PATTERNS: Array<{ re: RegExp; urgency: LifecycleUrgency }> = [
  { re: /end[\s-]*of[\s-]*life/i, urgency: "high" },
  { re: /\bEOL\b/i, urgency: "high" },
  { re: /end[\s-]*of[\s-]*sale/i, urgency: "high" },
  { re: /discontinued/i, urgency: "high" },
  { re: /last[\s-]*time[\s-]*buy/i, urgency: "high" },
  { re: /\bLTB\b/, urgency: "high" }, // case-sensitive: avoid matching inside words
  { re: /last[\s-]*buy/i, urgency: "high" },
  { re: /successor\s*[:\-]/i, urgency: "medium" },
  { re: /last[\s-]*order(?:[\s-]*date)?/i, urgency: "medium" },
  { re: /\blegacy\b/i, urgency: "medium" },
  { re: /\bsunset\b/i, urgency: "low" },
];

/** Return the highest-urgency lifecycle marker found in the text, or null. */
export const detectLifecycleMarker = (text: string | null | undefined): LifecycleMarker | null => {
  if (!text) return null;
  for (const { re, urgency } of PATTERNS) {
    const m = re.exec(text);
    if (m) return { match: m[0], urgency };
  }
  return null;
};
