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

const HEADER_SYNONYMS: Record<HeaderColumnKey, string[]> = {
  partNumber: ["partnumber", "part number", "partno", "part no"],
  modelNumber: ["modelnumber", "model number", "modelno", "model no"],
  description: ["name", "description"],
  listPrice: ["listprice", "list price", "price"],
  warning: ["warning"],
};

const COLUMN_DISPLAY: Array<{ key: HeaderColumnKey; label: string; required?: boolean }> = [
  { key: "partNumber", label: "Part Number", required: true },
  { key: "modelNumber", label: "Model Number", required: true },
  { key: "description", label: "Name / Description", required: true },
  { key: "listPrice", label: "List Price", required: true },
  { key: "warning", label: "Warning (optional)", required: false },
];

type FileValidation = {
  status: "idle" | "checking" | "valid" | "invalid";
  message: string | null;
  columns: Partial<Record<HeaderColumnKey, boolean>>;
  rowCount: number;
  sheetName: string | null;
};

const INITIAL_VALIDATION: FileValidation = {
  status: "idle",
  message: null,
  columns: {},
  rowCount: 0,
  sheetName: null,
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

const normalizeHeaderValue = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = typeof value === "number" ? String(value) : value;
  const trimmed = str.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, "");
};

const findHeaderRow = (rows: unknown[][]) => {
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const columnMap: Partial<Record<HeaderColumnKey, number>> = {};
    row.forEach((cell, colIdx) => {
      const normalized = normalizeHeaderValue(cell);
      if (!normalized) return;
      (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
        if (columnMap[key] != null) return;
        const matchesHeader = HEADER_SYNONYMS[key].some(
          (candidate) => normalizeHeaderValue(candidate) === normalized,
        );
        if (matchesHeader) {
          columnMap[key] = colIdx;
        }
      });
    });

    const detectedCount = Object.keys(columnMap).length;
    if (detectedCount > 0) {
      return { headerRowIndex: idx, columnMap };
    }
  }
  return null;
};

const hasCellValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

const summarizeColumns = (columnMap: Partial<Record<HeaderColumnKey, number>>) => {
  const summary: Record<HeaderColumnKey, boolean> = {
    partNumber: columnMap.partNumber != null,
    modelNumber: columnMap.modelNumber != null,
    description: columnMap.description != null,
    listPrice: columnMap.listPrice != null,
    warning: columnMap.warning != null,
  };
  return summary;
};

const validateWorksheet = (rows: unknown[][]) => {
  const header = findHeaderRow(rows);
  if (!header) return null;

  const columns = summarizeColumns(header.columnMap);
  const dataRows = rows.slice(header.headerRowIndex + 1, header.headerRowIndex + 501);
  let matchedRows = 0;

  dataRows.forEach((row) => {
    if (!Array.isArray(row)) return;
    const part = header.columnMap.partNumber != null ? row[header.columnMap.partNumber] : null;
    const model = header.columnMap.modelNumber != null ? row[header.columnMap.modelNumber] : null;
    const description = header.columnMap.description != null ? row[header.columnMap.description] : null;
    const price = header.columnMap.listPrice != null ? row[header.columnMap.listPrice] : null;

    const hasPart = hasCellValue(part);
    const hasModel = hasCellValue(model);
    const hasDescription = hasCellValue(description);
    const hasPrice = hasCellValue(price);
    if (hasPart && hasModel && hasDescription && hasPrice) {
      matchedRows += 1;
    }
  });

  const missingRequired: string[] = [];
  if (!columns.partNumber) missingRequired.push("Part Number");
  if (!columns.modelNumber) missingRequired.push("Model Number");
  if (!columns.description) missingRequired.push("Name / Description");
  if (!columns.listPrice) missingRequired.push("List Price");

  const status: FileValidation["status"] =
    missingRequired.length === 0 && matchedRows > 0 ? "valid" : "invalid";

  const foundColumns = COLUMN_DISPLAY.filter((col) => columns[col.key]).map((col) => col.label);
  const missingOptional = COLUMN_DISPLAY.filter((col) => !col.required && !columns[col.key]).map(
    (col) => col.label,
  );

  const parts: string[] = [];
  if (missingRequired.length > 0) {
    parts.push(`Missing required: ${missingRequired.join(", ")}`);
  }
  if (foundColumns.length > 0) {
    parts.push(`Found: ${foundColumns.join(", ")}`);
  }
  if (missingOptional.length > 0) {
    parts.push(`Missing optional: ${missingOptional.join(", ")}`);
  }
  if (matchedRows === 0) {
    parts.push("No rows with part number, model number, description, and list price.");
  } else {
    parts.push(
      `Found ${matchedRows} row${matchedRows === 1 ? "" : "s"} with part number, model number, description, and list price.`,
    );
  }

  const message = parts.join(" • ");

  return { status, message, columns, rowCount: matchedRows };
};

const validateFileStructure = async (uploadFile: File): Promise<FileValidation> => {
  try {
    const buffer = await uploadFile.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    let fallback: FileValidation | null = null;

    for (const sheetName of workbook.SheetNames ?? []) {
      const sheet = workbook.Sheets?.[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
      const validation = validateWorksheet(rows);
      if (validation) {
        const result: FileValidation = {
          status: validation.status,
          message: validation.message,
          columns: validation.columns,
          rowCount: validation.rowCount,
          sheetName: sheetName ?? null,
        };
        if (result.status === "valid") {
          return result;
        }
        if (!fallback) {
          fallback = result;
        }
      }
    }

    if (fallback) return fallback;

    return {
      ...INITIAL_VALIDATION,
      status: "invalid",
      message: "Could not find the required headers (Part Number, Model Number, Name/Description, List Price).",
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
          "Please attach a file with Part Number, Model Number, Name/Description, and List Price columns.",
      );
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
                      Required columns: Part Number/Part No, Model Number/Model No, Name/Description, and List Price/Price (case insensitive). Warning is optional.
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
                            "We expect Part Number, Model Number, Name/Description, and List Price columns."}
                          {fileValidation.status === "valid" && (
                            <span className={styles.validationHint}>
                              {fileValidation.rowCount > 0
                                ? `Found ${fileValidation.rowCount} row${fileValidation.rowCount === 1 ? "" : "s"} with required data${
                                    fileValidation.sheetName ? ` in ${fileValidation.sheetName}` : ""
                                  }.`
                                : null}
                            </span>
                          )}
                        </div>
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
