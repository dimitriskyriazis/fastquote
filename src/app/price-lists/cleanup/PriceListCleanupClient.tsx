"use client";

import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import Link from "next/link";
import layoutStyles from "../priceListDetail.module.css";
import styles from "./PriceListCleanup.module.css";
import { showToastMessage } from "../../../lib/toast";
import { showConfirmDialog } from "../../../lib/confirm";
import { detectDecimalFormat } from "../../../lib/parsePriceValue";
import { detectLifecycleMarker } from "../../../lib/priceListLifecycle";
import {
  PRICE_LIST_DECIMAL_FORMAT_OPTIONS,
  type PriceListDecimalFormat,
} from "../../../lib/priceListDecimalFormats";
import {
  COLUMN_DISPLAY,
  INITIAL_VALIDATION,
  evaluateSelection,
  validateFileStructure,
  loadXlsx,
  type FileValidation,
  type HeaderColumnKey,
} from "../../../lib/priceListColumnDetection";
import {
  cleanupRows,
  buildCleanedWorkbook,
  formatDecimalForExport,
  suggestDiscountColumn,
  usedOutputHeaders,
  type CleanedRow,
  type CostMode,
} from "../../../lib/priceListCleanup";

// Fields the cleanup tool maps (a subset of the importer — service/legacy columns are
// out of scope for the normalized output).
const CLEANUP_KEYS: HeaderColumnKey[] = [
  "partNumber",
  "modelNumber",
  "description",
  "listPrice",
  "costPrice",
  "warning",
  "moq",
  "weblink",
];
const CLEANUP_FIELDS = COLUMN_DISPLAY.filter((column) => CLEANUP_KEYS.includes(column.key));

const OUTPUT_COLUMNS: Array<{ key: keyof CleanedRow; label: string; isCost?: boolean }> = [
  { key: "partNumber", label: "Part Number" },
  { key: "modelNumber", label: "Model Number" },
  { key: "description", label: "Description" },
  { key: "listPrice", label: "List Price" },
  { key: "costPrice", label: "Cost Price", isCost: true },
  { key: "warning", label: "Warning" },
  { key: "moq", label: "MOQ" },
  { key: "weblink", label: "Weblink" },
  { key: "status", label: "Status" },
];

// Above this many rows, confirm before sending them all to the AI.
const AI_CONFIRM_THRESHOLD = 200;
const AI_CHUNK = 25;

const makeCleanedFileName = (originalName: string): string => {
  const dot = originalName.lastIndexOf(".");
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${base} - cleaned.xlsx`;
};

const downloadXlsx = (buffer: ArrayBuffer, fileName: string) => {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export default function PriceListCleanupClient() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const [discountColumnIndex, setDiscountColumnIndex] = useState<number | null>(null);
  const [decimalFormat, setDecimalFormat] = useState<PriceListDecimalFormat>("auto");
  const [generateCost, setGenerateCost] = useState(false);
  const [costMode, setCostMode] = useState<CostMode>("keepExisting");
  const [keepNonNumericPrice, setKeepNonNumericPrice] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI description state.
  const [brand, setBrand] = useState("");
  const [aiByPartNumber, setAiByPartNumber] = useState<Record<string, string>>({});
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  // Lifecycle / EOL handling: keep marker in description, move to a Status column, or drop rows.
  const [eolChoice, setEolChoice] = useState<"keep" | "annotate" | "drop">("keep");

  const activeSheet = fileValidation.sheets[fileValidation.activeSheetIndex] ?? null;
  const hasPartAndPrice =
    activeSheet?.selection.partNumber != null && activeSheet?.selection.listPrice != null;
  const hasExistingCost = activeSheet?.selection.costPrice != null;

  // The cost column is included when the file already has one, or when the user opts to
  // generate it. Mode drives how each cost value is produced.
  const includeCost = Boolean(hasExistingCost || generateCost);
  const effectiveCostMode: CostMode = hasExistingCost
    ? costMode
    : generateCost
      ? "compute"
      : "none";
  const showDiscountControls = effectiveCostMode === "compute";

  // Resolve "auto" to a concrete format from the list-price column so the preview and the
  // download agree.
  const resolvedFormat = useMemo<PriceListDecimalFormat>(() => {
    if (decimalFormat !== "auto") return decimalFormat;
    if (!activeSheet || activeSheet.selection.listPrice == null) return "dotDecimal";
    const lpIdx = activeSheet.selection.listPrice;
    return detectDecimalFormat(activeSheet.allRows.map((row) => row[lpIdx]));
  }, [decimalFormat, activeSheet]);

  // Concrete format used to write/preview prices (resolvedFormat is never "auto" at runtime).
  const exportFormat: "dotDecimal" | "commaDecimal" =
    resolvedFormat === "commaDecimal" ? "commaDecimal" : "dotDecimal";

  const formatPreviewCell = useCallback(
    (key: keyof CleanedRow, value: string | number | null): string => {
      if (value == null) return "";
      if ((key === "listPrice" || key === "costPrice") && typeof value === "number") {
        return formatDecimalForExport(value, exportFormat);
      }
      return typeof value === "number" ? String(value) : value;
    },
    [exportFormat],
  );

  // All cleaned rows (pre-AI, pre-lifecycle) + the run summary — the single source of truth
  // for preview, AI input, lifecycle scan, and download.
  const cleanedAll = useMemo(() => {
    if (!activeSheet || !hasPartAndPrice) return null;
    return cleanupRows(activeSheet.allRows, {
      selection: activeSheet.selection,
      discountColumnIndex,
      fileWideDiscountPercent: null,
      decimalFormat: resolvedFormat,
      costMode: effectiveCostMode,
      keepNonNumericPrice,
    });
  }, [
    activeSheet,
    hasPartAndPrice,
    discountColumnIndex,
    resolvedFormat,
    effectiveCostMode,
    keepNonNumericPrice,
  ]);

  // Apply AI descriptions (by part number) and the lifecycle choice. Lifecycle is detected on
  // the ORIGINAL cleaned description (before any AI rewrite removes the marker).
  const transformRows = useCallback(
    (rows: CleanedRow[]): CleanedRow[] => {
      const out: CleanedRow[] = [];
      for (const row of rows) {
        const marker = detectLifecycleMarker(row.description) ?? detectLifecycleMarker(row.warning);
        if (marker && eolChoice === "drop") continue;
        const ai = aiByPartNumber[row.partNumber];
        const next: CleanedRow = { ...row, description: ai ?? row.description };
        if (marker && eolChoice === "annotate") next.status = marker.match;
        out.push(next);
      }
      return out;
    },
    [aiByPartNumber, eolChoice],
  );

  const transformedAll = useMemo(
    () => (cleanedAll ? transformRows(cleanedAll.rows) : null),
    [cleanedAll, transformRows],
  );

  const previewRows = useMemo(() => transformedAll?.slice(0, 20) ?? null, [transformedAll]);

  const lifecycleCount = useMemo(
    () =>
      cleanedAll
        ? cleanedAll.rows.filter(
            (r) => detectLifecycleMarker(r.description) || detectLifecycleMarker(r.warning),
          ).length
        : 0,
    [cleanedAll],
  );

  // Only show columns that carry data (drops Cost when off, empty optional columns, and the
  // Status column unless EOL annotation added it).
  const outputColumns = useMemo(() => {
    const used = new Set(usedOutputHeaders(transformedAll ?? [], includeCost));
    return OUTPUT_COLUMNS.filter((col) => used.has(col.label));
  }, [transformedAll, includeCost]);

  const processFile = useCallback(async (nextFile: File) => {
    setFile(nextFile);
    setError(null);
    setAiByPartNumber({}); // a new file invalidates any prior AI descriptions
    setEolChoice("keep");
    setFileValidation((prev) => ({
      ...prev,
      status: "checking",
      message: "Checking file format…",
    }));
    const result = await validateFileStructure(nextFile);
    setFileValidation(result);
    const active = result.sheets[result.activeSheetIndex];
    if (active) {
      setDiscountColumnIndex(suggestDiscountColumn(active.columns));
      setCostMode(active.selection.costPrice != null ? "keepExisting" : "compute");
    } else {
      setDiscountColumnIndex(null);
    }
  }, []);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0];
    if (next) void processFile(next);
  };

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleFileDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const next = event.dataTransfer.files?.[0];
    if (next) void processFile(next);
  };

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

  const handleSheetChange = useCallback(
    (targetIdx: number) => {
      const target = fileValidation.sheets[targetIdx];
      setFileValidation((prev) => {
        if (targetIdx < 0 || targetIdx >= prev.sheets.length) return prev;
        const sheets = prev.sheets.map((sheet, idx) => ({ ...sheet, enabled: idx === targetIdx }));
        const evaluation = evaluateSelection(sheets, targetIdx);
        return { ...prev, ...evaluation, sheets, activeSheetIndex: targetIdx };
      });
      if (target) {
        setDiscountColumnIndex(suggestDiscountColumn(target.columns));
        setCostMode(target.selection.costPrice != null ? "keepExisting" : "compute");
      }
    },
    [fileValidation],
  );

  const handleImproveDescriptions = useCallback(async () => {
    if (!cleanedAll || aiRunning) return;
    const rows = cleanedAll.rows;
    if (rows.length === 0) return;

    if (rows.length > AI_CONFIRM_THRESHOLD) {
      const ok = await showConfirmDialog({
        title: "Improve descriptions with AI?",
        message: `This sends ${rows.length} rows to the AI (with web search). It can take a while and incurs cost. Continue?`,
        confirmLabel: "Run AI",
      });
      if (!ok) return;
    }

    setAiRunning(true);
    setAiProgress({ done: 0, total: rows.length });
    setError(null);
    try {
      const acc: Record<string, string> = { ...aiByPartNumber };
      for (let i = 0; i < rows.length; i += AI_CHUNK) {
        const slice = rows.slice(i, i + AI_CHUNK);
        const payload = slice.map((r, j) => ({
          id: i + j,
          partNumber: r.partNumber,
          modelNumber: r.modelNumber ?? "",
          description: r.description ?? "",
        }));
        const res = await fetch("/api/price-lists/cleanup/describe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand: brand.trim(), useWeb: true, rows: payload }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e?.error || `Request failed (${res.status})`);
        }
        const data = await res.json();
        for (const result of data.results ?? []) {
          if (result?.newDescription && typeof result.id === "number") {
            const row = rows[result.id];
            if (row) acc[row.partNumber] = result.newDescription;
          }
        }
        setAiByPartNumber({ ...acc });
        setAiProgress({ done: Math.min(i + AI_CHUNK, rows.length), total: rows.length });
      }
      const count = Object.keys(acc).length;
      showToastMessage(`AI improved ${count} description${count === 1 ? "" : "s"}.`, "success", 6000);
    } catch (err) {
      console.error("AI describe failed", err);
      setError(err instanceof Error ? err.message : "AI description generation failed.");
    } finally {
      setAiRunning(false);
      setAiProgress(null);
    }
  }, [cleanedAll, aiRunning, aiByPartNumber, brand]);

  const handleCleanAndDownload = useCallback(async () => {
    if (!file || !transformedAll || !cleanedAll) return;
    setProcessing(true);
    setError(null);
    try {
      if (transformedAll.length === 0) {
        setError(
          "No product rows found after cleanup. Check the Part Number and List Price columns.",
        );
        return;
      }
      const xlsx = await loadXlsx();
      const buffer = buildCleanedWorkbook(transformedAll, xlsx, {
        includeCost,
        numberFormat: exportFormat,
      });
      downloadXlsx(buffer, makeCleanedFileName(file.name));

      const summary = cleanedAll.summary;
      const parts = [`Cleaned ${transformedAll.length}`, `trimmed ${summary.trimmed} junk`];
      if (summary.zeroPriced > 0) parts.push(`${summary.zeroPriced} priced 0`);
      if (eolChoice === "drop" && lifecycleCount > 0) parts.push(`${lifecycleCount} EOL dropped`);
      if (eolChoice === "annotate" && lifecycleCount > 0) parts.push(`${lifecycleCount} EOL flagged`);
      const aiCount = Object.keys(aiByPartNumber).length;
      if (aiCount > 0) parts.push(`${aiCount} AI descriptions`);
      if (effectiveCostMode === "compute") {
        parts.push(`cost on ${summary.withCost}`);
        if (summary.capped > 0) parts.push(`${summary.capped} capped`);
        if (summary.withoutCost > 0) parts.push(`${summary.withoutCost} without cost`);
      }
      showToastMessage(parts.join(" • "), "success", 7000);
    } catch (err) {
      console.error("Cleanup failed", err);
      setError("Something went wrong while cleaning the file. Please try again.");
    } finally {
      setProcessing(false);
    }
  }, [
    file,
    transformedAll,
    cleanedAll,
    includeCost,
    exportFormat,
    eolChoice,
    lifecycleCount,
    aiByPartNumber,
    effectiveCostMode,
  ]);

  const showNoDiscountWarning = showDiscountControls && discountColumnIndex == null;

  return (
    <main className={`${layoutStyles.page} ${styles.cleanupPage}`}>
      <div className={`${layoutStyles.headerRow} ${layoutStyles.headerRowCentered}`}>
        <Link
          href="/price-lists"
          className={`${layoutStyles.backLink} ${layoutStyles.backLinkAbsolute} ${styles.backLinkCentered} page-header-button`}
        >
          ← Back to price lists
        </Link>
        <h1 className={layoutStyles.heading}>Pricelist Cleanup</h1>
        <div className={styles.headerActions}>
          {error && <div className={styles.error}>{error}</div>}
          <button
            type="button"
            className={`${styles.submitButton} page-header-button`}
            onClick={() => void handleCleanAndDownload()}
            disabled={!hasPartAndPrice || processing}
          >
            {processing ? "Cleaning…" : "Clean & Download"}
          </button>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.intro}>
          Upload a messy supplier pricelist to tidy it up for import: it trims junk rows
          (category/section headers, repeated headers, blanks) and can optionally add a Cost
          column (<strong>Cost = List × (1 − discount%)</strong>). The download has normalized
          headers, so it re-imports with no column mapping. Nothing is saved to the database.
        </div>

        <label
          className={`${styles.uploadArea} ${isDragging ? styles.uploadAreaDragging : ""}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleFileDrop}
        >
          <input
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv"
            className={styles.fileInput}
            onChange={handleFileChange}
            autoComplete="off"
          />
          <div className={styles.uploadText}>
            <div className={styles.uploadTitle}>Drop your Excel file here</div>
            <div className={styles.uploadSubtitle}>
              Required columns: Part Number and List Price. Everything else is optional.
            </div>
            {file ? (
              <div className={styles.selectedFile}>
                Selected: <strong>{file.name}</strong>
              </div>
            ) : (
              <div className={styles.selectedFile}>Accepted: .xlsx, .xlsm, .xls, .csv</div>
            )}
          </div>
        </label>

        {fileValidation.status !== "idle" ? (
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
                {fileValidation.message ?? "Choose columns for the fields below."}
                {activeSheet ? (
                  <span className={styles.validationHint}>
                    {`Detected ${activeSheet.columns.length} column${activeSheet.columns.length === 1 ? "" : "s"} in ${activeSheet.name}. `}
                    {activeSheet.rowCount > 0
                      ? activeSheet.visibleDataRowIndices !== null
                        ? `${activeSheet.visibleRowCount} visible row${activeSheet.visibleRowCount === 1 ? "" : "s"} of ${activeSheet.rowCount} total (Excel filter active).`
                        : `${activeSheet.rowCount} data row${activeSheet.rowCount === 1 ? "" : "s"} after the header.`
                      : "No data rows detected yet."}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {fileValidation.sheets.length > 1 ? (
          <div className={styles.sheetTabs}>
            {fileValidation.sheets.map((sheet, idx) => {
              const isActive = idx === fileValidation.activeSheetIndex;
              return (
                <button
                  type="button"
                  key={sheet.name || idx}
                  className={`${styles.sheetTab} ${isActive ? styles.sheetTabActive : ""}`}
                  onClick={() => handleSheetChange(idx)}
                >
                  {sheet.name || `Sheet ${idx + 1}`}
                  <span className={styles.sheetTabRows}>
                    {sheet.visibleDataRowIndices !== null
                      ? `${sheet.visibleRowCount} / ${sheet.rowCount} rows`
                      : `${sheet.rowCount} rows`}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {activeSheet ? (
          <>
            <div className={styles.sectionHeading}>Column mapping</div>
            <div className={styles.mappingGrid}>
              {CLEANUP_FIELDS.map((column) => {
                const selectionValue =
                  activeSheet.selection[column.key] != null
                    ? String(activeSheet.selection[column.key])
                    : "";
                const suggestions = activeSheet.suggestions[column.key] ?? [];
                const suggestedIndexes = new Set(suggestions.map((opt) => opt.index));
                const otherOptions = activeSheet.columns.filter(
                  (col) => !suggestedIndexes.has(col.index),
                );
                return (
                  <label key={column.key} className={styles.mappingField}>
                    <span className={styles.mappingLabel}>
                      {column.label}
                      {column.required ? <span className={styles.requiredMark}>*</span> : null}
                    </span>
                    <select
                      className={styles.input}
                      value={selectionValue}
                      onChange={(event) =>
                        updateColumnSelection(
                          column.key,
                          event.target.value === "" ? null : Number(event.target.value),
                        )
                      }
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

            <label className={styles.radioLabel}>
              <input
                type="checkbox"
                checked={keepNonNumericPrice}
                onChange={(event) => setKeepNonNumericPrice(event.target.checked)}
              />
              Keep rows with a non-numeric price (e.g. &quot;CALL&quot;, &quot;POA&quot;) and set their List Price to 0
            </label>

            <div className={styles.sectionHeading}>Cost Price</div>
            {hasExistingCost ? (
              <div className={styles.infoNote}>
                This file already has a Cost column.
                <span className={styles.toggleRow} style={{ marginTop: 6 }}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="costMode"
                      checked={costMode === "keepExisting"}
                      onChange={() => setCostMode("keepExisting")}
                    />
                    Keep existing cost
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="costMode"
                      checked={costMode === "compute"}
                      onChange={() => setCostMode("compute")}
                    />
                    Recompute from discount
                  </label>
                </span>
              </div>
            ) : (
              <label className={styles.radioLabel}>
                <input
                  type="checkbox"
                  checked={generateCost}
                  onChange={(event) => setGenerateCost(event.target.checked)}
                />
                Generate a Cost Price column from a discount
              </label>
            )}

            {showDiscountControls ? (
              <>
                <div className={styles.optionsRow}>
                  <label className={styles.mappingField}>
                    <span className={styles.mappingLabel}>Per-row discount column</span>
                    <select
                      className={styles.input}
                      value={discountColumnIndex != null ? String(discountColumnIndex) : ""}
                      onChange={(event) =>
                        setDiscountColumnIndex(
                          event.target.value === "" ? null : Number(event.target.value),
                        )
                      }
                    >
                      <option value="">None</option>
                      {activeSheet.columns.map((col) => (
                        <option key={col.index} value={col.index}>
                          {col.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {showNoDiscountWarning ? (
                  <div className={styles.warningNote}>
                    No discount column mapped — Cost will equal List Price. Map a per-row discount
                    column above.
                  </div>
                ) : null}
              </>
            ) : null}

            <div className={styles.sectionHeading}>Number format</div>
            <div className={styles.optionsRow}>
              <label className={styles.mappingField}>
                <span className={styles.mappingLabel}>Number format (for reading &amp; exporting prices)</span>
                <select
                  className={styles.input}
                  value={decimalFormat}
                  onChange={(event) =>
                    setDecimalFormat(event.target.value as PriceListDecimalFormat)
                  }
                >
                  <option value="auto">Auto-detect</option>
                  {PRICE_LIST_DECIMAL_FORMAT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className={styles.sectionHeading}>Descriptions (AI)</div>
            <div className={styles.optionsRow}>
              <label className={styles.mappingField}>
                <span className={styles.mappingLabel}>Brand (for AI context)</span>
                <input
                  type="text"
                  className={styles.input}
                  value={brand}
                  onChange={(event) => setBrand(event.target.value)}
                  placeholder="e.g. Samsung"
                />
              </label>
              <div className={styles.mappingField}>
                <span className={styles.mappingLabel}>&nbsp;</span>
                <button
                  type="button"
                  className={styles.submitButton}
                  onClick={() => void handleImproveDescriptions()}
                  disabled={!hasPartAndPrice || aiRunning}
                >
                  {aiRunning
                    ? aiProgress
                      ? `Improving ${aiProgress.done}/${aiProgress.total}…`
                      : "Improving…"
                    : "Improve descriptions with AI"}
                </button>
              </div>
            </div>
            <div className={styles.intro}>
              Rewrites the Description column to the Telmaco house style (uses web search for extra
              specs). Nothing is saved — only your downloaded file changes.
              {Object.keys(aiByPartNumber).length > 0 && !aiRunning ? (
                <>
                  {" "}
                  <strong>{Object.keys(aiByPartNumber).length}</strong> improved.{" "}
                  <button
                    type="button"
                    className={styles.sheetTab}
                    onClick={() => setAiByPartNumber({})}
                  >
                    Clear AI descriptions
                  </button>
                </>
              ) : null}
            </div>

            {lifecycleCount > 0 ? (
              <>
                <div className={styles.sectionHeading}>Lifecycle / EOL</div>
                <div className={styles.warningNote}>
                  {lifecycleCount} row{lifecycleCount === 1 ? "" : "s"} contain lifecycle markers
                  (EOL, discontinued, successor, …).
                  <span className={styles.toggleRow} style={{ marginTop: 6 }}>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        name="eolChoice"
                        checked={eolChoice === "keep"}
                        onChange={() => setEolChoice("keep")}
                      />
                      Keep marker in description
                    </label>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        name="eolChoice"
                        checked={eolChoice === "annotate"}
                        onChange={() => setEolChoice("annotate")}
                      />
                      Add a Status column
                    </label>
                    <label className={styles.radioLabel}>
                      <input
                        type="radio"
                        name="eolChoice"
                        checked={eolChoice === "drop"}
                        onChange={() => setEolChoice("drop")}
                      />
                      Drop these rows
                    </label>
                  </span>
                </div>
              </>
            ) : null}

            <div className={styles.previewSection}>
              <div className={styles.previewHeading}>
                <span>Cleaned preview (first product rows)</span>
                <span className={styles.previewHint}>
                  Normalized output columns{includeCost ? "; the Cost Price column is bold" : ""}.
                </span>
              </div>
              {!hasPartAndPrice ? (
                <div className={styles.previewEmpty}>
                  Map Part Number and List Price to see the cleaned preview.
                </div>
              ) : !previewRows || previewRows.length === 0 ? (
                <div className={styles.previewEmpty}>
                  No product rows detected in this sheet yet.
                </div>
              ) : (
                <div className={styles.previewTableWrapper}>
                  <table className={styles.previewTable}>
                    <thead>
                      <tr>
                        {outputColumns.map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {outputColumns.map((column) => (
                            <td
                              key={`${rowIndex}-${column.key}`}
                              className={column.isCost ? styles.previewCost : ""}
                            >
                              {formatPreviewCell(column.key, row[column.key] ?? null)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
