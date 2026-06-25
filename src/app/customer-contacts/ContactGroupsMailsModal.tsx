"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import LookupModal from '../components/LookupModal';
import lookupStyles from '../components/LookupModal.module.css';
import { showToastMessage } from '../../lib/toast';

type GroupEntry = {
  ContactGroupListID: number;
  ContactGroupID: number;
  Description: string | null;
  Importance: string | null;
  Note: string | null;
};

type MailEntry = {
  MailContactID: number;
  MailID: number;
  Description: string | null;
  Note: string | null;
};

type GroupOption = { value: string; label: string };

type Props = {
  contactId: number;
  contactName: string;
  onClose: () => void;
};

export default function ContactGroupsMailsModal({ contactId, contactName, onClose }: Props) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [mails, setMails] = useState<MailEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [allGroupOptions, setAllGroupOptions] = useState<GroupOption[]>([]);
  const [addGroupText, setAddGroupText] = useState('');
  const [addGroupSelected, setAddGroupSelected] = useState<GroupOption | null>(null);
  const [isAddGroupListOpen, setIsAddGroupListOpen] = useState(false);
  const [addGroupSaving, setAddGroupSaving] = useState(false);
  const addGroupListTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    let active = true;
    const loadGroups = async () => {
      try {
        const res = await fetch('/api/marketing/contact-groups', { cache: 'no-store' });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; options?: GroupOption[] } | null;
        if (active && data?.ok && Array.isArray(data.options)) {
          setAllGroupOptions(data.options);
        }
      } catch { /* ignore */ }
    };
    void loadGroups();
    return () => { active = false; };
  }, []);

  const memberGroupIds = useMemo(
    () => new Set(groups.map((g) => String(g.ContactGroupID))),
    [groups],
  );

  const filteredAddGroupOptions = useMemo(() => {
    const available = allGroupOptions.filter((o) => !memberGroupIds.has(o.value));
    const query = addGroupText.trim().toLowerCase();
    if (!query) return available;
    return available.filter((o) => o.label.toLowerCase().includes(query) || o.value.includes(query));
  }, [allGroupOptions, memberGroupIds, addGroupText]);

  const cancelAddGroupListClose = useCallback(() => {
    if (addGroupListTimerRef.current) {
      clearTimeout(addGroupListTimerRef.current);
      addGroupListTimerRef.current = null;
    }
  }, []);

  const scheduleAddGroupListClose = useCallback(() => {
    cancelAddGroupListClose();
    addGroupListTimerRef.current = setTimeout(() => {
      setIsAddGroupListOpen(false);
      addGroupListTimerRef.current = null;
    }, 120);
  }, [cancelAddGroupListClose]);

  useEffect(() => () => cancelAddGroupListClose(), [cancelAddGroupListClose]);

  const handleAddToGroup = useCallback(async () => {
    if (!addGroupSelected) return;
    setAddGroupSaving(true);
    try {
      const res = await fetch(`/api/customer-contacts/${encodeURIComponent(contactId)}/groups-and-mails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'group', targetId: Number(addGroupSelected.value) }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? 'Failed to add to group');
      }
      showToastMessage('Added to group', 'success');
      setAddGroupText('');
      setAddGroupSelected(null);
      setIsAddGroupListOpen(false);
      // Refresh the groups list
      const refreshRes = await fetch(`/api/customer-contacts/${encodeURIComponent(contactId)}/groups-and-mails`);
      const refreshData = (await refreshRes.json().catch(() => null)) as {
        ok?: boolean;
        groups?: GroupEntry[];
        mails?: MailEntry[];
      } | null;
      if (refreshData?.ok) {
        setGroups(refreshData.groups ?? []);
        setMails(refreshData.mails ?? []);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add to group';
      showToastMessage(message, 'error');
    } finally {
      setAddGroupSaving(false);
    }
  }, [addGroupSelected, contactId]);

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
  const addRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    marginBottom: isAddGroupListOpen ? 196 : 8, position: 'relative',
    transition: 'margin-bottom 150ms ease',
  };
  const addInputStyle: React.CSSProperties = {
    flex: 1, border: '1px solid #d1d5db', borderRadius: '8px',
    padding: '6px 10px', fontSize: '13px', color: '#0f172a', background: '#fff',
  };
  const addBtnStyle: React.CSSProperties = {
    border: 'none', borderRadius: '8px', padding: '6px 14px',
    fontSize: '13px', fontWeight: 500, cursor: 'pointer',
    background: '#000', color: '#fff', whiteSpace: 'nowrap',
  };
  const comboListStyle: React.CSSProperties = {
    position: 'absolute', top: '100%', left: 0, right: 60,
    zIndex: 10, maxHeight: '180px', overflow: 'auto',
    border: '1px solid #d1d5db', borderRadius: '10px',
    background: '#fff', boxShadow: '0 10px 24px rgba(15,23,42,0.12)',
    display: 'flex', flexDirection: 'column', marginTop: '4px',
  };
  const comboOptionStyle: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left', border: 'none',
    background: 'transparent', padding: '8px 10px', fontSize: '13px',
    color: '#0f172a', cursor: 'pointer',
  };
  const comboEmptyStyle: React.CSSProperties = {
    padding: '8px 10px', fontSize: '13px', color: '#64748b',
  };

  return (
    <LookupModal
      open
      title={`Contact Group Lists - ${contactName}`}
      onClose={onClose}
      onConfirm={onClose}
      confirmLabel="Close"
      saving={false}
      error={null}
      cardClassName={lookupStyles.cardWide}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '500px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>Loading...</div>
        ) : (
          <>
            <div>
              <div style={sectionStyle}>Contact Groups</div>
              <div style={addRowStyle}>
                <input
                  autoComplete="off"
                  style={addInputStyle}
                  value={addGroupText}
                  placeholder="Search groups to add..."
                  onFocus={() => {
                    cancelAddGroupListClose();
                    setIsAddGroupListOpen(true);
                  }}
                  onBlur={() => scheduleAddGroupListClose()}
                  onChange={(e) => {
                    setAddGroupText(e.target.value);
                    setAddGroupSelected(null);
                    setIsAddGroupListOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isAddGroupListOpen && filteredAddGroupOptions.length > 0) {
                      e.preventDefault();
                      cancelAddGroupListClose();
                      setAddGroupSelected(filteredAddGroupOptions[0]);
                      setAddGroupText(filteredAddGroupOptions[0].label);
                      setIsAddGroupListOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  style={{ ...addBtnStyle, opacity: (!addGroupSelected || addGroupSaving) ? 0.5 : 1 }}
                  disabled={!addGroupSelected || addGroupSaving}
                  onClick={() => void handleAddToGroup()}
                >
                  {addGroupSaving ? 'Adding...' : 'Add'}
                </button>
                {isAddGroupListOpen ? (
                  <div style={comboListStyle}>
                    {filteredAddGroupOptions.length > 0 ? (
                      filteredAddGroupOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          style={comboOptionStyle}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseOver={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#e5efff'; }}
                          onMouseOut={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                          onClick={() => {
                            cancelAddGroupListClose();
                            setAddGroupSelected(option);
                            setAddGroupText(option.label);
                            setIsAddGroupListOpen(false);
                          }}
                        >
                          {option.label}
                        </button>
                      ))
                    ) : (
                      <div style={comboEmptyStyle}>No groups available</div>
                    )}
                  </div>
                ) : null}
              </div>
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
