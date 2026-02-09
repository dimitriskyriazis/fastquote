'use client';

import { useEffect, useState, useCallback } from 'react';
import LookupModal from '../../components/LookupModal';
import { formatDateTime } from '../../lib/formatDateTime';
import styles from './OfferStatusHistoryModal.module.css';

type StatusHistoryEntry = {
  ID: number;
  StatusName: string;
  CreatedOn: string | Date;
  CreatedByFullName: string | null;
  CreatedByUserName: string | null;
};

type Props = {
  open: boolean;
  offerId: string;
  onClose: () => void;
};

export default function OfferStatusHistoryModal({ open, offerId, onClose }: Props) {
  const [history, setHistory] = useState<StatusHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!open || !offerId) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/status-history`);
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to load history');
      }

      setHistory(data.history || []);
    } catch (err) {
      console.error('Failed to fetch status history', err);
      setError(err instanceof Error ? err.message : 'Unable to load status history');
    } finally {
      setLoading(false);
    }
  }, [open, offerId]);

  useEffect(() => {
    if (open) {
      void fetchHistory();
    }
  }, [open, fetchHistory]);

  const formatUser = (entry: StatusHistoryEntry) => {
    if (entry.CreatedByFullName) return entry.CreatedByFullName;
    if (entry.CreatedByUserName) return entry.CreatedByUserName;
    return 'Unknown user';
  };

  return (
    <LookupModal
      open={open}
      title="Status History"
      onClose={onClose}
      onConfirm={onClose}
      confirmLabel=""
      cancelLabel=""
      cardStyle={{ width: '600px', maxWidth: '90vw' }}
      footerClassName={styles.hiddenFooter}
      headerClassName={styles.customHeader}
    >
      {loading && <div className={styles.loading}>Loading history...</div>}
      {error && <div className={styles.error}>{error}</div>}
      {!loading && !error && history.length === 0 && (
        <div className={styles.empty}>No status changes recorded</div>
      )}
      {!loading && !error && history.length > 0 && (
        <table className={styles.historyTable}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Changed On</th>
              <th>Changed By</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.ID}>
                <td>{entry.StatusName}</td>
                <td>{formatDateTime(entry.CreatedOn)}</td>
                <td>{formatUser(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </LookupModal>
  );
}
