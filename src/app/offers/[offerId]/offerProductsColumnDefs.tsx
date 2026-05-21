/**
 * Column definition builders for the offer products grid.
 *
 * Extracted from OfferProductsPanel to reduce file size. The main component
 * wraps these in useMemo with the same dependency arrays.
 */

import React from 'react';
import type {
  CellStyle,
  ColDef,
  ICellRendererParams,
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
import { isOfferProductProduct, isOfferProductCategory, isOfferProductComment, resolveOfferProductRowType } from '../../../lib/offerProductRows';
import { getUserNumberLocale } from '../../../lib/localeNumber';

const otherCurrencyAmountFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
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
  } = deps;
  const additionalDiscountVisibleByDefault = pricingPolicyName === 'AVC4';

  const offerCurrencyFormatter = buildCurrencyFormatter(offerCurrencySymbol);

  if (standardPackageMode) {
    return [
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
          // display (incl. the "C" suffix on non-printable comments and
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
        editable: (params) => {
          const row = params?.data ?? null;
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
      },
      {
        field: 'Quantity',
        headerName: 'Qty',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        headerClass: 'ag-right-aligned-header',
        editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
        valueFormatter: zeroBlankNumberFormatter,
        cellClass: actualNumericCellClass,
        cellStyle: actualNumericCellStyle,
      },
    ];
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
    valueGetter: ({ data }) => {
      // Always return the raw TreeOrdering — AG-Grid uses this for sorting
      // and filtering. The renderer handles the display (incl. the "C"
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
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
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
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
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
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
      valueParser: parseDiscountValue,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return percentageFormatter(params);
      },
      cellClassRules: {
        'offer-products-grid__cell--negative-margin': (params) => {
          const value = coerceNumber(params.value ?? (params.data as { CustomerDiscount?: unknown } | null | undefined)?.CustomerDiscount ?? null);
          return value != null && value < 0;
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
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
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
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
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
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
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
        return currencyName === '$' ? `${currencyName} ${formatted}` : `${formatted} ${currencyName}`;
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
      editable: (params) => !isUnassignedRequestedRow(params.data ?? null) && isOfferProductCommentOrProduct(params.data ?? null),
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

  const requestedColumnIds = new Set<string>(['RequestedItemNo', ...REQUESTED_DISPLAY_FIELD_KEYS]);
  const hasSavedHidden = Object.keys(savedHiddenMap).length > 0;
  return ordered.map((column) => {
    const id = typeof column.colId === 'string'
      ? column.colId
      : typeof column.field === 'string'
        ? column.field
        : '';
    if (!id) return column;
    if (requestedColumnIds.has(id)) {
      const isVisible = id === 'RequestedItemNo'
        ? requestedItemNoVisible
        : Boolean(requestedColumnVisibility[id as RequestedDisplayFieldKey]);
      const shouldHide = !showRequestedColumns || !isVisible;
      if (column.hide !== shouldHide) {
        return { ...column, hide: shouldHide };
      }
      return column;
    }
    if (hasSavedHidden && savedHiddenMap[id] != null) {
      return { ...column, hide: savedHiddenMap[id] };
    }
    return column;
  });
}
