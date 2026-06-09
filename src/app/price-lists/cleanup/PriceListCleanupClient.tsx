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
  buildValidationFromRows,
  loadXlsx,
  type FileValidation,
  type HeaderColumnKey,
  type SheetMapping,
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
import { groupSimilarRows } from "../../../lib/priceListSimilarity";

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
  // Multi-select lets the user tick several sheets to combine into one output (like the
  // pricelist importer). Off → a single selected sheet is the output.
  const [multiSelectEnabled, setMultiSelectEnabled] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
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
  const multiSheet = fileValidation.sheets.length > 1;

  const sheetReady = (sheet: SheetMapping | null | undefined) =>
    sheet?.selection.partNumber != null && sheet?.selection.listPrice != null;

  // Ticked sheets drive the output; in single-select mode only the active sheet is enabled.
  const enabledSheets = fileValidation.sheets.filter((s) => s.enabled);
  const enabledReadySheets = enabledSheets.filter(sheetReady);

  // Whether anything can be produced — at least one enabled sheet has Part Number + List Price.
  const canProduce = enabledReadySheets.length > 0;

  // The cost column is included when an enabled sheet already has one, or when the user opts
  // to generate it. Mode drives how each cost value is produced.
  const enabledHasCost = enabledSheets.some((s) => s.selection.costPrice != null);
  const includeCost = Boolean(enabledHasCost || generateCost);
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

  // Clean a single sheet using its own detected mapping + the global options. Each sheet
  // resolves its own decimal format (when "auto") and its own discount column (except the
  // active sheet, which honours the user's explicit discount-column choice).
  const cleanOneSheet = useCallback(
    (sheet: SheetMapping) => {
      const sel = sheet.selection;
      const lpIdx = sel.listPrice;
      if (sel.partNumber == null || lpIdx == null) return null;
      const hasCost = sel.costPrice != null;
      const mode: CostMode = hasCost ? costMode : generateCost ? "compute" : "none";
      const fmt =
        decimalFormat !== "auto"
          ? decimalFormat
          : detectDecimalFormat(sheet.allRows.map((r) => r[lpIdx]));
      const discIdx =
        sheet === activeSheet ? discountColumnIndex : suggestDiscountColumn(sheet.columns);
      return cleanupRows(sheet.allRows, {
        selection: sel,
        discountColumnIndex: discIdx,
        fileWideDiscountPercent: null,
        decimalFormat: fmt,
        costMode: mode,
        keepNonNumericPrice,
      });
    },
    [activeSheet, costMode, generateCost, decimalFormat, discountColumnIndex, keepNonNumericPrice],
  );

  // All cleaned rows (pre-AI, pre-lifecycle) + the aggregated summary — the source of truth for
  // the lifecycle scan and the download. Combines every ticked (enabled) sheet.
  const cleanedAll = useMemo(() => {
    const sheetsToClean = fileValidation.sheets.filter((s) => s.enabled);
    const results = sheetsToClean.map(cleanOneSheet).filter((r): r is NonNullable<typeof r> => r !== null);
    if (results.length === 0) return null;
    const rows = results.flatMap((r) => r.rows);
    const summary = results.reduce(
      (acc, r) => ({
        kept: acc.kept + r.summary.kept,
        trimmed: acc.trimmed + r.summary.trimmed,
        withCost: acc.withCost + r.summary.withCost,
        withoutCost: acc.withoutCost + r.summary.withoutCost,
        capped: acc.capped + r.summary.capped,
        zeroPriced: acc.zeroPriced + r.summary.zeroPriced,
      }),
      { kept: 0, trimmed: 0, withCost: 0, withoutCost: 0, capped: 0, zeroPriced: 0 },
    );
    return { rows, summary };
  }, [fileValidation.sheets, cleanOneSheet]);

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

  // The active (selected) sheet cleaned on its own — drives the preview and the AI descriptions,
  // so switching sheet tabs updates both even when merging. The merged `transformedAll` still
  // drives the download and the lifecycle scan.
  const cleanedActive = useMemo(
    () => (activeSheet && hasPartAndPrice ? cleanOneSheet(activeSheet) : null),
    [activeSheet, hasPartAndPrice, cleanOneSheet],
  );

  const previewTransformed = useMemo(
    () => (cleanedActive ? transformRows(cleanedActive.rows) : null),
    [cleanedActive, transformRows],
  );

  const previewRows = useMemo(() => previewTransformed?.slice(0, 20) ?? null, [previewTransformed]);

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

  const applyValidation = useCallback((result: FileValidation) => {
    setFileValidation(result);
    setMultiSelectEnabled(false); // default to a single selected sheet (the importer's default)
    const active = result.sheets[result.activeSheetIndex];
    if (active) {
      setDiscountColumnIndex(suggestDiscountColumn(active.columns));
      setCostMode(active.selection.costPrice != null ? "keepExisting" : "compute");
    } else {
      setDiscountColumnIndex(null);
    }
  }, []);

  const processFile = useCallback(
    async (nextFile: File) => {
      setFile(nextFile);
      setError(null);
      setAiByPartNumber({}); // a new file invalidates any prior AI descriptions
      setEolChoice("keep");

      const isPdf = nextFile.type === "application/pdf" || /\.pdf$/i.test(nextFile.name);
      if (isPdf) {
        setPdfLoading(true);
        setFileValidation((prev) => ({
          ...prev,
          status: "checking",
          message: "Extracting tables from the PDF with AI…",
        }));
        try {
          const formData = new FormData();
          formData.append("file", nextFile);
          const res = await fetch("/api/price-lists/cleanup/parse-pdf", {
            method: "POST",
            body: formData,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data?.ok) {
            setFileValidation({
              ...INITIAL_VALIDATION,
              status: "invalid",
              message: data?.error || "Could not read the PDF. Try an Excel/CSV export instead.",
            });
            return;
          }
          applyValidation(
            buildValidationFromRows(nextFile.name.replace(/\.pdf$/i, ""), data.aoa),
          );
        } catch (err) {
          console.error("PDF parse failed", err);
          setFileValidation({
            ...INITIAL_VALIDATION,
            status: "invalid",
            message: "Could not read the PDF. Please try an Excel/CSV export.",
          });
        } finally {
          setPdfLoading(false);
        }
        return;
      }

      setFileValidation((prev) => ({
        ...prev,
        status: "checking",
        message: "Checking file format…",
      }));
      applyValidation(await validateFileStructure(nextFile));
    },
    [applyValidation],
  );

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

  // Sync the per-sheet option defaults (discount column, cost mode) when the active sheet changes.
  const syncActiveSheetOptions = useCallback((sheet: SheetMapping | undefined) => {
    if (!sheet) return;
    setDiscountColumnIndex(suggestDiscountColumn(sheet.columns));
    setCostMode(sheet.selection.costPrice != null ? "keepExisting" : "compute");
  }, []);

  // Single-select: make this the only ticked sheet AND the active one (the output is just it).
  const handleSheetChange = useCallback(
    (targetIdx: number) => {
      const target = fileValidation.sheets[targetIdx];
      setFileValidation((prev) => {
        if (targetIdx < 0 || targetIdx >= prev.sheets.length) return prev;
        const sheets = prev.sheets.map((sheet, idx) => ({ ...sheet, enabled: idx === targetIdx }));
        const evaluation = evaluateSelection(sheets, targetIdx);
        return { ...prev, ...evaluation, sheets, activeSheetIndex: targetIdx };
      });
      syncActiveSheetOptions(target);
    },
    [fileValidation, syncActiveSheetOptions],
  );

  // Multi-select: just switch which sheet is shown for mapping/preview; keep the ticked set.
  const activateSheet = useCallback(
    (targetIdx: number) => {
      const target = fileValidation.sheets[targetIdx];
      setFileValidation((prev) => {
        if (targetIdx < 0 || targetIdx >= prev.sheets.length) return prev;
        const evaluation = evaluateSelection(prev.sheets, targetIdx);
        return { ...prev, ...evaluation, activeSheetIndex: targetIdx };
      });
      syncActiveSheetOptions(target);
    },
    [fileValidation, syncActiveSheetOptions],
  );

  // Multi-select: tick/untick whether a sheet is included in the combined output.
  const toggleSheetEnabled = useCallback((index: number, enabled: boolean) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) => (idx === index ? { ...sheet, enabled } : sheet));
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const handleImproveDescriptions = useCallback(async () => {
    if (!cleanedActive || aiRunning) return;
    const rows = cleanedActive.rows;
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

      // Group very similar products (e.g. the same line in different colours/sizes) so each
      // family is rewritten in one call and reads consistently. Then pack groups into batches of
      // up to AI_CHUNK rows WITHOUT splitting a group across batches — a family must stay in one
      // request to share a single LLM call.
      const groups = groupSimilarRows(rows);
      const batches: number[][][] = [];
      let current: number[][] = [];
      let currentCount = 0;
      for (const group of groups) {
        if (currentCount > 0 && currentCount + group.length > AI_CHUNK) {
          batches.push(current);
          current = [];
          currentCount = 0;
        }
        current.push(group);
        currentCount += group.length;
      }
      if (current.length > 0) batches.push(current);

      let done = 0;
      for (const batch of batches) {
        const payload = batch.flatMap((group) => {
          // Tag multi-member families with a stable key (their lowest row index); singletons go
          // unkeyed so the server keeps the original per-row path for them.
          const groupKey = group.length > 1 ? `g${group[0]}` : "";
          return group.map((idx) => {
            const r = rows[idx];
            return {
              id: idx,
              partNumber: r.partNumber,
              modelNumber: r.modelNumber ?? "",
              description: r.description ?? "",
              ...(groupKey ? { groupKey } : {}),
            };
          });
        });
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
        done += payload.length;
        setAiByPartNumber({ ...acc });
        setAiProgress({ done: Math.min(done, rows.length), total: rows.length });
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
  }, [cleanedActive, aiRunning, aiByPartNumber, brand]);

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
      const combinedSheetCount = fileValidation.sheets.filter(
        (s) => s.enabled && s.selection.partNumber != null && s.selection.listPrice != null,
      ).length;
      if (combinedSheetCount > 1) {
        parts.push(`merged ${combinedSheetCount} sheets`);
      }
      if (includeCost) {
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
    fileValidation.sheets,
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
            disabled={!canProduce || processing || pdfLoading}
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
            accept=".xlsx,.xlsm,.xls,.csv,.pdf"
            className={styles.fileInput}
            onChange={handleFileChange}
            autoComplete="off"
          />
          <div className={styles.uploadText}>
            <div className={styles.uploadTitle}>Drop your Excel or PDF file here</div>
            <div className={styles.uploadSubtitle}>
              Excel/CSV or PDF (tables are extracted with AI). Required columns: Part Number and
              List Price.
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

        {multiSheet ? (
          <div className={styles.sheetSelector}>
            <div className={styles.sheetToggle}>
              <span>Multi-select</span>
              <button
                type="button"
                tabIndex={-1}
                className={`${styles.toggleSwitch} ${multiSelectEnabled ? styles.toggleSwitchOn : ""}`}
                onClick={() => setMultiSelectEnabled((prev) => !prev)}
              >
                <span className={styles.toggleKnob} />
              </button>
            </div>
            <div className={styles.sheetTabs}>
              {fileValidation.sheets.map((sheet, idx) => {
                const isActive = idx === fileValidation.activeSheetIndex;
                const included = sheet.enabled;
                return (
                  <button
                    type="button"
                    key={sheet.name || idx}
                    className={`${styles.sheetTab} ${isActive ? styles.sheetTabActive : ""} ${included ? styles.sheetTabIncluded : ""}`}
                    onClick={() => (multiSelectEnabled ? activateSheet(idx) : handleSheetChange(idx))}
                  >
                    {multiSelectEnabled ? (
                      <input
                        type="checkbox"
                        checked={included}
                        className={styles.sheetTabCheckbox}
                        onChange={(event) => {
                          event.stopPropagation();
                          toggleSheetEnabled(idx, event.target.checked);
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : null}
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
            <div className={styles.intro}>
              {multiSelectEnabled
                ? "Tick the sheets to combine into one output. Click a tab to preview and map its columns."
                : "Click a sheet to use it. Turn on Multi-select to combine several sheets into one output."}
            </div>
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
              specs). Very similar products (the same line in different colours/sizes) are rewritten
              together so their descriptions stay consistent. Nothing is saved — only your downloaded
              file changes.
              {enabledReadySheets.length > 1
                ? " Only the selected sheet's descriptions are processed — switch tabs to run it on another sheet."
                : ""}
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
                <span>
                  Cleaned preview (first product rows)
                  {multiSheet ? ` — ${activeSheet?.name ?? "active sheet"}` : ""}
                </span>
                <span className={styles.previewHint}>
                  Normalized output columns{includeCost ? "; the Cost Price column is bold" : ""}.
                  {enabledReadySheets.length > 1
                    ? ` Showing the selected sheet; the download combines ${enabledReadySheets.length} sheets.`
                    : ""}
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
