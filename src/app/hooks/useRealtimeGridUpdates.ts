'use client';

import { useEffect, useRef } from 'react';
import type { GridApi } from 'ag-grid-community';
import { showToastMessage } from '../../lib/toast';

type RowData = Record<string, unknown>;

type RealtimeEvent = {
  resource: string;
  type:
    | 'row-added'
    | 'row-updated'
    | 'row-deleted'
    | 'rows-reordered'
    | 'rows-refresh'
    | 'rows-restored'
    | 'cell-updated'
    | 'connected';
  data: {
    row?: RowData;
    rowId?: number;
    OfferDetailID?: number;
    field?: string;
    value?: unknown;
    updates?: Array<{ OfferDetailID: number; TreeOrdering: string }>;
    updatedBy?: string;
    reason?: string;
    restoredCount?: number;
  };
  timestamp: number;
};

type UseRealtimeGridUpdatesOptions = {
  resource: string;
  gridApi: GridApi | null;
  enabled?: boolean;
  showNotifications?: boolean; // Default: false - only show toasts for own edits, not real-time updates
  onBeforeCellUpdate?: (info: {
    rowId: number;
    field: string;
    value: unknown;
    updatedBy?: string;
  }) => void;
  onRowAdded?: (row: RowData) => void;
  onRowUpdated?: (rowId: number, field: string, value: unknown) => void;
  onRowDeleted?: (rowId: number) => void;
  onRowsReordered?: (updates: Array<{ OfferDetailID: number; TreeOrdering: string }>) => void;
};

function findInsertIndex(api: GridApi, targetOrdering: string | null | undefined): number {
  if (!targetOrdering) return -1; // Append to end

  let insertIndex = -1;
  let found = false;

  api.forEachNode((node, index) => {
    if (found) return;
    const currentOrdering = node.data?.TreeOrdering ?? '';

    // Compare TreeOrdering to find correct position
    if (compareTreeOrdering(currentOrdering, targetOrdering) > 0) {
      insertIndex = index;
      found = true;
    }
  });

  return insertIndex;
}

function compareTreeOrdering(a: string, b: string): number {
  // Compare "1.2.3" style ordering
  const aParts = a.split('.').map((part) => {
    const num = Number.parseInt(part.trim(), 10);
    return Number.isNaN(num) ? 0 : num;
  });
  const bParts = b.split('.').map((part) => {
    const num = Number.parseInt(part.trim(), 10);
    return Number.isNaN(num) ? 0 : num;
  });

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  return 0;
}

export function useRealtimeGridUpdates({
  resource,
  gridApi,
  enabled = true,
  showNotifications = false, // Default to false - person making edit already gets feedback
  onBeforeCellUpdate,
  onRowAdded,
  onRowUpdated,
  onRowDeleted,
  onRowsReordered,
}: UseRealtimeGridUpdatesOptions) {
  const gridApiRef = useRef(gridApi);

  // Update ref in effect to avoid updating during render
  useEffect(() => {
    gridApiRef.current = gridApi;
  }, [gridApi]);

  useEffect(() => {
    if (!enabled || !resource) return;

    const url = `/api/realtime?resource=${encodeURIComponent(resource)}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as RealtimeEvent;
        if (event.type === 'connected') return;

        const api = gridApiRef.current;
        if (!api || api.isDestroyed?.()) return;

        switch (event.type) {
          case 'row-added': {
            const { row } = event.data;
            if (row) {
              // Find where to insert based on TreeOrdering
              const insertIndex = findInsertIndex(api, row.TreeOrdering as string | null | undefined);
              
              // Add row to grid
              api.applyServerSideTransaction({
                add: [row],
                addIndex: insertIndex >= 0 ? insertIndex : undefined,
              });

              // Optional: Scroll to new row after a brief delay
              setTimeout(() => {
                if (api && !api.isDestroyed?.() && row.OfferDetailID) {
                  api.forEachNode((node) => {
                    if (node.data?.OfferDetailID === row.OfferDetailID) {
                      api.ensureNodeVisible(node, 'middle');
                    }
                  });
                }
              }, 100);

              if (showNotifications) {
                showToastMessage('New row added by another user', 'info');
              }
              onRowAdded?.(row);
            }
            break;
          }

          case 'cell-updated':
          case 'row-updated': {
            const { rowId, OfferDetailID, field, value, row: fullRow, updatedBy } = event.data;
            const targetId = rowId ?? OfferDetailID;

            if (fullRow && targetId) {
              // Update entire row
              api.applyServerSideTransaction({
                update: [fullRow],
              });
            } else if (targetId && field !== undefined) {
              onBeforeCellUpdate?.({
                rowId: targetId,
                field,
                value,
                updatedBy,
              });
              // Update specific cell
              api.forEachNode((node) => {
                if (node.data?.OfferDetailID === targetId) {
                  node.setDataValue(field, value);
                }
              });
            }
            if (targetId && field) {
              onRowUpdated?.(targetId, field, value);
            }
            break;
          }

          case 'row-deleted': {
            const { OfferDetailID, rowId } = event.data;
            const targetId = OfferDetailID ?? rowId;
            
            if (targetId) {
              let rowToRemove: RowData | null = null;
              api.forEachNode((node) => {
                if (node.data?.OfferDetailID === targetId) {
                  rowToRemove = node.data;
                }
              });

              if (rowToRemove) {
                api.applyServerSideTransaction({
                  remove: [rowToRemove],
                });
                if (showNotifications) {
                  showToastMessage('Row deleted by another user', 'info');
                }
                onRowDeleted?.(targetId);
              }
            }
            break;
          }

          case 'rows-reordered': {
            const { updates } = event.data;
            if (updates && updates.length > 0) {
              // Update TreeOrdering values
              updates.forEach(({ OfferDetailID, TreeOrdering }) => {
                api.forEachNode((node) => {
                  if (node.data?.OfferDetailID === OfferDetailID) {
                    node.setDataValue('TreeOrdering', TreeOrdering);
                  }
                });
              });

              // Refresh to apply new order
              api.refreshServerSide({ purge: false });

              if (showNotifications) {
                showToastMessage('Row order updated by another user', 'info');
              }
              onRowsReordered?.(updates);
            }
            break;
          }

          case 'rows-refresh':
          case 'rows-restored': {
            // Bulk mutations (add products, import requested rows, assign/unassign requested rows, restore)
            // can change many fields and/or row counts, so just refresh from the server.
            api.refreshServerSide({ purge: false });
            if (showNotifications) {
              showToastMessage('Rows updated by another user', 'info');
            }
            break;
          }
        }
      } catch (err) {
        console.error('Failed to process realtime event', err);
      }
    };

    eventSource.onerror = (err) => {
      if (process.env.NODE_ENV !== 'production') {
        console.debug('Realtime connection error (will retry)', err);
      }
      // EventSource will automatically reconnect
    };

    return () => {
      eventSource.close();
    };
  }, [
    resource,
    enabled,
    showNotifications,
    onBeforeCellUpdate,
    onRowAdded,
    onRowUpdated,
    onRowDeleted,
    onRowsReordered,
  ]);
}
