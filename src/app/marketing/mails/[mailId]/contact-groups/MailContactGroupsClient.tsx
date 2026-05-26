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
  description: string | null;
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

type AssignedGroupRow = {
  MailContactGroupID: number;
  ContactGroupID: number;
  Description: string | null;
  TotalCount: number | null;
  MinimumImportance: string | null;
  Note: string | null;
};

function normalizeAssignedContextMenuItems(
  items: Array<string | DefaultMenuItem | MenuItemDef<AssignedGroupRow, unknown>>,
): Array<string | DefaultMenuItem | MenuItemDef<RowData, unknown>> {
  return items.map((item) => {
    if (typeof item === "string") return item;
    const typed = item as MenuItemDef<AssignedGroupRow, unknown>;
    return {
      ...typed,
      action: typeof typed.action === "function"
        ? (params: IMenuActionParams<RowData, unknown>) =>
            typed.action?.(params as unknown as IMenuActionParams<AssignedGroupRow, unknown>)
        : undefined,
    } as MenuItemDef<RowData, unknown>;
  });
}

export default function MailContactGroupsClient({ mailId, description }: Props) {
  const [refreshToken, setRefreshToken] = useState(0);
  const topGridApiRef = useRef<GridApi | null>(null);
  const bottomGridApiRef = useRef<GridApi | null>(null);

  const handleRemoveGroups = useCallback(async (mcgIds: number[]) => {
    if (mcgIds.length === 0) return;
    try {
      const res = await fetch(`/api/marketing/mails/${encodeURIComponent(mailId)}/contact-groups`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ MailContactGroupIDs: mcgIds }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        showToastMessage(data?.error ?? 'Failed to remove group(s)', 'error');
        return;
      }
      setRefreshToken((prev) => prev + 1);
      showToastMessage(`${mcgIds.length} group(s) removed from mail list`, 'success');
    } catch (err) {
      console.error('Failed to remove group(s)', err);
      showToastMessage('Failed to remove group(s)', 'error');
    }
  }, [mailId]);

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
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
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
      items.push('separator');
      items.push('export');

      return normalizeContextMenuItems(items);
    },
    [handleAddGroups],
  );

  const getBottomContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<AssignedGroupRow>;
      const clickedRow = typedParams.node?.data;
      const items: Array<string | DefaultMenuItem | MenuItemDef<AssignedGroupRow, unknown>> = [];

      items.push({
        name: 'Remove from Mail List',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>',
        action: () => {
          const api = bottomGridApiRef.current;
          const selectedNodes = api?.getSelectedNodes?.() ?? [];
          const selectedIds = selectedNodes
            .map((n) => (n.data as AssignedGroupRow | undefined)?.MailContactGroupID)
            .filter((id): id is number => id != null);

          if (clickedRow?.MailContactGroupID != null && !selectedIds.includes(clickedRow.MailContactGroupID)) {
            void handleRemoveGroups([clickedRow.MailContactGroupID]);
            return;
          }

          if (selectedIds.length > 0) {
            void handleRemoveGroups(selectedIds);
          } else if (clickedRow?.MailContactGroupID != null) {
            void handleRemoveGroups([clickedRow.MailContactGroupID]);
          }
        },
      });

      items.push('separator');
      items.push('copy');
      items.push('separator');
      items.push('export');

      return normalizeAssignedContextMenuItems(items);
    },
    [handleRemoveGroups],
  );

  const allGroupsColumnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Description",
      headerName: "Group",
      filter: "agTextColumnFilter",
    },
    {
      field: "Division",
      headerName: "Division",
      filter: "agTextColumnFilter",
    },
    {
      field: "TotalCount",
      headerName: "Total",
      filter: "agNumberColumnFilter",
    },
    {
      field: "Importance1",
      headerName: "Imp. High",
      filter: "agNumberColumnFilter",
    },
    {
      field: "Importance2",
      headerName: "Imp. Med",
      filter: "agNumberColumnFilter",
    },
    {
      field: "Importance3",
      headerName: "Imp. Low",
      filter: "agNumberColumnFilter",
    },
    {
      field: "Note",
      headerName: "Note",
      filter: "agTextColumnFilter",
    },
  ], []);

  const assignedColumnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Description",
      headerName: "Group",
      filter: "agTextColumnFilter",
    },
    {
      field: "TotalCount",
      headerName: "Count",
      filter: "agNumberColumnFilter",
    },
    {
      field: "MinimumImportance",
      headerName: "Min. Importance",
      filter: "agTextColumnFilter",
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: ["", "High", "Med", "Low"] },
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
          {description || `Mail ${mailId}`} - Contact Group List
        </h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`} />
      </div>

      <div className={styles.splitContainer}>
        <div className={styles.halfSection}>
          <div className={styles.sectionTitle}>All Contact Groups</div>
          <div className={`${styles.gridFrame} fq-grid-panel`}>
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
          <div className={`${styles.gridFrame} fq-grid-panel`}>
            <AgGridAll
              endpoint={`/api/marketing/mails/${encodeURIComponent(mailId)}/contact-groups`}
              columnDefs={assignedColumnDefs}
              columnStateNamespace={`mail-contact-groups-${mailId}`}
              getContextMenuItems={getBottomContextMenuItems}
              onGridReady={(api) => { bottomGridApiRef.current = api; }}
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
