"use client";

import React, { useMemo, useCallback, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { ColDef, CellValueChangedEvent } from 'ag-grid-community';
import { showToastMessage } from '../../../../../lib/toast';
import { formatBooleanValue } from '../../../../lib/formatBooleanValue';
import LookupModal from '../../../../components/LookupModal';
import modalStyles from '../../../../components/LookupModal.module.css';
import styles from './MailContactsClient.module.css';

const AgGridAll = dynamic(() => import('../../../../components/AgGridAll'), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading contacts…</div>,
});

type AvailableContact = {
  ContactID: number;
  CustomerName: string | null;
  Title: string | null;
  LastName: string | null;
  FirstName: string | null;
  Email: string | null;
  Fax: string | null;
};

type Props = {
  mailId: string;
  description: string | null;
};

export default function MailContactsClient({ mailId, description }: Props) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AvailableContact[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);

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
      const data = (await res.json().catch(() => null)) as { ok?: boolean; rows?: AvailableContact[] } | null;
      if (data?.ok && data.rows) {
        setSearchResults(data.rows);
        setSelectedContactIds(new Set());
      }
    } catch (err) {
      console.error('Failed to search contacts', err);
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
      const res = await fetch(`/api/marketing/mails/${encodeURIComponent(mailId)}/contacts/add`, {
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
      showToastMessage(`${data.added ?? 0} contact(s) added to mail`, 'success');
    } catch (err) {
      console.error('Failed to add contacts', err);
      showToastMessage('Failed to add contacts', 'error');
    } finally {
      setAdding(false);
    }
  }, [mailId, selectedContactIds]);

  const handleExportList = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/marketing/mails/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailId: Number(mailId) }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; folder?: string; error?: string } | null;
      if (!res.ok || !data?.ok) {
        showToastMessage(data?.error ?? 'Export failed', 'error');
        return;
      }
      showToastMessage(`Export saved to ${data.folder ?? 'the shared drive'}`, 'success');
    } catch (err) {
      console.error('Export failed', err);
      showToastMessage('Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }, [mailId]);

  const toggleContact = useCallback((contactId: number) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }, []);

  const columnDefs = useMemo<ColDef[]>(() => [
    { field: "CustomerName", headerName: "Customer", filter: "agTextColumnFilter" },
    { field: "Title", headerName: "Title", filter: "agTextColumnFilter" },
    { field: "LastName", headerName: "Last Name", filter: "agTextColumnFilter" },
    { field: "FirstName", headerName: "First Name", filter: "agTextColumnFilter" },
    { field: "Email", headerName: "Email", filter: "agTextColumnFilter" },
    { field: "Fax", headerName: "Fax", filter: "agTextColumnFilter" },
    { field: "Importance", headerName: "Importance", filter: "agTextColumnFilter", editable: true, cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["", "High", "Med", "Low"] } },
    { field: "Note", headerName: "Note", filter: "agTextColumnFilter", editable: true },
    {
      field: "Sent", headerName: "Sent", filter: "agSetColumnFilter",
      valueFormatter: (params) => formatBooleanValue(params.value),
    },
    {
      field: "FaxSent", headerName: "Fax Sent", filter: "agSetColumnFilter",
      valueFormatter: (params) => formatBooleanValue(params.value),
    },
  ], []);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field) return;
    if (event.newValue === event.oldValue) return;
    const mcId = event.data?.MailContactID as number | undefined;
    if (mcId == null) return;

    const submit = async () => {
      try {
        const res = await fetch(`/api/marketing/mails/${encodeURIComponent(mailId)}/contacts`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ MailContactID: mcId, field, value: event.newValue }] }),
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
    <>
      <main className={styles.page}>
        <div className={styles.headerRow}>
          <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
            <Link href="/marketing" className={`${styles.backLink} page-header-button`}>
              <span aria-hidden="true">←</span>
              Back to Mail Lists
            </Link>
          </div>
          <h1 className={styles.heading}>
            {description || `Mail ${mailId}`} - Contacts List
          </h1>
          <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
            <button
              type="button"
              className="page-header-button"
              onClick={handleExportList}
              disabled={exporting}
            >
              {exporting ? 'Exporting…' : 'Export List'}
            </button>
            <button
              type="button"
              className="page-header-button"
              onClick={() => setAddModalOpen(true)}
            >
              Add Customer
            </button>
          </div>
        </div>

        <div className={`${styles.gridFrame} fq-grid-panel`}>
          <AgGridAll
            endpoint={`/api/marketing/mails/${encodeURIComponent(mailId)}/contacts`}
            columnDefs={columnDefs}
            columnStateNamespace={`mail-contacts-${mailId}`}
            onCellValueChanged={handleCellEdit}
            refreshToken={refreshToken}
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
          />
        </div>
      </main>

      <LookupModal
        open={addModalOpen}
        title="Add Customer to Mail"
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
