"use client";

import React, { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { ColDef, CellEditingStartedEvent, CellValueChangedEvent, GetContextMenuItemsParams, GridApi } from 'ag-grid-community';
import { showToastMessage } from '../../../../lib/toast';
import { useAuditUser } from '../../../components/AuditUserProvider';
import { coerceRoles, roleHasPermission } from '../../../../lib/roles';
import { GridRowDeletion } from '../../../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../../../lib/deletePermissions';
import { useUndoStack } from '../../../hooks/useUndoStack';
import { pushCellEditUndo, makePatternAUndoFn } from '../../../../lib/undoHelpers';
import LookupModal from '../../../components/LookupModal';
import PageHeader from '../../../components/PageHeader';
import modalStyles from '../../../components/LookupModal.module.css';
import { formatBooleanValue } from '../../../lib/formatBooleanValue';
import { createMailListExportRowFilter } from '../../mailListExportFilter';
import styles from './ContactGroupDetailClient.module.css';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading contacts…</div>,
});

type RowData = Record<string, unknown>;

type AvailableContact = {
  ContactID: number;
  CustomerName: string | null;
  Title: string | null;
  LastName: string | null;
  FirstName: string | null;
  Email: string | null;
};

type Props = {
  groupId: string;
  description: string | null;
};

const readText = (value: unknown): string => {
  if (value == null) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
};

// "Last First (Customer)" for confirm dialogs and toasts; falls back to the
// helper's own "record #123" when the row has no usable name.
const formatMemberLabel = (row: RowData | null | undefined, fallback: string): string => {
  if (!row) return fallback;
  const name = [readText(row.LastName), readText(row.FirstName)].filter((part) => part.length > 0).join(' ');
  const customer = readText(row.CustomerName);
  if (name && customer) return `${name} (${customer})`;
  return name || customer || fallback;
};

// Columns that live on dbo.Contacts rather than on the membership row. Edits to
// them go through the contacts endpoint so the change lands on the contact
// itself, and therefore everywhere the contact appears, not on this group only.
const CONTACTS_ENDPOINT = '/api/customer-contacts';
const CONTACT_FIELD_LABELS: Record<string, string> = {
  Email: 'Email',
  EmailStatus: 'Email status',
  SecondEmail: 'Second email',
  SecondEmailStatus: 'Second email status',
};
const CONTACT_FIELD_TOOLTIP = 'Stored on the contact record. Editing it here updates the contact everywhere.';
const STATUS_FIELDS = new Set(['EmailStatus', 'SecondEmailStatus']);

const readContactId = (row: RowData | undefined): number | null => {
  const candidate = row?.ContactID;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
};

export default function ContactGroupDetailClient({ groupId, description }: Props) {
  const { roles } = useAuditUser();
  const canManage = useMemo(() => roleHasPermission(coerceRoles([...roles]), 'manageMarketing'), [roles]);
  // Contact columns follow the contacts grid's permission, not the marketing
  // one: the PATCH they hit is /api/customer-contacts.
  const canEditContacts = useMemo(() => roleHasPermission(coerceRoles([...roles]), 'manageCustomersContacts'), [roles]);
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();

  // Email-status dropdown values come from dbo.EmailStatuses via the contacts
  // lookups endpoint. Held in a ref that cellEditorParams reads lazily, so the
  // memoised column defs keep their identity and saved layouts survive.
  const statusValuesRef = useRef<string[]>(['']);
  const statusLookupInFlightRef = useRef(false);
  const refreshStatusValues = useCallback(async () => {
    if (statusLookupInFlightRef.current) return;
    statusLookupInFlightRef.current = true;
    try {
      const res = await fetch(`${CONTACTS_ENDPOINT}?mode=lookups`, { cache: 'no-store' });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; lookups?: { statuses?: unknown } }
        | null;
      const statuses = payload?.lookups?.statuses;
      if (!res.ok || !payload?.ok || !Array.isArray(statuses)) return;
      const unique = new Set(
        statuses.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean),
      );
      statusValuesRef.current = ['', ...Array.from(unique)];
    } catch (err) {
      console.error('Failed to load email statuses', err);
    } finally {
      statusLookupInFlightRef.current = false;
    }
  }, []);
  useEffect(() => {
    if (canEditContacts) void refreshStatusValues();
  }, [canEditContacts, refreshStatusValues]);
  // Re-pull the list whenever a status editor opens so a status added in the
  // meantime is available on the next open without a page reload.
  const handleCellEditingStarted = useCallback((event: CellEditingStartedEvent<RowData>) => {
    const field = event.colDef.field;
    if (field && STATUS_FIELDS.has(field)) void refreshStatusValues();
  }, [refreshStatusValues]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AvailableContact[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);

  const membersEndpoint = useMemo(
    () => `/api/marketing/contact-groups/${encodeURIComponent(groupId)}/contacts`,
    [groupId],
  );
  const restoreEndpoint = `${membersEndpoint}/restore`;

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) {
      showToastMessage('Enter a search term', 'error');
      return;
    }
    setSearching(true);
    try {
      const res = await fetch('/api/customer-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            startRow: 0,
            endRow: 200,
            quickFilterText: q,
            enableFuzzyText: false,
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; rows?: AvailableContact[]; error?: string } | null;
      if (data?.ok && data.rows) {
        setSearchResults(data.rows);
        setSelectedContactIds(new Set());
      } else {
        setSearchResults([]);
        const msg = data?.error ?? 'Search failed';
        console.error('Search returned error:', msg);
        showToastMessage(msg, 'error');
      }
    } catch (err) {
      console.error('Failed to search contacts', err);
      showToastMessage('Unable to search contacts', 'error');
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  const handleAddSelected = useCallback(async () => {
    if (selectedContactIds.size === 0) {
      showToastMessage('Select at least one contact', 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`${membersEndpoint}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: Array.from(selectedContactIds) }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; added?: number; error?: string } | null;
      if (!res.ok || !data?.ok) {
        showToastMessage(data?.error ?? 'Failed to add contacts', 'error');
        return;
      }
      setRefreshToken((prev) => prev + 1);
      setSelectedContactIds(new Set());
      setAddModalOpen(false);
      setSearchResults([]);
      setSearchQuery('');
      showToastMessage(`${data.added ?? 0} contact(s) added to group`, 'success');
    } catch (err) {
      console.error('Failed to add contacts', err);
      showToastMessage('Failed to add contacts', 'error');
    } finally {
      setAdding(false);
    }
  }, [membersEndpoint, selectedContactIds]);

  const toggleContact = useCallback((contactId: number) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }, []);

  // Removing a member deletes the dbo.ContactsGroupLists row, never the contact.
  // Wired into the grid's right-click menu; the helper supplies the confirm
  // dialog, the permission check and the Undo wiring.
  const memberRowDeletion = useMemo(
    () =>
      new GridRowDeletion<RowData>({
        endpoint: membersEndpoint,
        dataEndpoint: membersEndpoint,
        idField: 'ContactGroupListID',
        actionVerb: 'Remove',
        resolveRowId: (row) => {
          const candidate = row?.ContactGroupListID;
          return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
        },
        resolveRowLabel: formatMemberLabel,
        // With select-all active the helper has no row data, only an
        // "N records" fallback; keep the count, swap the noun.
        resolveMultiRowLabel: (rows, fallback) => {
          const count = rows.length > 0 ? rows.length : Number.parseInt(fallback, 10);
          return Number.isFinite(count) ? `${count} members` : fallback;
        },
        resolveRowTypeLabel: () => 'member',
        buildPayload: (ids) => ({ ContactGroupListIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? 'Remove Member from Group' : 'Remove Members from Group'),
        confirmMessage: (_typeLabel, label) => `Remove ${label} from this group? The contact record itself is not deleted.`,
        confirmConfirmLabel: () => 'Remove',
        confirmCancelLabel: () => 'Cancel',
        successToastMessage: (_typeLabel, label) => `${label} removed from group`,
        failureToastMessage: 'Unable to remove from group. Please try again.',
        refreshHandler: (api) => {
          if (api && typeof api.refreshServerSide === 'function') {
            try { api.deselectAll?.(); } catch { /* noop */ }
            try { api.refreshServerSide({ purge: true }); return; } catch { /* fall through */ }
          }
          setRefreshToken((prev) => prev + 1);
        },
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageMarketing'),
        restoreEndpoint,
        // The toast's Undo goes through the page's undo stack so it and Ctrl+Z
        // act on one entry instead of each restoring the rows.
        onRequestUndo: () => { void performUndo(); },
        onDeleteSuccess: (deletedRows, api) => {
          if (deletedRows.length === 0) return;
          pushUndo({
            label: deletedRows.length === 1
              ? 'Member removed from group'
              : `${deletedRows.length} members removed from group`,
            undo: async () => {
              const res = await fetch(restoreEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: deletedRows }),
              });
              const result = (await res.json().catch(() => null)) as { ok?: boolean } | null;
              if (!res.ok || !result?.ok) throw new Error('Failed to restore');
              try { api?.refreshServerSide?.({ purge: true }); } catch { /* noop */ }
            },
          });
        },
      }),
    [membersEndpoint, restoreEndpoint, roles, pushUndo, performUndo],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => memberRowDeletion.getContextMenuItems(params),
    [memberRowDeletion],
  );

  const columnDefs = useMemo<ColDef[]>(() => [
    { field: "CustomerName", headerName: "Customer", filter: "agTextColumnFilter" },
    { field: "Title", headerName: "Title", filter: "agTextColumnFilter" },
    { field: "LastName", headerName: "Last Name", filter: "agTextColumnFilter" },
    { field: "FirstName", headerName: "First Name", filter: "agTextColumnFilter" },
    { field: "Position", headerName: "Position", filter: "agTextColumnFilter" },
    // Contact-record columns (CONTACT_FIELD_LABELS): an edit PATCHes the contact.
    { field: "Email", headerName: "Email", filter: "agTextColumnFilter", editable: canEditContacts, headerTooltip: CONTACT_FIELD_TOOLTIP },
    {
      field: "EmailStatus", headerName: "Email Status", filter: "agTextColumnFilter",
      editable: canEditContacts, headerTooltip: CONTACT_FIELD_TOOLTIP,
      cellEditor: "agSelectCellEditor", cellEditorParams: () => ({ values: statusValuesRef.current }),
    },
    { field: "SecondEmail", headerName: "Second Email", filter: "agTextColumnFilter", editable: canEditContacts, headerTooltip: CONTACT_FIELD_TOOLTIP },
    {
      field: "SecondEmailStatus", headerName: "Second Email Status", filter: "agTextColumnFilter",
      editable: canEditContacts, headerTooltip: CONTACT_FIELD_TOOLTIP,
      cellEditor: "agSelectCellEditor", cellEditorParams: () => ({ values: statusValuesRef.current }),
    },
    { field: "Importance", headerName: "Importance", filter: "agTextColumnFilter", editable: canManage, cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["", "High", "Med", "Low"] } },
    { field: "Note", headerName: "Note", filter: "agTextColumnFilter", editable: canManage },
    // A member whose customer has been retired stays visible here — this is the
    // screen you remove it from — but it is left out of the Excel/CSV export,
    // exactly as the mail-list export routes leave it out. The column makes that
    // difference visible and filterable instead of mysterious.
    {
      field: "CustomerEnabled", headerName: "Customer Enabled", filter: "agSetColumnFilter",
      valueFormatter: (params) => formatBooleanValue(params.value),
      filterParams: {
        values: ["true", "false"],
        valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
      },
    },
    {
      field: "ContactEnabled", headerName: "Contact Enabled", filter: "agSetColumnFilter",
      valueFormatter: (params) => formatBooleanValue(params.value),
      filterParams: {
        values: ["true", "false"],
        valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
      },
    },
  ], [canManage, canEditContacts]);

  const getExportRowFilter = useMemo(() => createMailListExportRowFilter(), []);

  // Preset filters, the Offers-list way: once AgGridAll has restored any
  // persisted filters, default Customer Enabled and Contact Enabled to Yes for
  // whichever of the two the user has not filtered. Both are guarded columns in
  // AgGridAll, so at their default they do not count as active filters, and the
  // header's "Clear filters" puts them back to Yes instead of wiping them.
  const defaultFiltersAppliedRef = useRef(false);
  const handleGridReady = useCallback((api: GridApi<RowData>) => {
    if (!api || defaultFiltersAppliedRef.current) return;
    const existing = api.getFilterModel() as Record<string, unknown> | null;
    const model: Record<string, unknown> = existing && typeof existing === 'object' ? { ...existing } : {};
    let changed = false;
    for (const key of ['CustomerEnabled', 'ContactEnabled']) {
      if (key in model) continue;
      model[key] = { filterType: 'set', values: ['true'] };
      changed = true;
    }
    if (changed) api.setFilterModel(model);
    defaultFiltersAppliedRef.current = true;
  }, []);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<RowData>) => {
    const field = event.colDef.field;
    if (!field) return;
    // Undo/redo and the failure revert below write back with source 'api'; that
    // write must not count as a fresh edit or it would PATCH a second time.
    if (event.source === 'api') return;
    if (event.newValue === event.oldValue) return;

    const revert = () => {
      if (event.node) {
        try {
          event.node.setDataValue(field, event.oldValue, 'api');
          return;
        } catch { /* noop */ }
      }
      event.api.refreshCells({ force: true });
    };

    // Email / status columns belong to the contact: PATCH dbo.Contacts through
    // the contacts endpoint (status names resolve to EmailStatusID there) and
    // offer the same toast Undo the contacts grid does.
    if (field in CONTACT_FIELD_LABELS) {
      const contactId = readContactId(event.data);
      if (contactId == null) return;
      const label = CONTACT_FIELD_LABELS[field];
      const value = event.newValue == null ? '' : String(event.newValue).trim();
      const submit = async () => {
        try {
          const res = await fetch(CONTACTS_ENDPOINT, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: [{ ContactID: contactId, field, value }] }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) throw new Error(payload?.error ?? `Failed to update ${label}`);
          pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
            endpoint: CONTACTS_ENDPOINT,
            idField: 'ContactID',
            entityId: contactId,
            field,
            oldValue: event.oldValue,
            node: event.node,
            gridApi: event.api,
          }));
          event.api.refreshServerSide?.({ purge: false });
        } catch (err) {
          console.error(`Failed to update ${label}`, err);
          showToastMessage(`Unable to update ${label}. Please try again.`, 'error');
          revert();
        }
      };
      void submit();
      return;
    }

    // Importance / Note live on the membership row (dbo.ContactsGroupLists).
    const cglId = event.data?.ContactGroupListID;
    if (typeof cglId !== 'number' || !Number.isFinite(cglId)) return;

    const submit = async () => {
      try {
        const res = await fetch(membersEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ ContactGroupListID: cglId, field, value: event.newValue }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (!res.ok || !payload?.ok) {
          showToastMessage('Failed to update', 'error');
          revert();
        }
      } catch {
        showToastMessage('Failed to update', 'error');
        revert();
      }
    };
    void submit();
  }, [membersEndpoint, pushUndo, performUndo]);

  return (
    <>
      <main className={styles.page}>
        {/* PageHeader supplies the slot AgGridAll's active-filters indicator
            ("Showing N rows with M filters ×") portals into, as on Offers. */}
        <PageHeader
          title={`${description || `Contact Group ${groupId}`} - Members`}
          leftActions={
            <>
              <Link href="/marketing/contact-groups" className={`${styles.backLink} page-header-button`}>
                <span aria-hidden="true">←</span>
                Back to Contact Groups
              </Link>
              {canUndo && (
                <button type="button" className="page-header-button" onClick={() => void performUndo()}>
                  ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
                </button>
              )}
            </>
          }
          rightActions={
            canManage ? (
              <button
                type="button"
                className="page-header-button"
                onClick={() => setAddModalOpen(true)}
              >
                Add Contact
              </button>
            ) : null
          }
        >
          <div className={`${styles.gridFrame} fq-grid-panel`}>
            <AgGridAll
              endpoint={membersEndpoint}
              columnDefs={columnDefs}
              columnStateNamespace={`contact-group-members-${groupId}`}
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              onCellEditingStarted={handleCellEditingStarted}
              getExportRowFilter={getExportRowFilter}
              getContextMenuItems={getContextMenuItems}
              refreshToken={refreshToken}
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
            />
          </div>
        </PageHeader>
      </main>

      <LookupModal
        open={addModalOpen}
        title="Add Contact to Group"
        onClose={() => {
          setAddModalOpen(false);
          setSearchResults([]);
          setSearchQuery('');
          setSelectedContactIds(new Set());
        }}
        onConfirm={handleAddSelected}
        confirmLabel={adding ? 'Adding…' : `Add Selected (${selectedContactIds.size})`}
        saving={adding}
        error={null}
        cardClassName={modalStyles.cardWide}
      >
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input
            style={{
              flex: 1,
              padding: '6px 10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '13px',
            }}
            placeholder="Search by customer name, contact name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
          />
          <button
            type="button"
            className="page-header-button"
            onClick={handleSearch}
            disabled={searching}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {searchResults.length > 0 && (
          <div style={{ overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f1f5f9', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left', width: '30px' }}></th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Customer</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Last Name</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>First Name</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>Email</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((c) => (
                  <tr
                    key={c.ContactID}
                    style={{
                      cursor: 'pointer',
                      background: selectedContactIds.has(c.ContactID) ? '#dbeafe' : undefined,
                    }}
                    onClick={() => toggleContact(c.ContactID)}
                  >
                    <td style={{ padding: '4px 8px' }}>
                      <input type="checkbox" checked={selectedContactIds.has(c.ContactID)} readOnly />
                    </td>
                    <td style={{ padding: '4px 8px' }}>{c.CustomerName ?? ''}</td>
                    <td style={{ padding: '4px 8px' }}>{c.LastName ?? ''}</td>
                    <td style={{ padding: '4px 8px' }}>{c.FirstName ?? ''}</td>
                    <td style={{ padding: '4px 8px' }}>{c.Email ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {searchResults.length === 0 && searchQuery.trim().length > 0 && !searching && (
          <div style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
            No results found. Try a different search term.
          </div>
        )}
      </LookupModal>
    </>
  );
}
