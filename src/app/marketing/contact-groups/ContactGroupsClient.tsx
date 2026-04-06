"use client";

import React, { useMemo, useCallback, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type {
  ColDef,
  ICellRendererParams,
  CellValueChangedEvent,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
  DefaultMenuItem,
  IMenuActionParams,
} from 'ag-grid-community';
import { GridRowDeletion } from '../../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../../lib/deletePermissions';
import { useAuditUser } from '../../components/AuditUserProvider';
import PageHeader from '../../components/PageHeader';
import { GridQuickSearchProvider } from '../../components/GridQuickSearchProvider';
import LookupModal from '../../components/LookupModal';
import { showToastMessage } from '../../../lib/toast';
import { formatBooleanValue } from '../../lib/formatBooleanValue';
import { normalizeBoolean } from '../../../lib/normalizeBoolean';
import { useUndoStack } from '../../hooks/useUndoStack';
import { pushCellEditUndo, makePatternAUndoFn } from '../../../lib/undoHelpers';
import { useAddModal } from '../../lib/useAddModal';
import {
  createContactGroup,
  EMPTY_CONTACT_GROUP_FORM,
  type ContactGroupFormValues,
  validateContactGroupForm,
} from './contactGroupModalHelpers';
import styles from './ContactGroupsClient.module.css';

const AgGridAll = dynamic(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading contact groups…</div>,
});

type RowData = Record<string, unknown>;

type GroupRow = {
  ContactGroupID: number | null;
  Description: string | null;
  Division: string | null;
  GroupImportance: string | null;
  Note: string | null;
  Enabled: boolean | number | null;
  TotalCount: number | null;
  Importance1: number | null;
  Importance2: number | null;
  Importance3: number | null;
};

const normalizeGroupId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const GROUP_FIELD_LABELS: Record<string, string> = {
  Description: "Description",
  Division: "Division",
  GroupImportance: "Group Importance",
  Note: "Note",
  Enabled: "Enabled",
};

function normalizeMenuItemDef(item: MenuItemDef<GroupRow, unknown>): MenuItemDef<RowData, unknown> {
  return {
    ...item,
    action:
      typeof item.action === "function"
        ? (params: IMenuActionParams<RowData, unknown>) =>
            item.action?.(params as unknown as IMenuActionParams<GroupRow, unknown>)
        : undefined,
    subMenu: Array.isArray(item.subMenu) ? normalizeGroupContextMenuItems(item.subMenu) : item.subMenu,
  };
}

function normalizeGroupContextMenuItems(
  items: Array<string | DefaultMenuItem | MenuItemDef<GroupRow, unknown>>,
): Array<string | DefaultMenuItem | MenuItemDef<RowData, unknown>> {
  return items.map((item) => {
    if (typeof item === "string") return item;
    return normalizeMenuItemDef(item as MenuItemDef<GroupRow, unknown>);
  });
}

export default function ContactGroupsClient() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { roles } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [refreshToken, setRefreshToken] = useState(0);
  const gridApiRef = useRef<GridApi | null>(null);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);

  const {
    values: groupForm,
    setField: setGroupField,
    isOpen: isAddGroupOpen,
    open: openAddGroup,
    close: closeAddGroup,
    saving: groupSaving,
    error: groupError,
    setSaving: setGroupSaving,
    setError: setGroupError,
  } = useAddModal<ContactGroupFormValues>(() => ({ ...EMPTY_CONTACT_GROUP_FORM }));

  const groupRowDeletion = useMemo(
    () =>
      new GridRowDeletion<GroupRow>({
        endpoint: "/api/marketing/contact-groups",
        dataEndpoint: "/api/marketing/contact-groups",
        idField: "ContactGroupID",
        resolveRowId: (row) => {
          const candidate = row?.ContactGroupID;
          return typeof candidate === "number" ? candidate : null;
        },
        resolveRowLabel: (row, fallback) => {
          const name = row?.Description;
          if (typeof name === "string" && name.trim().length > 0) return name.trim();
          return fallback;
        },
        resolveRowTypeLabel: () => "contact group",
        buildPayload: (ids) => ({ ContactGroupIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? "Delete Contact Group" : "Delete Contact Group(s)"),
        confirmConfirmLabel: ({ isSingle }) => (isSingle ? "Delete" : "Delete all"),
        confirmCancelLabel: () => "Cancel",
        successToastMessage: (_, label) => `${label} deleted`,
        failureToastMessage: "Unable to delete. Please try again.",
        refreshHandler: (api) => {
          if (!api || typeof api.refreshServerSide !== "function") return;
          try { api.refreshServerSide({ purge: true }); } catch { /* noop */ }
        },
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageCustomersContacts'),
      }),
    [roles],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<GroupRow>;
      const items = groupRowDeletion.getContextMenuItems(typedParams);
      return normalizeGroupContextMenuItems(items ?? []);
    },
    [groupRowDeletion],
  );

  const viewDetailsIcon = `
    <span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </span>
  `;

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    if (!params.data) return null;
    const id = params.data.ContactGroupID as number | undefined;
    if (!id) return null;
    return (
      <button
        type="button"
        className={styles.detailsButton}
        title="View Contact Group Lists"
        onClick={() => {
          window.open(`/marketing/contact-groups/${encodeURIComponent(String(id))}`, '_blank', 'noopener,noreferrer');
        }}
        dangerouslySetInnerHTML={{ __html: viewDetailsIcon }}
      />
    );
  }, [viewDetailsIcon]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        headerName: '',
        field: '__actions__',
        pinned: 'left',
        lockPinned: true,
        lockPosition: true,
        suppressNavigable: true,
        resizable: false,
        sortable: false,
        filter: false,
        suppressMovable: true,
        suppressSizeToFit: true,
        suppressColumnsToolPanel: true,
        width: 48,
        cellClass: styles.actionCellContainer,
        cellRenderer: ActionCell,
      },
      { field: "Description", headerName: "Description", filter: "agTextColumnFilter", editable: true },
      { field: "Division", headerName: "Division", filter: "agTextColumnFilter", editable: true },
      { field: "GroupImportance", headerName: "Group Importance", filter: "agTextColumnFilter", editable: true, cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["", "High", "Med", "Low"] } },
      { field: "Note", headerName: "Note", filter: "agTextColumnFilter", editable: true },
      { field: "TotalCount", headerName: "Total Count", filter: "agNumberColumnFilter", editable: false },
      { field: "Importance1", headerName: "Imp. High", filter: "agNumberColumnFilter", editable: false },
      { field: "Importance2", headerName: "Imp. Med", filter: "agNumberColumnFilter", editable: false },
      { field: "Importance3", headerName: "Imp. Low", filter: "agNumberColumnFilter", editable: false },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        valueFormatter: (params) => formatBooleanValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
        },
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    [enabledOptions, ActionCell],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in GROUP_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const groupId = normalizeGroupId(
      (event.data as { ContactGroupID?: unknown } | undefined)?.ContactGroupID ?? null,
    );
    if (groupId == null) return;
    const label = GROUP_FIELD_LABELS[field] ?? field;
    const revertValue = () => {
      if (event.node) {
        try { event.node.setDataValue(field, event.oldValue); return; } catch { /* noop */ }
      }
      event.api.refreshCells({ force: true });
    };
    const value = field === "Enabled"
      ? normalizeBoolean((event.data as Record<string, unknown>)?.[field] ?? event.newValue)
      : normalizeTextValue(event.newValue);

    const submit = async () => {
      try {
        const res = await fetch("/api/marketing/contact-groups", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ ContactGroupID: groupId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: "/api/marketing/contact-groups",
          idField: "ContactGroupID",
          entityId: groupId,
          field,
          oldValue: event.oldValue,
          node: event.node,
          gridApi: event.api,
        }));
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, "error");
        revertValue();
      }
    };
    void submit();
  }, [pushUndo, performUndo]);

  const handleCreateGroup = useCallback(async () => {
    const validationError = validateContactGroupForm(groupForm);
    if (validationError) {
      setGroupError(validationError);
      showToastMessage(validationError, "error");
      return;
    }
    setGroupSaving(true);
    setGroupError(null);
    const result = await createContactGroup(groupForm);
    if (!result.ok) {
      const message = result.error ?? "Unable to create contact group.";
      setGroupError(message);
      showToastMessage(message, "error");
      setGroupSaving(false);
      return;
    }
    closeAddGroup();
    setGroupSaving(false);
    setRefreshToken((prev) => prev + 1);
    showToastMessage("Contact group created", "success");
  }, [groupForm, closeAddGroup, setGroupError, setGroupSaving]);

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Marketing - Contact Groups"
          leftActions={
            <>
              {canUndo && (
                <button type="button" className={`page-header-button ${styles.headerButton}`} onClick={performUndo}>
                  ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
                </button>
              )}
            </>
          }
          rightActions={
            <div className={styles.headerActions}>
              <button type="button" className={`page-header-button ${styles.headerButton}`} onClick={openAddGroup}>
                Add Contact Group
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/marketing/contact-groups"
                columnDefs={columnDefs}
                columnStateNamespace="marketing-contact-groups"
                onCellValueChanged={handleCellEdit}
                refreshToken={refreshToken}
                getContextMenuItems={getContextMenuItems}
                onGridReady={(api) => { gridApiRef.current = api; }}
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
      </main>
      <LookupModal
        open={isAddGroupOpen}
        title="Add contact group"
        onClose={closeAddGroup}
        onConfirm={handleCreateGroup}
        confirmLabel="Add group"
        saving={groupSaving}
        error={groupError}
      >
        <div style={{ display: 'grid', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 500 }}>
              Description *
            </label>
            <input
              style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}
              value={groupForm.description}
              required
              onChange={(e) => setGroupField("description", e.target.value)}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 500 }}>
              Note
            </label>
            <textarea
              style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', minHeight: '60px', resize: 'vertical' }}
              value={groupForm.note}
              onChange={(e) => setGroupField("note", e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '13px', fontWeight: 500 }}>Enabled</label>
            <input
              type="checkbox"
              checked={groupForm.enabled}
              onChange={(e) => setGroupField("enabled", e.target.checked)}
            />
            <span style={{ fontSize: '13px' }}>{groupForm.enabled ? "Yes" : "No"}</span>
          </div>
        </div>
      </LookupModal>
    </>
  );
}
