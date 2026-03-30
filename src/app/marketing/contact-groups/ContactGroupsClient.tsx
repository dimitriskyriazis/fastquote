"use client";

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
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
import { createPortal } from 'react-dom';
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from '../../components/actionMenuMarkers';
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from '../../components/useActionMenuCoordinator';
import { useActionMenuPosition } from '../../components/useActionMenuPosition';
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
        confirmTitle: ({ isSingle }) => (isSingle ? "Delete contact group" : "Delete contact groups"),
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

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const ActionMenu: React.FC = () => {
      const [open, setOpen] = useState(false);
      const closeMenu = useCallback(() => setOpen(false), []);
      const instanceId = useActionMenuCloseListener(closeMenu);
      const { buttonRef, menuRef, menuPos } = useActionMenuPosition(open);
      const id = params?.data?.ContactGroupID as number | undefined;
      const encodedId = id != null ? encodeURIComponent(String(id)) : '';

      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };

      useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
          if (!(e.target instanceof Node)) return setOpen(false);
          if (buttonRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
          setOpen(false);
        };
        window.addEventListener('click', onDocClick);
        return () => window.removeEventListener('click', onDocClick);
      }, [open, buttonRef, menuRef]);

      const lines = (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="3" y="10.5" width="10" height="1.5" rx="0.75" fill="currentColor"/>
        </svg>
      );

      return (
        <div
          className={styles.actionCell}
          {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            className={styles.actionButton}
            {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
            onClick={(event) => {
              event.stopPropagation();
              if (!open) dispatchActionMenuCloseEvent(instanceId);
              setOpen((v) => !v);
            }}
            onMouseDownCapture={preventRangeSelection}
            onPointerDownCapture={preventRangeSelection}
            onContextMenuCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
            disabled={!encodedId}
            title={encodedId ? 'Open menu' : 'Missing group ID'}
            ref={buttonRef}
          >
            {lines}
          </button>
          {open && menuPos && createPortal(
            <div
              role="menu"
              className={styles.actionMenu}
              style={{ top: menuPos.top, left: menuPos.left }}
              ref={menuRef}
              {...{ [ACTION_MENU_PANEL_ATTRIBUTE]: 'true' }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <button
                type="button"
                role="menuitem"
                className={styles.actionMenuItem}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  if (encodedId) {
                    window.open(`/marketing/contact-groups/${encodedId}`, '_blank', 'noopener,noreferrer');
                  }
                }}
              >
                View Contact Group Lists
              </button>
            </div>,
            document.body
          )}
        </div>
      );
    };

    return <ActionMenu />;
  }, []);

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
              <button
                type="button"
                className="page-header-button"
                style={{ border: '1px solid rgba(15,23,42,0.15)', backgroundColor: '#e5e7eb', color: '#0f172a' }}
                onClick={() => router.push("/marketing")}
              >
                <span aria-hidden="true">←</span>
                Back to Mails
              </button>
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
