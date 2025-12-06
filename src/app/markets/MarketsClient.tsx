"use client";

import React, { useMemo, useCallback, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { CellValueChangedEvent, ColDef, GridApi, GetContextMenuItemsParams } from "ag-grid-community";
import styles from "./MarketsClient.module.css";
import { showToastMessage } from "../../lib/toast";
import {
  createMarket,
  EMPTY_MARKET_FORM,
  MarketFormValues,
  validateMarketForm,
} from "./marketModalHelpers";
import { useAddModal } from "../lib/useAddModal";
import { GridRowDeletion } from "../../lib/gridRowDeletion";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading markets…
    </div>
  ),
});

type Props = {
  salesDivisions: string[];
};

const resolveEnabledState = (value: unknown): boolean | null => {
  if (value === 1 || value === true || value === "true" || value === "Yes") return true;
  if (value === 0 || value === false || value === "false" || value === "No") return false;
  return null;
};

const formatBooleanValue = (value: unknown) => {
  const state = resolveEnabledState(value);
  if (state === true) return "Yes";
  if (state === false) return "No";
  return "";
};

const normalizeEnabledInput = (value: unknown): boolean => {
  const state = resolveEnabledState(value);
  return state === true;
};

const normalizeMarketId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const MARKET_FIELD_LABELS: Record<string, string> = {
  Name: "Market name",
  SalesDivision: "Sales division",
  Enabled: "Enabled",
};

export default function MarketsClient({ salesDivisions }: Props) {
  const defaultEnabledFilterAppliedRef = useRef(false);
  const salesDivisionOptions = useMemo(() => {
    const unique = new Set(
      salesDivisions.map((name) => (typeof name === "string" ? name.trim() : "")).filter(Boolean),
    );
    return Array.from(unique);
  }, [salesDivisions]);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const [refreshToken, setRefreshToken] = useState(0);
  const {
    values: marketForm,
    setField: setMarketField,
    isOpen: isAddMarketOpen,
    open: openAddMarket,
    close: closeAddMarket,
    saving: marketSaving,
    error: marketError,
    setSaving: setMarketSaving,
    setError: setMarketError,
  } = useAddModal<MarketFormValues>(() => ({ ...EMPTY_MARKET_FORM }));

  type MarketRow = {
    MarketID: number | null;
    Name: string | null;
    SalesDivision: string | null;
    Enabled: boolean | number | null;
  };

  const marketRowDeletion = useMemo(
    () =>
      new GridRowDeletion<MarketRow>({
        endpoint: "/api/markets",
        resolveRowId: (row) => {
          const candidate = row?.MarketID;
          return typeof candidate === "number" ? candidate : null;
        },
        resolveRowLabel: (row, fallback) => {
          const name = row?.Name;
          if (typeof name === "string" && name.trim().length > 0) return name.trim();
          return fallback;
        },
        resolveRowTypeLabel: () => "market",
        buildPayload: (ids) => ({ MarketIDs: ids }),
        confirmTitle: "Delete market",
        confirmConfirmLabel: "Delete market",
        confirmCancelLabel: "Keep market",
        successToastMessage: (_, label) => `${label} deleted`,
        failureToastMessage: "Unable to delete market. Please try again.",
        refreshHandler: (api) => {
          if (!api || typeof api.refreshServerSide !== "function") return;
          try {
            api.refreshServerSide({ purge: true });
          } catch (err) {
            console.warn("Failed to refresh markets grid after deletion", err);
          }
        },
      }),
    [],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<MarketRow>) => marketRowDeletion.getContextMenuItems(params),
    [marketRowDeletion],
  );

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api || defaultEnabledFilterAppliedRef.current) return;
    const existingModel = api.getFilterModel() as Record<string, unknown> | null;
    const nextModel = existingModel && typeof existingModel === "object" ? { ...existingModel } : {};
    if ("Enabled" in nextModel) {
      defaultEnabledFilterAppliedRef.current = true;
      return;
    }
    api.setFilterModel({
      ...nextModel,
      Enabled: { filterType: "set", values: ["true"] },
    });
    defaultEnabledFilterAppliedRef.current = true;
  }, []);

  const handleCreateMarket = useCallback(async () => {
    const validationError = validateMarketForm(marketForm);
    if (validationError) {
      setMarketError(validationError);
      showToastMessage(validationError, "error");
      return;
    }
    setMarketSaving(true);
    setMarketError(null);
    const result = await createMarket(marketForm);
    if (!result.ok) {
      const message = result.error ?? "Unable to add market.";
      setMarketError(message);
      showToastMessage(message, "error");
      setMarketSaving(false);
      return;
    }
    closeAddMarket();
    setMarketSaving(false);
    setRefreshToken((prev) => prev + 1);
    showToastMessage("Market added", "success");
  }, [marketForm, closeAddMarket, setMarketError, setMarketSaving]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "Name",
        headerName: "Market",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 200,
        editable: true,
      },
      {
        field: "SalesDivision",
        headerName: "Sales Division",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 200,
        flex: 1,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: salesDivisionOptions,
        },
        valueSetter: (params) => {
          const next = typeof params.newValue === "string" ? params.newValue : "";
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).SalesDivision = next;
          return true;
        },
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        valueFormatter: (params) => formatBooleanValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
          buttons: ["apply"],
          closeOnApply: true,
        },
        width: 120,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: enabledOptions,
        },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeEnabledInput(params.newValue);
          return true;
        },
      },
    ],
    [enabledOptions, salesDivisionOptions],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in MARKET_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const marketId = normalizeMarketId(
      (event.data as { MarketID?: unknown } | undefined)?.MarketID ?? null,
    );
    if (marketId == null) return;
    const label = MARKET_FIELD_LABELS[field] ?? field;
    const revertValue = () => {
      if (event.node) {
        try {
          event.node.setDataValue(field, event.oldValue);
          return;
        } catch {
          /* noop */
        }
      }
      event.api.refreshCells({ force: true });
    };
    const value =
      field === "Enabled"
        ? normalizeEnabledInput(
            (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
          )
        : normalizeTextValue(event.newValue);

    const submit = async () => {
      try {
        const res = await fetch("/api/markets", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ MarketID: marketId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        showToastMessage(`${label} updated`, "success");
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, "error");
        revertValue();
      }
    };

    void submit();
  }, []);

  return (
    <>
      <main className={styles.page}>
        <div className={styles.headerRow}>
          <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
            <Link href="/offers" className={`page-header-button ${styles.headerButton}`}>
              <span aria-hidden="true">←</span>
              Back to offers
            </Link>
          </div>
          <h1 className={styles.heading}>Markets</h1>
          <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
            <div className={styles.headerActions}>
                <button
                  type="button"
                  className={`page-header-button ${styles.headerButton}`}
                  onClick={openAddMarket}
                >
                  Add Market
                </button>
            </div>
          </div>
        </div>
        <div className={styles.gridFrame}>
          <AgGridAll
            endpoint="/api/markets"
            columnDefs={columnDefs}
            rowGroupPanelShow="always"
            columnStateNamespace="markets"
            onGridReady={handleGridReady}
            onCellValueChanged={handleCellEdit}
            refreshToken={refreshToken}
            getContextMenuItems={getContextMenuItems}
          />
        </div>
      </main>
      {isAddMarketOpen ? (
        <div
          className={styles.marketModalOverlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeAddMarket();
            }
          }}
        >
        <div className={styles.marketModalCard} role="dialog" aria-modal="true" aria-label="Add market">
          <div className={styles.marketModalHeader}>
            <div>
              <div className={styles.marketModalTitle}>Add Market</div>
            </div>
            <button
              type="button"
              className={styles.marketModalClose}
              aria-label="Close add market form"
              onClick={closeAddMarket}
            >
              ×
            </button>
          </div>
          <div className={styles.marketModalBody}>
            <div className={styles.marketModalGrid}>
              <div className={styles.marketModalField}>
                <label className={styles.fieldLabel} htmlFor="market-name">
                  Market name
                </label>
                <input
                  autoComplete="off"
                  id="market-name"
                  className={styles.fieldControl}
                  value={marketForm.name}
                  onChange={(event) => setMarketField("name", event.target.value)}
                />
              </div>
              <div className={styles.marketModalField}>
                <label className={styles.fieldLabel} htmlFor="market-sales-division">
                  Sales division
                </label>
                <select
                  id="market-sales-division"
                  className={styles.fieldControl}
                  value={marketForm.salesDivision}
                  onChange={(event) => setMarketField("salesDivision", event.target.value)}
                >
                  <option value="">Select division...</option>
                  {salesDivisionOptions.map((division) => (
                    <option key={division} value={division}>
                      {division}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`${styles.marketModalField} ${styles.marketModalToggle}`}>
                <label className={styles.fieldLabel} htmlFor="market-enabled">
                  Enabled
                </label>
                <label className={styles.marketToggleControl} htmlFor="market-enabled">
                  <input
                    id="market-enabled"
                    type="checkbox"
                    checked={marketForm.enabled}
                  onChange={(event) => setMarketField("enabled", event.target.checked)}
                  />
                  {marketForm.enabled ? "Yes" : "No"}
                </label>
              </div>
            </div>
            {marketError ? <div className={styles.marketModalError}>{marketError}</div> : null}
          </div>
          <div className={styles.marketModalFooter}>
            <button
              type="button"
              className={`page-header-button ${styles.marketModalCancel}`}
              onClick={closeAddMarket}
              disabled={marketSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`page-header-button ${styles.marketSaveButton}`}
              onClick={handleCreateMarket}
              disabled={marketSaving}
            >
              {marketSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
      ) : null}
    </>
  );
}
