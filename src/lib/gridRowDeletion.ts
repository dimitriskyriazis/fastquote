import type { GridApi, GetContextMenuItemsParams, MenuItemDef, DefaultMenuItem, RowNode, ServerSideRowSelectionState } from 'ag-grid-community';
import { showConfirmDialog } from './confirm';
import { showToastMessage } from './toast';
import type { DeletePermissionResult } from './deletePermissions';

const contextMenuSelectionSnapshots = new WeakMap<GridApi<unknown>, unknown[]>();

export const setGridRowDeletionContextMenuSelectionSnapshot = <RowData>(
  api: GridApi<RowData> | null,
  selection: Array<RowNode<RowData>> | null,
) => {
  if (!api) return;
  const key = api as GridApi<unknown>;
  const existing = contextMenuSelectionSnapshots.get(key);
  const existingCount = Array.isArray(existing) ? existing.length : 0;
  const newCount = Array.isArray(selection) ? selection.length : 0;
  // Only prevent updating if going from multi-selection to single selection (preserve multi-select intent)
  // But always allow updates when selection is cleared (0 nodes) or when explicitly changing to a different multi-selection
  if (existingCount > 1 && newCount === 1) {
    return;
  }
  contextMenuSelectionSnapshots.set(key, selection ? selection.slice() : []);
};

const readContextMenuSelectionSnapshot = <RowData>(api: GridApi<RowData> | null) => {
  if (!api) return null;
  const stored = contextMenuSelectionSnapshots.get(api as GridApi<unknown>);
  if (!stored || stored.length === 0) return null;
  return stored as Array<RowNode<RowData>>;
};

export const getContextMenuSelectionSnapshot = <RowData>(api: GridApi<RowData> | null) => {
  const nodes = readContextMenuSelectionSnapshot(api);
  if (!nodes) return [];
  return nodes.slice();
};

const hasServerSideSelectAll = <RowData>(api: GridApi<RowData> | null) => {
  if (!api || typeof api.getServerSideSelectionState !== 'function') return false;
  const state = api.getServerSideSelectionState();
  return Boolean(state && 'selectAll' in state && Boolean((state as ServerSideRowSelectionState).selectAll));
};

const deleteRecordMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--danger" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 7L18.2 19.2C18.1 20.8 16.8 22 15.2 22H8.8C7.2 22 5.9 20.8 5.8 19.2L5 7" />
      <path d="M10 11V17" />
      <path d="M14 11V17" />
      <path d="M4 7H20" />
      <path d="M9 7V4.8C9 3.8 9.8 3 10.8 3H13.2C14.2 3 15 3.8 15 4.8V7" />
    </svg>
  </span>
`;

type GridRowDeletionLabelContext = {
  isSingle: boolean;
  count: number;
  typeLabel: string;
  rowLabel: string;
};

type GridRowDeletionLabel = string | ((context: GridRowDeletionLabelContext) => string | undefined | null);

type GridRowDeletionConfig<RowData> = {
  endpoint: string;
  resolveRowId: (row: RowData | null | undefined) => number | null;
  resolveRowLabel: (row: RowData | null | undefined, fallback: string) => string;
  resolveMultiRowLabel?: (rows: RowData[], fallback: string) => string;
  resolveRowTypeLabel?: (row: RowData | null | undefined) => string | null | undefined;
  resolveMultiRowTypeLabel?: (rows: RowData[]) => string | null | undefined;
  buildPayload?: (ids: number[]) => unknown;
  confirmTitle?: GridRowDeletionLabel;
  confirmMessage?: (typeLabel: string, label: string) => string;
  confirmConfirmLabel?: GridRowDeletionLabel;
  confirmCancelLabel?: GridRowDeletionLabel;
  successToastMessage?: string | ((typeLabel: string, label: string) => string);
  failureToastMessage?: string;
  refreshHandler?: (api: GridApi<RowData> | null) => void;
  canDelete?: (count: number) => DeletePermissionResult;
  restoreEndpoint?: string;
  onDeleteSuccess?: (deletedRows: unknown[], api: GridApi<RowData> | null) => void;
};

export class GridRowDeletion<RowData> {
  constructor(private readonly config: GridRowDeletionConfig<RowData>) {}

  private getRowTypeLabel(row: RowData | null | undefined) {
    const resolved = this.config.resolveRowTypeLabel?.(row);
    const normalized = typeof resolved === 'string' ? resolved.trim() : resolved ? String(resolved).trim() : '';
    if (normalized.length > 0) return normalized;
    return 'record';
  }

  private getNonNullRows(rows: (RowData | null)[]) {
    return rows.filter((row): row is RowData => row != null);
  }

  private getMultiRowLabel(rows: (RowData | null)[], fallback: string) {
    if (typeof this.config.resolveMultiRowLabel === 'function') {
      const resolved = this.config.resolveMultiRowLabel(this.getNonNullRows(rows), fallback);
      if (typeof resolved === 'string' && resolved.trim().length > 0) {
        return resolved.trim();
      }
    }
    return fallback;
  }

  private getMultiRowTypeLabel(rows: (RowData | null)[]) {
    if (typeof this.config.resolveMultiRowTypeLabel === 'function') {
      const resolved = this.config.resolveMultiRowTypeLabel(this.getNonNullRows(rows));
      const normalized = typeof resolved === 'string' ? resolved.trim() : resolved ? String(resolved).trim() : '';
      if (normalized.length > 0) return normalized;
    }
    const first = rows.find((row): row is RowData => row != null) ?? null;
    const singleLabel = this.getRowTypeLabel(first);
    if (singleLabel.endsWith('s')) return singleLabel;
    return `${singleLabel}s`;
  }

  private buildConfirmMessage(typeLabel: string, rowLabel: string) {
    if (typeof this.config.confirmMessage === 'function') {
      return this.config.confirmMessage(typeLabel, rowLabel);
    }
    return `Delete ${typeLabel} ${rowLabel}? This action cannot be undone.`;
  }

  private buildPayload(ids: number[]) {
    if (typeof this.config.buildPayload === 'function') return this.config.buildPayload(ids);
    return { ids };
  }

  private resolveLabel(
    value: GridRowDeletionLabel | undefined,
    fallback: string,
    context: GridRowDeletionLabelContext,
  ) {
    if (typeof value === 'function') {
      const resolved = value(context);
      if (typeof resolved === 'string' && resolved.trim().length > 0) {
        return resolved;
      }
    } else if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
    return fallback;
  }

  private getSuccessMessage(typeLabel: string, rowLabel: string) {
    if (typeof this.config.successToastMessage === 'string') {
      return this.config.successToastMessage;
    }
    if (typeof this.config.successToastMessage === 'function') {
      return this.config.successToastMessage(typeLabel, rowLabel);
    }
    return 'Row deleted';
  }

  private getFailureMessage() {
    return this.config.failureToastMessage ?? 'Unable to delete row. Please try again.';
  }

  private refreshGrid(api: GridApi<RowData> | null) {
    if (typeof this.config.refreshHandler === 'function') {
      try {
        this.config.refreshHandler(api);
      } catch (err) {
        console.warn('Failed to refresh grid after deletion', err);
      }
      return;
    }
    if (!api || typeof api.refreshServerSide !== 'function') return;
    try {
      api.refreshServerSide({ purge: true });
    } catch (err) {
      console.warn('Failed to refresh server-side data after deletion', err);
    }
  }

  private async deleteRows(rows: (RowData | null)[], ids: number[], api: GridApi<RowData> | null) {
    if (ids.length === 0) return;
    if (typeof this.config.canDelete === 'function') {
      const check = this.config.canDelete(ids.length);
      if (!check.allowed) {
        showToastMessage(check.reason, 'error');
        return;
      }
    }
    const isSingle = ids.length === 1;
    const fallbackLabel = isSingle ? `record #${ids[0]}` : `${ids.length} records`;
    const typeLabel = isSingle ? this.getRowTypeLabel(rows[0]) : this.getMultiRowTypeLabel(rows);
    const rowLabel = isSingle
      ? this.config.resolveRowLabel(rows[0], fallbackLabel)
      : this.getMultiRowLabel(rows, fallbackLabel);
    const labelContext: GridRowDeletionLabelContext = {
      isSingle,
      count: ids.length,
      typeLabel,
      rowLabel,
    };
    const defaultTitle = `Delete ${typeLabel}`;
    const title = this.resolveLabel(this.config.confirmTitle, defaultTitle, labelContext);
    const confirmLabel = this.resolveLabel(
      this.config.confirmConfirmLabel,
      defaultTitle,
      labelContext,
    );
    const cancelLabel = this.resolveLabel(
      this.config.confirmCancelLabel,
      `Keep ${typeLabel}`,
      labelContext,
    );
    const confirmed = await showConfirmDialog({
      title,
      message: this.buildConfirmMessage(typeLabel, rowLabel),
      confirmLabel,
      cancelLabel,
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await fetch(this.config.endpoint, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload(ids)),
      });
      let payload: { ok?: boolean; error?: string; deletedRows?: unknown[] } | null = null;
      try {
        payload = (await res.json()) as { ok?: boolean; error?: string; deletedRows?: unknown[] } | null;
      } catch {
        payload = null;
      }
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to delete row (status ${res.status})`);
      }
      const apiDeletedRows = Array.isArray(payload.deletedRows) ? payload.deletedRows : [];
      const restoreEndpoint = this.config.restoreEndpoint;
      if (restoreEndpoint && apiDeletedRows.length > 0) {
        const capturedApi = api;
        showToastMessage(this.getSuccessMessage(typeLabel, rowLabel), 'success', 5500, {
          label: 'Undo',
          onClick: () => {
            fetch(restoreEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rows: apiDeletedRows }),
            })
              .then((r) => r.json())
              .then((result: { ok?: boolean } | null) => {
                if (result?.ok) {
                  showToastMessage('Restored successfully', 'info');
                  this.refreshGrid(capturedApi);
                } else {
                  showToastMessage('Unable to restore. Please try again.', 'error');
                }
              })
              .catch(() => {
                showToastMessage('Unable to restore. Please try again.', 'error');
              });
          },
        });
      } else {
        showToastMessage(this.getSuccessMessage(typeLabel, rowLabel), 'success');
      }
      if (typeof this.config.onDeleteSuccess === 'function') {
        this.config.onDeleteSuccess(apiDeletedRows, api);
      }
      this.refreshGrid(api);
    } catch (err) {
      console.error('Failed to delete row', err);
      showToastMessage(this.getFailureMessage(), 'error');
    }
  }

  public async deleteRow(
    rowData: RowData | null | undefined,
    rowId: number,
    api: GridApi<RowData> | null,
  ) {
    await this.deleteRows([rowData ?? null], [rowId], api);
  }

  public getContextMenuItems(params: GetContextMenuItemsParams<RowData>) {
    const baseItems: Array<MenuItemDef<RowData> | DefaultMenuItem | string> =
      Array.isArray(params.defaultItems) ? [...params.defaultItems] : [];
    try {
      const rowData = params.node?.data ?? null;
      const clickedRowId = this.config.resolveRowId(rowData);
      const snapshotNodes = readContextMenuSelectionSnapshot(params.api ?? null);
      const selectedNodes = snapshotNodes ?? (hasServerSideSelectAll(params.api ?? null)
        ? []
        : (typeof params.api?.getSelectedNodes === 'function'
          ? (params.api.getSelectedNodes() as Array<RowNode<RowData>>)
          : []));
      const selectedEntries = selectedNodes
        .map((node) => {
          const data = node?.data ?? null;
          if (!data) return null;
          const id = this.config.resolveRowId(data);
          if (id == null) return null;
          return { row: data, id };
        })
        .filter((entry): entry is { row: NonNullable<RowData>; id: number } => entry != null);
      const normalizedSelectedEntries = [...selectedEntries];
      const hasMultiSelection = normalizedSelectedEntries.length > 1;
      const targetEntries = hasMultiSelection
        ? normalizedSelectedEntries.map((entry) => ({ row: entry.row, id: entry.id }))
        : (clickedRowId != null ? [{ row: rowData ?? null, id: clickedRowId }] : []);
      if (targetEntries.length === 0) {
        return baseItems;
      }
      let deleteBlocked: string | null = null;
      if (typeof this.config.canDelete === 'function') {
        const check = this.config.canDelete(targetEntries.length);
        if (!check.allowed) deleteBlocked = check.reason;
      }
      if (baseItems.length > 0 && baseItems[baseItems.length - 1] !== 'separator') {
        baseItems.push('separator');
      }
      const rows = targetEntries.map((entry) => entry.row ?? null);
      const deleteLabel = targetEntries.length > 1
        ? `Delete ${this.getMultiRowTypeLabel(rows)}`
        : `Delete ${this.getRowTypeLabel(rows[0])}`;
      const deleteItem: MenuItemDef<RowData> = {
        name: deleteLabel,
        icon: deleteRecordMenuIcon,
        disabled: deleteBlocked != null,
        tooltip: deleteBlocked ?? undefined,
        action: () => {
          const ids = targetEntries.map((entry) => entry.id);
          void this.deleteRows(rows, ids, params.api ?? null);
        },
      };
      baseItems.push(deleteItem);
      return baseItems;
    } catch (err) {
      console.error('Failed to build delete context menu items', err);
      return baseItems.length > 0 ? baseItems : (params.defaultItems ?? []);
    }
  }
}
