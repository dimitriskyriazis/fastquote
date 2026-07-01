/**
 * Column definition builders for the offer products grid.
 *
 * Extracted from OfferProductsPanel to reduce file size. The main component
 * wraps these in useMemo with the same dependency arrays.
 */

import React from 'react';
import type {
  CellClassParams,
  CellStyle,
  ColDef,
  ICellRendererParams,
  IRowNode,
  ValueFormatterParams,
  ValueGetterParams,
  ValueSetterParams,
} from 'ag-grid-community';
import styles from './OfferProductsPanel.module.css';
import MultilineTextCellEditor from './MultilineTextCellEditor';
import {
  coerceNumber,
  percentageFormatter,
  buildCurrencyFormatter,
  zeroBlankNumberFormatter,
  compareTreeOrderingValues,
  isRequestedDescriptionField,
  canEditRequestedField,
  normalizeDescriptionValue,
  normalizeRequestedLookupValue,
  normalizeRequestedQuantityValue,
  normalizeRequestedItemNoValue,
  isRequestedRow,
  isUnassignedRequestedRow,
  isOfferProductCommentOrProduct,
  categoryTotalPriceGetter,
  categoryTotalNetGetter,
  categoryTotalCostGetter,
  productAccentCellClassRules,
  productPriceListClassRules,
  totalPriceCellClassRules,
  REQUESTED_DISPLAY_FIELD_KEYS,
  DESCRIPTION_PASTE_BLOCKLIST,
  type RequestedDisplayFieldKey,
} from './offerProductsUtils';
import { isOfferProductProduct, isOfferProductCategory, isOfferProductComment, isOfferProductService, isOfferProductOption, isNonPrintableOfferProductRow, resolveOfferProductRowType } from '../../../lib/offerProductRows';
import { CELL_PAINT_MARKER_CLASS, isDarkColor, type ResolvePaintColor } from './products/offerCellPaint';
import { deriveMarkupFactor, markupFactorFromMargin } from '../../../lib/pricing';
import { getUserNumberLocale } from '../../../lib/localeNumber';

const otherCurrencyAmountFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

// Markup is shown as a cost multiplier (e.g. 1,25), not a percentage.
const markupFactorFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/* ── Constants ───────────────────────────────────────────────────────── */

const ACTUAL_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--actual';
const TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--truncate';

/* ── Requested column definitions ────────────────────────────────────── */

export type RequestedColumnDefsDeps = {
  requestedCellClassRules: Record<string, (params: { data?: CellStyle | null }) => boolean>;
  truncateCellStyle: CellStyle;
  actualNumericCellStyle: CellStyle;
};

export function buildRequestedColumnDefsMap(
  deps: RequestedColumnDefsDeps,
): Record<RequestedDisplayFieldKey, ColDef> {
  const { requestedCellClassRules, truncateCellStyle, actualNumericCellStyle } = deps;

  const buildTextRequestedColumn = (
    field: RequestedDisplayFieldKey,
    headerName: string,
  ) => {
    const isDescription = isRequestedDescriptionField(field);
    const supportsWebLink = field === 'RequestedPartNo' || field === 'RequestedModelNo';
    const column: ColDef = {
      field,
      headerName,
      hide: true,
      filter: 'agTextColumnFilter',
      headerClass: styles.requestedHeader,
      cellClassRules: requestedCellClassRules,
      cellClass: isDescription ? ACTUAL_COLUMN_GLOBAL_CLASS : TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
      cellStyle: isDescription
        ? (params) => {
            const row = params.data as Record<string, unknown> | null | undefined;
            const description = (row?.[field] ?? '') as string;
            const hasLineBreaks = description.includes('\n');
            return {
              whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
              lineHeight: '1.5',
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
            };
          }
        : truncateCellStyle,
      editable: (params: { data?: CellStyle | null }) =>
        canEditRequestedField(field, params.data ?? null),
      cellEditor: isDescription ? MultilineTextCellEditor : 'agTextCellEditor',
      valueGetter: (params: ValueGetterParams<Record<string, unknown>, unknown>) => {
        const row = params.data ?? null;
        const rawValue = row ? row[field] : null;
        if (isDescription) {
          return normalizeDescriptionValue(rawValue) ?? '';
        }
        if (typeof rawValue === 'string') return rawValue.trim();
        return rawValue;
      },
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        const normalized = isDescription
          ? normalizeDescriptionValue(newValue)
          : normalizeRequestedLookupValue(newValue);
        (data as Record<string, unknown>)[field] = normalized;
        return true;
      },
      cellRenderer: supportsWebLink
        ? (params: ICellRendererParams<Record<string, unknown>>) => {
            const rawValue = params.value;
            if (rawValue == null) return '';
            const displayValue = String(rawValue).trim();
            if (!displayValue) return '';

            if (field === 'RequestedModelNo') {
              const partNoRaw = (params.data as { RequestedPartNo?: unknown } | undefined)?.RequestedPartNo ?? null;
              const partNo = normalizeRequestedLookupValue(partNoRaw);
              if (partNo) return displayValue;
            }

            const rawLink = (params.data as { RequestedWebLink?: unknown } | undefined)?.RequestedWebLink ?? null;
            const normalizedLink = normalizeRequestedLookupValue(rawLink);
            if (!normalizedLink) return displayValue;

            const stop = (event: React.SyntheticEvent) => {
              event.stopPropagation();
            };

            return (
              <a
                href={normalizedLink}
                target="_blank"
                rel="noreferrer noopener"
                className={styles.partNumberLink}
                onClick={stop}
                onMouseDown={stop}
                onDoubleClick={stop}
                onContextMenu={stop}
                title="Open requested product link"
              >
                {displayValue}
              </a>
            );
          }
        : undefined,
    };
    return column;
  };

  return {
    RequestedBrand: buildTextRequestedColumn('RequestedBrand', 'Req. Brand'),
    RequestedPartNo: buildTextRequestedColumn('RequestedPartNo', 'Req. Part Number'),
    RequestedModelNo: buildTextRequestedColumn('RequestedModelNo', 'Req. Model Number'),
    RequestedWebLink: buildTextRequestedColumn('RequestedWebLink', 'Req. Web Link'),
    RequestedDescription: buildTextRequestedColumn('RequestedDescription', 'Req. Description'),
    RequestedDescription2: buildTextRequestedColumn('RequestedDescription2', 'Req. Description 2'),
    RequestedDescription3: buildTextRequestedColumn('RequestedDescription3', 'Req. Description 3'),
    RequestedQuantity: {
      field: 'RequestedQuantity',
      headerName: 'Req. Qty',
      hide: true,
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
      headerClass: [styles.requestedHeader, 'ag-right-aligned-header'],
      cellClassRules: requestedCellClassRules,
      cellClass: 'ag-right-aligned',
      cellStyle: actualNumericCellStyle,
      editable: (params: { data?: CellStyle | null }) =>
        canEditRequestedField('RequestedQuantity', params.data ?? null),
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        (data as Record<string, unknown>).RequestedQuantity = normalizeRequestedQuantityValue(newValue);
        return true;
      },
    },
  };
}

/* ── Product column definitions ──────────────────────────────────────── */

export type ProductColumnDefsDeps = {
  standardPackageMode: boolean;
  isManualMode: () => boolean;
  showRequestedColumns: boolean;
  requestedColumnDefsMap: Record<RequestedDisplayFieldKey, ColDef>;
  requestedCellClassRules: Record<string, (params: { data?: CellStyle | null }) => boolean>;
  requestedColumnVisibility: Partial<Record<RequestedDisplayFieldKey, boolean>>;
  requestedItemNoVisible: boolean;
  savedHiddenMap: Record<string, boolean>;
  savedColumnOrder: string[];
  truncateCellStyle: CellStyle;
  actualNumericCellClass: string[];
  actualNumericCellStyle: CellStyle;
  TreeOrderingCell: (params: ICellRendererParams<Record<string, unknown>>) => React.ReactNode;
  PartNumberCell: (params: ICellRendererParams<Record<string, unknown>>) => React.ReactNode;
  ModelNumberCell: (params: ICellRendererParams<Record<string, unknown>>) => React.ReactNode;
  RequestedItemNoCell: (params: ICellRendererParams<Record<string, unknown>>) => React.ReactNode;
  offerCurrencySymbol: string;
  pricingPolicyName?: string | null;
  readOnly?: boolean;
  // Excel-style manual cell fill. Resolves the hex colour painted on a cell (or
  // null). Merged into every column so any cell can be painted — see
  // offerCellPaint.ts.
  resolvePaintColor?: ResolvePaintColor;
  // Handles an inline Markup-cell edit. Markup is a derived column (no stored
  // field): the typed value is converted to the equivalent Margin and routed
  // through the existing Margin pipeline by the panel.
  onMarkupEdit?: (
    node: IRowNode<Record<string, unknown>> | null | undefined,
    newValue: unknown,
    data: Record<string, unknown> | null | undefined,
  ) => void;
};

// Discount columns (CustomerDiscount, AdditionalCustomerDiscount,
// TelmacoDiscount) accept values in [-100, 100]; out-of-range numerics clamp to
// the bound, non-numeric input reverts to the previous value.
const parseDiscountValue = (params: { newValue: unknown; oldValue: unknown }) => {
  const raw = params.newValue;
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
  const num = coerceNumber(raw);
  if (num == null) return params.oldValue;
  if (num > 100) return 100;
  if (num < -100) return -100;
  return num;
};

// A priced row (a product or a printable service) that carries a Net Unit Price
// but no List Price is almost always a data-entry mistake — the list price was
// dropped (compare 1.4 vs 2.2 in the DIVA offer, both "First Year Support": one
// has a list price, one doesn't). When such a row has no explicit customer
// discount, surface a -100% sentinel discount so the cell flags red (the
// negative-margin rule fires on value < 0) and the anomaly is easy to spot.
// Display-only: returned by the valueGetter, never written to the field, so it
// is not persisted or exported as real data.
const MISSING_LIST_PRICE_DISCOUNT_FLAG = -100;

const flagMissingListPriceDiscount = (
  data: Record<string, unknown> | null | undefined,
): number | null => {
  if (!data) return null;
  const isPricedRow = isOfferProductProduct(data) || resolveOfferProductRowType(data) === 'printable-service';
  if (!isPricedRow) return null;
  // Respect an explicitly entered discount — only flag rows that are otherwise blank.
  const storedDiscount = coerceNumber((data as { CustomerDiscount?: unknown }).CustomerDiscount);
  if (storedDiscount != null && storedDiscount !== 0) return null;
  const listPrice = coerceNumber((data as { ListPrice?: unknown }).ListPrice);
  if (listPrice != null && listPrice !== 0) return null;
  const netUnitPrice = coerceNumber((data as { NetUnitPrice?: unknown }).NetUnitPrice);
  if (netUnitPrice == null || netUnitPrice === 0) return null;
  return MISSING_LIST_PRICE_DISCOUNT_FLAG;
};

// The inverse of flagMissingListPriceDiscount: a priced row that HAS a list price
// but no net price (net blank or 0) is a 100% discount — the line is being given
// away for free. That is almost always a data-entry gap (no selling price entered),
// and when there is a cost behind it, an outright loss the Margin cell cannot show
// (its margin would be a division by zero, so it renders blank rather than red).
// Surface an honest 100% so the cell formats and flags red. Display-only: returned
// by the valueGetter, never written to the field, so it is not persisted or
// exported as real data.
const FULL_DISCOUNT_NO_NET_FLAG = 100;

const flagFullDiscountNoNet = (
  data: Record<string, unknown> | null | undefined,
): number | null => {
  if (!data) return null;
  const isPricedRow = isOfferProductProduct(data) || resolveOfferProductRowType(data) === 'printable-service';
  if (!isPricedRow) return null;
  // Respect an explicitly entered discount — only flag rows that are otherwise blank.
  const storedDiscount = coerceNumber((data as { CustomerDiscount?: unknown }).CustomerDiscount);
  if (storedDiscount != null && storedDiscount !== 0) return null;
  // There must be a list price to discount from.
  const listPrice = coerceNumber((data as { ListPrice?: unknown }).ListPrice);
  if (listPrice == null || listPrice <= 0) return null;
  // ...and no net, neither per-unit nor as a stored line total.
  const netUnitPrice = coerceNumber((data as { NetUnitPrice?: unknown }).NetUnitPrice);
  if (netUnitPrice != null && netUnitPrice > 0) return null;
  const totalNet = coerceNumber((data as { TotalNet?: unknown }).TotalNet);
  if (totalNet != null && totalNet > 0) return null;
  return FULL_DISCOUNT_NO_NET_FLAG;
};

// A zero (or blank) quantity on a line that should contribute to the offer
// totals is almost always a mistake — the line prices out to nothing. Flag
// products, services and priced comments. Non-printable comments are exempt:
// they are single cost lines whose quantity legitimately stays 0
// (recalcProductTotals treats it as 1). Unassigned requested rows are exempt
// because there is no actual product behind the cell yet.
const ZERO_QTY_PRICE_FIELDS = ['ListPrice', 'NetUnitPrice', 'NetCost', 'TotalPrice', 'TotalNet'] as const;

const flagZeroQuantity = (data: Record<string, unknown> | null | undefined): boolean => {
  if (!data || isUnassignedRequestedRow(data)) return false;
  const quantity = coerceNumber((data as { Quantity?: unknown }).Quantity) ?? 0;
  if (quantity !== 0) return false;
  const rowType = resolveOfferProductRowType(data);
  if (rowType === 'product' || rowType === 'printable-service' || rowType === 'non-printable-service') {
    return true;
  }
  if (rowType !== 'printable-comment') return false;
  return ZERO_QTY_PRICE_FIELDS.some((field) => {
    const value = coerceNumber(data[field]);
    return value != null && value !== 0;
  });
};

const zeroQuantityCellClassRules = {
  'offer-products-grid__cell--negative-margin': (params: { data?: Record<string, unknown> | null }) =>
    flagZeroQuantity(params.data ?? null),
};

// On flagged rows show an explicit 0 — a blank cell would hide what the red
// warning is complaining about. Unflagged rows keep the zero-blank behaviour
// (non-printable comments, unpriced comments, categories).
const zeroWarnQuantityFormatter = (params: ValueFormatterParams<Record<string, unknown>, unknown>) => {
  if (flagZeroQuantity(params.data ?? null)) return '0';
  return zeroBlankNumberFormatter(params);
};

export function buildProductColumnDefs(deps: ProductColumnDefsDeps): ColDef[] {
  const {
    standardPackageMode,
    isManualMode,
    showRequestedColumns,
    requestedColumnDefsMap,
    requestedCellClassRules,
    requestedColumnVisibility,
    requestedItemNoVisible,
    savedHiddenMap,
    savedColumnOrder,
    truncateCellStyle,
    actualNumericCellClass,
    actualNumericCellStyle,
    TreeOrderingCell,
    PartNumberCell,
    ModelNumberCell,
    RequestedItemNoCell,
    offerCurrencySymbol,
    pricingPolicyName,
    readOnly = false,
    resolvePaintColor,
    onMarkupEdit,
  } = deps;
  const additionalDiscountVisibleByDefault = pricingPolicyName === 'AVC4';

  const offerCurrencyFormatter = buildCurrencyFormatter(offerCurrencySymbol);

  // Merge the Excel-style manual cell fill into every column so any cell can be
  // painted: a marker class (drives the CSS background-image overlay) plus an
  // inline --fq-cellpaint custom property carrying the chosen hex, composed on
  // top of each column's own cellStyle. Dark fills flip the text to white.
  const applyPaintRules = (cols: ColDef[]): ColDef[] => {
    const resolve = resolvePaintColor;
    if (!resolve) return cols;
    return cols.map((column) => {
      const prevStyle = column.cellStyle;
      return {
        ...column,
        cellClassRules: {
          ...(column.cellClassRules ?? {}),
          [CELL_PAINT_MARKER_CLASS]: (params: CellClassParams) => resolve(params) != null,
        },
        cellStyle: (params: CellClassParams): CellStyle | null | undefined => {
          const base = typeof prevStyle === 'function' ? prevStyle(params) : prevStyle;
          const hex = resolve(params);
          if (!hex) return base ?? null;
          const baseObj = base && typeof base === 'object' ? base : {};
          const styled = { ...baseObj, '--fq-cellpaint': hex } as CellStyle;
          if (isDarkColor(hex)) styled.color = '#ffffff';
          return styled;
        },
      };
    });
  };

  if (standardPackageMode) {
    return applyPaintRules([
      {
        headerName: '',
        colId: '__row_drag__',
        pinned: 'left',
        lockPosition: true,
        suppressMovable: true,
        suppressSizeToFit: true,
        suppressColumnsToolPanel: true,
        resizable: false,
        sortable: false,
        filter: false,
        width: 44,
        // Drag-to-reorder is disabled in manual mode — manual mode is for
        // typing Item No values; reordering is done in normal mode.
        rowDrag: () => !isManualMode(),
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      },
      {
        field: 'TreeOrdering',
        headerName: 'Item No',
        filter: 'agTextColumnFilter',
        type: 'numericColumn',
        comparator: compareTreeOrderingValues,
        editable: (params) =>
          isManualMode()
          && resolveOfferProductRowType(params.data ?? null) !== 'non-printable-comment',
        cellRenderer: TreeOrderingCell,
        headerClass: 'ag-right-aligned-header',
        cellClass: [
          'offer-products-tree-ordering-cell',
          ACTUAL_COLUMN_GLOBAL_CLASS,
          TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
          'ag-right-aligned',
        ],
        cellStyle: truncateCellStyle,
        valueGetter: ({ data }) => {
          // Always return the raw TreeOrdering — AG-Grid uses this for
          // sorting and filtering. The renderer is responsible for the
          // display (incl. the "np" suffix on non-printable comments and
          // the "o" suffix on options).
          const row = data as { TreeOrdering?: unknown } | null | undefined;
          const value = row?.TreeOrdering;
          if (value == null) return '';
          return typeof value === 'string' ? value.trim() : String(value);
        },
      },
      {
        field: 'BrandName',
        headerName: 'Brand',
        filter: 'agTextColumnFilter',
        editable: false,
        cellClassRules: productAccentCellClassRules,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        colId: 'WarningIndicator',
        headerName: '',
        field: 'PriceListItemWarning',
        width: 36,
        minWidth: 36,
        maxWidth: 36,
        resizable: false,
        sortable: false,
        filter: false,
        editable: false,
        suppressMovable: true,
        cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
        cellRenderer: ({ data }: ICellRendererParams<Record<string, unknown>>) => {
          const row = data as Record<string, unknown> | null | undefined;
          if (!row) return null;
          const moq = (row.PriceListItemMOQ ?? null) as number | null;
          const warning = (row.PriceListItemWarning ?? null) as string | null;
          if (moq == null && !warning) return null;
          return (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                color: '#fff',
                fontSize: 13,
                fontWeight: 700,
                lineHeight: 1,
                cursor: 'default',
                flexShrink: 0,
              }}
            >
              !
            </span>
          );
        },
        tooltipValueGetter: ({ data }) => {
          const row = data as Record<string, unknown> | null | undefined;
          if (!row) return '';
          const moq = (row.PriceListItemMOQ ?? null) as number | null;
          const warning = (row.PriceListItemWarning ?? null) as string | null;
          const moqPrefix = moq != null ? `MOQ: ${moq}` : null;
          if (moqPrefix && warning) return `${moqPrefix}, ${warning}`;
          if (moqPrefix) return moqPrefix;
          return warning ?? '';
        },
      },
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
        editable: false,
        cellRenderer: PartNumberCell,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
        cellRenderer: ModelNumberCell,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        valueGetter: ({ data }) => {
          const row = data as Record<string, unknown> | null | undefined;
          const rawProductId = (row as { ProductID?: unknown } | null | undefined)?.ProductID ?? null;
          const hasProductId =
            typeof rawProductId === 'number'
              ? Number.isFinite(rawProductId)
              : typeof rawProductId === 'string'
                ? rawProductId.trim().length > 0
                : false;
          const isAssignedProduct = isOfferProductProduct(row) || hasProductId;
          if (isRequestedRow(row) && !isAssignedProduct) return '';
          const manual = normalizeDescriptionValue(row?.ProductDescription ?? null);
          if (manual != null) return manual;
          if (!isOfferProductCategory(row) && !isOfferProductProduct(row) && !isOfferProductComment(row)) {
            return '';
          }
          return normalizeDescriptionValue(row?.Description ?? null) ?? '';
        },
        valueSetter: ({ data, newValue }) => {
          if (!data) return false;
          const normalized = normalizeDescriptionValue(newValue);
          if (normalized != null && DESCRIPTION_PASTE_BLOCKLIST.has(normalized)) return false;
          (data as Record<string, unknown>).ProductDescription = normalized;
          (data as Record<string, unknown>).Description = normalized;
          return true;
        },
        editable: readOnly ? false : (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
            || isOfferProductService(row)
          );
        },
        cellEditor: MultilineTextCellEditor,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
        cellStyle: (params) => {
          const row = params.data as Record<string, unknown> | null | undefined;
          const description = (row?.ProductDescription ?? row?.Description ?? '') as string;
          const hasLineBreaks = description.includes('\n');
          return {
            whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
          };
        },
        tooltipValueGetter: ({ data }) => {
          const row = data as Record<string, unknown> | null | undefined;
          if (!row) return '';
          return (normalizeDescriptionValue(row?.ProductDescription ?? null) ?? normalizeDescriptionValue(row?.Description ?? null) ?? '') as string;
        },
      },
      {
        field: 'Quantity',
        headerName: 'Qty',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        headerClass: 'ag-right-aligned-header',
        editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
        valueFormatter: zeroWarnQuantityFormatter,
        cellClassRules: zeroQuantityCellClassRules,
        cellClass: actualNumericCellClass,
        cellStyle: actualNumericCellStyle,
      },
    ]);
  }

  // ── Full layout ──────────────────────────────────────────────────────
  const requestedColumns: ColDef[] = [];
  REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
    const baseColDef = requestedColumnDefsMap[key];
    if (!baseColDef) return;
    requestedColumns.push({ ...baseColDef });
  });

  const treeColumn: ColDef = {
    field: 'TreeOrdering',
    headerName: 'Item No',
    filter: 'agTextColumnFilter',
    type: 'numericColumn',
    comparator: compareTreeOrderingValues,
    editable: (params) =>
      isManualMode()
      && resolveOfferProductRowType(params.data ?? null) !== 'non-printable-comment',
    cellRenderer: TreeOrderingCell,
    headerClass: 'ag-right-aligned-header',
    cellClass: [
      'offer-products-tree-ordering-cell',
      ACTUAL_COLUMN_GLOBAL_CLASS,
      TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
      'ag-right-aligned',
    ],
    cellStyle: truncateCellStyle,
    cellClassRules: {
      // Purple "option" badge on the Item No cell. Works on top of any row
      // colour, so a printable/non-printable comment marked as an option keeps
      // its blue/red row while its Item No cell turns purple.
      'offer-products-tree-ordering-cell--option': (params) => isOfferProductOption(params.data ?? null),
    },
    valueGetter: ({ data }) => {
      // Always return the raw TreeOrdering — AG-Grid uses this for sorting
      // and filtering. The renderer handles the display (incl. the "np"
      // suffix on non-printable comments and "o" on options).
      const row = data as {
        __isRequestedRow?: number | null;
        TreeOrdering?: unknown;
      } | null | undefined;
      const treeValue = row?.TreeOrdering;
      if (treeValue != null) {
        return typeof treeValue === 'string' ? treeValue.trim() : String(treeValue);
      }
      return '';
    },
  };

  const requestedItemNoColumn: ColDef = {
    field: 'RequestedItemNo',
    headerName: 'Req. Item No',
    hide: true,
    filter: 'agTextColumnFilter',
    headerClass: [styles.requestedHeader, 'ag-right-aligned-header'],
    cellClassRules: requestedCellClassRules,
    cellClass: [TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS, 'ag-right-aligned'],
    cellStyle: truncateCellStyle,
    editable: (params: { data?: CellStyle | null }) =>
      canEditRequestedField('RequestedItemNo', params.data ?? null),
    cellEditor: 'agTextCellEditor',
    valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
      if (!data) return false;
      const normalized = normalizeRequestedItemNoValue(newValue);
      (data as Record<string, unknown>).RequestedItemNo = normalized;
      return true;
    },
    valueGetter: ({ data }) => {
      if (!data) return '';
      const requestedItemNo = normalizeRequestedItemNoValue(
        (data as Record<string, unknown>).RequestedItemNo ?? null,
      );
      return requestedItemNo ?? '';
    },
    cellRenderer: RequestedItemNoCell,
  };

  const baseColumns: ColDef[] = [
    {
      headerName: '',
      colId: '__row_drag__',
      pinned: 'left',
      lockPosition: true,
      suppressMovable: true,
      suppressSizeToFit: true,
      suppressColumnsToolPanel: true,
      resizable: false,
      sortable: false,
      filter: false,
      width: 44,
      rowDrag: true,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    requestedItemNoColumn,
    ...requestedColumns,
    treeColumn,
    {
      field: 'BrandName',
      headerName: 'Brand',
      filter: 'agTextColumnFilter',
      editable: false,
      cellClassRules: productAccentCellClassRules,
      cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
      cellStyle: truncateCellStyle,
    },
    {
      colId: 'WarningIndicator',
      headerName: '',
      field: 'PriceListItemWarning',
      width: 36,
      minWidth: 36,
      maxWidth: 36,
      resizable: false,
      sortable: false,
      filter: false,
      editable: false,
      suppressMovable: true,
      cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
      cellRenderer: ({ data }: ICellRendererParams<Record<string, unknown>>) => {
        const row = data as Record<string, unknown> | null | undefined;
        if (!row) return null;
        const moq = (row.PriceListItemMOQ ?? null) as number | null;
        const warning = (row.PriceListItemWarning ?? null) as string | null;
        if (moq == null && !warning) return null;
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              borderRadius: '50%',
              backgroundColor: '#dc2626',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1,
              cursor: 'default',
              flexShrink: 0,
            }}
          >
            !
          </span>
        );
      },
      tooltipValueGetter: ({ data }) => {
        const row = data as Record<string, unknown> | null | undefined;
        if (!row) return '';
        const moq = (row.PriceListItemMOQ ?? null) as number | null;
        const warning = (row.PriceListItemWarning ?? null) as string | null;
        const moqPrefix = moq != null ? `MOQ: ${moq}` : null;
        if (moqPrefix && warning) return `${moqPrefix}, ${warning}`;
        if (moqPrefix) return moqPrefix;
        return warning ?? '';
      },
    },
    {
      field: 'PartNumber',
      headerName: 'Part Number',
      filter: 'agTextColumnFilter',
      editable: false,
      cellRenderer: PartNumberCell,
      cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
      cellStyle: truncateCellStyle,
    },
    {
      field: 'ModelNumber',
      headerName: 'Model Number',
      filter: 'agTextColumnFilter',
      cellRenderer: ModelNumberCell,
      cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
      cellStyle: truncateCellStyle,
    },
    {
      field: 'Description',
      headerName: 'Description',
      filter: 'agTextColumnFilter',
      valueGetter: ({ data }) => {
        const row = data as Record<string, unknown> | null | undefined;
        const rawProductId = (row as { ProductID?: unknown } | null | undefined)?.ProductID ?? null;
        const hasProductId =
          typeof rawProductId === 'number'
            ? Number.isFinite(rawProductId)
            : typeof rawProductId === 'string'
              ? rawProductId.trim().length > 0
              : false;
        const isAssignedProduct = isOfferProductProduct(row) || hasProductId;
        if (isRequestedRow(row) && !isAssignedProduct) return '';
        const manual = normalizeDescriptionValue(row?.ProductDescription ?? null);
        if (manual != null) return manual;
        if (!isOfferProductCategory(row) && !isOfferProductProduct(row) && !isOfferProductComment(row)) {
          return '';
        }
        return normalizeDescriptionValue(row?.Description ?? null) ?? '';
      },
      valueSetter: ({ data, newValue }) => {
        if (!data) return false;
        const normalized = normalizeDescriptionValue(newValue);
        (data as Record<string, unknown>).ProductDescription = normalized;
        (data as Record<string, unknown>).Description = normalized;
        return true;
      },
      editable: readOnly ? false : (params) => {
        const row = params?.data ?? null;
        if (isUnassignedRequestedRow(row)) return false;
        return (
          isOfferProductCategory(row)
          || isOfferProductComment(row)
          || isOfferProductProduct(row)
          || isOfferProductService(row)
        );
      },
      cellEditor: MultilineTextCellEditor,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      cellStyle: (params) => {
        const row = params.data as Record<string, unknown> | null | undefined;
        const description = (row?.ProductDescription ?? row?.Description ?? '') as string;
        const hasLineBreaks = description.includes('\n');
        return {
          whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
          lineHeight: '1.5',
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
        };
      },
      tooltipValueGetter: ({ data }) => {
        const row = data as Record<string, unknown> | null | undefined;
        if (!row) return '';
        return (normalizeDescriptionValue(row?.ProductDescription ?? null) ?? normalizeDescriptionValue(row?.Description ?? null) ?? '') as string;
      },
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroWarnQuantityFormatter,
      cellClassRules: zeroQuantityCellClassRules,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return offerCurrencyFormatter(params);
      },
      cellClassRules: productPriceListClassRules,
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueGetter: categoryTotalPriceGetter,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null) && !isOfferProductCategory(params.data ?? null)) return '';
        return offerCurrencyFormatter(params);
      },
      cellClassRules: totalPriceCellClassRules,
      editable: false,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Customer Discount',
      // Clipboard copy must use the stored discount, NOT the display-only 100% /
      // -100% sentinel this column's valueGetter surfaces on anomalous rows (see
      // flagFullDiscountNoNet / flagMissingListPriceDiscount). Without this, copying
      // such a cell — whose real stored discount is blank — pastes a bogus 100%.
      // Carried on colDef.context (AG Grid's slot for app data) and honoured by
      // AgGridAll's processCellForClipboard.
      context: { copyValueFromField: true },
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueParser: parseDiscountValue,
      // Display the stored discount, except surface a -100% flag on priced rows
      // that have a net price but no list price (see flagMissingListPriceDiscount).
      valueGetter: (params) => {
        const missingList = flagMissingListPriceDiscount(params.data ?? null);
        if (missingList != null) return missingList;
        // List price but no net → surface an honest 100% (full giveaway). Mutually
        // exclusive with the flag above (that one requires no list price).
        const fullDiscount = flagFullDiscountNoNet(params.data ?? null);
        if (fullDiscount != null) return fullDiscount;
        return (params.data as { CustomerDiscount?: unknown } | null | undefined)?.CustomerDiscount ?? null;
      },
      // Pairing a valueGetter with editing requires an explicit setter to write
      // edits back to the underlying field.
      valueSetter: (params) => {
        if (!params.data) return false;
        (params.data as Record<string, unknown>).CustomerDiscount = params.newValue;
        return true;
      },
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return percentageFormatter(params);
      },
      cellClassRules: {
        // Red for an anomalous discount: below 0 (selling above list / missing-list
        // sentinel) OR a full 100%+ discount (the line is given away free).
        'offer-products-grid__cell--negative-margin': (params) => {
          const value = coerceNumber(params.value ?? (params.data as { CustomerDiscount?: unknown } | null | undefined)?.CustomerDiscount ?? null);
          return value != null && (value < 0 || value >= 100);
        },
      },
      cellStyle: actualNumericCellStyle,
      cellClass: actualNumericCellClass,
      width: 150
    },
    {
      field: 'AdditionalCustomerDiscount',
      headerName: 'Add. Customer Discount',
      hide: !additionalDiscountVisibleByDefault,
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueParser: parseDiscountValue,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return percentageFormatter(params);
      },
      cellStyle: actualNumericCellStyle,
      cellClass: actualNumericCellClass,
      width: 170,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: offerCurrencyFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueGetter: categoryTotalNetGetter,
      valueFormatter: offerCurrencyFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'Warranty',
      headerName: 'Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueParser: parseDiscountValue,
      valueFormatter: percentageFormatter,
      cellClassRules: {
        'offer-products-grid__cell--negative-margin': (params) => {
          const value = coerceNumber(params.value ?? (params.data as { TelmacoDiscount?: unknown } | null | undefined)?.TelmacoDiscount ?? null);
          return value != null && value < 0;
        },
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'NetCostOtherCurrency',
      headerName: 'Net Cost (Other Currency)',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: (params) => {
        const num = coerceNumber(params.value);
        if (num == null || Object.is(num, 0)) return '';
        const currencyName = typeof (params.data as { OtherCurrencyName?: unknown } | null | undefined)?.OtherCurrencyName === 'string'
          ? String((params.data as { OtherCurrencyName?: unknown }).OtherCurrencyName).trim()
          : '';
        if (!currencyName) return '';
        const formatted = otherCurrencyAmountFormatter.format(num);
        return currencyName === '$' || currencyName === '£' ? `${currencyName} ${formatted}` : `${formatted} ${currencyName}`;
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'CurrencyCostModifier',
      headerName: 'Cost Modifier',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: (params) => {
        const currencyName = typeof (params.data as { OtherCurrencyName?: unknown } | null | undefined)?.OtherCurrencyName === 'string'
          ? String((params.data as { OtherCurrencyName?: unknown }).OtherCurrencyName).trim()
          : '';
        if (!currencyName) return '';
        const num = coerceNumber(params.value);
        if (num == null) return '';
        return String(num);
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: offerCurrencyFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'TotalCost',
      headerName: 'Total Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: offerCurrencyFormatter,
      valueGetter: categoryTotalCostGetter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClassRules: {
        'offer-products-grid__cell--negative-margin': (params) => {
          const value = coerceNumber(
            params.value
            ?? (params.data as { Margin?: unknown } | null | undefined)?.Margin
            ?? null,
          );
          return value != null && value < 0;
        },
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      // Markup is the cost-basis twin of Margin, shown as a cost MULTIPLIER
      // (e.g. 1,25 = sell at 125% of cost), not a percentage. It is hidden by
      // default and never stored — the value is derived from Margin (falling
      // back to NetUnitPrice / NetCost), and an edit is converted to the
      // equivalent Margin and routed through the existing Margin pipeline
      // (valueSetter → onMarkupEdit → node.setDataValue('Margin')).
      colId: 'Markup',
      headerName: 'Markup',
      hide: true,
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !readOnly && !isUnassignedRequestedRow(params.data ?? null) && !isNonPrintableOfferProductRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueGetter: (params: ValueGetterParams<Record<string, unknown>>) => {
        const data = params.data;
        if (!isOfferProductCommentOrProduct(data ?? null)) return null;
        const fromMargin = markupFactorFromMargin(coerceNumber((data as { Margin?: unknown } | undefined)?.Margin));
        if (fromMargin != null) return fromMargin;
        return deriveMarkupFactor(
          coerceNumber((data as { NetUnitPrice?: unknown } | undefined)?.NetUnitPrice),
          coerceNumber((data as { NetCost?: unknown } | undefined)?.NetCost),
        );
      },
      valueFormatter: (params) => {
        const num = coerceNumber(params.value);
        return num == null ? '' : markupFactorFormatter.format(num);
      },
      valueSetter: (params: ValueSetterParams<Record<string, unknown>>) => {
        // Hand the typed markup factor to the panel, which converts it to a
        // Margin edit. Return false so AG Grid neither stores a value nor fires
        // its own cellValueChanged — the derived getter stays the source of truth.
        onMarkupEdit?.(params.node, params.newValue, params.data ?? null);
        return false;
      },
      cellClassRules: {
        // A markup factor below 1 means selling below cost (negative margin).
        'offer-products-grid__cell--negative-margin': (params) => {
          const value = coerceNumber(params.value);
          return value != null && value < 1;
        },
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: offerCurrencyFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'TelmacoWarranty',
      headerName: 'Telmaco Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'PriceListItemWarning',
      headerName: 'Warning',
      filter: 'agTextColumnFilter',
      width: 200,
      editable: false,
      valueGetter: ({ data }) => {
        const row = data as Record<string, unknown> | null | undefined;
        if (!row) return '';
        const moq = (row.PriceListItemMOQ ?? null) as number | null;
        const warning = (row.PriceListItemWarning ?? null) as string | null;
        const moqPrefix = moq != null ? `MOQ: ${moq}` : null;
        if (moqPrefix && warning) return `${moqPrefix}, ${warning}`;
        if (moqPrefix) return moqPrefix;
        return warning ?? '';
      },
      cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
      cellStyle: truncateCellStyle,
      tooltipValueGetter: ({ data }) => {
        const row = data as Record<string, unknown> | null | undefined;
        if (!row) return '';
        const moq = (row.PriceListItemMOQ ?? null) as number | null;
        const warning = (row.PriceListItemWarning ?? null) as string | null;
        const moqPrefix = moq != null ? `MOQ: ${moq}` : null;
        if (moqPrefix && warning) return `${moqPrefix}, ${warning}`;
        if (moqPrefix) return moqPrefix;
        return warning ?? '';
      },
    },
    {
      field: 'Origin',
      headerName: 'Origin',
      filter: 'agTextColumnFilter',
      width: 130,
      editable: (params) => !isUnassignedRequestedRow(params?.data ?? null) && isOfferProductProduct(params?.data ?? null),
      valueSetter: ({ data, newValue }) => {
        if (!data) return false;
        const trimmed = typeof newValue === 'string' ? newValue.trim() : newValue == null ? null : String(newValue).trim();
        (data as Record<string, unknown>).Origin = trimmed && trimmed.length > 0 ? trimmed : null;
        return true;
      },
      cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
      cellStyle: truncateCellStyle,
    },
    {
      field: 'Comment',
      headerName: 'Comment',
      filter: 'agTextColumnFilter',
      editable: (params) => {
        const row = params?.data ?? null;
        if (isUnassignedRequestedRow(row)) return false;
        return (
          isOfferProductCategory(row)
          || isOfferProductComment(row)
          || isOfferProductProduct(row)
        );
      },
      cellEditor: MultilineTextCellEditor,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      cellStyle: (params) => {
        const row = params.data as Record<string, unknown> | null | undefined;
        const comment = (row?.Comment ?? '') as string;
        const hasLineBreaks = comment.includes('\n');
        return {
          whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
          lineHeight: '1.5',
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
        };
      },
    },
    {
      field: 'Delivery',
      headerName: 'Delivery',
      filter: 'agTextColumnFilter',
      editable: (params) => {
        const row = params?.data ?? null;
        if (isUnassignedRequestedRow(row)) return false;
        return (
          isOfferProductCategory(row)
          || isOfferProductComment(row)
          || isOfferProductProduct(row)
        );
      },
      valueGetter: ({ data }) => {
        const raw = (data as { Delivery?: unknown } | null | undefined)?.Delivery;
        return raw == null ? '' : String(raw).trim();
      },
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        (data as Record<string, unknown>).Delivery = normalizeRequestedLookupValue(newValue ?? null);
        return true;
      },
      cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
      cellStyle: truncateCellStyle,
    },
    {
      field: 'Installation',
      headerName: 'Installation (h)',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
      width: 120,
      minWidth: 0,
    },
    {
      field: 'ElInstalation',
      headerName: 'El. Installation (h)',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
      width: 135,
      minWidth: 0,
    },
    {
      field: 'Commissioning',
      headerName: 'Commissioning (h)',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
      width: 145,
      minWidth: 0,
    },
  ];

  // ── Column ordering and visibility ───────────────────────────────────
  const columnMap = new Map<string, ColDef>();
  baseColumns.forEach((column) => {
    const id = typeof column.colId === 'string'
      ? column.colId
      : typeof column.field === 'string'
        ? column.field
        : '';
    if (!id) return;
    columnMap.set(id, column);
  });
  const ordered: ColDef[] = [];

  const fixedStartIds = [
    '__row_drag__',
    'RequestedItemNo',
    ...REQUESTED_DISPLAY_FIELD_KEYS,
    'TreeOrdering',
  ];
  const fixedStartSet = new Set(fixedStartIds);
  fixedStartIds.forEach((id) => {
    const column = columnMap.get(id);
    if (!column) return;
    ordered.push(column);
    columnMap.delete(id);
  });

  savedColumnOrder
    .filter((id) => !fixedStartSet.has(id))
    .forEach((id) => {
      const column = columnMap.get(id);
      if (!column) return;
      ordered.push(column);
      columnMap.delete(id);
    });
  columnMap.forEach((column) => ordered.push(column));

  // A freshly-added Markup column has no entry in the user's saved order yet, so
  // the leftover sweep above appends it at the far right. Reposition it directly
  // after Margin so it shows up where it belongs until the user saves a layout
  // (after which savedColumnOrder honours their chosen position).
  if (!savedColumnOrder.includes('Markup')) {
    const markupIdx = ordered.findIndex((column) => column.colId === 'Markup');
    const marginIdx = ordered.findIndex((column) => column.field === 'Margin');
    if (markupIdx !== -1 && marginIdx !== -1 && markupIdx !== marginIdx + 1) {
      const [markupColumn] = ordered.splice(markupIdx, 1);
      const insertAt = ordered.findIndex((column) => column.field === 'Margin') + 1;
      ordered.splice(insertAt, 0, markupColumn);
    }
  }

  const requestedColumnIds = new Set<string>(['RequestedItemNo', ...REQUESTED_DISPLAY_FIELD_KEYS]);
  const hasSavedHidden = Object.keys(savedHiddenMap).length > 0;
  return applyPaintRules(ordered.flatMap((column) => {
    const id = typeof column.colId === 'string'
      ? column.colId
      : typeof column.field === 'string'
        ? column.field
        : '';
    if (!id) return [column];
    if (requestedColumnIds.has(id)) {
      // Outside the wReq layout, OMIT requested columns from the grid entirely
      // instead of merely hiding them. A hidden column's runtime visibility can
      // be transiently flipped back on by AG Grid during a collapse/expand
      // refresh reconcile (a visible "flash"); a column that isn't in the
      // colDefs at all can never be surfaced. They are re-added when the user
      // switches to wReq (this builder depends on showRequestedColumns).
      if (!showRequestedColumns) return [];
      const isVisible = id === 'RequestedItemNo'
        ? requestedItemNoVisible
        : Boolean(requestedColumnVisibility[id as RequestedDisplayFieldKey]);
      const shouldHide = !isVisible;
      if (column.hide !== shouldHide) {
        return [{ ...column, hide: shouldHide }];
      }
      return [column];
    }
    if (hasSavedHidden && savedHiddenMap[id] != null) {
      return [{ ...column, hide: savedHiddenMap[id] }];
    }
    return [column];
  }));
}
