import type { GridApi, IRowNode } from 'ag-grid-community';
import { showToastMessage } from './toast';

type UndoPush = (entry: {
  label: string;
  undo: () => Promise<void>;
  redo?: () => Promise<void>;
}) => void;

/**
 * After a successful cell edit, pushes an undo entry and shows a toast with an undo action.
 *
 * @param pushUndo - from useUndoStack
 * @param performUndo - from useUndoStack
 * @param label - human-readable field label (e.g. "Brand name")
 * @param undoFn - async function that reverts the edit (PATCH + grid revert)
 * @param redoFn - optional async function that re-applies the edit (enables Ctrl+Y / redo)
 */
export function pushCellEditUndo(
  pushUndo: UndoPush,
  performUndo: () => Promise<void>,
  label: string,
  undoFn: () => Promise<void>,
  redoFn?: () => Promise<void>,
) {
  pushUndo({ label: `${label} updated`, undo: undoFn, redo: redoFn });
  showToastMessage(`${label} updated`, 'success', 5500, {
    label: 'Undo',
    onClick: () => performUndo(),
  });
}

/**
 * Server-recomputed columns the offer-detail PATCH returns in resolvedRows. The revert
 * repaints these from the server response so dependent values match the reverted input —
 * e.g. undoing a List Price edit must also restore Customer Discount, Net Unit Price,
 * Margin and the row totals, not just the List Price cell. Mirrors the forward pricing
 * path's derived-field list in OfferProductsPanel.handlePricingEdit.
 */
const OFFER_DETAIL_DERIVED_FIELDS = [
  'CustomerDiscount',
  'AdditionalCustomerDiscount',
  'TelmacoDiscount',
  'NetUnitPrice',
  'NetCost',
  'Margin',
  'ListPrice',
  'NetCostOtherCurrency',
  'OtherCurrencyID',
  'CurrencyCostModifier',
  'TotalPrice',
  'TotalNet',
  'TotalCost',
  'GrossProfit',
] as const;

/**
 * Builds one direction (revert or re-apply) of an offer-detail row field change for the
 * offer products grid. PATCHes the given fields, then:
 *  1. Repaints every server-recomputed derived column from the PATCH's resolvedRows, so
 *     dependent values follow the change (fixes "undo List Price but Customer Discount
 *     stays stale").
 *  2. Writes the explicitly-reverted field(s) last, so the exact captured value wins.
 * All node writes use source 'api' — they do NOT re-enter handleCellEdit (every per-field
 * handler and propagateChangeToDuplicates bail on source==='api'), which stops an
 * undo/redo from firing a spurious save or re-opening the "apply to all duplicates" prompt.
 *
 * Pass old values for `undo` and new values for `redo`; the two directions are symmetric,
 * so a single helper produces both. Values are snapshotted at call time.
 */
export function makeOfferDetailRevert(params: {
  endpoint: string;
  offerDetailId: number;
  /** PATCH body fields (merged with OfferDetailID). */
  patch: Record<string, unknown>;
  /** [field, value] writes applied to the grid node (source 'api'). */
  cells: ReadonlyArray<readonly [string, unknown]>;
  node: IRowNode | null | undefined;
  api: GridApi | null | undefined;
}): () => Promise<void> {
  const { endpoint, offerDetailId, patch, cells, node, api } = params;
  return async () => {
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ OfferDetailID: offerDetailId, ...patch }] }),
    });
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      resolvedRows?: Array<Record<string, unknown> & { OfferDetailID?: number }>;
    } | null;
    if (!res.ok || !payload?.ok) throw new Error('Failed to revert');

    // 1. Repaint server-recomputed derived columns authoritatively.
    const resolved = payload.resolvedRows?.find(
      (row) => Number(row?.OfferDetailID) === offerDetailId,
    );
    if (resolved && node) {
      const data = (node.data ?? {}) as Record<string, unknown>;
      const otherCurrencyId = Number(data.OtherCurrencyID);
      const otherCurrencyName =
        typeof data.OtherCurrencyName === 'string' ? data.OtherCurrencyName.trim() : '';
      const rowHasForeignCurrency =
        (Number.isFinite(otherCurrencyId) && otherCurrencyId > 0) || otherCurrencyName.length > 0;
      // On foreign-currency rows the server returns ListPrice = EffectiveListPrice (a cost
      // fallback); applying it would wrongly fill the List Price cell unless we are
      // explicitly reverting ListPrice itself. Mirrors the forward pricing path.
      const skipDerivedListPrice = rowHasForeignCurrency && !('ListPrice' in patch);
      for (const fieldKey of OFFER_DETAIL_DERIVED_FIELDS) {
        if (!(fieldKey in resolved)) continue;
        if (fieldKey === 'ListPrice' && skipDerivedListPrice) continue;
        try { node.setDataValue(fieldKey, resolved[fieldKey] ?? null, 'api'); } catch { /* noop */ }
      }
    }

    // 2. The explicitly-reverted field(s): exact captured value wins over the recompute.
    for (const [field, value] of cells) {
      try { node?.setDataValue(field, value, 'api'); } catch { /* noop */ }
    }
    api?.refreshServerSide?.({ purge: false });
  };
}

/**
 * Creates a standard undo function for Pattern A (bulk PATCH with updates array).
 * Works for: brands, suppliers, markets, contacts, customer-groups, price-list-products,
 * users, standard-packages, countries.
 */
export function makePatternAUndoFn(params: {
  endpoint: string;
  idField: string;
  entityId: number;
  field: string;
  oldValue: unknown;
  node: IRowNode | null;
  gridApi: GridApi;
}): () => Promise<void> {
  const { endpoint, idField, entityId, field, oldValue, node, gridApi } = params;
  return async () => {
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{ [idField]: entityId, field, value: oldValue }],
      }),
    });
    const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!res.ok || !payload?.ok) throw new Error('Failed to revert');
    try {
      node?.setDataValue(field, oldValue);
    } catch {
      /* noop */
    }
    gridApi?.refreshServerSide?.({ purge: false });
  };
}
