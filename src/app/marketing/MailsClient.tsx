"use client";

import React, { useMemo, useCallback, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
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
        restoreEndpoint: "/api/marketing/mails/restore",
        onDeleteSuccess: (deletedRows, api) => {
          if (deletedRows.length > 0) {
            pushUndo({
              label: "Mail deleted",
              undo: async () => {
                const res = await fetch("/api/marketing/mails/restore", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ rows: deletedRows }),
                });
                const result = (await res.json().catch(() => null)) as { ok?: boolean } | null;
                if (!res.ok || !result?.ok) throw new Error("Failed to restore");
                try { api?.refreshServerSide?.({ purge: true }); } catch { /* noop */ }
              },
            });
          }
        },
      }),
    [roles, pushUndo],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<MailRow>;
      const baseItems = mailRowDeletion.getContextMenuItems(typedParams) ?? [];
      const normalized = normalizeMailContextMenuItems(baseItems);
      const mailId = normalizeMailId(
        (params.node?.data as { MailID?: unknown } | undefined)?.MailID ?? null,
      );
      if (mailId == null) return normalized;
      const encodedId = encodeURIComponent(String(mailId));
      const groupsHref = `/marketing/mails/${encodedId}/contact-groups`;
      const contactsHref = `/marketing/mails/${encodedId}/contacts`;
      const groupsIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>';
      const contactsIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>';
      const newTabIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>';
      const viewGroupsItem: MenuItemDef<RowData, unknown> = {
        name: 'View Mail Contact Group List',
        icon: groupsIcon,
        action: () => { routerRef.current.push(groupsHref); },
        subMenu: [
          {
            name: 'Open',
            icon: groupsIcon,
            action: () => { routerRef.current.push(groupsHref); },
          },
          {
            name: 'Open in new tab',
            icon: newTabIcon,
            action: () => { window.open(groupsHref, '_blank', 'noopener,noreferrer'); },
          },
        ],
      };
      const viewContactsItem: MenuItemDef<RowData, unknown> = {
        name: 'View Mail Contacts List',
        icon: contactsIcon,
        action: () => { routerRef.current.push(contactsHref); },
        subMenu: [
          {
            name: 'Open',
            icon: contactsIcon,
            action: () => { routerRef.current.push(contactsHref); },
          },
          {
            name: 'Open in new tab',
            icon: newTabIcon,
            action: () => { window.open(contactsHref, '_blank', 'noopener,noreferrer'); },
          },
        ],
      };
      return [viewGroupsItem, viewContactsItem, 'separator', ...normalized];
    },
    [mailRowDeletion],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
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
    [enabledOptions],
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
    const mailId = result.mailId;
    pushCellEditUndo(pushUndo, performUndo, `Mail "${mailForm.description}"`, async () => {
      const res = await fetch('/api/marketing/mails', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ MailIDs: [mailId] }),
      });
      const del = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !del?.ok) throw new Error('Failed to delete mail');
    });
  }, [mailForm, closeAddMail, setMailError, setMailSaving, pushUndo, performUndo]);

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
            <div className={`${styles.gridFrame} fq-grid-panel`}>
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
