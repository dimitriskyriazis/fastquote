import type { GridApi, IRowNode } from 'ag-grid-community';
import { showToastMessage } from './toast';

type UndoPush = (entry: { label: string; undo: () => Promise<void> }) => void;

/**
 * After a successful cell edit, pushes an undo entry and shows a toast with an undo action.
 *
 * @param pushUndo - from useUndoStack
 * @param performUndo - from useUndoStack
 * @param label - human-readable field label (e.g. "Brand name")
 * @param undoFn - async function that reverts the edit (PATCH + grid revert)
 */
export function pushCellEditUndo(
  pushUndo: UndoPush,
  performUndo: () => Promise<void>,
  label: string,
  undoFn: () => Promise<void>,
) {
  pushUndo({ label: `${label} updated`, undo: undoFn });
  showToastMessage(`${label} updated`, 'success', 5500, {
    label: 'Undo',
    onClick: () => performUndo(),
  });
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
