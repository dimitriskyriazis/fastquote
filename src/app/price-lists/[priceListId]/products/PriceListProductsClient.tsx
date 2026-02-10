"use client";

import React, { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  MenuItemDef,
  ValueFormatterParams,
} from "ag-grid-community";
import layoutStyles from "../../priceListDetail.module.css";
import pageStyles from "./PriceListProductsPage.module.css";
import { GridRowDeletion } from "../../../../lib/gridRowDeletion";
import { getUserNumberLocale } from "../../../../lib/localeNumber";
import { normalizeBoolean } from "../../../../lib/normalizeBoolean";
import { showToastMessage } from "../../../../lib/toast";

const AgGridAll = dynamic(() => import("../../../components/AgGridAll"), {
  ssr: false,
  loading: () => <div>Loading price list products…</div>,
});

type Props = {
  priceListId: string;
  headingText: string;
  priceListLabel: string;
};

type PriceListProductRowGrid = {
  ProductID?: number | null;
  PriceListItemID?: number | null;
  Description?: string | null;
  PartNumber?: string | null;
  ModelNumber?: string | null;
  ListPrice?: string | number | null;
  CostPrice?: string | number | null;
  Warning?: string | number | boolean | null;
  Enabled?: boolean | number | null;
  PriceListID?: number | null;
};

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatCurrency = (params: ValueFormatterParams) => {
  const value = params?.value;
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${currencyFormatter.format(num)} €`;
};

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

const normalizePriceListItemId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const resolvePriceListRowLabel = (row: PriceListProductRowGrid | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const normalize = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : value ? String(value) : "";
  const partNumber = normalize(row.PartNumber);
  const description = normalize(row.Description);
  if (partNumber && description) return `${partNumber} – ${description}`;
  if (partNumber) return partNumber;
  if (description) return description;
  return fallback;
};

const PRICE_LIST_ROW_TYPE_LABEL = "price list item";
const TWO_CONDITION_FILTER_PARAMS = {
  maxNumConditions: 2,
  alwaysShowBothConditions: true,
  defaultJoinOperator: "AND" as const,
};

const PRICE_LIST_FIELD_LABELS: Record<string, string> = {
  Enabled: "Enabled",
};

const productHistoryMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--history" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5a7 7 0 1 1-7 7" />
      <path d="M12 9v4l2.6 1.5" />
      <path d="M5 7 4 4l3 1" />
    </svg>
  </span>
`;

export default function PriceListProductsClient({
  priceListId,
  headingText,
  priceListLabel,
}: Props) {
  const endpoint = useMemo(
    () => `/api/price-lists/${encodeURIComponent(priceListId)}/products`,
    [priceListId],
  );
  const router = useRouter();
  const enabledOptions = useMemo(() => ["Yes", "No"], []);

  const columnDefs: ColDef[] = useMemo(
    () => [
      {
        colId: "__seq__",
        headerName: "#",
        width: 64,
        suppressMovable: true,
        suppressSizeToFit: true,
        sortable: false,
        filter: false,
        valueGetter: (params) => {
          const idx = params.node?.rowIndex;
          return typeof idx === "number" && idx >= 0 ? idx + 1 : "";
        },
      },
      {
        field: "PriceListItemID",
        hide: true,
        suppressColumnsToolPanel: true,
      },
      {
        field: "Description",
        headerName: "Product",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
      },
      {
        field: "PartNumber",
        headerName: "Part Number",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 160,
      },
      {
        field: "ListPrice",
        headerName: "List Price",
        filter: "agNumberColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        valueFormatter: formatCurrency,
        type: "numericColumn",
        width: 140,
      },
      {
        field: "CostPrice",
        headerName: "Cost Price",
        filter: "agNumberColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        valueFormatter: formatCurrency,
        type: "numericColumn",
        width: 140,
      },
      {
        field: "Warning",
        headerName: "Warning",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 140,
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        valueFormatter: (params) => formatEnabledValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatEnabledValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
        },
        width: 110,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
      {
        field: "PriceListID",
        headerName: "Price List ID",
        hide: true,
        suppressColumnsToolPanel: true,
      },
    ],
    [enabledOptions],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in PRICE_LIST_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const priceListItemId = normalizePriceListItemId(
      (event.data as { PriceListItemID?: unknown } | undefined)?.PriceListItemID ?? null,
    );
    if (priceListItemId == null) return;
    const label = PRICE_LIST_FIELD_LABELS[field] ?? field;
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
    const value = normalizeBoolean(
      (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
    );

    const submit = async () => {
      try {
        const res = await fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ PriceListItemID: priceListItemId, field, value }] }),
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
  }, [endpoint]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
      filterParams: TWO_CONDITION_FILTER_PARAMS,
    }),
    [],
  );

  const historyBackHref = `/price-lists/${encodeURIComponent(priceListId)}/products`;
  const historyBackLabel = priceListLabel?.trim() ? priceListLabel.trim() : "price list";

  const priceListRowDeletion = useMemo(
    () =>
      new GridRowDeletion<PriceListProductRowGrid>({
        endpoint,
        resolveRowId: (row) => normalizePriceListItemId(row?.PriceListItemID ?? null),
        resolveRowLabel: resolvePriceListRowLabel,
        resolveRowTypeLabel: () => PRICE_LIST_ROW_TYPE_LABEL,
        buildPayload: (ids) => ({ PriceListItemIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? "Delete price list item" : "Delete price list items"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete price list item" : "Delete price list items"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep item" : "Keep items"),
        successToastMessage: "Price list item deleted",
        failureToastMessage: "Unable to delete price list item. Please try again.",
      }),
    [endpoint],
  );

  const priceListContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const baseItems = priceListRowDeletion.getContextMenuItems(params) ?? [];
      const items = [...baseItems];
      const rowData = params.node?.data ?? null;
      if (!rowData) {
        return items;
      }

      const rawProductId = (rowData as { ProductID?: unknown }).ProductID;
      const productId =
        typeof rawProductId === "number"
          ? rawProductId
          : typeof rawProductId === "string"
            ? Number.parseInt(rawProductId, 10)
            : null;

      if (!productId || !Number.isInteger(productId)) {
        return items;
      }

      const historyItem: MenuItemDef = {
        name: "View Product's History",
        icon: productHistoryMenuIcon,
        action: () => {
          const qs = new URLSearchParams();
          qs.set("backHref", historyBackHref);
          qs.set("backLabel", historyBackLabel);
          void router.push(
            `/products/${encodeURIComponent(String(productId))}/history?${qs.toString()}`,
          );
        },
      };

      const deleteIndex = items.findIndex(
        (item) =>
          typeof item === "object" &&
          item != null &&
          typeof (item as MenuItemDef).name === "string" &&
          (item as MenuItemDef).name.trim().toLowerCase().startsWith("delete"),
      );
      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, historyItem);
        return items;
      }
      items.push(historyItem);
      return items;
    },
    [historyBackHref, historyBackLabel, priceListRowDeletion, router],
  );

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/price-lists" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to price lists
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <Link
            href={`/price-lists/${encodeURIComponent(priceListId)}/basicdata`}
            className={`${layoutStyles.headerActionButton} page-header-button`}
          >
            View Basic Data
          </Link>
        </div>
      </div>
      <div className={`${layoutStyles.pageBody} ${pageStyles.gridShell}`}>
        <div className={`${pageStyles.gridWrapper} ${pageStyles.bandedRows}`}>
          <AgGridAll
            endpoint={endpoint}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getContextMenuItems={priceListContextMenuItems}
            onCellValueChanged={handleCellEdit}
            rowGroupPanelShow="never"
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
          />
        </div>
      </div>
    </main>
  );
}
