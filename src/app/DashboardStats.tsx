'use client';

import { useEffect, useState } from 'react';
import Skeleton from './components/Skeleton';
import styles from './DashboardStats.module.css';

type DashboardStatsData = {
  openOffers: number;
  offersByStatus: Record<string, number>;
  createdThisMonth: number;
  createdThisYear: number;
  winRate: number | null;
};

const STATUS_COLORS: Record<string, string> = {
  Draft: '#94a3b8',
  Sent: '#3b82f6',
  'In Negotiation': '#f59e0b',
  Won: '#22c55e',
  Lost: '#ef4444',
  Cancelled: '#a1a1aa',
};

const getStatusColor = (status: string) =>
  STATUS_COLORS[status] ?? '#cbd5e1';

export default function DashboardStats() {
  const [stats, setStats] = useState<DashboardStatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/dashboard/stats')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.ok) setStats(data.stats);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <section className={styles.statsSection}>
        <h2 className={styles.sectionTitle}>Dashboard</h2>
        <div className={styles.statsGrid}>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={styles.skeletonCard}>
              <Skeleton width={60} height={32} />
              <Skeleton width={100} height={14} variant="text" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!stats) return null;

  const winRateDisplay = stats.winRate != null
    ? `${Math.round(stats.winRate * 100)}%`
    : '—';

  const totalOffers = Object.values(stats.offersByStatus).reduce((sum, c) => sum + c, 0);
  const statusEntries = Object.entries(stats.offersByStatus)
    .sort((a, b) => b[1] - a[1]);

  return (
    <section className={styles.statsSection}>
      <h2 className={styles.sectionTitle}>Dashboard</h2>
      <hr className={styles.sectionDivider} />
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{stats.openOffers}</span>
          <span className={styles.statLabel}>Open Offers</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{totalOffers}</span>
          <span className={styles.statLabel}>Total Offers</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{stats.createdThisMonth}</span>
          <span className={styles.statLabel}>This Month</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{stats.createdThisYear}</span>
          <span className={styles.statLabel}>This Year</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{winRateDisplay}</span>
          <span className={styles.statLabel}>Win Rate</span>
        </div>
      </div>

      {statusEntries.length > 0 && (
        <div className={styles.pipelineWrapper}>
          <div className={styles.pipelineBar}>
            {statusEntries.map(([status, count]) => (
              <div
                key={status}
                className={styles.pipelineSegment}
                style={{
                  width: `${(count / totalOffers) * 100}%`,
                  backgroundColor: getStatusColor(status),
                }}
                title={`${status}: ${count}`}
              />
            ))}
          </div>
          <div className={styles.pipelineLegend}>
            {statusEntries.map(([status, count]) => (
              <span key={status} className={styles.legendItem}>
                <span className={styles.legendDot} style={{ backgroundColor: getStatusColor(status) }} />
                {status} ({count})
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
