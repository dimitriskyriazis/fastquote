"use client";

import React, { useMemo, useCallback, useState, useRef } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type {
  ColDef,
  CellValueChangedEvent,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
  DefaultMenuItem,
  IMenuActionParams,
} from 'ag-grid-community';
import { showToastMessage } from '../../../../../lib/toast';
import styles from './MailContactGroupsClient.module.css';

const AgGridAll = dynamic(() => import('../../../../components/AgGridAll'), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading contact groups…</div>,
});

type RowData = Record<string, unknown>;

type Props = {
  mailId: string;
};

type AllGroupRow = {
  ContactGroupID: number;
  Description: string | null;
  Division: string | null;
  GroupImportance: string | null;
  Note: string | null;
  TotalCount: number | null;
  Importance1: number | null;
  Importance2: number | null;
  Importance3: number | null;
  Enabled: boolean | number | null;
};

function normalizeContextMenuItems(
  items: Array<string | DefaultMenuItem | MenuItemDef<AllGroupRow, unknown>>,
): Array<string | DefaultMenuItem | MenuItemDef<RowData, unknown>> {
  return items.map((item) => {
    if (typeof item === "string") return item;
    const typed = item as MenuItemDef<AllGroupRow, unknown>;
    return {
      ...typed,
      action: typeof typed.action === "function"
        ? (params: IMenuActionParams<RowData, unknown>) =>
            typed.action?.(params as unknown as IMenuActionParams<AllGroupRow, unknown>)
        : undefined,
    } as MenuItemDef<RowData, unknown>;
  });
}

export default function MailContactGroupsClient({ mailId }: Props) {
  const [refreshToken, setRefreshToken] = useState(0);
  const topGridApiRef = useRef<GridApi | null>(null);

  const handleAddGroups = useCallback(async (groupIds: number[]) => {
    if (groupIds.length === 0) return;
    try {
      const res = await fetch(`/api/marketing/mails/${encodeURIComponent(mailId)}/contact-groups/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactGroupIds: groupIds }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        showToastMessage(data?.error ?? 'Failed to add group(s)', 'error');
        return;
      }
      setRefreshToken((prev) => prev + 1);
      showToastMessage(`${groupIds.length} group(s) added to mail list`, 'success');
    } catch (err) {
      console.error('Failed to add group(s)', err);
      showToastMessage('Failed to add group(s)', 'error');
    }
  }, [mailId]);

  const getTopContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<AllGroupRow>;
      const clickedRow = typedParams.node?.data;
      const items: Array<string | DefaultMenuItem | MenuItemDef<AllGroupRow, unknown>> = [];

      items.push({
        name: 'Add to Mail List',
        action: () => {
          const api = topGridApiRef.current;
          const selectedNodes = api?.getSelectedNodes?.() ?? [];
          const selectedIds = selectedNodes
            .map((n) => (n.data as AllGroupRow | undefined)?.ContactGroupID)
            .filter((id): id is number => id != null);

          // If clicked row is not in selection, just add the clicked row
          if (clickedRow?.ContactGroupID != null && !selectedIds.includes(clickedRow.ContactGroupID)) {
            void handleAddGroups([clickedRow.ContactGroupID]);
            return;
          }

          // Otherwise add all selected
          if (selectedIds.length > 0) {
            void handleAddGroups(selectedIds);
          } else if (clickedRow?.ContactGroupID != null) {
            void handleAddGroups([clickedRow.ContactGroupID]);
          }
        },
      });

      items.push('separator');
      items.push('copy');

      return normalizeContextMenuItems(items);
    },
    [handleAddGroups],
  );

  const allGroupsColumnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Description",
      headerName: "Group",
      filter: "agTextColumnFilter",
      flex: 1,
    },
    {
      field: "Division",
      headerName: "Division",
      filter: "agTextColumnFilter",
      width: 150,
    },
    {
      field: "TotalCount",
      headerName: "Total",
      filter: "agNumberColumnFilter",
      width: 90,
    },
    {
      field: "Importance1",
      headerName: "Imp. 1",
      filter: "agNumberColumnFilter",
      width: 80,
    },
    {
      field: "Importance2",
      headerName: "Imp. 2",
      filter: "agNumberColumnFilter",
      width: 80,
    },
    {
      field: "Importance3",
      headerName: "Imp. 3",
      filter: "agNumberColumnFilter",
      width: 80,
    },
    {
      field: "Note",
      headerName: "Note",
      filter: "agTextColumnFilter",
      width: 200,
    },
  ], []);

  const assignedColumnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Description",
      headerName: "Group",
      filter: "agTextColumnFilter",
      flex: 1,
    },
    {
      field: "TotalCount",
      headerName: "Count",
      filter: "agNumberColumnFilter",
      width: 100,
    },
    {
      field: "MinimumImportance",
      headerName: "Min. Importance",
      filter: "agNumberColumnFilter",
      editable: true,
      width: 150,
    },
    {
      field: "Note",
      headerName: "Note",
      filter: "agTextColumnFilter",
      editable: true,
    },
  ], []);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field) return;
    if (event.newValue === event.oldValue) return;
    const mcgId = event.data?.MailContactGroupID as number | undefined;
    if (mcgId == null) return;

    const submit = async () => {
      try {
        const res = await fetch(`/api/marketing/mails/${encodeURIComponent(mailId)}/contact-groups`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ MailContactGroupID: mcgId, field, value: event.newValue }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (!res.ok || !payload?.ok) {
          showToastMessage('Failed to update', 'error');
          if (event.node) event.node.setDataValue(field, event.oldValue);
        }
      } catch {
        showToastMessage('Failed to update', 'error');
        if (event.node) event.node.setDataValue(field, event.oldValue);
      }
    };
    void submit();
  }, [mailId]);

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
          <Link href="/marketing" className={`${styles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to Mail Lists
          </Link>
        </div>
        <h1 className={styles.heading}>
          Mail {mailId} - Contact Group List
        </h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`} />
      </div>

      <div className={styles.splitContainer}>
        <div className={styles.halfSection}>
          <div className={styles.sectionTitle}>All Contact Groups</div>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/marketing/contact-groups"
              columnDefs={allGroupsColumnDefs}
              columnStateNamespace="mail-all-contact-groups"
              getContextMenuItems={getTopContextMenuItems}
              onGridReady={(api) => { topGridApiRef.current = api; }}
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
            />
          </div>
        </div>

        <div className={styles.halfSection}>
          <div className={styles.sectionTitle}>Assigned Contact Groups for this Mail List</div>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint={`/api/marketing/mails/${encodeURIComponent(mailId)}/contact-groups`}
              columnDefs={assignedColumnDefs}
              columnStateNamespace={`mail-contact-groups-${mailId}`}
              onCellValueChanged={handleCellEdit}
              refreshToken={refreshToken}
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
            />
          </div>
        </div>
      </div>
    </main>
  );
}
