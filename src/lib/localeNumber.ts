type SeparatorInfo = {
  group: string;
  decimal: string;
  resolvedLocale: string;
};

const separatorCache = new Map<string, SeparatorInfo>();

const getCacheKey = (locale?: string) => (locale && locale.trim() ? locale.trim() : "__default__");

const NUMBER_LOCALE_COOKIE = "fastquote-number-locale";

const readCookie = (name: string): string | null => {
  if (typeof document === "undefined") return null;
  const segments = document.cookie.split(";").map((segment) => segment.trim());
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith(`${name}=`)) {
      const raw = decodeURIComponent(segment.slice(name.length + 1));
      const trimmed = raw.trim();
      return trimmed ? trimmed : null;
    }
  }
  return null;
};

const inferLocaleFromTimeZone = (): string | null => {
  // Best-effort "regional format" hint. Browsers don't expose OS number-format overrides,
  // so we fall back to a time zone heuristic when needed.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === "Europe/Athens") return "el-GR";
  } catch {
    /* noop */
  }
  return null;
};

export const getUserNumberLocale = (): string | undefined => {
  const cookie = readCookie(NUMBER_LOCALE_COOKIE);
  if (cookie) return cookie;
  const inferred = inferLocaleFromTimeZone();
  return inferred ?? undefined;
};

const resolveSeparators = (locale?: string): SeparatorInfo => {
  const key = getCacheKey(locale);
  const cached = separatorCache.get(key);
  if (cached) return cached;

  const nf = new Intl.NumberFormat(locale);
  const resolvedLocale = nf.resolvedOptions().locale;
  const parts = nf.formatToParts(12345.6);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";

  const next = { group, decimal, resolvedLocale };
  separatorCache.set(key, next);
  return next;
};

const stripCommonSymbols = (value: string) =>
  value
    // currency / percent / common clutter
    .replace(/[%€$£¥]/g, "")
    // normalize various spaces (including NBSP / narrow NBSP)
    .replace(/[\u00A0\u202F]/g, " ")
    .trim();

const normalizeWithSeparators = (input: string, seps: Pick<SeparatorInfo, "group" | "decimal">) => {
  const { group, decimal } = seps;
  let s = stripCommonSymbols(input);
  if (!s) return "";

  // remove grouping separators and normal spaces
  s = s.replaceAll(" ", "");
  if (group) s = s.replaceAll(group, "");
  if (decimal && decimal !== ".") s = s.replaceAll(decimal, ".");

  return s;
};

const parseHeuristic = (raw: string): number | null => {
  // Tolerant parsing for pasted values that don't match the current locale.
  // Strategy: if both '.' and ',' exist, treat the last one as decimal.
  let s = stripCommonSymbols(raw);
  if (!s) return null;
  s = s.replaceAll(" ", "");

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    const normalized = s.replaceAll(group, "").replaceAll(decimal, ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }

  // Only one of them exists: treat it as decimal.
  const normalized = s.replaceAll(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

export const parseLocaleNumber = (value: unknown, options?: { locale?: string }): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value == null) return null;

  const raw = typeof value === "string" ? value : String(value);
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const locale = options?.locale ?? getUserNumberLocale();
  const seps = resolveSeparators(locale);
  const normalized = normalizeWithSeparators(trimmed, seps);
  const n = Number(normalized);
  if (Number.isFinite(n)) return n;

  return parseHeuristic(trimmed);
};

export const createLocaleNumberFormatter = (
  options: Intl.NumberFormatOptions,
  locale?: string,
) => new Intl.NumberFormat(locale, options);

export const getResolvedLocale = (locale?: string) => resolveSeparators(locale).resolvedLocale;

