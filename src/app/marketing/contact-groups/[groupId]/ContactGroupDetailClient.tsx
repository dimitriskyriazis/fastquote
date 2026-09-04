"use client";

import React, { useMemo, useCallback, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { ColDef, CellValueChangedEvent, GetContextMenuItemsParams } from 'ag-grid-community';
import { showToastMessage } from '../../../../lib/toast';
import { useAuditUser } from '../../../components/AuditUserProvider';
import { coerceRoles, roleHasPermission } from '../../../../lib/roles';
import { GridRowDeletion } from '../../../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../../../lib/deletePermissions';
import { useUndoStack } from '../../../hooks/useUndoStack';
import LookupModal from '../../../components/LookupModal';
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

export default function ContactGroupDetailClient({ groupId, description }: Props) {
  const { roles } = useAuditUser();
  const canManage = useMemo(() => roleHasPermission(coerceRoles([...roles]), 'manageMarketing'), [roles]);
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
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
    { field: "Email", headerName: "Email", filter: "agTextColumnFilter" },
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
  ], [canManage]);

  const getExportRowFilter = useMemo(() => createMailListExportRowFilter(), []);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field) return;
    if (event.newValue === event.oldValue) return;
    const cglId = event.data?.ContactGroupListID as number | undefined;
    if (cglId == null) return;

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
          if (event.node) event.node.setDataValue(field, event.oldValue);
        }
      } catch {
        showToastMessage('Failed to update', 'error');
        if (event.node) event.node.setDataValue(field, event.oldValue);
      }
    };
    void submit();
  }, [membersEndpoint]);

  return (
    <>
      <main className={styles.page}>
        <div className={styles.headerRow}>
          <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
            <Link href="/marketing/contact-groups" className={`${styles.backLink} page-header-button`}>
              <span aria-hidden="true">←</span>
              Back to Contact Groups
            </Link>
            {canUndo && (
              <button type="button" className="page-header-button" onClick={() => void performUndo()}>
                ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
              </button>
            )}
          </div>
          <h1 className={styles.heading}>
            {description || `Contact Group ${groupId}`} - Members
          </h1>
          <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
            {canManage && (
              <button
                type="button"
                className="page-header-button"
                onClick={() => setAddModalOpen(true)}
              >
                Add Contact
              </button>
            )}
          </div>
        </div>

        <div className={`${styles.gridFrame} fq-grid-panel`}>
          <AgGridAll
            endpoint={membersEndpoint}
            columnDefs={columnDefs}
            columnStateNamespace={`contact-group-members-${groupId}`}
            onCellValueChanged={handleCellEdit}
            getExportRowFilter={getExportRowFilter}
            getContextMenuItems={getContextMenuItems}
            refreshToken={refreshToken}
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
          />
        </div>
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
