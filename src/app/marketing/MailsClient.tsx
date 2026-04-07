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
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from '../components/actionMenuMarkers';
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from '../components/useActionMenuCoordinator';
import { useActionMenuPosition } from '../components/useActionMenuPosition';
import { GridRowDeletion } from '../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../lib/deletePermissions';
import { useAuditUser } from '../components/AuditUserProvider';
import PageHeader from '../components/PageHeader';
import { GridQuickSearchProvider } from '../components/GridQuickSearchProvider';
import LookupModal from '../components/LookupModal';
import { showToastMessage } from '../../lib/toast';
import { formatBooleanValue } from '../lib/formatBooleanValue';
import { formatDateUK } from '../lib/formatDateTime';
import UKDatePicker from '../components/DatePicker';
import { normalizeBoolean } from '../../lib/normalizeBoolean';
import { useUndoStack } from '../hooks/useUndoStack';
import { pushCellEditUndo, makePatternAUndoFn } from '../../lib/undoHelpers';
import { useAddModal } from '../lib/useAddModal';
import {
  createMail,
  EMPTY_MAIL_FORM,
  type MailFormValues,
  validateMailForm,
} from './mailModalHelpers';
import styles from './MailsClient.module.css';

const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading mails…
    </div>
  ),
});

type RowData = Record<string, unknown>;

type MailRow = {
  MailID: number | null;
  Date: string | null;
  Description: string | null;
  Note: string | null;
  UsedForFax: boolean | number | null;
  IsPresent: boolean | number | null;
  Locked: boolean | number | null;
};

const normalizeMailId = (value: unknown): number | null => {
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

const MAIL_FIELD_LABELS: Record<string, string> = {
  Description: "Description",
  Note: "Note",
  Date: "Date",
  IsPresent: "Present",
  UsedForFax: "Used for fax",
  Locked: "Locked",
};

function normalizeMenuItemDef(item: MenuItemDef<MailRow, unknown>): MenuItemDef<RowData, unknown> {
  return {
    ...item,
    action:
      typeof item.action === "function"
        ? (params: IMenuActionParams<RowData, unknown>) =>
            item.action?.(params as unknown as IMenuActionParams<MailRow, unknown>)
        : undefined,
    subMenu: Array.isArray(item.subMenu) ? normalizeMailContextMenuItems(item.subMenu) : item.subMenu,
  };
}

function normalizeMailContextMenuItems(
  items: Array<string | DefaultMenuItem | MenuItemDef<MailRow, unknown>>,
): Array<string | DefaultMenuItem | MenuItemDef<RowData, unknown>> {
  return items.map((item) => {
    if (typeof item === "string") return item;
    return normalizeMenuItemDef(item as MenuItemDef<MailRow, unknown>);
  });
}

export default function MailsClient() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { roles } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [refreshToken, setRefreshToken] = useState(0);
  const [exporting, setExporting] = useState(false);
  const gridApiRef = useRef<GridApi | null>(null);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);

  const handleExportMail = useCallback(async () => {
    const api = gridApiRef.current;
    if (!api) return;
    const selectedNodes = api.getSelectedNodes?.() ?? [];
    if (selectedNodes.length === 0) {
      showToastMessage('Select a mail row first', 'error');
      return;
    }
    const mailId = (selectedNodes[0]?.data as MailRow | undefined)?.MailID;
    if (mailId == null) {
      showToastMessage('Selected row has no mail ID', 'error');
      return;
    }
    setExporting(true);
    try {
      const res = await fetch('/api/marketing/mails/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailId }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null) as { error?: string } | null;
        showToastMessage(errData?.error ?? 'Export failed', 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MailCustomerEmailList_${mailId}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToastMessage('Export downloaded', 'success');
    } catch (err) {
      console.error('Export failed', err);
      showToastMessage('Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }, []);

  const handleExportAll = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/marketing/mails/export-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null) as { error?: string } | null;
        showToastMessage(errData?.error ?? 'Export failed', 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'AllEmailContacts.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToastMessage('Export downloaded', 'success');
    } catch (err) {
      console.error('Export failed', err);
      showToastMessage('Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }, []);

  const {
    values: mailForm,
    setField: setMailField,
    isOpen: isAddMailOpen,
    open: openAddMail,
    close: closeAddMail,
    saving: mailSaving,
    error: mailError,
    setSaving: setMailSaving,
    setError: setMailError,
  } = useAddModal<MailFormValues>(() => ({ ...EMPTY_MAIL_FORM }));

  const mailRowDeletion = useMemo(
    () =>
      new GridRowDeletion<MailRow>({
        endpoint: "/api/marketing/mails",
        dataEndpoint: "/api/marketing/mails",
        idField: "MailID",
        resolveRowId: (row) => {
          const candidate = row?.MailID;
          return typeof candidate === "number" ? candidate : null;
        },
        resolveRowLabel: (row, fallback) => {
          const name = row?.Description;
          if (typeof name === "string" && name.trim().length > 0) return name.trim();
          return fallback;
        },
        resolveRowTypeLabel: () => "mail",
        buildPayload: (ids) => ({ MailIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? "Delete Mail List" : "Delete Mail List(s)"),
        confirmConfirmLabel: ({ isSingle }) => (isSingle ? "Delete Mail List" : "Delete Mail List(s)"),
        confirmCancelLabel: ({ isSingle }) => (isSingle ? "Keep mail" : "Keep mails"),
        successToastMessage: (_, label) => `${label} deleted`,
        failureToastMessage: "Unable to delete mail. Please try again.",
        refreshHandler: (api) => {
          if (!api || typeof api.refreshServerSide !== "function") return;
          try {
            api.refreshServerSide({ purge: true });
          } catch (err) {
            console.warn("Failed to refresh mails grid after deletion", err);
          }
        },
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageCustomersContacts'),
      }),
    [roles],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<MailRow>;
      const items = mailRowDeletion.getContextMenuItems(typedParams);
      return normalizeMailContextMenuItems(items ?? []);
    },
    [mailRowDeletion],
  );

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const ActionMenu: React.FC = () => {
      const [open, setOpen] = useState(false);
      const closeMenu = useCallback(() => setOpen(false), []);
      const instanceId = useActionMenuCloseListener(closeMenu);
      const { buttonRef, menuRef, menuPos } = useActionMenuPosition(open);
      const id = params?.data?.MailID as string | number | undefined;
      const encodedId = id != null ? encodeURIComponent(String(id)) : '';

      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };
      const openInNewWindow = (path: string) => {
        if (!encodedId) return;
        const url = `/marketing/mails/${encodedId}/${path}`;
        setOpen(false);
        if (typeof window !== 'undefined') {
          window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        routerRef.current.push(url);
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
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            className={styles.actionButton}
            {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
            onClick={(event) => {
              event.stopPropagation();
              if (!open) {
                dispatchActionMenuCloseEvent(instanceId);
              }
              setOpen((v) => !v);
            }}
            onMouseDownCapture={preventRangeSelection}
            onPointerDownCapture={preventRangeSelection}
            onContextMenuCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
            disabled={!encodedId}
            title={encodedId ? 'Open menu' : 'Missing mail ID'}
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
                  openInNewWindow('contact-groups');
                }}
              >
                View Mail Contact Group List
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.actionMenuItem}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openInNewWindow('contacts');
                }}
              >
                View Mail Contacts List
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
      {
        field: "Date",
        headerName: "Date",
        filter: "agDateColumnFilter",
        valueFormatter: (params) => formatDateUK(params.value),
      },
      {
        field: "Description",
        headerName: "Description",
        filter: "agTextColumnFilter",
        editable: true,
        width: 400,
      },
      {
        field: "Note",
        headerName: "Note",
        filter: "agTextColumnFilter",
        editable: true,
        width: 400,
      },
      {
        field: "IsPresent",
        headerName: "Present",
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
          (params.data as Record<string, unknown>).IsPresent = normalizeBoolean(params.newValue);
          return true;
        },
      },
      {
        field: "Locked",
        headerName: "Locked",
        filter: "agSetColumnFilter",
        editable: false,
        valueFormatter: (params) => formatBooleanValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
        },
      },
    ],
    [enabledOptions, ActionCell],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in MAIL_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const mailId = normalizeMailId(
      (event.data as { MailID?: unknown } | undefined)?.MailID ?? null,
    );
    if (mailId == null) return;
    const label = MAIL_FIELD_LABELS[field] ?? field;
    const revertValue = () => {
      if (event.node) {
        try {
          event.node.setDataValue(field, event.oldValue);
          return;
        } catch {
          /* noop */
        }
      }
      event.api.refreshCells({ force: true });
    };
    const value =
      field === "IsPresent" || field === "Locked" || field === "UsedForFax"
        ? normalizeBoolean(
            (event.data as Record<string, unknown>)?.[field] ?? event.newValue,
          )
        : normalizeTextValue(event.newValue);

    const submit = async () => {
      try {
        const res = await fetch("/api/marketing/mails", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ MailID: mailId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: "/api/marketing/mails",
          idField: "MailID",
          entityId: mailId,
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

  const handleCreateMail = useCallback(async () => {
    const validationError = validateMailForm(mailForm);
    if (validationError) {
      setMailError(validationError);
      showToastMessage(validationError, "error");
      return;
    }
    setMailSaving(true);
    setMailError(null);
    const result = await createMail(mailForm);
    if (!result.ok) {
      const message = result.error ?? "Unable to create mail.";
      setMailError(message);
      showToastMessage(message, "error");
      setMailSaving(false);
      return;
    }
    closeAddMail();
    setMailSaving(false);
    setRefreshToken((prev) => prev + 1);
    showToastMessage("Mail created", "success");
  }, [mailForm, closeAddMail, setMailError, setMailSaving]);

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Marketing - Mail Lists"
          leftActions={
            canUndo ? (
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={performUndo}
              >
                ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
              </button>
            ) : undefined
          }
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={handleExportMail}
                disabled={exporting}
              >
                Export List
              </button>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={handleExportAll}
                disabled={exporting}
              >
                Export List with All Contacts
              </button>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={openAddMail}
              >
                Create Mail List
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/marketing/mails"
                columnDefs={columnDefs}
                columnStateNamespace="marketing-mails"
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
        open={isAddMailOpen}
        title="Create Mail List"
        onClose={closeAddMail}
        onConfirm={handleCreateMail}
        confirmLabel="Create Mail List"
        saving={mailSaving}
        error={mailError}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 500 }}>
              Date
            </label>
            <UKDatePicker
              value={mailForm.date}
              onChange={(val) => setMailField("date", val)}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 500 }}>
              Description *
            </label>
            <input
              style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}
              value={mailForm.description}
              required
              onChange={(e) => setMailField("description", e.target.value)}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 500 }}>
              Note
            </label>
            <textarea
              style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', minHeight: '60px', resize: 'vertical' }}
              value={mailForm.note}
              onChange={(e) => setMailField("note", e.target.value)}
            />
          </div>
        </div>
      </LookupModal>
    </>
  );
}
