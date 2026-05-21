// Brand-driven part number pattern matching and formatting.
//
// Pattern syntax:
//   %  -> single digit (0-9) placeholder
//   #  -> single letter (A-Z, case-insensitive) placeholder
//   *  -> one or more characters of any kind (variable-length wildcard)
//   anything else (e.g. ".", "-", letters in a suffix) -> literal character
//
// Example for Rittal:
//   suffix:   "-RT"
//   pattern1: "%%%%.%%%-RT"   (e.g. 1234.567-RT)
//   pattern2: "##.%%%%.%%%-RT" (e.g. AB.1234.567-RT)
//
// Example for free-form + suffix only:
//   suffix:   "-XX"
//   pattern1: "*-XX"          (e.g. ABC123-XX, 1234.567-XX — any body)
//
// applyBrandPattern() accepts a part number that may already be canonical, may
// be missing the suffix, or may be missing the literal separators (and/or both),
// and returns the canonical form when a pattern can be matched.

export type PartNumberPatternConfig = {
  patterns: string[];
  suffix: string | null;
};

export type PartNumberPatternResult =
  | { ok: true; value: string; matchedPattern: string | null; transformed: boolean }
  | { ok: false; value: string; reason: "no-match" };

const DIGIT_PLACEHOLDER = "%";
const LETTER_PLACEHOLDER = "#";
const WILDCARD_PLACEHOLDER = "*";
const PLACEHOLDER_CHARS = new Set([DIGIT_PLACEHOLDER, LETTER_PLACEHOLDER, WILDCARD_PLACEHOLDER]);

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const placeholderClass = (ch: string): string => {
  if (ch === DIGIT_PLACEHOLDER) return "\\d";
  if (ch === LETTER_PLACEHOLDER) return "[A-Za-z]";
  if (ch === WILDCARD_PLACEHOLDER) return ".+";
  return escapeForRegex(ch);
};

const patternToRegex = (pattern: string): RegExp => {
  let body = "";
  for (const ch of pattern) body += placeholderClass(ch);
  return new RegExp(`^${body}$`);
};

const stripTrailingSuffix = (pattern: string, suffix: string | null): string => {
  if (!suffix) return pattern;
  return pattern.endsWith(suffix) ? pattern.slice(0, pattern.length - suffix.length) : pattern;
};

const placeholderCount = (pattern: string): number => {
  let count = 0;
  for (const ch of pattern) if (PLACEHOLDER_CHARS.has(ch)) count += 1;
  return count;
};

const hasWildcard = (pattern: string): boolean => pattern.includes(WILDCARD_PLACEHOLDER);

const formatTokensAgainstPattern = (tokens: string, pattern: string): string | null => {
  if (hasWildcard(pattern)) {
    // Wildcard patterns: * consumes all remaining tokens; fixed placeholders must still match.
    const fixedCount = [...pattern].filter(
      (ch) => PLACEHOLDER_CHARS.has(ch) && ch !== WILDCARD_PLACEHOLDER,
    ).length;
    if (tokens.length < fixedCount + 1) return null; // need at least 1 char for *
    let out = "";
    let cursor = 0;
    for (const ch of pattern) {
      if (!PLACEHOLDER_CHARS.has(ch)) { out += ch; continue; }
      if (ch === WILDCARD_PLACEHOLDER) {
        // consume everything not claimed by fixed placeholders after this point
        const fixedAfter = [...pattern.slice(pattern.indexOf(ch) + 1)].filter(
          (c) => PLACEHOLDER_CHARS.has(c) && c !== WILDCARD_PLACEHOLDER,
        ).length;
        const consumeUntil = tokens.length - fixedAfter;
        out += tokens.slice(cursor, consumeUntil);
        cursor = consumeUntil;
        continue;
      }
      const token = tokens[cursor++];
      if (ch === DIGIT_PLACEHOLDER) {
        if (!/\d/.test(token)) return null;
      } else {
        if (!/[A-Za-z]/.test(token)) return null;
      }
      out += token;
    }
    return cursor === tokens.length ? out : null;
  }

  if (tokens.length !== placeholderCount(pattern)) return null;
  let out = "";
  let cursor = 0;
  for (const ch of pattern) {
    if (!PLACEHOLDER_CHARS.has(ch)) {
      out += ch;
      continue;
    }
    const token = tokens[cursor];
    cursor += 1;
    if (ch === DIGIT_PLACEHOLDER) {
      if (!/\d/.test(token)) return null;
      out += token;
    } else {
      if (!/[A-Za-z]/.test(token)) return null;
      out += token;
    }
  }
  return out;
};

export const normalizePatternConfig = (
  raw: { suffix?: string | null; patterns?: Array<string | null | undefined> },
): PartNumberPatternConfig => {
  const cleanSuffix = typeof raw.suffix === "string" ? raw.suffix.trim() : "";
  const cleanPatterns = (raw.patterns ?? [])
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p): p is string => p.length > 0);
  return {
    suffix: cleanSuffix.length > 0 ? cleanSuffix : null,
    patterns: cleanPatterns,
  };
};

export const hasPatternConfig = (config: PartNumberPatternConfig): boolean =>
  config.patterns.length > 0;

// Try to coerce `input` into a canonical part number for the brand.
// - If the brand has no patterns, returns the input as-is (matched).
// - If `input` already matches a full pattern, returns it unchanged.
// - If `input` matches a pattern minus suffix, appends suffix.
// - Otherwise tries to reconstruct from the digits alone, against each pattern.
// Returns { ok: false } when no pattern can be reconciled.
export const applyBrandPattern = (
  rawInput: string | null | undefined,
  config: PartNumberPatternConfig,
): PartNumberPatternResult => {
  const input = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!hasPatternConfig(config)) {
    return { ok: true, value: input, matchedPattern: null, transformed: false };
  }
  if (!input) {
    return { ok: false, value: input, reason: "no-match" };
  }

  for (const pattern of config.patterns) {
    if (patternToRegex(pattern).test(input)) {
      return { ok: true, value: input, matchedPattern: pattern, transformed: false };
    }
  }

  const suffix = config.suffix;

  if (suffix) {
    for (const pattern of config.patterns) {
      const core = stripTrailingSuffix(pattern, suffix);
      if (core === pattern) continue;
      if (patternToRegex(core).test(input)) {
        return { ok: true, value: input + suffix, matchedPattern: pattern, transformed: true };
      }
    }
  }

  const inputWithoutSuffix = suffix && input.endsWith(suffix)
    ? input.slice(0, input.length - suffix.length)
    : input;
  const tokens = inputWithoutSuffix.replace(/[^A-Za-z0-9]+/g, "");

  if (tokens.length > 0) {
    for (const pattern of config.patterns) {
      const core = stripTrailingSuffix(pattern, suffix);
      const formattedCore = formatTokensAgainstPattern(tokens, core);
      if (formattedCore == null) continue;
      const finalValue = suffix ? formattedCore + suffix : formattedCore;
      return { ok: true, value: finalValue, matchedPattern: pattern, transformed: true };
    }
  }

  return { ok: false, value: input, reason: "no-match" };
};

// Generate a human-friendly example for a pattern, e.g.
//   "%%%%.%%%-RT"   -> "1234.567-RT"
//   "##.%%%%.%%%-RT" -> "AB.1234.567-RT"
export const formatPatternExample = (pattern: string): string => {
  let out = "";
  let digit = 1;
  let letterCode = "A".charCodeAt(0);
  for (const ch of pattern) {
    if (ch === DIGIT_PLACEHOLDER) {
      out += String(digit);
      digit = digit >= 9 ? 1 : digit + 1;
    } else if (ch === LETTER_PLACEHOLDER) {
      out += String.fromCharCode(letterCode);
      letterCode = letterCode >= "Z".charCodeAt(0) ? "A".charCodeAt(0) : letterCode + 1;
    } else if (ch === WILDCARD_PLACEHOLDER) {
      out += "12345";
    } else {
      out += ch;
    }
  }
  return out;
};
