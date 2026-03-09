"use client";

import React, { useState, useEffect, useCallback } from 'react';
import LookupModal from '../components/LookupModal';
import { showToastMessage } from '../../lib/toast';

type GroupEntry = {
  ContactGroupListID: number;
  ContactGroupID: number;
  Description: string | null;
  Importance: number | null;
  Note: string | null;
};

type MailEntry = {
  MailContactID: number;
  MailID: number;
  Description: string | null;
  Note: string | null;
};

type Props = {
  contactId: number;
  contactName: string;
  onClose: () => void;
};

export default function ContactGroupsMailsModal({ contactId, contactName, onClose }: Props) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [mails, setMails] = useState<MailEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/customer-contacts/${encodeURIComponent(contactId)}/groups-and-mails`);
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        groups?: GroupEntry[];
        mails?: MailEntry[];
      } | null;
      if (data?.ok) {
        setGroups(data.groups ?? []);
        setMails(data.mails ?? []);
      }
    } catch (err) {
      console.error('Failed to fetch contact groups/mails', err);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleDeleteGroup = useCallback(async (contactGroupListId: number) => {
    try {
      const res = await fetch(`/api/customer-contacts/${encodeURIComponent(contactId)}/groups-and-mails`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'group', id: contactGroupListId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (data?.ok) {
        setGroups((prev) => prev.filter((g) => g.ContactGroupListID !== contactGroupListId));
        showToastMessage('Removed from group', 'success');
      } else {
        showToastMessage('Failed to remove from group', 'error');
      }
    } catch {
      showToastMessage('Failed to remove from group', 'error');
    }
  }, [contactId]);

  const handleDeleteMail = useCallback(async (mailContactId: number) => {
    try {
      const res = await fetch(`/api/customer-contacts/${encodeURIComponent(contactId)}/groups-and-mails`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mail', id: mailContactId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (data?.ok) {
        setMails((prev) => prev.filter((m) => m.MailContactID !== mailContactId));
        showToastMessage('Removed from mail', 'success');
      } else {
        showToastMessage('Failed to remove from mail', 'error');
      }
    } catch {
      showToastMessage('Failed to remove from mail', 'error');
    }
  }, [contactId]);

  const tableStyle: React.CSSProperties = {
    width: '100%', borderCollapse: 'collapse', fontSize: '13px',
  };
  const thStyle: React.CSSProperties = {
    padding: '6px 8px', textAlign: 'left', background: '#f1f5f9',
    borderBottom: '1px solid #e2e8f0', fontWeight: 600, fontSize: '12px',
  };
  const tdStyle: React.CSSProperties = {
    padding: '4px 8px', borderBottom: '1px solid #f1f5f9',
  };
  const deleteBtnStyle: React.CSSProperties = {
    background: 'none', border: 'none', color: '#ef4444',
    cursor: 'pointer', fontSize: '13px', padding: '2px 6px',
  };
  const sectionStyle: React.CSSProperties = {
    fontWeight: 600, fontSize: '14px', marginBottom: '6px', color: '#334155',
  };

  return (
    <LookupModal
      open
      title={`Contact Group Lists — ${contactName}`}
      onClose={onClose}
      onConfirm={onClose}
      confirmLabel="Close"
      saving={false}
      error={null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '500px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>Loading...</div>
        ) : (
          <>
            <div>
              <div style={sectionStyle}>Contact Groups</div>
              {groups.length === 0 ? (
                <div style={{ fontSize: '13px', color: '#888' }}>Not in any contact groups</div>
              ) : (
                <div style={{ maxHeight: '200px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Description</th>
                        <th style={{ ...thStyle, width: '80px' }}>Importance</th>
                        <th style={thStyle}>Note</th>
                        <th style={{ ...thStyle, width: '50px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.ContactGroupListID}>
                          <td style={tdStyle}>{g.Description ?? ''}</td>
                          <td style={tdStyle}>{g.Importance ?? ''}</td>
                          <td style={tdStyle}>{g.Note ?? ''}</td>
                          <td style={tdStyle}>
                            <button
                              type="button"
                              style={deleteBtnStyle}
                              title="Remove from group"
                              onClick={() => handleDeleteGroup(g.ContactGroupListID)}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <div style={sectionStyle}>Mails</div>
              {mails.length === 0 ? (
                <div style={{ fontSize: '13px', color: '#888' }}>Not in any mails</div>
              ) : (
                <div style={{ maxHeight: '200px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, width: '60px' }}>Mail ID</th>
                        <th style={thStyle}>Description</th>
                        <th style={thStyle}>Note</th>
                        <th style={{ ...thStyle, width: '50px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {mails.map((m) => (
                        <tr key={m.MailContactID}>
                          <td style={tdStyle}>{m.MailID}</td>
                          <td style={tdStyle}>{m.Description ?? ''}</td>
                          <td style={tdStyle}>{m.Note ?? ''}</td>
                          <td style={tdStyle}>
                            <button
                              type="button"
                              style={deleteBtnStyle}
                              title="Remove from mail"
                              onClick={() => handleDeleteMail(m.MailContactID)}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </LookupModal>
  );
}
