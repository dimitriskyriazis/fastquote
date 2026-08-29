'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import layoutStyles from '../customerDetail.module.css';
import styles from './CustomerDuplicates.module.css';
import type {
  DuplicateConfidence,
  DuplicateGroup,
  DuplicateScanCustomer,
} from '../../../lib/customerDuplicates';

type ScanResponse = {
  ok?: boolean;
  error?: string;
  groups?: DuplicateGroup[];
  total?: number;
  offset?: number;
  limit?: number;
  counts?: Record<DuplicateConfidence, number>;
  customerCount?: number;
  scannedAt?: string;
  scanMs?: number;
  cached?: boolean;
};

const PAGE_SIZE = 25;

const TABS: ReadonlyArray<{ id: DuplicateConfidence | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

const CONFIDENCE_CLASS: Record<DuplicateConfidence, string> = {
  high: styles.badgeHigh,
  medium: styles.badgeMedium,
  low: styles.badgeLow,
};

const customerLabel = (member: DuplicateScanCustomer): string =>
  member.Name?.trim() || member.BrandName?.trim() || `#${member.CustomerID}`;

export default function CustomerDuplicatesClient() {
  const router = useRouter();

  const [tab, setTab] = useState<DuplicateConfidence | 'all'>('high');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(true);
  const [excludeParents, setExcludeParents] = useState(true);
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Per-group choices: which member is the primary, and which are included. */
  const [primaryByGroup, setPrimaryByGroup] = useState<Record<string, number>>({});
  const [excludedByGroup, setExcludedByGroup] = useState<Record<string, Set<number>>>({});

  const abortRef = useRef<AbortController | null>(null);
  const tokenRef = useRef(0);
  // Opening or refreshing the page always rescans, so a customer renamed or
  // merged a moment ago is never shown with its old details. Paging and tab
  // switches after that reuse the server's cached scan.
  const firstLoadRef = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { setOffset(0); }, [tab, debouncedSearch, enabledOnly, excludeParents]);

  const load = useCallback(async (refresh: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = ++tokenRef.current;

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(PAGE_SIZE),
        enabledOnly: enabledOnly ? '1' : '0',
        excludeParents: excludeParents ? '1' : '0',
      });
      if (tab !== 'all') params.set('confidence', tab);
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (refresh || firstLoadRef.current) params.set('refresh', '1');
      firstLoadRef.current = false;

      const res = await fetch(`/api/customers/duplicates?${params.toString()}`, {
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as ScanResponse | null;
      if (token !== tokenRef.current) return;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'Unable to scan for duplicates.');
      }
      setData(payload);
    } catch (err) {
      if (controller.signal.aborted || token !== tokenRef.current) return;
      setError(err instanceof Error ? err.message : 'Unable to scan for duplicates.');
    } finally {
      if (token === tokenRef.current) setLoading(false);
    }
  }, [offset, tab, debouncedSearch, enabledOnly, excludeParents]);

  useEffect(() => {
    void load(false);
    return () => abortRef.current?.abort();
  }, [load]);

  const groups = data?.groups ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts;

  const selectionFor = useCallback((group: DuplicateGroup) => {
    const primaryId = primaryByGroup[group.key] ?? group.suggestedPrimaryId;
    const excluded = excludedByGroup[group.key] ?? new Set<number>();
    const secondaryIds = group.members
      .map((member) => member.CustomerID)
      .filter((id) => id !== primaryId && !excluded.has(id));
    return { primaryId, excluded, secondaryIds };
  }, [primaryByGroup, excludedByGroup]);

  const setPrimary = useCallback((groupKey: string, customerId: number) => {
    setPrimaryByGroup((current) => ({ ...current, [groupKey]: customerId }));
    // A member cannot be both the survivor and excluded from the merge.
    setExcludedByGroup((current) => {
      const existing = current[groupKey];
      if (!existing?.has(customerId)) return current;
      const next = new Set(existing);
      next.delete(customerId);
      return { ...current, [groupKey]: next };
    });
  }, []);

  const toggleExcluded = useCallback((groupKey: string, customerId: number) => {
    setExcludedByGroup((current) => {
      const next = new Set(current[groupKey] ?? []);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return { ...current, [groupKey]: next };
    });
  }, []);

  const openMerge = useCallback((group: DuplicateGroup) => {
    const { primaryId, secondaryIds } = selectionFor(group);
    if (secondaryIds.length === 0) return;
    router.push(
      `/customers/merge?primary=${primaryId}&secondary=${secondaryIds.join(',')}`,
    );
  }, [router, selectionFor]);

  const summary = useMemo(() => {
    if (!data) return '';
    const parts = [`${total} group${total === 1 ? '' : 's'}`];
    if (data.customerCount) parts.push(`${data.customerCount.toLocaleString()} customers scanned`);
    if (data.scanMs != null) parts.push(`${data.scanMs} ms`);
    if (data.cached) parts.push('cached');
    return parts.join(' · ');
  }, [data, total]);

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/customers" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to customers
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>
          Possible duplicate customers
        </h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <button
            type="button"
            className={`${layoutStyles.headerActionButton} page-header-button`}
            onClick={() => void load(true)}
            disabled={loading}
          >
            Rescan
          </button>
        </div>
      </div>

      <div className={layoutStyles.pageBody}>
        <div className={styles.shell}>
          <div className={styles.toolbar}>
            <div className={styles.tabs}>
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`${styles.tab} ${tab === entry.id ? styles.tabActive : ''}`}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                  {counts && entry.id !== 'all' ? ` (${counts[entry.id]})` : ''}
                  {counts && entry.id === 'all'
                    ? ` (${counts.high + counts.medium + counts.low})`
                    : ''}
                </button>
              ))}
            </div>
            <input
              className={styles.input}
              placeholder="Filter by name, tax id or customer id…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={enabledOnly}
                onChange={(event) => setEnabledOnly(event.target.checked)}
              />
              Enabled only
            </label>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={excludeParents}
                onChange={(event) => setExcludeParents(event.target.checked)}
              />
              Skip group headers
            </label>
            <div className={styles.toolbarSpacer} />
            <span className={styles.note}>{summary}</span>
          </div>

          <div className={styles.scrollArea}>
            {error ? <div className={styles.errorBox}>{error}</div> : null}
            {!error && loading && groups.length === 0
              ? <div className={styles.status}>Scanning the customer base…</div>
              : null}
            {!error && !loading && groups.length === 0
              ? <div className={styles.status}>No possible duplicates match these filters.</div>
              : null}

            {groups.map((group) => {
              const { primaryId, excluded, secondaryIds } = selectionFor(group);
              return (
                <div key={group.key} className={styles.groupCard}>
                  <div className={styles.groupHead}>
                    <span className={`${styles.badge} ${CONFIDENCE_CLASS[group.confidence]}`}>
                      {group.confidence}
                    </span>
                    <span className={styles.badge}>{group.members.length} records</span>
                    <span className={styles.badge}>score {group.score.toFixed(2)}</span>
                    <span className={styles.reasons}>{group.reasons.join(' · ')}</span>
                  </div>

                  <table className={styles.memberTable}>
                    <thead>
                      <tr>
                        <th>Primary</th>
                        <th>Include</th>
                        <th>Customer</th>
                        <th>Tax ID</th>
                        <th>ERP</th>
                        <th>City</th>
                        <th className={styles.numeric}>Offers</th>
                        <th className={styles.numeric}>Contacts</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {group.members.map((member) => {
                        const isPrimary = member.CustomerID === primaryId;
                        return (
                          <tr key={member.CustomerID}>
                            <td>
                              <input
                                type="radio"
                                name={`primary-${group.key}`}
                                checked={isPrimary}
                                onChange={() => setPrimary(group.key, member.CustomerID)}
                                aria-label={`Keep ${customerLabel(member)}`}
                              />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                checked={isPrimary || !excluded.has(member.CustomerID)}
                                disabled={isPrimary}
                                onChange={() => toggleExcluded(group.key, member.CustomerID)}
                                aria-label={`Include ${customerLabel(member)}`}
                              />
                            </td>
                            <td>
                              <div className={styles.memberName}>{customerLabel(member)}</div>
                              <div className={styles.reasons}>#{member.CustomerID}</div>
                            </td>
                            <td>{member.TaxID ?? ''}</td>
                            <td>{member.ERPID ?? ''}</td>
                            <td>{member.City?.trim() ?? ''}</td>
                            <td className={styles.numeric}>{member.OfferCount}</td>
                            <td className={styles.numeric}>{member.ContactCount}</td>
                            <td>
                              <Link
                                href={`/customers/${member.CustomerID}/basicdata`}
                                className={styles.memberLink}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Open
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className={styles.groupFoot}>
                    <span className={styles.note}>
                      Keeping{' '}
                      <strong>
                        {customerLabel(
                          group.members.find((m) => m.CustomerID === primaryId) ?? group.members[0],
                        )}
                      </strong>
                      {secondaryIds.length > 0
                        ? `, merging ${secondaryIds.length} other${secondaryIds.length === 1 ? '' : 's'} in`
                        : ' — nothing selected to merge'}
                    </span>
                    <div className={styles.groupFootSpacer} />
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => openMerge(group)}
                      disabled={secondaryIds.length === 0}
                    >
                      Review merge →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
              disabled={offset === 0 || loading}
            >
              Previous
            </button>
            <span className={styles.note}>
              {total === 0
                ? '0'
                : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
            >
              Next
            </button>
            <div className={styles.footerSpacer} />
            <span className={styles.note}>
              High = same tax id, ERP id or identical name. Medium and low are name similarity —
              always open the records before merging.
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}
