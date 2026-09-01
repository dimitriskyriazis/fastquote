"use client";

import React, { useMemo, useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  CellValueChangedEvent,
  ColDef,
  GridApi,
} from "ag-grid-community";
import { useAuditUser } from "../components/AuditUserProvider";
import AccessDeniedPage from "../components/AccessDeniedPage";
import styles from "./PaymentTermsClient.module.css";
import LookupModal from "../components/LookupModal";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { showToastMessage } from "../../lib/toast";
import { showConfirmDialog } from "../../lib/confirm";
import { useUndoStack } from "../hooks/useUndoStack";
import { pushCellEditUndo, makePatternAUndoFn } from "../../lib/undoHelpers";
import { useAddModal } from "../lib/useAddModal";
import {
  createPaymentTerm,
  EMPTY_PAYMENT_TERM_FORM,
  PaymentTermFormValues,
  validatePaymentTermForm,
} from "./paymentTermModalHelpers";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading payment terms…
    </div>
  ),
});

const normalizeTermId = (value: unknown): number | null => {
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

const PAYMENT_TERM_FIELD_LABELS: Record<string, string> = {
  Name: "Payment term name",
  DescriptionGR: "Greek description",
  DescriptionEN: "English description",
  Enabled: "Enabled",
};

// DescriptionGR/DescriptionEN are absent from GLOBAL_COLUMN_WIDTH_ASSIGNMENTS and
// their colDefs carry no width, so without this they fall back to 100px. The widest
// preset (3) is only 210px and these hold full sentences, so they take explicit
// pixels instead. Module scope on purpose: an inline literal would change identity
// on every render.
const columnWidthDefaults = { DescriptionGR: 420, DescriptionEN: 420 };

export default function PaymentTermsClient() {
  const { roles, loading } = useAuditUser();
  const canAccess = roles.includes("Administrator") || roles.includes("Developer");
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => [true, false], []);
  const [refreshToken, setRefreshToken] = useState(0);
  const {
    values: paymentTermForm,
    setField: setPaymentTermField,
    isOpen: isAddPaymentTermOpen,
    open: openAddPaymentTerm,
    close: closeAddPaymentTerm,
    saving: paymentTermSaving,
    error: paymentTermError,
    setSaving: setPaymentTermSaving,
    setError: setPaymentTermError,
  } = useAddModal<PaymentTermFormValues>(() => ({ ...EMPTY_PAYMENT_TERM_FORM }));

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

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        // Shown on purpose: the id encodes the business ordering of the terms.
        field: "PaymentTermID",
        headerName: "ID",
        type: "numericColumn",
        width: 90,
        filter: "agNumberColumnFilter",
        editable: false,
      },
      {
        field: "Name",
        headerName: "Payment Term",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "DescriptionGR",
        headerName: "Description (GR)",
        filter: "agTextColumnFilter",
        editable: true,
        tooltipField: "DescriptionGR",
      },
      {
        field: "DescriptionEN",
        headerName: "Description (EN)",
        filter: "agTextColumnFilter",
        editable: true,
        tooltipField: "DescriptionEN",
      },
      {
        field: "CustomerCount",
        headerName: "Customers",
        type: "numericColumn",
        width: 110,
        // filter: false is mandatory. CustomerCount is a SQL alias, so a filter
        // would emit WHERE [CustomerCount] = ..., which SQL Server rejects.
        filter: false,
        editable: false,
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        width: 130,
        valueFormatter: (params) => formatBooleanValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
        },
        editable: true,
        cellEditor: "agSelectCellEditor",
        // Booleans, not the "Yes"/"No" strings other grids pass here. agSelectCellEditor
        // preselects by strict equality against the cell value (a real boolean) and falls
        // back to values[0] when nothing matches, so strings would make every disabled
        // term open showing "Yes" and silently re-enable it on tab-out. The column's own
        // valueFormatter renders these options as Yes/No.
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    [enabledOptions],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    // Load-bearing, and it must stay ahead of everything else. revertValue() below and
    // makePatternAUndoFn both write through node.setDataValue, which AG Grid dispatches
    // back into this handler as a fresh cellValueChanged. That echo carries genuinely
    // different old and new values (it IS a change), so only the source tells it apart
    // from a user edit. Without this, cancelling the disable confirm would still PATCH,
    // and every Undo would push a new inverted undo entry. Do not move it past any await.
    if ((event as { source?: string }).source === "api") return;
    if (event.newValue === event.oldValue) return;
    if (!field || !(field in PAYMENT_TERM_FIELD_LABELS)) return;
    const termId = normalizeTermId(
      (event.data as { PaymentTermID?: unknown } | undefined)?.PaymentTermID ?? null,
    );
    if (termId == null) return;
    const label = PAYMENT_TERM_FIELD_LABELS[field] ?? field;
    const revertValue = () => {
      if (event.node) {
        try {
          // Source 'api' so the echo bails at the top of this handler.
          event.node.setDataValue(field, event.oldValue, "api");
          return;
        } catch {
          /* noop */
        }
      }
      event.api.refreshCells({ force: true });
    };
    const value =
      field === "Enabled"
        ? normalizeBoolean(
            (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
          )
        : normalizeTextValue(event.newValue);

    const submit = async () => {
      if (field === "Enabled" && value === false) {
        // Disabling replaces deletion here, but Enabled = 0 is honoured only by the
        // customer dropdown, never by a read join: customers already pointing at the
        // term keep it, and their select renders blank.
        const assigned = Number((event.data as { CustomerCount?: unknown })?.CustomerCount ?? 0);
        if (assigned > 0) {
          const ok = await showConfirmDialog({
            title: 'Disable payment term',
            message: `${assigned} customer(s) are still assigned to this payment term. Disabling it removes it from the customer dropdown but leaves those customers pointing at it. Continue?`,
            confirmLabel: 'Disable',
            cancelLabel: 'Keep enabled',
            tone: 'danger',
          });
          if (!ok) {
            revertValue();
            return;
          }
        }
      }
      try {
        const res = await fetch("/api/payment-terms", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ PaymentTermID: termId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: "/api/payment-terms",
          idField: "PaymentTermID",
          entityId: termId,
          field,
          oldValue: event.oldValue,
          node: event.node,
          gridApi: event.api,
        }));
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        // The PATCH route authors user-facing text for every rejection it can name
        // (blank value, over-length name, duplicate name), so surface it rather than
        // replacing it with a generic retry message the admin cannot act on.
        const message =
          err instanceof Error && err.message ? err.message : `Unable to update ${label}. Please try again.`;
        showToastMessage(message, "error");
        revertValue();
      }
    };

    void submit();
  }, [pushUndo, performUndo]);

  const handleCreatePaymentTerm = useCallback(async () => {
    const validationError = validatePaymentTermForm(paymentTermForm);
    if (validationError) {
      setPaymentTermError(validationError);
      showToastMessage(validationError, "error");
      return;
    }
    setPaymentTermSaving(true);
    setPaymentTermError(null);
    const result = await createPaymentTerm(paymentTermForm);
    if (!result.ok) {
      const message = result.error ?? "Unable to add payment term.";
      setPaymentTermError(message);
      showToastMessage(message, "error");
      setPaymentTermSaving(false);
      return;
    }
    closeAddPaymentTerm();
    setPaymentTermSaving(false);
    setRefreshToken((prev) => prev + 1);
    // No undo entry for a create: there is no DELETE endpoint for payment terms,
    // so disabling the new row is the only way back.
    const termName = result.paymentTerm?.Name ?? paymentTermForm.name;
    showToastMessage(`Payment term "${termName}" added`, "success");
  }, [paymentTermForm, closeAddPaymentTerm, setPaymentTermError, setPaymentTermSaving, setRefreshToken]);

  // Checked before canAccess on purpose: roles resolve asynchronously, so testing
  // canAccess first flashes Access Denied at every Administrator.
  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.loading}>Loading access...</div>
      </main>
    );
  }

  if (!canAccess) {
    return <AccessDeniedPage />;
  }

  return (
    <main className={styles.page}>
      <PageHeader
        title="Payment Terms"
        leftActions={
          <>
            {canUndo && (
              <button type="button" className={`page-header-button ${styles.headerButton}`} onClick={performUndo}>
                ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
              </button>
            )}
          </>
        }
        rightActions={
          <div className={styles.headerActions}>
            <button
              type="button"
              className={`${styles.headerButton} page-header-button`}
              onClick={openAddPaymentTerm}
            >
              Add Payment Term
            </button>
          </div>
        }
      >
        <GridQuickSearchProvider>
          <div className={`${styles.gridFrame} fq-grid-panel`}>
            <AgGridAll
              endpoint="/api/payment-terms"
              columnDefs={columnDefs}
              columnWidthDefaults={columnWidthDefaults}
              columnStateNamespace="payment-terms"
              rowGroupPanelShow="never"
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              refreshToken={refreshToken}
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
      <LookupModal
        open={isAddPaymentTermOpen}
        title="Add payment term"
        onClose={closeAddPaymentTerm}
        onConfirm={handleCreatePaymentTerm}
        confirmLabel="Add payment term"
        saving={paymentTermSaving}
        error={paymentTermError}
      >
        <div className={styles.termModalGrid}>
          <div className={`${styles.termModalField} ${styles.termModalFieldFull}`}>
            <label className={styles.fieldLabel} htmlFor="payment-term-name">
              Payment term name <span className={styles.fieldRequired}>*</span>
            </label>
            <input
              id="payment-term-name"
              className={styles.fieldControl}
              value={paymentTermForm.name}
              required
              onChange={(event) => setPaymentTermField("name", event.target.value)}
            />
          </div>
          <div className={`${styles.termModalField} ${styles.termModalFieldFull}`}>
            <label className={styles.fieldLabel} htmlFor="payment-term-description-gr">
              Description (GR) <span className={styles.fieldRequired}>*</span>
            </label>
            <input
              id="payment-term-description-gr"
              className={styles.fieldControl}
              value={paymentTermForm.descriptionGR}
              required
              onChange={(event) => setPaymentTermField("descriptionGR", event.target.value)}
            />
          </div>
          <div className={`${styles.termModalField} ${styles.termModalFieldFull}`}>
            <label className={styles.fieldLabel} htmlFor="payment-term-description-en">
              Description (EN) <span className={styles.fieldRequired}>*</span>
            </label>
            <input
              id="payment-term-description-en"
              className={styles.fieldControl}
              value={paymentTermForm.descriptionEN}
              required
              onChange={(event) => setPaymentTermField("descriptionEN", event.target.value)}
            />
          </div>
          <div className={`${styles.termModalField} ${styles.termModalToggle}`}>
            <label className={styles.fieldLabel} htmlFor="payment-term-enabled">
              Enabled
            </label>
            <label className={styles.termToggleControl} htmlFor="payment-term-enabled">
              <input
                id="payment-term-enabled"
                type="checkbox"
                checked={paymentTermForm.enabled}
                onChange={(event) => setPaymentTermField("enabled", event.target.checked)}
              />
              {paymentTermForm.enabled ? "Yes" : "No"}
            </label>
          </div>
        </div>
      </LookupModal>
    </main>
  );
}
