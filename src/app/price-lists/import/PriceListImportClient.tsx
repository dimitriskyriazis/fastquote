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
import * as XLSX from "xlsx";
import type { DropdownOption } from "../../../lib/dropdownOptions";
import { showToastMessage } from "../../../lib/toast";
import layoutStyles from "../priceListDetail.module.css";
import styles from "./PriceListImport.module.css";

export type PricingPolicyRuleOption = DropdownOption & {
  brandId: number | null;
  brandName: string | null;
  pricingPolicyId: number | null;
  pricingPolicyName: string | null;
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

type FormValues = {
  name: string;
  brandId: string;
  pricingPolicyId: string;
  pricingPolicyRuleId: string;
  responsibleUserId: string;
  supplierId: string;
  hasDuty: boolean | null;
  currencyId: string;
  countryId: string;
  validFromDate: string;
  validToDate: string;
  comments: string;
  supplierComments: string;
  previousPriceListId: string;
};

type HeaderColumnKey = "partNumber" | "modelNumber" | "description" | "listPrice" | "warning";

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

  warning: [
    "warn",
    "note",
    "remark",
    "comment",
    "info",
    "σημείωση",
    "σημειωση",
    "σημ.",
    "προσοχή",
    "προσοχη",
    "παρατήρηση",
    "παρατηρηση",
    "παρατηρ.",
    "σχόλιο",
    "σχολιο",
    "σχόλια",
    "σχολια",
    "πληροφορίες",
    "πληροφοριες",
  ],
};

const COLUMN_DISPLAY: Array<{ key: HeaderColumnKey; label: string; required?: boolean }> = [
  { key: "partNumber", label: "Part Number", required: true },
  { key: "modelNumber", label: "Model Number (optional)", required: false },
  { key: "description", label: "Name / Description", required: true },
  { key: "listPrice", label: "List Price", required: true },
  { key: "warning", label: "Warning (optional)", required: false },
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
  "pricingPolicyId",
  "responsibleUserId",
  "supplierId",
  "currencyId",
  "validFromDate",
  "validToDate",
];

const normalizeDate = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
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
    warning: makeSuggestions("warning"),
  };
};

const analyzeSheet = (sheetName: string, rows: unknown[][], fallbackIndex: number, enabled: boolean): SheetMapping => {
  const headerRowIndex = detectHeaderRowIndex(rows);
  const headerRow = Array.isArray(rows[headerRowIndex]) ? rows[headerRowIndex] : [];
  const columns = buildColumns(headerRow);
  const suggestions = buildSuggestions(columns);
  const dataRows = rows.slice(headerRowIndex + 1, headerRowIndex + 501);
  const rowCount = dataRows.filter((row) => Array.isArray(row) && row.some(hasCellValue)).length;

  return {
    name: sheetName || `Sheet ${fallbackIndex + 1}`,
    headerRowIndex,
    columns,
    suggestions,
    selection: {},
    rowCount,
    enabled,
  };
};

const analyzeWorkbook = (workbook: XLSX.WorkBook): SheetMapping[] => {
  const sheets: SheetMapping[] = [];
  for (const sheetName of workbook.SheetNames ?? []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
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
    warning: selection.warning != null,
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
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheets = analyzeWorkbook(workbook);

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
  const [values, setValues] = useState<FormValues>({
    name: "",
    brandId: "",
    pricingPolicyId: "",
    pricingPolicyRuleId: "",
    responsibleUserId: "",
    supplierId: "",
    hasDuty: null,
    currencyId: "",
    countryId: "",
    validFromDate: "",
    validToDate: "",
    comments: "",
    supplierComments: "",
    previousPriceListId: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const validationRunId = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brandText, setBrandText] = useState("");
  const [brandError, setBrandError] = useState<string | null>(null);
  const [showBrandList, setShowBrandList] = useState(false);

  const filteredRules = useMemo(() => {
    const rawBrand = values.brandId.trim();
    const brandId = rawBrand ? Number(rawBrand) : null;
    if (brandId == null || !Number.isFinite(brandId)) return pricingPolicyRules;
    return pricingPolicyRules.filter(
      (rule) => rule.brandId == null || rule.brandId === brandId,
    );
  }, [pricingPolicyRules, values.brandId]);

  const filteredPolicyIds = useMemo(() => {
    const ids = new Set<string>();
    filteredRules.forEach((rule) => {
      if (rule.pricingPolicyId != null) {
        ids.add(String(rule.pricingPolicyId));
      }
    });
    return ids;
  }, [filteredRules]);

  const filteredPolicies = useMemo(() => {
    const hasBrand = values.brandId.trim().length > 0 && Number.isFinite(Number(values.brandId));
    if (!hasBrand || filteredPolicyIds.size === 0) return pricingPolicies;
    return pricingPolicies.filter((policy) => filteredPolicyIds.has(policy.value));
  }, [filteredPolicyIds, pricingPolicies, values.brandId]);

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
    if (!search) return brands;
    return brands.filter((option) => {
      const label = option.label?.toLowerCase() ?? "";
      const value = option.value?.toLowerCase() ?? "";
      return label.includes(search) || value.includes(search);
    });
  }, [brandText, brands]);

  useEffect(() => {
    const brandId = Number(values.brandId);
    const selectedRule = pricingPolicyRules.find(
      (rule) => rule.value === values.pricingPolicyRuleId,
    );
    if (
      selectedRule &&
      brandId &&
      selectedRule.brandId &&
      selectedRule.brandId !== brandId
    ) {
      setValues((prev) => ({ ...prev, pricingPolicyRuleId: "" }));
    }

    if (
      values.pricingPolicyId &&
      filteredPolicyIds.size > 0 &&
      !filteredPolicyIds.has(values.pricingPolicyId)
    ) {
      setValues((prev) => ({ ...prev, pricingPolicyId: "" }));
    }
  }, [filteredPolicyIds, pricingPolicyRules, values.brandId, values.pricingPolicyId, values.pricingPolicyRuleId]);

  const updateField = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const findBrandOption = useCallback(
    (text: string) => {
      const normalized = text.trim().toLowerCase();
      if (!normalized) return null;
      return (
        brands.find((option) => {
          const label = option.label?.trim().toLowerCase();
          const value = option.value?.trim().toLowerCase();
          return label === normalized || value === normalized;
        }) ?? null
      );
    },
    [brands],
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

    if (missing.length > 0) {
      setError("Please complete all required fields and attach the file.");
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("name", values.name);
      formData.append("brandId", values.brandId);
      formData.append("pricingPolicyId", values.pricingPolicyId);
      if (values.pricingPolicyRuleId) formData.append("pricingPolicyRuleId", values.pricingPolicyRuleId);
      formData.append("responsibleUserId", values.responsibleUserId);
      formData.append("supplierId", values.supplierId);
      formData.append("hasDuty", values.hasDuty ? "1" : "0");
      formData.append("currencyId", values.currencyId);
      if (values.countryId) formData.append("countryId", values.countryId);
      formData.append("validFromDate", values.validFromDate);
      formData.append("validToDate", values.validToDate);
      formData.append("comments", values.comments);
      formData.append("supplierComments", values.supplierComments);
      if (values.previousPriceListId) {
        formData.append("previousPriceListId", values.previousPriceListId);
      }
      if (values.hasDuty !== null) {
        formData.append("hasDuty", values.hasDuty ? "1" : "0");
      }
      formData.append("file", file as Blob);
      const columnMappings = selectedSheets.map((sheet) => ({
        sheetName: sheet.name,
        headerRowIndex: sheet.headerRowIndex,
        columns: {
          partNumber: sheet.selection.partNumber ?? null,
          modelNumber: sheet.selection.modelNumber ?? null,
          description: sheet.selection.description ?? null,
          listPrice: sheet.selection.listPrice ?? null,
          warning: sheet.selection.warning ?? null,
        },
      }));
      formData.append("columnMappings", JSON.stringify(columnMappings));

      const response = await fetch("/api/price-lists/import", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        priceListId?: string | number;
        createdProductCount?: number;
        matchedProductCount?: number;
        skippedRows?: number;
        totalRows?: number;
      };
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Unable to import price list. Please try again.");
      }

      const summary = [
        `Imported ${payload.totalRows ?? 0} rows`,
        `${payload.createdProductCount ?? 0} new products`,
        `${payload.matchedProductCount ?? 0} matched`,
        `${payload.skippedRows ?? 0} skipped`,
      ].join(" • ");
      showToastMessage(summary);

      const targetId = payload.priceListId != null ? encodeURIComponent(String(payload.priceListId)) : null;
      if (targetId) {
        router.push(`/price-lists/${targetId}/products`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to import price list. Please try again.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [file, fileValidation, router, values]);

  const renderOption = (option: DropdownOption) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  );

  return (
    <main className={`${layoutStyles.page} ${styles.importPage}`}>
      <div className={`${layoutStyles.headerRow} ${layoutStyles.headerRowCentered}`}>
        <Link href="/price-lists" className={`${layoutStyles.backLink} ${layoutStyles.backLinkAbsolute}`}>
          ← Back to price lists
        </Link>
        <h1 className={layoutStyles.heading}>Import Price List</h1>
      </div>

      <section className={styles.card}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.formGrid}>
            <div className={styles.fieldStack}>
              <div className={styles.sectionHeading}>Price List Details</div>
              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Name <span className={styles.requiredMark}>*</span>
                  </span>
                  <input
                    className={styles.input}
                    value={values.name}
                    onChange={(e) => updateField("name", e.target.value)}
                  />
                </label>
                <div className={`${styles.field} ${styles.comboWrapper}`}>
                  <span className={styles.label}>
                    Brand <span className={styles.requiredMark}>*</span>
                  </span>
                  <input
                    className={`${styles.input} ${styles.comboInput}`}
                    value={brandText}
                    placeholder="Type to filter brands"
                    onChange={(e) => handleBrandInputChange(e.target.value)}
                    onFocus={(e) => {
                      e.target.select();
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
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Pricing Policy <span className={styles.requiredMark}>*</span>
                  </span>
                  <select
                    className={styles.input}
                    value={values.pricingPolicyId}
                    onChange={(e) => updateField("pricingPolicyId", e.target.value)}
                  >
                    <option value="">Select pricing policy</option>
                    {filteredPolicies.map(renderOption)}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Pricing Policy Rule</span>
                  <select
                    className={styles.input}
                    value={values.pricingPolicyRuleId}
                    onChange={(e) => updateField("pricingPolicyRuleId", e.target.value)}
                  >
                    <option value="">No rule</option>
                    {filteredRules.map((rule) => (
                      <option key={rule.value} value={rule.value}>
                        {rule.label}
                        {rule.brandName ? ` • ${rule.brandName}` : ""}
                        {rule.pricingPolicyName ? ` • ${rule.pricingPolicyName}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Responsible User <span className={styles.requiredMark}>*</span>
                  </span>
                  <select
                    className={styles.input}
                    value={values.responsibleUserId}
                    onChange={(e) => updateField("responsibleUserId", e.target.value)}
                  >
                    <option value="">Select responsible user</option>
                    {users.map(renderOption)}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Supplier <span className={styles.requiredMark}>*</span>
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
                  <span className={styles.label}>
                    Currency <span className={styles.requiredMark}>*</span>
                  </span>
                  <select
                    className={styles.input}
                    value={values.currencyId}
                    onChange={(e) => updateField("currencyId", e.target.value)}
                  >
                    <option value="">Select currency</option>
                    {currencies.map(renderOption)}
                  </select>
                </label>
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
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Valid From <span className={styles.requiredMark}>*</span>
                  </span>
                  <input
                    type="date"
                    className={styles.input}
                    value={values.validFromDate}
                    onChange={(e) => updateField("validFromDate", e.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Valid To <span className={styles.requiredMark}>*</span>
                  </span>
                  <input
                    type="date"
                    className={styles.input}
                    value={values.validToDate}
                    onChange={(e) => updateField("validToDate", e.target.value)}
                  />
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Comments</span>
                  <textarea
                    className={`${styles.input} ${styles.textarea}`}
                    value={values.comments}
                    onChange={(e) => updateField("comments", e.target.value)}
                    rows={3}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Supplier Comments</span>
                  <textarea
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
            <div className={styles.uploadCard}>
              <label
                className={`${styles.uploadArea} ${isDragging ? styles.uploadAreaDragging : ""}`}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleFileDrop}
              >
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className={styles.fileInput}
                  onChange={handleFileChange}
                />
                <div className={styles.uploadText}>
                  <div className={styles.uploadTitle}>Drop your Excel file here</div>
                    <div className={styles.uploadSubtitle}>
                      Required columns: Part Number/Part No, Name/Description, and List Price/Price (case insensitive). Model Number and Warning are optional. Use the dropdowns below to map the headers we find, even if the names are not exact.
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
                            "Choose columns for Part Number, Name/Description, and List Price. Model Number is optional."}
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
            <button type="submit" className={styles.submitButton} disabled={submitting}>
              {submitting ? "Importing…" : "Create Price List"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
