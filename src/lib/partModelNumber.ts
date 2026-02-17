const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;
const CLEAR_PART_MODEL_REGEX = /[-_\s./,()"\'&+\u2013\u2014\u2019]+/g;

export const clearPartModelNumber = (value: string): string =>
  value.normalize("NFKD").replace(COMBINING_MARKS_REGEX, "").replace(CLEAR_PART_MODEL_REGEX, "");

export const clearPartModelNumberUpper = (value: string): string =>
  clearPartModelNumber(value).toUpperCase();
