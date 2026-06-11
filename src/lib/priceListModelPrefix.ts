/**
 * Detect a model number that suppliers prepend to the description ("I600-4K8 black EU") and
 * optionally relocate it to the Model Number column. Pure — no React/DOM; unit-tested.
 *
 * Detection is conservative: the leading token must look like a SKU (digits + letters in a
 * hyphenated/uppercase shape), the Model Number column must be empty or already hold the same
 * token, and stripping it must leave a non-empty description. Anything else is left untouched —
 * the user explicitly chooses keep/move in the UI, so detection only has to be safe, not clever.
 */

export type ModelPrefixChoice = "keep" | "move";

export type ModelPrefixRow = {
  partNumber: string;
  modelNumber: string | null;
  description: string | null;
};

export type ModelPrefixDetection = { token: string; rest: string };

// Allowed SKU charset for the leading token (after trailing punctuation is trimmed).
const MODEL_TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9\-_/+.]{1,29}$/;

const looksLikeModelToken = (token: string, partNumber: string): boolean => {
  if (token.length < 3 || !MODEL_TOKEN_SHAPE.test(token)) return false;
  const digits = (token.match(/\d/g) ?? []).length;
  const letters = (token.match(/[A-Za-z]/g) ?? []).length;
  if (digits === 0 || letters === 0) return false; // pure words and pure numbers are never SKUs
  if (token.toUpperCase() === partNumber.toUpperCase()) return true; // echoes the part number
  // SKU shapes: hyphen/underscore-joined ("I600-4K8"), several digits ("Z48"), or the
  // all-caps+digits look ("MASK6C"). A mixed-case single-digit word like "Cat5e" is rejected.
  if (/[-_/]/.test(token)) return true;
  if (digits >= 2) return true;
  return token === token.toUpperCase();
};

/**
 * Return the leading model-number token and the remaining description, or null when the
 * description doesn't start with a movable model number. "Movable" also requires the row's
 * Model Number to be empty or to already equal the token — a conflicting Model Number means
 * we can't know which is right, so the row is skipped.
 */
export const detectModelPrefix = (row: ModelPrefixRow): ModelPrefixDetection | null => {
  const desc = (row.description ?? "").trim();
  if (!desc) return null;
  // First whitespace-token, then a separator, then the rest. A dash/colon separator must be
  // followed by whitespace so a hyphen INSIDE the token ("I600-4K8") can't be treated as one.
  const match = desc.match(/^(\S+)(?:\s*[-–—:]\s+|\s+)(\S[\s\S]*)$/);
  if (!match) return null;
  const token = match[1].replace(/[.,;:]+$/, "");
  const rest = match[2].trim();
  if (!rest) return null;
  if (!looksLikeModelToken(token, row.partNumber)) return null;
  const model = (row.modelNumber ?? "").trim();
  if (model && model.toUpperCase() !== token.toUpperCase()) return null;
  return { token, rest };
};

/**
 * Apply the "move" choice: for each detected row, strip the leading model number from the
 * description and place it in the Model Number column (unless the column already holds it).
 * Rows without a detection are returned unchanged.
 */
export const applyModelPrefixMove = <T extends ModelPrefixRow>(rows: T[]): T[] =>
  rows.map((row) => {
    const hit = detectModelPrefix(row);
    if (!hit) return row;
    return {
      ...row,
      modelNumber: (row.modelNumber ?? "").trim() ? row.modelNumber : hit.token,
      description: hit.rest,
    };
  });
