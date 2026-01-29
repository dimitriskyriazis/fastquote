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
  pricingPolicies: DropdownOption[];
  pricingPolicyRules: PricingPolicyRuleOption[];
  users: DropdownOption[];
  previousPriceLists: PreviousPriceListOption[];
};

type PricingPolicySelection = {
  pricingPolicyId: number;
  pricingPolicyRuleId: number | null;
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
  const normalized = str.trim().toLowerCase();
  return normalized || null;
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
  const limit = Math.min(rows.length, 25);
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const score = row.reduce<number>((count, cell) => (hasCellValue(cell) ? count + 1 : count), 0);
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
    const keywords = columnKeywords[key].map((kw) => kw.toLowerCase());
    return columns.filter((col) => keywords.some((kw) => col.normalized.includes(kw)));
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
  
  const dataRows = rows.slice(headerRowIndex + 1, headerRowIndex + 501);
  const rowCount = dataRows.filter((row) => Array.isArray(row) && row.some(hasCellValue)).length;
  const previewRows = dataRows
    .filter((row) => Array.isArray(row) && row.some(hasCellValue))
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

    const evaluation = evaluateSelection(sheets, 0);

    return {
      status: evaluation.status,
      message: evaluation.message,
      columns: evaluation.columns,
      rowCount: evaluation.rowCount,
      sheetName: evaluation.sheetName,
      sheets,
      activeSheetIndex: 0,
    };
  } catch (err) {
    console.error("Failed to validate uploaded file", err);
    return {
      ...INITIAL_VALIDATION,
      status: "invalid",
      message: "Unable to read the file. Please upload a valid .xlsx, .xls, or .csv.",
    };
  }
};

export default function PriceListImportClient({
  brands,
  suppliers,
  currencies,
  countries,
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
  const [rulePickerSelection, setRulePickerSelection] = useState<Set<number>>(new Set());
  const [rulePickerError, setRulePickerError] = useState<string | null>(null);
  const [discountDrafts, setDiscountDrafts] = useState<Record<number, { telmaco: string; customer: string }>>({});
  const [file, setFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const validationRunId = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [brandText, setBrandText] = useState("");
  const [brandError, setBrandError] = useState<string | null>(null);
  const [showBrandList, setShowBrandList] = useState(false);
  const [localBrands, setLocalBrands] = useState<DropdownOption[]>(brands);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [brandsError, setBrandsError] = useState<string | null>(null);
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

  // Automatically select current user as responsible user
  useEffect(() => {
    if (currentUserId && !values.responsibleUserId) {
      setValues((prev) => ({ ...prev, responsibleUserId: currentUserId }));
    }
  }, [currentUserId, values.responsibleUserId]);

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

  const filteredRules = useMemo(() => {
    const rawBrand = values.brandId.trim();
    const brandId = rawBrand ? Number(rawBrand) : null;
    if (brandId == null || !Number.isFinite(brandId)) return localPricingPolicyRules;
    return localPricingPolicyRules.filter(
      (rule) => rule.brandId == null || rule.brandId === brandId,
    );
  }, [localPricingPolicyRules, values.brandId]);

  const hasBrandSelection = useMemo(() => {
    const rawBrand = values.brandId.trim();
    return rawBrand.length > 0 && Number.isFinite(Number(rawBrand));
  }, [values.brandId]);

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

  const rulesForPicker = useMemo(() => {
    const sorted = [...filteredRules];
    sorted.sort((a, b) => {
      const aPolicy = a.pricingPolicyName ?? pricingPolicyNameById.get(Number(a.pricingPolicyId)) ?? "";
      const bPolicy = b.pricingPolicyName ?? pricingPolicyNameById.get(Number(b.pricingPolicyId)) ?? "";
      const policyCompare = aPolicy.localeCompare(bPolicy);
      if (policyCompare !== 0) return policyCompare;
      return (a.label ?? "").localeCompare(b.label ?? "");
    });
    return sorted;
  }, [filteredRules, pricingPolicyNameById]);

  const selectedRuleIds = useMemo(() => {
    return new Set(
      values.pricingPolicies
        .map((entry) => entry.pricingPolicyRuleId)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id)),
    );
  }, [values.pricingPolicies]);

  const rulesById = useMemo(() => {
    const map = new Map<number, PricingPolicyRuleOption>();
    localPricingPolicyRules.forEach((rule) => {
      const id = Number(rule.value);
      if (Number.isFinite(id)) {
        map.set(id, rule);
      }
    });
    return map;
  }, [localPricingPolicyRules]);

  const selectedRuleSummary = useMemo(() => {
    return values.pricingPolicies
      .map((entry) => (entry.pricingPolicyRuleId != null ? rulesById.get(entry.pricingPolicyRuleId) : null))
      .filter((rule): rule is PricingPolicyRuleOption => Boolean(rule));
  }, [rulesById, values.pricingPolicies]);

  useEffect(() => {
    if (!isRulePickerOpen) return;
    setRulePickerError(null);
    const visibleRuleIds = new Set(
      rulesForPicker
        .map((rule) => Number(rule.value))
        .filter((id) => Number.isFinite(id)),
    );
    setRulePickerSelection(
      new Set(Array.from(selectedRuleIds).filter((id) => visibleRuleIds.has(id))),
    );
  }, [isRulePickerOpen, rulesForPicker, selectedRuleIds]);

  useEffect(() => {
    if (!isRulePickerOpen) return;
    const next: Record<number, { telmaco: string; customer: string }> = {};
    rulesForPicker.forEach((rule) => {
      const id = Number(rule.value);
      if (!Number.isFinite(id)) return;
      next[id] = {
        telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
        customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
      };
    });
    setDiscountDrafts(next);
  }, [isRulePickerOpen, rulesForPicker]);

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

  const toggleRuleSelection = useCallback((ruleId: number) => {
    setRulePickerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  }, []);

  const applyRuleSelection = useCallback(() => {
    const rulesById = new Map<number, PricingPolicyRuleOption>();
    rulesForPicker.forEach((rule) => {
      const id = Number(rule.value);
      if (Number.isFinite(id)) {
        rulesById.set(id, rule);
      }
    });
    const nextPolicies = Array.from(rulePickerSelection)
      .map((ruleId) => {
        const rule = rulesById.get(ruleId);
        if (!rule || rule.pricingPolicyId == null) return null;
        return {
          pricingPolicyId: rule.pricingPolicyId,
          pricingPolicyRuleId: ruleId,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          pricingPolicyId: number;
          pricingPolicyRuleId: number;
        } => entry !== null,
      );

    if (nextPolicies.length === 0) {
      setRulePickerError("Please select at least one pricing policy rule.");
      return;
    }

    setValues((prev) => ({ ...prev, pricingPolicies: nextPolicies }));
    setIsRulePickerOpen(false);
  }, [rulePickerSelection, rulesForPicker]);

  const handleRuleDiscountChange = useCallback(
    (ruleId: number, field: "telmaco" | "customer", value: string) => {
      setDiscountDrafts((prev) => ({
        ...prev,
        [ruleId]: {
          telmaco: prev[ruleId]?.telmaco ?? "",
          customer: prev[ruleId]?.customer ?? "",
          [field]: value,
        },
      }));
    },
    [],
  );

  const handleRuleDiscountSave = useCallback(
    async (rule: PricingPolicyRuleOption, field: "telmaco" | "customer") => {
      const ruleId = Number(rule.value);
      if (!Number.isFinite(ruleId)) return;
      if (rule.brandId == null || rule.pricingPolicyId == null) {
        showToastMessage("This rule cannot be edited.", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
          },
        }));
        return;
      }

      const draft = discountDrafts[ruleId]?.[field] ?? "";
      const parsed = parseLocaleNumber(draft);
      if (parsed == null) {
        showToastMessage("Discount is required", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
          },
        }));
        return;
      }

      const currentValue =
        field === "telmaco" ? rule.telmacoDiscountPercentage ?? null : rule.customerDiscountPercentage ?? null;
      if (currentValue != null && parsed === currentValue) {
        return;
      }

      try {
        const response = await fetch("/api/pricing-policies/matrix", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId: rule.brandId,
            pricingPolicyId: rule.pricingPolicyId,
            field,
            value: parsed,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to update discounts");
        }
        setLocalPricingPolicyRules((prev) =>
          prev.map((entry) =>
            entry.value === rule.value
              ? {
                  ...entry,
                  telmacoDiscountPercentage:
                    field === "telmaco" ? parsed : entry.telmacoDiscountPercentage ?? null,
                  customerDiscountPercentage:
                    field === "customer" ? parsed : entry.customerDiscountPercentage ?? null,
                }
              : entry,
          ),
        );
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco:
              field === "telmaco" ? formatDiscountValue(parsed) : prev[ruleId]?.telmaco ?? "",
            customer:
              field === "customer" ? formatDiscountValue(parsed) : prev[ruleId]?.customer ?? "",
          },
        }));
        showToastMessage("Discount updated", "success");
      } catch (err) {
        console.error("Failed to update discount", err);
        showToastMessage("Unable to update discount. Please try again.", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
          },
        }));
      }
    },
    [discountDrafts],
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
                <label className={styles.field}>
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
                  <span className={styles.label}>
                    Brand <span className={styles.requiredMark}>*</span>
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
                        Pricing Policy Rules <span className={styles.requiredMark}>*</span>
                      </label>
                    </div>
                  </div>
                  {selectedRuleSummary.length > 0 ? (
                    <div className={styles.ruleSummaryList}>
                      {selectedRuleSummary.map((rule) => (
                        <span key={rule.value} className={styles.ruleSummaryItem}>
                          {rule.label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.chipListEmpty} style={{ marginBottom: "8px" }}>
                      No pricing policy rules selected.
                    </div>
                  )}
                  <span
                    className={styles.tooltipWrapper}
                    data-tooltip={
                      !hasBrandSelection
                        ? "Select a brand with a pricing policy and a rule first."
                        : rulesForPicker.length === 0
                          ? "No pricing policy rules are available for this brand."
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
                      disabled={!hasBrandSelection || rulesForPicker.length === 0}
                    >
                      Select Pricing Policy Rules
                    </button>
                  </span>
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
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
                <label className={styles.field}>
                  <span className={styles.label}>
                    Supplier
                  </span>
                  <select
                    className={styles.input}
                    value={values.supplierId}
                    onChange={(e) => updateField("supplierId", e.target.value)}
                  >
                    <option value="">Select supplier</option>
                    {suppliers.map(renderOption)}
                  </select>
                </label>
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
                  accept=".xlsx,.xls,.csv"
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
                      <div className={styles.selectedFile}>Accepted: .xlsx, .xls, .csv</div>
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
                            <div className={styles.sheetTabs}>
                              {fileValidation.sheets.map((sheet, idx) => {
                                const isActive = idx === fileValidation.activeSheetIndex;
                                const included = sheet.enabled;
                                return (
                                  <button
                                    type="button"
                                    key={sheet.name || idx}
                                    className={`${styles.sheetTab} ${isActive ? styles.sheetTabActive : ""} ${included ? styles.sheetTabIncluded : ""}`}
                                    onClick={() => handleSheetChange(idx)}
                                  >
                                    {sheet.name || `Sheet ${idx + 1}`}
                                  </button>
                                );
                              })}
                            </div>
                            {activeSheet && fileValidation.sheets.length > 1 ? (
                              <label className={styles.sheetToggle}>
                                <input
                                  autoComplete="off"
                                  type="checkbox"
                                  checked={activeSheet.enabled}
                                  onChange={(e) => toggleSheetEnabled(fileValidation.activeSheetIndex, e.target.checked)}
                                />
                                <span>Include this sheet</span>
                              </label>
                            ) : null}
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
    </main>
      <LookupModal
        open={isRulePickerOpen}
        title="Select Pricing Policy Rules"
        onClose={() => setIsRulePickerOpen(false)}
        onConfirm={applyRuleSelection}
        confirmLabel="Apply"
        error={rulePickerError}
        cardClassName={styles.rulePickerModal}
        bodyClassName={styles.rulePickerBody}
      >
        {rulesForPicker.length > 0 ? (
          <table className={styles.ruleTable}>
            <thead>
              <tr>
                <th className={styles.ruleCheckboxCell} />
                <th>Rule</th>
                <th>Pricing Policy</th>
                <th>Telmaco Discount</th>
                <th>Customer Discount</th>
              </tr>
            </thead>
            <tbody>
              {rulesForPicker.map((rule) => {
                const ruleId = Number(rule.value);
                const isSelected = Number.isFinite(ruleId) && rulePickerSelection.has(ruleId);
                const policyLabel =
                  rule.pricingPolicyName ??
                  pricingPolicyNameById.get(Number(rule.pricingPolicyId)) ??
                  "—";
                const canEdit = rule.brandId != null && rule.pricingPolicyId != null;
                const draft = Number.isFinite(ruleId) ? discountDrafts[ruleId] : null;
                return (
                  <tr key={rule.value} className={isSelected ? styles.ruleRowSelected : ""}>
                    <td className={styles.ruleCheckboxCell}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          if (!Number.isFinite(ruleId)) return;
                          toggleRuleSelection(ruleId);
                        }}
                      />
                    </td>
                    <td className={styles.ruleName}>{rule.label}</td>
                    <td className={styles.rulePolicy}>{policyLabel}</td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.telmaco ?? formatDiscountValue(rule.telmacoDiscountPercentage ?? null)}
                        onChange={(event) => {
                          if (!Number.isFinite(ruleId)) return;
                          handleRuleDiscountChange(ruleId, "telmaco", event.target.value);
                        }}
                        onBlur={() => handleRuleDiscountSave(rule, "telmaco")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!canEdit}
                        aria-label={`Telmaco discount for ${rule.label}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.customer ?? formatDiscountValue(rule.customerDiscountPercentage ?? null)}
                        onChange={(event) => {
                          if (!Number.isFinite(ruleId)) return;
                          handleRuleDiscountChange(ruleId, "customer", event.target.value);
                        }}
                        onBlur={() => handleRuleDiscountSave(rule, "customer")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!canEdit}
                        aria-label={`Customer discount for ${rule.label}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className={styles.ruleTableEmpty}>No pricing policy rules available for the selected brand.</div>
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
    </>
  );
}
