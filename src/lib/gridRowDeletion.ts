import type { GridApi, GetContextMenuItemsParams, MenuItemDef, DefaultMenuItem } from 'ag-grid-community';
import { showConfirmDialog } from './confirm';
import { showToastMessage } from './toast';

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

type GridRowDeletionConfig<RowData> = {
  endpoint: string;
  resolveRowId: (row: RowData | null | undefined) => number | null;
  resolveRowLabel: (row: RowData | null | undefined, fallback: string) => string;
  resolveRowTypeLabel?: (row: RowData | null | undefined) => string | null | undefined;
  buildPayload?: (ids: number[]) => unknown;
  confirmTitle?: string;
  confirmMessage?: (typeLabel: string, label: string) => string;
  confirmConfirmLabel?: string;
  confirmCancelLabel?: string;
  successToastMessage?: string | ((typeLabel: string, label: string) => string);
  failureToastMessage?: string;
  refreshHandler?: (api: GridApi<RowData> | null) => void;
};

export class GridRowDeletion<RowData> {
  constructor(private readonly config: GridRowDeletionConfig<RowData>) {}

  private getRowTypeLabel(row: RowData | null | undefined) {
    const resolved = this.config.resolveRowTypeLabel?.(row);
    const normalized = typeof resolved === 'string' ? resolved.trim() : resolved ? String(resolved).trim() : '';
    if (normalized.length > 0) return normalized;
    return 'record';
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

  public async deleteRow(
    rowData: RowData | null | undefined,
    rowId: number,
    api: GridApi<RowData> | null,
  ) {
    const fallbackLabel = `record #${rowId}`;
    const rowLabel = this.config.resolveRowLabel(rowData, fallbackLabel);
    const typeLabel = this.getRowTypeLabel(rowData);
    const confirmed = await showConfirmDialog({
      title: this.config.confirmTitle ?? 'Delete row',
      message: this.buildConfirmMessage(typeLabel, rowLabel),
      confirmLabel: this.config.confirmConfirmLabel ?? 'Delete row',
      cancelLabel: this.config.confirmCancelLabel ?? 'Keep row',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await fetch(this.config.endpoint, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload([rowId])),
      });
      let payload: { ok?: boolean; error?: string } | null = null;
      try {
        payload = (await res.json()) as { ok?: boolean; error?: string } | null;
      } catch {
        payload = null;
      }
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to delete row (status ${res.status})`);
      }
      showToastMessage(this.getSuccessMessage(typeLabel, rowLabel), 'success');
      this.refreshGrid(api);
    } catch (err) {
      console.error('Failed to delete row', err);
      showToastMessage(this.getFailureMessage(), 'error');
    }
  }

  public getContextMenuItems(params: GetContextMenuItemsParams<RowData>) {
    const baseItems: Array<MenuItemDef<RowData> | DefaultMenuItem | string> =
      Array.isArray(params.defaultItems) ? [...params.defaultItems] : [];
    const rowData = params.node?.data ?? null;
    const rowId = this.config.resolveRowId(rowData);
    if (rowId == null) {
      return baseItems;
    }
    if (baseItems.length > 0 && baseItems[baseItems.length - 1] !== 'separator') {
      baseItems.push('separator');
    }
    const deleteItem: MenuItemDef = {
      name: 'Delete row',
      icon: deleteRecordMenuIcon,
      action: () => {
        void this.deleteRow(rowData, rowId, params.api ?? null);
      },
    };
    baseItems.push(deleteItem);
    return baseItems;
  }
}
