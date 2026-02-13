"use client";

import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type ChangeEvent,
  type DragEvent,
} from "react";
import Link from "next/link";
import AddBrandModal from "../../components/AddBrandModal";
import AddSupplierModal from "../../components/AddSupplierModal";
import lookupButtonStyles from "../../components/LookupAddButton.module.css";
import { useRouter } from "next/navigation";
import type * as XLSXTypes from "xlsx";
import type { DropdownOption } from "../../../lib/dropdownOptions";
import { showToastMessage } from "../../../lib/toast";
import layoutStyles from "../priceListDetail.module.css";
import styles from "./PriceListImport.module.css";
import lookupStyles from "../../components/LookupModal.module.css";
import LookupModal from "../../components/LookupModal";
import type { PricingPolicyRuleOption } from "../../../lib/lookupTypes";
import UKDatePicker from "../../components/DatePicker";
import {
  PRICE_LIST_DECIMAL_FORMAT_OPTIONS,
  type PriceListDecimalFormat,
} from "../../../lib/priceListDecimalFormats";
import { getUserNumberLocale, parseLocaleNumber } from "../../../lib/localeNumber";
import { useAuditUser } from "../../components/AuditUserProvider";

type XlsxModule = typeof import("xlsx");

const loadXlsx = () => import("xlsx");

const numberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const formatDiscountValue = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "";
  return numberFormatter.format(value);
};

export type PreviousPriceListOption = DropdownOption & {
  brandId: number | null;
  brandName: string | null;
};

type Props = {
  brands: DropdownOption[];
  suppliers: DropdownOption[];
  currencies: DropdownOption[];
  countries: DropdownOption[];
  cities: DropdownOption[];
  pricingPolicies: DropdownOption[];
  pricingPolicyRules: PricingPolicyRuleOption[];
  users: DropdownOption[];
  previousPriceLists: PreviousPriceListOption[];
};

type PricingPolicySelection = {
  pricingPolicyId: number;
  pricingPolicyRuleId: number | null;
};

type PricingPolicyPickerRow = {
  pricingPolicyId: number;
  pricingPolicyName: string;
  telmacoDiscountPercentage: number | null;
  customerDiscountPercentage: number | null;
};

type FormValues = {
  name: string;
  brandId: string;
  pricingPolicies: PricingPolicySelection[];
  responsibleUserId: string;
  supplierId: string;
  hasDuty: boolean | null;
  costCurrencyId: string;
  currencyCostModifier: string;
  countryId: string;
  validFromDate: string;
  validToDate: string;
  comments: string;
  supplierComments: string;
  previousPriceListId: string;
  decimalFormat: PriceListDecimalFormat;
};

type HeaderColumnKey = "partNumber" | "modelNumber" | "description" | "listPrice" | "costPrice" | "warning" | "weblink";

const columnKeywords: Record<HeaderColumnKey, string[]> = {
  partNumber: [
    "part ",
    "part_",
    "partno",
    "p/n",
    "sku",
    "item ",
    "item_",
    "article",
    "art ",
    "order ",
    "order_",
    "code",
    "catalog",
    "cat ",
    "κωδικός",
    "κωδικος",
    "κωδ.",
    "κωδ ",
    "κωδ_",
    "κωδικοσ",
    "κωδικο προϊόντος",
    "κωδικος προιοντος",
    "κωδ προιοντος",
    "κωδ προ",
    "αρ. είδους",
    "αριθμός είδους",
    "αριθμος ειδους",
    "κωδ παραγγελίας",
    "κωδικος παραγγελιας",
  ],

  modelNumber: [
    "model",
    "series",
    "type ",
    "type_",
    "mpn",
    "mfg",
    "family",
    "version",
    "rev",
    "revision",
    "μοντέλο",
    "μοντελο",
    "μτλο",
    "σειρά",
    "σειρα",
    "τύπος",
    "τυπος",
    "μοντ ",
    "μοντ_",
    "κωδ μοντέλου",
    "κωδ μοντελου",
    "κωδ τύπου",
    "κωδ τυπου",
  ],

  description: [
    "desc",
    "description",
    "name",
    "detail",
    "περιγραφή",
    "περιγραφη",
    "όνομα",
    "ονομα",
    "ονομασία",
    "ονομασια",
    "περ. ",
    "περ_",
    "λεπτομέρειες",
    "λεπτομερειες",
  ],

  listPrice: [
    "price",
    "list",
    "msrp",
    "rrp",
    "retail",
    "τιμή",
    "τιμη",
    "λιανική",
    "λιανικη",
    "κατάλογ",
    "καταλογος",
    "λιστ",
    "χονδρική",
    "χονδρικη",
    "euros",
    "eur",
    "ευρώ",
    "€",
    "dollars",
    "usd",
    "$",
  ],

  costPrice: [
    "costprice",
    "cost price",
    "cost",
    "κόστος",
    "κοστος",
    "τιμή κόστους",
    "τιμη κοστους",
  ],

  warning: [
    "warn",
    "note",
    "remark",
    "σημείωση",
    "σημειωση",
    "σημ.",
    "προσοχή",
    "προσοχη",
    "παρατήρηση",
    "παρατηρηση",
    "παρατηρ.",

  ],

  weblink: [
    "weblink",
    "web link",
    "weblnk",
    "url",
    "link",
    "hyperlink",
    "website",
    "web",
    "www",
    "http",
    "https",
    "σύνδεσμος",
    "συνδεσμος",
    "ιστοσελίδα",
    "ιστοσελιδα",
  ],
};

const COLUMN_DISPLAY: Array<{ key: HeaderColumnKey; label: string; required?: boolean }> = [
  { key: "partNumber", label: "Part Number", required: true },
  { key: "modelNumber", label: "Model Number (optional)", required: false },
  { key: "description", label: "Name / Description", required: true },
  { key: "listPrice", label: "List Price", required: true },
  { key: "costPrice", label: "Cost Price (optional)", required: false },
  { key: "warning", label: "Warning (optional)", required: false },
  { key: "weblink", label: "Weblink (optional)", required: false },
];

const PREVIEW_COLUMN_KEYS: HeaderColumnKey[] = [
  "partNumber",
  "modelNumber",
  "description",
  "listPrice",
  "costPrice",
  "warning",
  "weblink",
];

type ColumnOption = { index: number; label: string; normalized: string };

type SheetMapping = {
  name: string;
  headerRowIndex: number;
  columns: ColumnOption[];
  suggestions: Record<HeaderColumnKey, ColumnOption[]>;
  selection: Partial<Record<HeaderColumnKey, number | null>>;
  rowCount: number;
  enabled: boolean;
  previewRows: Record<number, string>[];
};

type PreviewColumn = {
  key: HeaderColumnKey;
  label: string;
  columnIndex: number;
  isListPrice: boolean;
};

type FileValidation = {
  status: "idle" | "checking" | "valid" | "invalid";
  message: string | null;
  columns: Partial<Record<HeaderColumnKey, boolean>>;
  rowCount: number;
  sheetName: string | null;
  sheets: SheetMapping[];
  activeSheetIndex: number;
};

const INITIAL_VALIDATION: FileValidation = {
  status: "idle",
  message: null,
  columns: {},
  rowCount: 0,
  sheetName: null,
  sheets: [],
  activeSheetIndex: 0,
};

const REQUIRED_FIELDS: Array<keyof FormValues> = [
  "name",
  "brandId",
  "responsibleUserId",
  "validFromDate",
  "validToDate",
];

const normalizeDate = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // For type="date" inputs, value is already in ISO format (YYYY-MM-DD)
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeHeaderText = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = typeof value === "number" ? String(value) : value;
  const normalized = str
    .trim()
    .toLowerCase()
    .replace(/[\u00a0]+/g, " ")
    .replace(/[|_/\\-]+/g, " ")
    .replace(/\s+/g, " ");
  return normalized || null;
};

const normalizeHeaderCompact = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "");

const headerContainsKeyword = (header: string, keyword: string) => {
  const normalizedKeyword = normalizeHeaderText(keyword);
  if (!normalizedKeyword) return false;
  if (header.includes(normalizedKeyword)) return true;
  const compactHeader = normalizeHeaderCompact(header);
  const compactKeyword = normalizeHeaderCompact(normalizedKeyword);
  if (!compactKeyword) return false;
  return compactHeader.includes(compactKeyword);
};

const LIST_PRICE_POSITIVE_HINTS = [
  "list",
  "msrp",
  "rrp",
  "retail",
  "catalog",
  "κατάλογ",
  "καταλογ",
  "λιαν",
];

const LIST_PRICE_NEGATIVE_HINTS = [
  "discount",
  "disc",
  "net",
  "offer",
  "promo",
  "special",
];

const scoreColumnForKey = (column: ColumnOption, key: HeaderColumnKey) => {
  const keywords = columnKeywords[key].map((kw) => kw.toLowerCase());
  const matchCount = keywords.reduce<number>(
    (count, keyword) => (headerContainsKeyword(column.normalized, keyword) ? count + 1 : count),
    0,
  );
  if (matchCount === 0) return -1;

  let score = matchCount * 10;
  if (key === "listPrice") {
    const hasPositiveHint = LIST_PRICE_POSITIVE_HINTS.some((hint) =>
      headerContainsKeyword(column.normalized, hint),
    );
    const hasNegativeHint = LIST_PRICE_NEGATIVE_HINTS.some((hint) =>
      headerContainsKeyword(column.normalized, hint),
    );
    if (hasPositiveHint) score += 40;
    if (hasNegativeHint && !hasPositiveHint) score -= 30;
  }

  return score;
};

const scoreHeaderRow = (row: unknown[]) => {
  const normalizedCells = row
    .map((cell) => normalizeHeaderText(cell))
    .filter((value): value is string => Boolean(value));
  if (normalizedCells.length === 0) return -1;

  const matchedKeys = new Set<HeaderColumnKey>();
  let keywordHits = 0;

  normalizedCells.forEach((cell) => {
    (Object.keys(columnKeywords) as HeaderColumnKey[]).forEach((key) => {
      const matches = columnKeywords[key].some((keyword) => headerContainsKeyword(cell, keyword));
      if (!matches) return;
      keywordHits += 1;
      matchedKeys.add(key);
    });
  });

  return matchedKeys.size * 100 + keywordHits * 10 + normalizedCells.length;
};

const hasCellValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

const stringifyCellValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

const detectHeaderRowIndex = (rows: unknown[][]) => {
  let bestIdx = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 100);
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const keywordScore = scoreHeaderRow(row);
    const densityScore = row.reduce<number>((count, cell) => (hasCellValue(cell) ? count + 1 : count), 0);
    const score = keywordScore >= 0 ? keywordScore : densityScore;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }
  return bestIdx;
};

const buildColumns = (headerRow: unknown[]): ColumnOption[] =>
  headerRow.map((cell, idx) => {
    const normalized = normalizeHeaderText(cell) ?? "";
    const label =
      typeof cell === "string"
        ? cell.trim()
        : typeof cell === "number"
          ? String(cell)
          : "";
    const safeLabel = label || `Column ${idx + 1}`;
    return { index: idx, label: safeLabel, normalized };
  });

const buildSuggestions = (columns: ColumnOption[]) => {
  const makeSuggestions = (key: HeaderColumnKey) => {
    return columns
      .map((col) => ({ col, score: scoreColumnForKey(col, key) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.col.index - b.col.index;
      })
      .map((entry) => entry.col);
  };

  return {
    partNumber: makeSuggestions("partNumber"),
    modelNumber: makeSuggestions("modelNumber"),
    description: makeSuggestions("description"),
    listPrice: makeSuggestions("listPrice"),
    costPrice: makeSuggestions("costPrice"),
    warning: makeSuggestions("warning"),
    weblink: makeSuggestions("weblink"),
  };
};

const autoSelectUniqueSuggestions = (
  suggestions: Record<HeaderColumnKey, ColumnOption[]>,
): Partial<Record<HeaderColumnKey, number | null>> => {
  const selection: Partial<Record<HeaderColumnKey, number | null>> = {};
  const usedIndexes = new Set<number>();

  COLUMN_DISPLAY.forEach((column) => {
    const match = (suggestions[column.key] ?? []).find((opt) => !usedIndexes.has(opt.index));
    if (!match) return;
    selection[column.key] = match.index;
    usedIndexes.add(match.index);
  });

  return selection;
};

const analyzeSheet = (sheetName: string, rows: unknown[][], fallbackIndex: number, enabled: boolean): SheetMapping => {
  const headerRowIndex = detectHeaderRowIndex(rows);
  const headerRow = Array.isArray(rows[headerRowIndex]) ? rows[headerRowIndex] : [];
  const columns = buildColumns(headerRow);
  const suggestions = buildSuggestions(columns);
  
  // Auto-select suggested columns, but do not map the same source column twice.
  const selection = autoSelectUniqueSuggestions(suggestions);
  
  const nonEmptyDataRows = rows
    .slice(headerRowIndex + 1)
    .filter((row) => Array.isArray(row) && row.some(hasCellValue));
  const rowCount = nonEmptyDataRows.length;
  const previewRows = nonEmptyDataRows
    .slice(0, 3)
    .map((row) => {
      const preview: Record<number, string> = {};
      row.forEach((cell, colIdx) => {
        preview[colIdx] = stringifyCellValue(cell);
      });
      return preview;
    });

  return {
    name: sheetName || `Sheet ${fallbackIndex + 1}`,
    headerRowIndex,
    columns,
    suggestions,
    selection,
    rowCount,
    enabled,
    previewRows,
  };
};

const analyzeWorkbook = (workbook: XLSXTypes.WorkBook, xlsx: XlsxModule): SheetMapping[] => {
  const sheets: SheetMapping[] = [];
  for (const sheetName of workbook.SheetNames ?? []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
    if (!Array.isArray(rows)) continue;
    sheets.push(analyzeSheet(sheetName, rows, sheets.length, sheets.length === 0));
  }
  return sheets;
};

const evaluateSelection = (sheets: SheetMapping[], activeSheetIndex: number) => {
  const active = sheets[activeSheetIndex];
  if (!active) {
    return {
      status: "invalid" as const,
      message: "Please upload a workbook to choose columns.",
      columns: {},
      rowCount: 0,
      sheetName: null,
    };
  }

  const enabledSheets = sheets.filter((sheet) => sheet.enabled);
  const validSheets = enabledSheets.filter((sheet) => {
    const selection = sheet.selection;
    return selection.partNumber != null && selection.description != null && selection.listPrice != null;
  });

  const selection = active.selection;
  const columns: Partial<Record<HeaderColumnKey, boolean>> = {
    partNumber: selection.partNumber != null,
    modelNumber: selection.modelNumber != null,
    description: selection.description != null,
    listPrice: selection.listPrice != null,
    costPrice: selection.costPrice != null,
    warning: selection.warning != null,
    weblink: selection.weblink != null,
  };

  const status: FileValidation["status"] = validSheets.length > 0 ? "valid" : "invalid";
  const message =
    validSheets.length === 0
      ? "Select columns for at least one enabled sheet (Part Number, Name/Description, List Price)."
      : `Using ${validSheets.length} sheet${validSheets.length === 1 ? "" : "s"} with selected columns.`;

  const rowCount = validSheets.reduce((acc, sheet) => acc + sheet.rowCount, 0);

  return { status, message, columns, rowCount, sheetName: active.name };
};

const validateFileStructure = async (uploadFile: File): Promise<FileValidation> => {
  try {
    const buffer = await uploadFile.arrayBuffer();
    const xlsx = await loadXlsx();
    const workbook = xlsx.read(buffer, { type: "array" });
    const sheets = analyzeWorkbook(workbook, xlsx);

    if (sheets.length === 0) {
      return {
        ...INITIAL_VALIDATION,
        status: "invalid",
        message: "Could not read any sheets. Please check your file and try again.",
      };
    }

    let activeIndex = 0;
    if (sheets.length > 1) {
      let biggestRowCount = -1;
      sheets.forEach((sheet, idx) => {
        if (sheet.rowCount > biggestRowCount) {
          biggestRowCount = sheet.rowCount;
          activeIndex = idx;
        }
      });
      sheets.forEach((sheet, idx) => {
        sheet.enabled = idx === activeIndex;
      });
    }

    const evaluation = evaluateSelection(sheets, activeIndex);

    return {
      status: evaluation.status,
      message: evaluation.message,
      columns: evaluation.columns,
      rowCount: evaluation.rowCount,
      sheetName: evaluation.sheetName,
      sheets,
      activeSheetIndex: activeIndex,
    };
  } catch (err) {
    console.error("Failed to validate uploaded file", err);
    return {
      ...INITIAL_VALIDATION,
      status: "invalid",
      message: "Unable to read the file. Please upload a valid .xlsx, .xlsm, .xls, or .csv.",
    };
  }
};

export default function PriceListImportClient({
  brands,
  suppliers,
  currencies,
  countries,
  cities,
  pricingPolicies,
  pricingPolicyRules,
  users,
  previousPriceLists,
}: Props) {
  const router = useRouter();
  const { userId: currentUserId } = useAuditUser();
  const euroCurrencyId = useMemo(() => {
    const match =
      currencies.find((c) => (c.label ?? "").trim() === "€") ??
      currencies.find((c) => (c.label ?? "").toLowerCase().includes("eur")) ??
      null;
    return match?.value ?? "";
  }, [currencies]);
  const euroCurrencyLabel = "€";

  const [values, setValues] = useState<FormValues>(() => ({
    name: "",
    brandId: "",
    pricingPolicies: [],
    responsibleUserId: "",
    supplierId: "",
    hasDuty: false,
    costCurrencyId: euroCurrencyId,
    currencyCostModifier: "1",
    countryId: "",
    validFromDate: "",
    validToDate: "",
    comments: "",
    supplierComments: "",
    previousPriceListId: "",
    decimalFormat: "dotDecimal",
  }));
  const [isRulePickerOpen, setIsRulePickerOpen] = useState(false);
  const [policyPickerSelection, setPolicyPickerSelection] = useState<Set<number>>(new Set());
  const [rulePickerError, setRulePickerError] = useState<string | null>(null);
  const [discountDrafts, setDiscountDrafts] = useState<Record<number, { telmaco: string; customer: string }>>({});
  const policyPickerSelectionInitializedRef = useRef(false);
  const [policyDiscountOverrides, setPolicyDiscountOverrides] = useState<
    Record<string, { telmaco: number | null; customer: number | null }>
  >({});
  const [file, setFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const validationRunId = useRef(0);
  const [showSheetSelector, setShowSheetSelector] = useState(false);
  const [multiSelectEnabled, setMultiSelectEnabled] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [brandText, setBrandText] = useState("");
  const [brandError, setBrandError] = useState<string | null>(null);
  const [showBrandList, setShowBrandList] = useState(false);
  const [localBrands, setLocalBrands] = useState<DropdownOption[]>(brands);
  const [localSuppliers, setLocalSuppliers] = useState<DropdownOption[]>(suppliers);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [brandsError, setBrandsError] = useState<string | null>(null);
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);
  const [isAddSupplierOpen, setIsAddSupplierOpen] = useState(false);
  const [localPricingPolicies, setLocalPricingPolicies] = useState(pricingPolicies);
  const [localPricingPolicyRules, setLocalPricingPolicyRules] = useState(pricingPolicyRules);
  const [isAddPricingPolicyRuleOpen, setIsAddPricingPolicyRuleOpen] = useState(false);
  const [newRuleName, setNewRuleName] = useState("");
  const [newRulePricingPolicyId, setNewRulePricingPolicyId] = useState("");
  const [newRuleBrandId, setNewRuleBrandId] = useState("");
  const [newRuleTelmaco, setNewRuleTelmaco] = useState("");
  const [newRuleCustomer, setNewRuleCustomer] = useState("");
  const [newRuleResponsibleUserId, setNewRuleResponsibleUserId] = useState("");
  const [newRuleComments, setNewRuleComments] = useState("");
  const [pricingPolicyRuleSaving, setPricingPolicyRuleSaving] = useState(false);
  const [pricingPolicyRuleError, setPricingPolicyRuleError] = useState<string | null>(null);

  useEffect(() => {
    setLocalPricingPolicies(pricingPolicies);
  }, [pricingPolicies]);

  useEffect(() => {
    setLocalPricingPolicyRules(pricingPolicyRules);
  }, [pricingPolicyRules]);

  useEffect(() => {
    setLocalBrands(brands);
  }, [brands]);

  useEffect(() => {
    setLocalSuppliers(suppliers);
  }, [suppliers]);

  // Automatically select current user as responsible user
  useEffect(() => {
    if (currentUserId && !values.responsibleUserId) {
      setValues((prev) => ({ ...prev, responsibleUserId: currentUserId }));
    }
  }, [currentUserId, values.responsibleUserId]);

  // Convert dropdown options to the format expected by AddSupplierModal
  const citiesForModal = useMemo(() =>
    cities.map((city) => ({
      id: Number(city.value),
      name: city.label,
    })),
    [cities]
  );

  const countriesForModal = useMemo(() =>
    countries.map((country) => ({
      id: Number(country.value),
      name: country.label,
    })),
    [countries]
  );

  const isCostCurrencyEuro = !values.costCurrencyId || values.costCurrencyId === euroCurrencyId;

  // Default cost currency to EUR when available.
  useEffect(() => {
    if (!euroCurrencyId) return;
    if (values.costCurrencyId) return;
    setValues((prev) => ({ ...prev, costCurrencyId: euroCurrencyId }));
  }, [euroCurrencyId, values.costCurrencyId]);

  // When cost currency is EUR (default), keep modifier at 1.
  useEffect(() => {
    if (!isCostCurrencyEuro) return;
    if (values.currencyCostModifier === "1") return;
    setValues((prev) => ({ ...prev, currencyCostModifier: "1" }));
  }, [isCostCurrencyEuro, values.currencyCostModifier]);

  const parseDecimalInput = (value: string): number | null => {
    return parseLocaleNumber(value);
  };


  const handleCreatePricingPolicyRule = useCallback(async () => {
    const trimmedName = newRuleName.trim();
    if (!trimmedName) {
      setPricingPolicyRuleError("Rule name is required");
      return;
    }
    const pricingPolicyId = Number(newRulePricingPolicyId);
    if (!pricingPolicyId) {
      setPricingPolicyRuleError("Pricing policy is required");
      return;
    }
    const brandId = newRuleBrandId.trim() ? Number(newRuleBrandId) : null;
    if (newRuleBrandId.trim() && !brandId) {
      setPricingPolicyRuleError("Brand is invalid");
      return;
    }
    const telmacoValue = parseDecimalInput(newRuleTelmaco);
    if (telmacoValue == null) {
      setPricingPolicyRuleError("Telmaco discount is required");
      return;
    }
    const customerValue = parseDecimalInput(newRuleCustomer);
    if (customerValue == null) {
      setPricingPolicyRuleError("Customer discount is required");
      return;
    }
    setPricingPolicyRuleSaving(true);
    setPricingPolicyRuleError(null);
    try {
      const response = await fetch("/api/pricing-policy-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          pricingPolicyId,
          brandId,
          telmacoDiscountPercentage: telmacoValue,
          customerDiscountPercentage: customerValue,
          responsibleUserId: newRuleResponsibleUserId || null,
          comments: newRuleComments.trim() || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; option?: PricingPolicyRuleOption; error?: string }
        | null;
      const option = payload?.option;
      if (!response.ok || !payload?.ok || !option) {
        throw new Error(payload?.error ?? "Unable to add pricing policy rule");
      }
      setLocalPricingPolicyRules((prev) => [...prev, option]);
      showToastMessage("Pricing policy rule added", "success");
      setIsAddPricingPolicyRuleOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to add pricing policy rule";
      setPricingPolicyRuleError(message);
      showToastMessage(message, "error");
    } finally {
      setPricingPolicyRuleSaving(false);
    }
  }, [
    newRuleName,
    newRulePricingPolicyId,
    newRuleBrandId,
    newRuleTelmaco,
    newRuleCustomer,
    newRuleResponsibleUserId,
    newRuleComments,
  ]);

  const selectedBrandId = useMemo(() => {
    const rawBrand = values.brandId.trim();
    if (!rawBrand) return null;
    const parsed = Number(rawBrand);
    return Number.isFinite(parsed) ? parsed : null;
  }, [values.brandId]);

  const hasBrandSelection = useMemo(() => selectedBrandId != null, [selectedBrandId]);

  const pricingPolicyNameById = useMemo(() => {
    const map = new Map<number, string>();
    localPricingPolicies.forEach((policy) => {
      const id = Number(policy.value);
      if (Number.isFinite(id)) {
        map.set(id, policy.label);
      }
    });
    return map;
  }, [localPricingPolicies]);

  const rulesByPolicyId = useMemo(() => {
    const map = new Map<number, PricingPolicyRuleOption[]>();
    localPricingPolicyRules.forEach((rule) => {
      const id = Number(rule.pricingPolicyId);
      if (!Number.isFinite(id)) return;
      const list = map.get(id) ?? [];
      list.push(rule);
      map.set(id, list);
    });
    return map;
  }, [localPricingPolicyRules]);

  const policiesForPicker = useMemo(() => {
    const brandId = selectedBrandId;
    const rows: PricingPolicyPickerRow[] = [];
    localPricingPolicies.forEach((policy) => {
      const policyId = Number(policy.value);
      if (!Number.isFinite(policyId)) return;

      const policyName = policy.label?.trim() || `Policy ${policyId}`;
      const allRules = rulesByPolicyId.get(policyId) ?? [];
      const brandRules = brandId != null
        ? allRules.filter((rule) => rule.brandId === brandId)
        : [];
      const defaultRules = allRules.filter((rule) => rule.brandId == null);
      const applicableRules = brandRules.length > 0 ? brandRules : defaultRules;

      const telmacoValues = applicableRules
        .map((rule) => rule.telmacoDiscountPercentage)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const customerValues = applicableRules
        .map((rule) => rule.customerDiscountPercentage)
        .filter((value): value is number => value != null && Number.isFinite(value));

      const key = `${brandId ?? "none"}:${policyId}`;
      const override = policyDiscountOverrides[key];
      rows.push({
        pricingPolicyId: policyId,
        pricingPolicyName: policyName,
        telmacoDiscountPercentage:
          override?.telmaco ?? (telmacoValues.length > 0 ? Math.min(...telmacoValues) : null),
        customerDiscountPercentage:
          override?.customer ?? (customerValues.length > 0 ? Math.min(...customerValues) : null),
      });
    });

    rows.sort((a, b) => a.pricingPolicyName.localeCompare(b.pricingPolicyName));
    return rows;
  }, [localPricingPolicies, policyDiscountOverrides, rulesByPolicyId, selectedBrandId]);

  const selectedPolicyIds = useMemo(() => {
    return new Set(
      values.pricingPolicies
        .map((entry) => entry.pricingPolicyId)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id)),
    );
  }, [values.pricingPolicies]);

  const selectedPolicySummary = useMemo(() => {
    const entries = values.pricingPolicies
      .map((entry) => {
        const name = pricingPolicyNameById.get(entry.pricingPolicyId);
        return name ? { id: entry.pricingPolicyId, name } : null;
      })
      .filter((entry): entry is { id: number; name: string } => Boolean(entry));

    const seen = new Set<number>();
    return entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [pricingPolicyNameById, values.pricingPolicies]);

  useEffect(() => {
    if (!isRulePickerOpen) {
      policyPickerSelectionInitializedRef.current = false;
      return;
    }
    setRulePickerError(null);
    const visiblePolicyIds = new Set(policiesForPicker.map((row) => row.pricingPolicyId));
    setPolicyPickerSelection((prev) => {
      if (!policyPickerSelectionInitializedRef.current) {
        policyPickerSelectionInitializedRef.current = true;
        return new Set(Array.from(selectedPolicyIds).filter((id) => visiblePolicyIds.has(id)));
      }
      return new Set(Array.from(prev).filter((id) => visiblePolicyIds.has(id)));
    });
  }, [isRulePickerOpen, policiesForPicker, selectedPolicyIds]);

  useEffect(() => {
    if (!isRulePickerOpen) return;
    const next: Record<number, { telmaco: string; customer: string }> = {};
    policiesForPicker.forEach((row) => {
      next[row.pricingPolicyId] = {
        telmaco: formatDiscountValue(row.telmacoDiscountPercentage ?? null),
        customer: formatDiscountValue(row.customerDiscountPercentage ?? null),
      };
    });
    setDiscountDrafts(next);
  }, [isRulePickerOpen, policiesForPicker]);

  const filteredPreviousPriceLists = useMemo(() => {
    const rawBrand = values.brandId.trim();
    const brandId = rawBrand ? Number(rawBrand) : null;
    if (brandId == null || !Number.isFinite(brandId)) return previousPriceLists;
    return previousPriceLists.filter(
      (pl) => pl.brandId == null || pl.brandId === brandId,
    );
  }, [previousPriceLists, values.brandId]);

  const filteredBrandOptions = useMemo(() => {
    const search = brandText.trim().toLowerCase();
    if (!search) return localBrands;
    return localBrands.filter((option) => {
      const label = option.label?.toLowerCase() ?? "";
      const value = option.value?.toLowerCase() ?? "";
      return label.includes(search) || value.includes(search);
    });
  }, [brandText, localBrands]);

  const refreshBrands = useCallback(async () => {
    if (brandsLoading) return;
    setBrandsLoading(true);
    setBrandsError(null);
    try {
      const response = await fetch("/api/products/lookups");
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; brands?: Array<{ id: number; name: string }> | null; error?: string }
        | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.brands)) {
        throw new Error(payload?.error ?? "Unable to load brands");
      }
      setLocalBrands(
        payload.brands.map((brand) => ({
          value: String(brand.id),
          label: brand.name?.trim() || `Brand ${brand.id}`,
        })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load brands";
      setBrandsError(message);
      showToastMessage("Unable to refresh brands. Please try again.", "error");
    } finally {
      setBrandsLoading(false);
    }
  }, [brandsLoading]);

  const updateField = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleBrandCreated = useCallback(
    (brand: { id: number; name: string }) => {
      const option = { value: String(brand.id), label: brand.name };
      setLocalBrands((prev) => {
        if (prev.some((existing) => existing.value === option.value)) return prev;
        return [...prev, option];
      });
      updateField("brandId", option.value);
      setBrandText(option.label);
      setBrandError(null);
      setBrandsError(null);
    },
    [updateField],
  );

  const handleSupplierCreated = useCallback(
    (supplier: { id: number; name: string }) => {
      const option = { value: String(supplier.id), label: supplier.name };
      setLocalSuppliers((prev) => {
        if (prev.some((existing) => existing.value === option.value)) return prev;
        return [...prev, option];
      });
      updateField("supplierId", option.value);
    },
    [updateField],
  );

  const togglePolicySelection = useCallback((policyId: number) => {
    setPolicyPickerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(policyId)) {
        next.delete(policyId);
      } else {
        next.add(policyId);
      }
      return next;
    });
  }, []);

  const applyRuleSelection = useCallback(() => {
    const nextPolicies = Array.from(policyPickerSelection)
      .filter((policyId) => Number.isFinite(policyId))
      .map((policyId) => ({ pricingPolicyId: policyId, pricingPolicyRuleId: null }));

    if (nextPolicies.length === 0) {
      setRulePickerError("Please select at least one pricing policy.");
      return;
    }

    setValues((prev) => ({ ...prev, pricingPolicies: nextPolicies }));
    setIsRulePickerOpen(false);
  }, [policyPickerSelection]);

  const handlePolicyDiscountChange = useCallback(
    (policyId: number, field: "telmaco" | "customer", value: string) => {
      setDiscountDrafts((prev) => ({
        ...prev,
        [policyId]: {
          telmaco: prev[policyId]?.telmaco ?? "",
          customer: prev[policyId]?.customer ?? "",
          [field]: value,
        },
      }));
    },
    [],
  );

  const handlePolicyDiscountSave = useCallback(
    async (row: PricingPolicyPickerRow, field: "telmaco" | "customer") => {
      const brandId = selectedBrandId;
      if (brandId == null) {
        showToastMessage("Please select a brand first.", "error");
        return;
      }

      const policyId = row.pricingPolicyId;
      if (!Number.isFinite(policyId)) return;

      const draft = discountDrafts[policyId]?.[field] ?? "";
      const parsed = parseLocaleNumber(draft);
      if (parsed == null) {
        showToastMessage("Discount is required", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [policyId]: {
            telmaco: formatDiscountValue(row.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(row.customerDiscountPercentage ?? null),
          },
        }));
        return;
      }

      const currentValue =
        field === "telmaco"
          ? row.telmacoDiscountPercentage ?? null
          : row.customerDiscountPercentage ?? null;
      if (currentValue != null && parsed === currentValue) {
        return;
      }

      try {
        const response = await fetch("/api/pricing-policies/matrix", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId,
            pricingPolicyId: policyId,
            field,
            value: parsed,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to update discounts");
        }
        const overrideKey = `${brandId}:${policyId}`;
        setPolicyDiscountOverrides((prev) => {
          const current = prev[overrideKey] ?? {
            telmaco: row.telmacoDiscountPercentage ?? null,
            customer: row.customerDiscountPercentage ?? null,
          };
          return {
            ...prev,
            [overrideKey]: {
              ...current,
              [field]: parsed,
            },
          };
        });
        setDiscountDrafts((prev) => ({
          ...prev,
          [policyId]: {
            telmaco:
              field === "telmaco" ? formatDiscountValue(parsed) : prev[policyId]?.telmaco ?? "",
            customer:
              field === "customer" ? formatDiscountValue(parsed) : prev[policyId]?.customer ?? "",
          },
        }));
        showToastMessage("Discount updated", "success");
      } catch (err) {
        console.error("Failed to update discount", err);
        showToastMessage("Unable to update discount. Please try again.", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [policyId]: {
            telmaco: formatDiscountValue(row.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(row.customerDiscountPercentage ?? null),
          },
        }));
      }
    },
    [discountDrafts, selectedBrandId],
  );

  const findBrandOption = useCallback(
    (text: string) => {
      const normalized = text.trim().toLowerCase();
      if (!normalized) return null;
      return (
        localBrands.find((option) => {
          const label = option.label?.trim().toLowerCase();
          const value = option.value?.trim().toLowerCase();
          return label === normalized || value === normalized;
        }) ?? null
      );
    },
    [localBrands],
  );

  const setBrandSelection = useCallback(
    (option: DropdownOption | null, rawText: string) => {
      setBrandText(rawText);
      setShowBrandList(false);
      updateField("brandId", option?.value ?? "");
      setBrandError(option ? null : brandError);
    },
    [brandError, updateField],
  );

  const handleBrandInputChange = useCallback(
    (text: string) => {
      const match = findBrandOption(text);
      setBrandSelection(match, text);
      if (!match) {
        setBrandError(null);
        updateField("brandId", "");
      }
      setShowBrandList(true);
    },
    [findBrandOption, setBrandSelection, updateField],
  );

  const handleBrandBlur = useCallback(() => {
    const match = findBrandOption(brandText);
    setBrandSelection(match, match?.label ?? brandText);
    if (!match && brandText.trim()) {
      setBrandError("Please choose a valid brand");
    } else {
      setBrandError(null);
    }
    setShowBrandList(false);
  }, [brandText, findBrandOption, setBrandSelection]);

  const activeSheet = useMemo(
    () => fileValidation.sheets[fileValidation.activeSheetIndex] ?? null,
    [fileValidation.activeSheetIndex, fileValidation.sheets],
  );

  const invalidDateRange = useMemo(() => {
    const from = normalizeDate(values.validFromDate);
    const to = normalizeDate(values.validToDate);
    return Boolean(from && to && from > to);
  }, [values.validFromDate, values.validToDate]);

  const previewColumns = useMemo<PreviewColumn[]>(() => {
    if (!activeSheet) return [];
    return PREVIEW_COLUMN_KEYS.map((key) => {
      const columnIndex = activeSheet.selection[key];
      if (columnIndex == null) return null;
      const column = activeSheet.columns.find((col) => col.index === columnIndex);
      return {
        key,
        label: column?.label ?? `Column ${columnIndex + 1}`,
        columnIndex,
        isListPrice: key === "listPrice",
      };
    }).filter((col): col is PreviewColumn => Boolean(col));
  }, [activeSheet]);

  const handleSheetChange = useCallback((nextIndex: number) => {
    setFileValidation((prev) => {
      const boundedIndex = Math.max(0, Math.min(nextIndex, prev.sheets.length - 1));
      const evaluation = evaluateSelection(prev.sheets, boundedIndex);
      return { ...prev, ...evaluation, activeSheetIndex: boundedIndex };
    });
  }, []);

  const updateColumnSelection = useCallback((key: HeaderColumnKey, columnIndex: number | null) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) =>
        idx === prev.activeSheetIndex
          ? { ...sheet, selection: { ...sheet.selection, [key]: columnIndex } }
          : sheet,
      );
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const toggleSheetEnabled = useCallback((index: number, enabled: boolean) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) =>
        idx === index ? { ...sheet, enabled } : sheet,
      );
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const handleFileSelection = useCallback((nextFile: File | null) => {
    validationRunId.current += 1;
    const runId = validationRunId.current;
    setFile(nextFile);

    if (!nextFile) {
      setFileValidation(INITIAL_VALIDATION);
      return;
    }

    setFileValidation({
      status: "checking",
      message: "Checking file format…",
      columns: {},
      rowCount: 0,
      sheetName: null,
      sheets: [],
      activeSheetIndex: 0,
    });

    void validateFileStructure(nextFile)
      .then((result) => {
        if (runId !== validationRunId.current) return;
        setFileValidation(result);
        if (result.sheets.length > 1) {
          setShowSheetSelector(true);
        }
      })
      .catch(() => {
        if (runId !== validationRunId.current) return;
        setFileValidation({
          ...INITIAL_VALIDATION,
          status: "invalid",
          message: "Unable to read the file. Please try a different upload.",
        });
      });
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextFile = event.target.files?.[0] ?? null;
      if (event.target) {
        event.target.value = "";
      }
      handleFileSelection(nextFile);
    },
    [handleFileSelection],
  );

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const droppedFile = event.dataTransfer?.files?.[0] ?? null;
      handleFileSelection(droppedFile);
    },
    [handleFileSelection],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setShowValidationErrors(true);

    if (!euroCurrencyId) {
      setError('EUR currency is not configured. Please add "€" (EUR) in Currencies and try again.');
      return;
    }

    const missing: string[] = [];
    REQUIRED_FIELDS.forEach((field) => {
      const value = values[field];
      if (typeof value === "string" && !value.trim()) {
        missing.push(field);
      }
    });

    if (!file) {
      missing.push("file");
    }

    if (fileValidation.status === "checking") {
      setError("Please wait for the file check to finish.");
      return;
    }

    if (fileValidation.status === "invalid") {
      setError(
        fileValidation.message ??
          "Please attach a file with Part Number, Name/Description, and List Price columns (Model Number optional).",
      );
      return;
    }

    const activeSheet = fileValidation.sheets[fileValidation.activeSheetIndex];
    const selectedSheets = fileValidation.sheets.filter(
      (sheet) =>
        sheet.enabled &&
        sheet.selection.partNumber != null &&
        sheet.selection.description != null &&
        sheet.selection.listPrice != null,
    );
    if (!activeSheet || selectedSheets.length === 0) {
      setError("Please upload a file and select the correct columns on at least one enabled sheet.");
      return;
    }

    const from = normalizeDate(values.validFromDate);
    const to = normalizeDate(values.validToDate);
    if (from && to && from > to) {
      setError("Valid From date cannot be after Valid To date.");
      return;
    }

    if (values.pricingPolicies.length === 0) {
      setError("Please add at least one pricing policy.");
      return;
    }

    if (missing.length > 0) {
      setError("Please complete all required fields and attach the file.");
      return;
    }

    setSubmitting(true);
    try {
      const currentFile = file;
      if (!currentFile) {
        throw new Error("Please attach an Excel file.");
      }

      // On Windows, a file can become unreadable while it's open in another program (e.g. Excel),
      // causing the browser upload stream to fail with a generic "Failed to fetch".
      // Do a tiny read upfront so we can show a meaningful message.
      try {
        await currentFile.slice(0, 64 * 1024).arrayBuffer();
      } catch {
        throw new Error(
          "Unable to read the selected file. It may be open in another program (e.g. Excel). Please close it and try again.",
        );
      }

      if (values.pricingPolicies.length === 0) {
        throw new Error("At least one pricing policy is required.");
      }

      const formData = new FormData();
      formData.append("name", values.name);
      formData.append("brandId", values.brandId);
      formData.append("pricingPolicies", JSON.stringify(values.pricingPolicies));
      formData.append("responsibleUserId", values.responsibleUserId);
      formData.append("supplierId", values.supplierId);
      formData.append("hasDuty", values.hasDuty ? "1" : "0");
      // Currency is always EUR.
      formData.append("currencyId", euroCurrencyId);
      formData.append("costCurrencyId", values.costCurrencyId || euroCurrencyId);
      formData.append("currencyCostModifier", isCostCurrencyEuro ? "1" : (values.currencyCostModifier || "1"));
      if (values.countryId) formData.append("countryId", values.countryId);
      // Values are already in ISO format (YYYY-MM-DD) from type="date" inputs
      formData.append("validFromDate", values.validFromDate);
      formData.append("validToDate", values.validToDate);
      formData.append("comments", values.comments);
      formData.append("supplierComments", values.supplierComments);
      formData.append("decimalFormat", values.decimalFormat);
      if (values.previousPriceListId) {
        formData.append("previousPriceListId", values.previousPriceListId);
      }
      if (values.hasDuty !== null) {
        formData.append("hasDuty", values.hasDuty ? "1" : "0");
      }
      formData.append("file", currentFile, currentFile.name);
      const columnMappings = selectedSheets.map((sheet) => ({
        sheetName: sheet.name,
        headerRowIndex: sheet.headerRowIndex,
        columns: {
          partNumber: sheet.selection.partNumber ?? null,
          modelNumber: sheet.selection.modelNumber ?? null,
          description: sheet.selection.description ?? null,
          listPrice: sheet.selection.listPrice ?? null,
          costPrice: sheet.selection.costPrice ?? null,
          warning: sheet.selection.warning ?? null,
          weblink: sheet.selection.weblink ?? null,
        },
      }));
      formData.append("columnMappings", JSON.stringify(columnMappings));

      const response = await fetch("/api/price-lists/import", {
        method: "POST",
        body: formData,
      });
      type ImportResponse = {
        ok?: boolean;
        error?: string;
        priceListId?: string | number;
        createdProductCount?: number;
        matchedProductCount?: number;
        skippedRows?: number;
        totalRows?: number;
      };
      const raw = await response.text().catch(() => "");
      const typedPayload: ImportResponse | null = (() => {
        try {
          return JSON.parse(raw) as ImportResponse;
        } catch {
          return null;
        }
      })();

      if (!response.ok || !typedPayload?.ok) {
        const serverError =
          typedPayload?.error ||
          (raw && raw.trim() ? raw.trim() : null) ||
          "Unable to import price list. Please try again.";
        throw new Error(serverError);
      }

      const summary = [
        `Imported ${typedPayload.totalRows ?? 0} rows`,
        `${typedPayload.createdProductCount ?? 0} new products`,
        `${typedPayload.matchedProductCount ?? 0} matched`,
        `${typedPayload.skippedRows ?? 0} skipped`,
      ].join(" • ");
      showToastMessage(summary);

      const targetId =
        typedPayload.priceListId != null ? encodeURIComponent(String(typedPayload.priceListId)) : null;
      if (targetId) {
        router.push(`/price-lists/${targetId}/products`);
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "";
      const normalized = rawMessage.trim().toLowerCase();
      const message =
        normalized === "failed to fetch" || normalized.includes("networkerror")
          ? "Upload failed. If the file is open in another program (e.g. Excel), close it and try again."
          : rawMessage || "Unable to import price list. Please try again.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [euroCurrencyId, file, fileValidation, isCostCurrencyEuro, router, values]);

  const renderOption = (option: DropdownOption) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  );

  const costCurrencyOptions = useMemo(() => {
    if (!euroCurrencyId) return currencies;
    const rest = currencies.filter((c) => c.value !== euroCurrencyId);
    return [{ value: euroCurrencyId, label: euroCurrencyLabel }, ...rest];
  }, [currencies, euroCurrencyId]);

  return (
    <>
      <main className={`${layoutStyles.page} ${styles.importPage}`}>
      <div className={`${layoutStyles.headerRow} ${layoutStyles.headerRowCentered}`}>
        <Link href="/price-lists" className={`${layoutStyles.backLink} ${layoutStyles.backLinkAbsolute} page-header-button`}>
          ← Back to price lists
        </Link>
        <h1 className={layoutStyles.heading}>Import Price List</h1>
      </div>

      <section className={styles.card}>
        <form
          className={styles.form}
          onSubmit={handleSubmit}
          autoComplete="off"
          noValidate
          data-show-validation={showValidationErrors ? "true" : "false"}
        >
          <div className={styles.formGrid}>
            <div className={styles.fieldStack}>
              <div className={styles.sectionHeading}>Price List Details</div>
              <div className={styles.fieldRow}>
                <label className={`${styles.field} ${styles.fieldNudgeDown}`}>
                  <span className={styles.label}>
                    Name <span className={styles.requiredMark}>*</span>
                  </span>
                  <input
                    autoComplete="off"
                    className={styles.input}
                    value={values.name}
                    required
                    onChange={(e) => updateField("name", e.target.value)}
                  />
                </label>
                <div className={`${styles.field} ${styles.comboWrapper}`}>
                  <span className={styles.lookupLabelRow}>
                    <span className={styles.labelText}>
                      <span className={styles.label}>
                        Brand <span className={styles.requiredMark}>*</span>
                      </span>
                    </span>
                    <button
                      type="button"
                      className={lookupButtonStyles.lookupAddButton}
                      onClick={() => setIsAddBrandOpen(true)}
                    >
                      Add New Brand
                    </button>
                  </span>
                  <input
                    autoComplete="off"
                    className={`${styles.input} ${styles.comboInput}`}
                    value={brandText}
                    aria-invalid={showValidationErrors && !values.brandId.trim()}
                    placeholder="Type to filter brands"
                    onChange={(e) => handleBrandInputChange(e.target.value)}
                    onFocus={(e) => {
                      e.target.select();
                      void refreshBrands();
                      setShowBrandList(true);
                    }}
                    onBlur={handleBrandBlur}
                    disabled={submitting}
                  />
                  {showBrandList && filteredBrandOptions.length > 0 ? (
                    <div className={styles.comboList}>
                      {filteredBrandOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={styles.comboOption}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setBrandSelection(option, option.label);
                            setBrandError(null);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {brandError ? <div className={styles.fieldError}>{brandError}</div> : null}
                  {brandsError ? <div className={styles.fieldError}>{brandsError}</div> : null}
                </div>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                  <div className={styles.lookupLabelRow}>
                    <div className={styles.labelText}>
                      <label className={styles.label}>
                        Pricing Policies <span className={styles.requiredMark}>*</span>
                      </label>
                    </div>
                  </div>
                  {selectedPolicySummary.length > 0 ? (
                    <div className={styles.ruleSummaryList}>
                      {selectedPolicySummary.map((policy) => (
                        <span key={policy.id} className={styles.ruleSummaryItem}>
                          {policy.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.chipListEmpty} style={{ marginBottom: "8px" }}>
                      No pricing policies selected.
                    </div>
                  )}
                  <span
                    className={styles.tooltipWrapper}
                    data-tooltip={
                      !hasBrandSelection
                        ? "Select a brand first."
                        : policiesForPicker.length === 0
                          ? "No pricing policies are available."
                          : ""
                    }
                  >
                    <button
                      type="button"
                      className={`${styles.buttonSecondary} ${styles.rulePickerButton}`}
                      onClick={() => {
                        if (!hasBrandSelection) {
                          showToastMessage("Please select a brand first.", "error");
                          return;
                        }
                        setIsRulePickerOpen(true);
                      }}
                      disabled={!hasBrandSelection || policiesForPicker.length === 0}
                    >
                      Select Pricing Policies
                    </button>
                  </span>
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label className={`${styles.field} ${styles.fieldNudgeDown}`}>
                  <span className={styles.label}>
                    Responsible User <span className={styles.requiredMark}>*</span>
                  </span>
                  <select
                    className={styles.input}
                    value={values.responsibleUserId}
                    required
                    onChange={(e) => updateField("responsibleUserId", e.target.value)}
                  >
                    <option value="">Select responsible user</option>
                    {users.map(renderOption)}
                  </select>
                </label>
                <div className={styles.field}>
                  <span className={styles.lookupLabelRow}>
                    <span className={styles.labelText}>
                      <span className={styles.label}>
                        Supplier
                      </span>
                    </span>
                    <button
                      type="button"
                      className={lookupButtonStyles.lookupAddButton}
                      onClick={() => setIsAddSupplierOpen(true)}
                    >
                      Add new Supplier
                    </button>
                  </span>
                  <select
                    className={styles.input}
                    value={values.supplierId}
                    onChange={(e) => updateField("supplierId", e.target.value)}
                  >
                    <option value="">Select supplier</option>
                    {localSuppliers.map(renderOption)}
                  </select>
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Country</span>
                  <select
                    className={styles.input}
                    value={values.countryId}
                    onChange={(e) => updateField("countryId", e.target.value)}
                  >
                    <option value="">No country</option>
                    {countries.map(renderOption)}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Cost Currency</span>
                  <select
                    className={styles.input}
                    value={values.costCurrencyId}
                    onChange={(e) => updateField("costCurrencyId", e.target.value)}
                  >
                    {costCurrencyOptions.map(renderOption)}
                  </select>
                  <span className={styles.helpText}>
                    The cost price column is in this currency. Cost price is converted to € using the modifier.
                  </span>
                </label>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.field} />
                {!isCostCurrencyEuro ? (
                  <label className={styles.field}>
                    <span className={styles.label}>Currency Cost Modifier</span>
                    <input
                      autoComplete="off"
                      className={styles.input}
                      inputMode="decimal"
                      placeholder="1"
                      value={values.currencyCostModifier}
                      onChange={(e) => updateField("currencyCostModifier", e.target.value)}
                    />
                    <span className={styles.helpText}>
                      EUR cost = Cost Price × Modifier
                    </span>
                  </label>
                ) : null}
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Valid From <span className={styles.requiredMark}>*</span>
                  </span>
                  <UKDatePicker
                    value={values.validFromDate}
                    onChange={(value) => updateField("validFromDate", value)}
                    placeholder="DD/MM/YYYY"
                    className={styles.input}
                    invalid={showValidationErrors && invalidDateRange}
                    required
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Valid To <span className={styles.requiredMark}>*</span>
                  </span>
                  <UKDatePicker
                    value={values.validToDate}
                    onChange={(value) => updateField("validToDate", value)}
                    placeholder="DD/MM/YYYY"
                    className={styles.input}
                    invalid={showValidationErrors && invalidDateRange}
                    required
                  />
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Comments</span>
                  <textarea
                    autoComplete="off"
                    className={`${styles.input} ${styles.textarea}`}
                    value={values.comments}
                    onChange={(e) => updateField("comments", e.target.value)}
                    rows={3}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Supplier Comments</span>
                  <textarea
                    autoComplete="off"
                    className={`${styles.input} ${styles.textarea}`}
                    value={values.supplierComments}
                    onChange={(e) => updateField("supplierComments", e.target.value)}
                    rows={3}
                  />
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Previous Version</span>
                  <select
                    className={styles.input}
                    value={values.previousPriceListId}
                    onChange={(e) => updateField("previousPriceListId", e.target.value)}
                  >
                    <option value="">No previous price list</option>
                    {filteredPreviousPriceLists.map(renderOption)}
                  </select>
                  <span className={styles.helpText}>
                    If selected, the previous price list will be disabled and replaced by this one.
                  </span>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Has Duty</span>
                  <select
                    className={styles.input}
                    value={values.hasDuty === null ? "" : values.hasDuty ? "1" : "0"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "") {
                        updateField("hasDuty", null);
                      } else {
                        updateField("hasDuty", val === "1");
                      }
                    }}
                  >
                    <option value="">Select</option>
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </label>
              </div>
            </div>

          <div className={styles.fieldStack}>
            <div className={styles.sectionHeading}>Upload</div>
            <div className={styles.field}>
              <span className={styles.label}>Price list decimal format</span>
              <select
                className={styles.input}
                value={values.decimalFormat}
                onChange={(event) =>
                  updateField("decimalFormat", event.target.value as PriceListDecimalFormat)
                }
              >
                {PRICE_LIST_DECIMAL_FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {`${option.label} - ${option.description}`}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.uploadCard}>
              <label
                className={`${styles.uploadArea} ${showValidationErrors && !file ? 'fastquote-invalid-outline' : ''} ${isDragging ? styles.uploadAreaDragging : ""}`}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleFileDrop}
              >
                <input
                  autoComplete="off"
                  type="file"
                  accept=".xlsx,.xlsm,.xls,.csv"
                  className={styles.fileInput}
                  onChange={handleFileChange}
                />
                <div className={styles.uploadText}>
                  <div className={styles.uploadTitle}>Drop your Excel file here</div>
                    <div className={styles.uploadSubtitle}>
                      Required columns: Part Number, Name/Description, and List Price. Model Number, Cost Price and Warning are optional.
                    </div>
                    {file ? (
                      <div className={styles.selectedFile}>
                        Selected: <strong>{file.name}</strong>
                      </div>
                    ) : (
                      <div className={styles.selectedFile}>Accepted: .xlsx, .xlsm, .xls, .csv</div>
                    )}
                    <div
                      className={`${styles.validationStatus} ${
                        fileValidation.status === "valid"
                          ? styles.validationValid
                          : fileValidation.status === "invalid"
                            ? styles.validationInvalid
                            : fileValidation.status === "checking"
                              ? styles.validationChecking
                              : styles.validationIdle
                      }`}
                    >
                      <div
                        className={`${styles.statusIcon} ${
                          fileValidation.status === "valid"
                            ? styles.statusIconValid
                            : fileValidation.status === "invalid"
                              ? styles.statusIconInvalid
                              : fileValidation.status === "checking"
                                ? styles.statusIconChecking
                                : styles.statusIconIdle
                        }`}
                        aria-hidden="true"
                      >
                        {fileValidation.status === "valid"
                          ? "✓"
                          : fileValidation.status === "invalid"
                            ? "!"
                            : fileValidation.status === "checking"
                              ? "…"
                              : "○"}
                      </div>
                      <div className={styles.validationContent}>
                        <div className={styles.validationTitle}>
                          {fileValidation.status === "valid"
                            ? "File looks good"
                            : fileValidation.status === "invalid"
                              ? "Check the columns"
                              : fileValidation.status === "checking"
                                ? "Checking file format"
                                : "Waiting for a file"}
                        </div>
                        <div className={styles.validationMessage}>
                          {fileValidation.message ??
                            "Choose columns for the fields below."}
                          {activeSheet ? (
                            <span className={styles.validationHint}>
                              {`Detected ${activeSheet.columns.length} column${activeSheet.columns.length === 1 ? "" : "s"} in ${
                                activeSheet.name
                              }. ${
                                activeSheet.rowCount > 0
                                  ? `${activeSheet.rowCount} data row${activeSheet.rowCount === 1 ? "" : "s"} after the header.`
                                  : "No data rows detected yet."
                              }`}
                            </span>
                          ) : null}
                        </div>
                        {fileValidation.sheets.length > 0 ? (
                          <div className={styles.sheetSelector}>
                            {fileValidation.sheets.length > 1 ? (
                              <div className={styles.sheetToggle}>
                                <span>Multi-select</span>
                                <button
                                  type="button"
                                  className={`${styles.toggleSwitch} ${multiSelectEnabled ? styles.toggleSwitchOn : ""}`}
                                  onClick={() => setMultiSelectEnabled((prev) => !prev)}
                                >
                                  <span className={styles.toggleKnob} />
                                </button>
                              </div>
                            ) : null}
                            <div className={styles.sheetTabs}>
                              {fileValidation.sheets.map((sheet, idx) => {
                                const isActive = idx === fileValidation.activeSheetIndex;
                                const included = sheet.enabled;
                                return (
                                  <button
                                    type="button"
                                    key={sheet.name || idx}
                                    className={`${styles.sheetTab} ${isActive ? styles.sheetTabActive : ""} ${included ? styles.sheetTabIncluded : ""}`}
                                    onClick={() => {
                                      if (!multiSelectEnabled && fileValidation.sheets.length > 1) {
                                        setFileValidation((prev) => {
                                          const sheets = prev.sheets.map((s, i) => ({ ...s, enabled: i === idx }));
                                          const evaluation = evaluateSelection(sheets, idx);
                                          return { ...prev, ...evaluation, sheets, activeSheetIndex: idx };
                                        });
                                      } else {
                                        handleSheetChange(idx);
                                      }
                                    }}
                                  >
                                    {multiSelectEnabled && fileValidation.sheets.length > 1 ? (
                                      <input
                                        type="checkbox"
                                        checked={included}
                                        className={styles.sheetTabCheckbox}
                                        onChange={(e) => {
                                          e.stopPropagation();
                                          toggleSheetEnabled(idx, e.target.checked);
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    ) : null}
                                    {sheet.name || `Sheet ${idx + 1}`}
                                    <span className={styles.sheetTabRows}>{sheet.rowCount} rows</span>
                                  </button>
                                );
                              })}
                            </div>
                            <div className={styles.helpText}>
                              <strong>{activeSheet?.name || "Sheet"}</strong> — Choose columns for the fields below.
                            </div>
                            <div className={styles.mappingGrid}>
                              {COLUMN_DISPLAY.map((column) => {
                                const selectionValue =
                                  activeSheet?.selection[column.key] != null
                                    ? String(activeSheet.selection[column.key])
                                    : "";
                                const suggestions = activeSheet?.suggestions[column.key] ?? [];
                                const suggestedIndexes = new Set(suggestions.map((opt) => opt.index));
                                const otherOptions =
                                  activeSheet?.columns.filter((col) => !suggestedIndexes.has(col.index)) ?? [];
                                return (
                                  <label key={column.key} className={styles.mappingField}>
                                    <span className={styles.mappingLabel}>
                                      {column.label} {column.required ? <span className={styles.requiredMark}>*</span> : null}
                                    </span>
                                    <select
                                      className={styles.input}
                                      required={Boolean(column.required)}
                                      value={selectionValue}
                                      onChange={(e) =>
                                        updateColumnSelection(
                                          column.key,
                                          e.target.value === "" ? null : Number(e.target.value),
                                        )
                                      }
                                      disabled={!activeSheet}
                                    >
                                      <option value="">Choose a column</option>
                                      {suggestions.length > 0 ? (
                                        <optgroup label="Suggested">
                                          {suggestions.map((opt) => (
                                            <option key={opt.index} value={opt.index}>
                                              {opt.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ) : null}
                                      {otherOptions.length > 0 ? (
                                        <optgroup label="All columns">
                                          {otherOptions.map((opt) => (
                                            <option key={opt.index} value={opt.index}>
                                              {opt.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ) : null}
                                    </select>
                                  </label>
                                );
                              })}
                            </div>
                            {activeSheet ? (
                              <div className={styles.previewSection}>
                                <div className={styles.previewHeading}>
                                  <span>
                                    Sample rows (first {activeSheet.previewRows.length > 0 ? activeSheet.previewRows.length : 3})
                                  </span>
                                  <span className={styles.previewHint}>
                                    Showing mapped columns; the list price column is bold.
                                  </span>
                                </div>
                                {previewColumns.length === 0 ? (
                                  <div className={styles.previewEmpty}>
                                    Select columns for Part Number, Name/Description, and List Price to see a preview.
                                  </div>
                                ) : activeSheet.previewRows.length === 0 ? (
                                  <div className={styles.previewEmpty}>
                                    No preview data available for this sheet yet.
                                  </div>
                                ) : (
                                  <div className={styles.previewTableWrapper}>
                                    <table className={styles.previewTable}>
                                      <thead>
                                        <tr>
                                          {previewColumns.map((column) => (
                                            <th key={column.key}>{column.label}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {activeSheet.previewRows.map((row, rowIndex) => (
                                          <tr key={rowIndex}>
                                            {previewColumns.map((column) => (
                                              <td
                                                key={`${rowIndex}-${column.key}`}
                                                className={column.isListPrice ? styles.previewListPrice : ""}
                                              >
                                                {row[column.columnIndex] ?? ""}
                                              </td>
                                            ))}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className={styles.validationColumns}>
                          {COLUMN_DISPLAY.map((column) => {
                            const found = Boolean(fileValidation.columns[column.key]);
                            const pillState = found
                              ? styles.columnPillGood
                              : column.required
                                ? styles.columnPillWarn
                                : styles.columnPillMuted;
                            return (
                              <div
                                key={column.key}
                                className={`${styles.columnPill} ${pillState}`}
                              >
                                <span className={styles.columnPillIcon}>
                                  {found ? "✓" : column.required ? "!" : "•"}
                                </span>
                                {column.label}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className={styles.actionsRow}>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.actionsSpacer} />
            <button type="submit" className={`${styles.submitButton} page-header-button`} disabled={submitting}>
              {submitting ? "Importing…" : "Create Price List"}
            </button>
          </div>
        </form>
      </section>
      <AddBrandModal
        open={isAddBrandOpen}
        onClose={() => setIsAddBrandOpen(false)}
        onCreated={handleBrandCreated}
      />
      <AddSupplierModal
        open={isAddSupplierOpen}
        onClose={() => setIsAddSupplierOpen(false)}
        onCreated={handleSupplierCreated}
        cities={citiesForModal}
        countries={countriesForModal}
      />
    </main>
      <LookupModal
        open={isRulePickerOpen}
        title="Select Pricing Policies"
        onClose={() => setIsRulePickerOpen(false)}
        onConfirm={applyRuleSelection}
        confirmLabel="Apply"
        error={rulePickerError}
        cardClassName={styles.rulePickerModal}
        bodyClassName={styles.rulePickerBody}
      >
        {policiesForPicker.length > 0 ? (
          <table className={styles.ruleTable}>
            <thead>
              <tr>
                <th className={styles.ruleCheckboxCell} />
                <th>Pricing Policy</th>
                <th>Telmaco Discount</th>
                <th>Customer Discount</th>
              </tr>
            </thead>
            <tbody>
              {policiesForPicker.map((row) => {
                const policyId = row.pricingPolicyId;
                const isSelected = policyPickerSelection.has(policyId);
                const draft = discountDrafts[policyId] ?? null;
                return (
                  <tr key={policyId} className={isSelected ? styles.ruleRowSelected : ""}>
                    <td className={styles.ruleCheckboxCell}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          togglePolicySelection(policyId);
                        }}
                      />
                    </td>
                    <td className={styles.rulePolicy}>{row.pricingPolicyName}</td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.telmaco ?? formatDiscountValue(row.telmacoDiscountPercentage ?? null)}
                        onChange={(event) => {
                          handlePolicyDiscountChange(policyId, "telmaco", event.target.value);
                        }}
                        onBlur={() => handlePolicyDiscountSave(row, "telmaco")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!hasBrandSelection}
                        aria-label={`Telmaco discount for ${row.pricingPolicyName}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.customer ?? formatDiscountValue(row.customerDiscountPercentage ?? null)}
                        onChange={(event) => {
                          handlePolicyDiscountChange(policyId, "customer", event.target.value);
                        }}
                        onBlur={() => handlePolicyDiscountSave(row, "customer")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!hasBrandSelection}
                        aria-label={`Customer discount for ${row.pricingPolicyName}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className={styles.ruleTableEmpty}>No pricing policies available.</div>
        )}
      </LookupModal>
      <LookupModal
        open={isAddPricingPolicyRuleOpen}
        title="Add Pricing Policy Rule"
        onClose={() => setIsAddPricingPolicyRuleOpen(false)}
        onConfirm={handleCreatePricingPolicyRule}
        confirmLabel="Create"
        saving={pricingPolicyRuleSaving}
        error={pricingPolicyRuleError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-name">
            Name
          </label>
          <input
            id="import-rule-name"
            className={lookupStyles.fieldControl}
            value={newRuleName}
            required
            onChange={(event) => setNewRuleName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-pricing-policy">
            Pricing policy
          </label>
          <select
            id="import-rule-pricing-policy"
            className={lookupStyles.fieldControl}
            value={newRulePricingPolicyId}
            required
            onChange={(event) => setNewRulePricingPolicyId(event.target.value)}
          >
            <option value="">Select pricing policy</option>
            {localPricingPolicies.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-brand">
            Brand
          </label>
          <select
            id="import-rule-brand"
            className={lookupStyles.fieldControl}
            value={newRuleBrandId}
            onChange={(event) => setNewRuleBrandId(event.target.value)}
          >
            <option value="">All brands (default)</option>
            {localBrands.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-telmaco">
            Telmaco discount (%)
          </label>
          <input
            id="import-rule-telmaco"
            className={lookupStyles.fieldControl}
            value={newRuleTelmaco}
            required
            onChange={(event) => setNewRuleTelmaco(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-customer">
            Customer discount (%)
          </label>
          <input
            id="import-rule-customer"
            className={lookupStyles.fieldControl}
            value={newRuleCustomer}
            required
            onChange={(event) => setNewRuleCustomer(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-user">
            Responsible user
          </label>
          <select
            id="import-rule-user"
            className={lookupStyles.fieldControl}
            value={newRuleResponsibleUserId}
            onChange={(event) => setNewRuleResponsibleUserId(event.target.value)}
          >
            <option value="">Select responsible user </option>
            {users.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-comments">
            Comments
          </label>
          <textarea
            id="import-rule-comments"
            className={`${lookupStyles.fieldControl} ${lookupStyles.textarea}`}
            value={newRuleComments}
            onChange={(event) => setNewRuleComments(event.target.value)}
          />
        </div>
      </LookupModal>
      {showSheetSelector && fileValidation.sheets.length > 1 ? (
        <div className={styles.sheetSelectorOverlay}>
          <div className={styles.sheetSelectorPopup} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetSelectorHeader}>
              <div className={styles.sheetSelectorTitle}>Sheet Selection</div>
              <button
                type="button"
                className={styles.sheetSelectorClose}
                aria-label="Close dialog"
                onClick={() => setShowSheetSelector(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.sheetSelectorDescription}>
              {`I have found ${fileValidation.sheets.length} sheets. Please select the appropriate sheet or multiple ones, after you close this window.`}
            </div>
            <div className={styles.sheetSelectorList}>
              {fileValidation.sheets.map((sheet, idx) => {
                const selected = sheet.enabled;
                return (
                  <div
                    key={sheet.name || idx}
                    className={`${styles.sheetSelectorItem} ${selected ? styles.sheetSelectorItemSelected : ""}`}
                  >
                    <span className={styles.sheetSelectorItemName}>{sheet.name || `Sheet ${idx + 1}`}</span>
                    <span className={styles.sheetSelectorItemRows}>{sheet.rowCount} rows</span>
                  </div>
                );
              })}
            </div>
            {(() => {
              const enabled = fileValidation.sheets.filter((s) => s.enabled);
              if (enabled.length === 1) {
                return (
                  <div className={styles.sheetSelectorDescription}>
                    {"Auto-selected "}
                    <strong>{enabled[0].name}</strong>
                    {` with ${enabled[0].rowCount} rows (largest sheet).`}
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>
      ) : null}
    </>
  );
}
