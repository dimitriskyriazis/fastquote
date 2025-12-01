"use client";

import React, { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { ColDef, GetContextMenuItemsParams, ValueFormatterParams } from "ag-grid-community";
import layoutStyles from "../../priceListDetail.module.css";
import pageStyles from "./PriceListProductsPage.module.css";
import { GridRowDeletion } from "../../../../lib/gridRowDeletion";

const AgGridAll = dynamic(() => import("../../../components/AgGridAll"), {
  ssr: false,
  loading: () => <div>Loading price list products…</div>,
});

type Props = {
  priceListId: string;
  headingText: string;
};

type PriceListProductRowGrid = {
  PriceListItemID?: number | null;
  Description?: string | null;
  PartNumber?: string | null;
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatCurrency = (params: ValueFormatterParams) => {
  const value = params?.value;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return value == null ? "" : String(value);
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

export default function PriceListProductsClient({ priceListId, headingText }: Props) {
  const endpoint = useMemo(
    () => `/api/price-lists/${encodeURIComponent(priceListId)}/products`,
    [priceListId],
  );

  const columnDefs: ColDef[] = useMemo(
    () => [
      {
        colId: "__seq__",
        headerName: "#",
        maxWidth: 80,
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
        flex: 1,
        minWidth: 220,
      },
      {
        field: "PartNumber",
        headerName: "Part Number",
        filter: "agTextColumnFilter",
        width: 160,
        minWidth: 140,
      },
      {
        field: "ListPrice",
        headerName: "List Price",
        filter: "agNumberColumnFilter",
        valueFormatter: formatCurrency,
        type: "numericColumn",
        width: 140,
      },
      {
        field: "Warning",
        headerName: "Warning",
        filter: "agTextColumnFilter",
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
          buttons: ["apply", "clear"],
          closeOnApply: true,
        },
        width: 110,
      },
      {
        field: "PriceListID",
        headerName: "Price List ID",
        hide: true,
        suppressColumnsToolPanel: true,
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
    }),
    [],
  );

  const priceListRowDeletion = useMemo(
    () =>
      new GridRowDeletion<PriceListProductRowGrid>({
        endpoint,
        resolveRowId: (row) => normalizePriceListItemId(row?.PriceListItemID ?? null),
        resolveRowLabel: resolvePriceListRowLabel,
        resolveRowTypeLabel: () => PRICE_LIST_ROW_TYPE_LABEL,
        buildPayload: (ids) => ({ PriceListItemIDs: ids }),
        confirmTitle: "Delete price list item",
        confirmConfirmLabel: "Delete price list item",
        confirmCancelLabel: "Keep item",
        successToastMessage: "Price list item deleted",
        failureToastMessage: "Unable to delete price list item. Please try again.",
      }),
    [endpoint],
  );

  const priceListContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      priceListRowDeletion.getContextMenuItems(params),
    [priceListRowDeletion],
  );

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/price-lists" className={layoutStyles.backLink}>
            <span aria-hidden="true">←</span>
            Back to price lists
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <Link
            href={`/price-lists/${encodeURIComponent(priceListId)}/basic`}
            className={layoutStyles.headerActionButton}
          >
            View basic data
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
          />
        </div>
      </div>
    </main>
  );
}
