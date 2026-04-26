const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;
const CLEAR_PART_MODEL_REGEX = /[-_\s./\\,()"\'&+\u2013\u2014\u2019]+/g;
// Cable/AV specs use "x" between digits as a "by" separator (e.g. "2x250", "3x1.5",
// "2x2x250"). Users search the same product with or without the x, so we strip x/X
// when sandwiched between digits on the search side. The matching SQL-side strip is
// in stripXBetweenDigitsSql() below, applied to the cleared columns at query time so
// stored values do not need to be backfilled.
const X_BETWEEN_DIGITS_REGEX = /(\d)[xX](\d)/g;

const stripXBetweenDigits = (value: string): string => {
  let prev = value;
  let next = value.replace(X_BETWEEN_DIGITS_REGEX, "$1$2");
  while (next !== prev) {
    prev = next;
    next = next.replace(X_BETWEEN_DIGITS_REGEX, "$1$2");
  }
  return next;
};

export const clearPartModelNumber = (value: string): string =>
  stripXBetweenDigits(
    value.normalize("NFKD").replace(COMBINING_MARKS_REGEX, "").replace(CLEAR_PART_MODEL_REGEX, ""),
  );

export const clearPartModelNumberUpper = (value: string): string =>
  clearPartModelNumber(value).toUpperCase();

// SQL-side mirror of stripXBetweenDigits, applied to cleared part/model columns at
// query time so we do not need to backfill stored values. Two passes handle up to
// two consecutive X's between digits (e.g. "2X2X250"); each pass repeats the inner
// expression three times, so two passes inline the column nine times — acceptable.
export const stripXBetweenDigitsSql = (expr: string): string => {
  const onePass = (e: string) =>
    `CASE WHEN ${e} LIKE '%[0-9]X[0-9]%' THEN STUFF(${e}, PATINDEX('%[0-9]X[0-9]%', ${e}) + 1, 1, '') ELSE ${e} END`;
  return onePass(`(${onePass(expr)})`);
};
