'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import layoutStyles from '../customerDetail.module.css';
import styles from './CustomerMerge.module.css';
import { showToastMessage } from '../../../lib/toast';
import {
  contactDuplicateKey,
  type MergeContactRecord,
  type MergeCustomerRecord,
  type MergeFieldDescriptor,
  type MergeFieldKey,
  type MergePreview,
} from './customerMergeTypes';

type Step = 'sources' | 'fields' | 'contacts' | 'review' | 'done';

const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: 'sources', label: 'Sources' },
  { id: 'fields', label: 'Fields' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'review', label: 'Review & merge' },
];

type CommitResult = {
  primaryId: number;
  secondaryIds: number[];
  moved: { contacts: number; offers: number; children: number };
  disabled: number;
  disabledContacts: number;
  fieldsUpdated: MergeFieldKey[];
  warnings: string[];
};

const parseIdList = (value: string | null): number[] => {
  if (!value) return [];
  const out = new Set<number>();
  value.split(',').forEach((part) => {
    const parsed = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) out.add(parsed);
  });
  return Array.from(out);
};

const customerLabel = (customer: MergeCustomerRecord): string =>
  customer.Name?.trim() || customer.BrandName?.trim() || `#${customer.CustomerID}`;

const contactName = (contact: MergeContactRecord): string => {
  const name = `${contact.LastName?.trim() ?? ''} ${contact.FirstName?.trim() ?? ''}`.trim();
  return name || `Contact #${contact.ContactID}`;
};

/**
 * What the picker shows for a field. FK fields store an id but must be shown by
 * name, otherwise the user is choosing between two meaningless integers.
 */
const displayValue = (
  customer: MergeCustomerRecord,
  descriptor: MergeFieldDescriptor,
): string => {
  if (descriptor.displayField) {
    const shown = customer[descriptor.displayField];
    if (shown !== null && shown !== undefined && String(shown).trim() !== '') {
      return String(shown).trim();
    }
    // Fall through to the raw id: better to show "42" than an empty cell when
    // the lookup join found nothing.
  }
  const raw = customer[descriptor.field as keyof MergeCustomerRecord];
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
};

const storedValue = (
  customer: MergeCustomerRecord,
  field: MergeFieldKey,
): string | number | null => {
  const raw = customer[field as keyof MergeCustomerRecord];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * ERPID (the numeric Soft1 TRDR) and ERPCode (that same record's TRDR.CODE) are
 * two halves of ONE ERP identity. Letting them be chosen from different source
 * customers would mint an account that matches nothing in Soft1, so a pick of
 * either one drags the other along.
 */
const ERP_PAIR: readonly MergeFieldKey[] = ['ERPID', 'ERPCode'];

export default function CustomerMergeClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialPrimary = Number.parseInt(searchParams.get('primary') ?? '', 10);
  const initialSecondaries = parseIdList(searchParams.get('secondary'));

  const [primaryId, setPrimaryId] = useState<number | null>(
    Number.isInteger(initialPrimary) && initialPrimary > 0 ? initialPrimary : null,
  );
  const [secondaryIds, setSecondaryIds] = useState<number[]>(initialSecondaries);

  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('sources');

  /** field -> the source customer whose value wins. */
  const [fieldSource, setFieldSource] = useState<Record<string, number>>({});
  const [keptContactIds, setKeptContactIds] = useState<Set<number>>(new Set());
  const [contactFilter, setContactFilter] = useState<'all' | 'duplicates' | 'offers'>('all');
  const [contactSearch, setContactSearch] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  // Only the source set drives a refetch. Field and contact decisions are pure
  // client state, so there is no debounce here and no way for a late preview to
  // repaint the numbers the user is reading on the review step.
  const requestTokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadPreview = useCallback(async () => {
    if (primaryId == null || secondaryIds.length === 0) {
      setPreview(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = ++requestTokenRef.current;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/customers/merge/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryId, secondaryIds }),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; preview?: MergePreview; error?: string }
        | null;
      if (token !== requestTokenRef.current) return;
      if (!res.ok || !payload?.ok || !payload.preview) {
        throw new Error(payload?.error ?? 'Unable to load the merge preview.');
      }
      setPreview(payload.preview);
    } catch (err) {
      if (controller.signal.aborted || token !== requestTokenRef.current) return;
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Unable to load the merge preview.');
    } finally {
      if (token === requestTokenRef.current) setLoading(false);
    }
  }, [primaryId, secondaryIds]);

  useEffect(() => {
    void loadPreview();
    return () => abortRef.current?.abort();
  }, [loadPreview]);

  const sources = useMemo<MergeCustomerRecord[]>(
    () => (preview ? [preview.primary, ...preview.secondaries] : []),
    [preview],
  );

  // Seed every field from the primary, falling back to the first source that
  // actually has a value — the common case is a sparse duplicate holding the one
  // detail the survivor is missing.
  useEffect(() => {
    if (!preview) return;
    setFieldSource((current) => {
      const next = { ...current };
      preview.fields.forEach((descriptor) => {
        if (next[descriptor.field] != null
          && sources.some((s) => s.CustomerID === next[descriptor.field])) {
          return;
        }
        const withValue = sources.find((source) => storedValue(source, descriptor.field) !== null);
        next[descriptor.field] = (withValue ?? preview.primary).CustomerID;
      });
      return next;
    });
  }, [preview, sources]);

  // Default: keep every contact from a secondary, EXCEPT one that is already
  // the same person as a contact the primary has (or as an earlier secondary's
  // contact). Keeping those would file the same person on the survivor twice,
  // which is the mess this tool exists to clean up. Dropping loses nothing —
  // the contact stays on its current customer — and every default is visible
  // and reversible in the list below.
  useEffect(() => {
    if (!preview) return;
    const keep = new Set<number>();
    const seen = new Set<string>();

    // The primary's own contacts always start kept: a merge must never quietly
    // switch off something the surviving customer already has.
    preview.contacts
      .filter((contact) => contact.CustomerID === preview.primary.CustomerID)
      .forEach((contact) => {
        if (contact.duplicateKey) seen.add(contact.duplicateKey);
        keep.add(contact.ContactID);
      });

    preview.contacts
      .filter((contact) => contact.CustomerID !== preview.primary.CustomerID)
      .forEach((contact) => {
        const key = contact.duplicateKey;
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        keep.add(contact.ContactID);
      });

    setKeptContactIds(keep);
  }, [preview]);

  const chooseField = useCallback((field: MergeFieldKey, customerId: number) => {
    setFieldSource((current) => {
      const next = { ...current, [field]: customerId };
      if (ERP_PAIR.includes(field)) {
        ERP_PAIR.forEach((paired) => { next[paired] = customerId; });
      }
      return next;
    });
  }, []);

  const secondaryContacts = useMemo(
    () => (preview
      ? preview.contacts.filter((c) => c.CustomerID !== preview.primary.CustomerID)
      : []),
    [preview],
  );

  const primaryContacts = useMemo(
    () => (preview
      ? preview.contacts.filter((c) => c.CustomerID === preview.primary.CustomerID)
      : []),
    [preview],
  );

  /** Contacts whose duplicate key appears more than once across all sources. */
  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    (preview?.contacts ?? []).forEach((contact) => {
      const key = contact.duplicateKey || contactDuplicateKey(contact);
      if (!key) return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return new Set(Array.from(counts.entries()).filter(([, n]) => n > 1).map(([k]) => k));
  }, [preview]);

  const isDuplicate = useCallback(
    (contact: MergeContactRecord) => duplicateKeys.has(contact.duplicateKey || contactDuplicateKey(contact)),
    [duplicateKeys],
  );

  const visibleContacts = useCallback(
    (list: MergeContactRecord[]) => {
      const needle = contactSearch.trim().toLowerCase();
      return list.filter((contact) => {
        if (contactFilter === 'duplicates' && !isDuplicate(contact)) return false;
        if (contactFilter === 'offers' && contact.OfferCount === 0) return false;
        if (!needle) return true;
        return [
          contact.LastName, contact.FirstName, contact.Email,
          contact.SecondEmail, contact.Position, contact.Mobile, contact.Phone,
        ].some((value) => (value ?? '').toLowerCase().includes(needle));
      });
    },
    [contactFilter, contactSearch, isDuplicate],
  );

  const toggleContact = useCallback((contactId: number) => {
    setKeptContactIds((current) => {
      const next = new Set(current);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }, []);

  const setContactsForCustomer = useCallback((customerId: number, keep: boolean) => {
    setKeptContactIds((current) => {
      const next = new Set(current);
      (preview?.contacts ?? [])
        .filter((contact) => contact.CustomerID === customerId)
        .forEach((contact) => {
          if (keep) next.add(contact.ContactID);
          else next.delete(contact.ContactID);
        });
      return next;
    });
  }, [preview]);

  const makePrimary = useCallback((customerId: number) => {
    if (primaryId == null || customerId === primaryId) return;
    setSecondaryIds((current) => [
      ...current.filter((id) => id !== customerId),
      primaryId,
    ].sort((a, b) => a - b));
    setPrimaryId(customerId);
    setFieldSource({});
  }, [primaryId]);

  const dropSecondary = useCallback((customerId: number) => {
    setSecondaryIds((current) => current.filter((id) => id !== customerId));
  }, []);

  const fieldValues = useMemo(() => {
    if (!preview) return {} as Partial<Record<MergeFieldKey, string | number | null>>;
    const byId = new Map(sources.map((source) => [source.CustomerID, source]));
    const out: Partial<Record<MergeFieldKey, string | number | null>> = {};
    preview.fields.forEach((descriptor) => {
      const source = byId.get(fieldSource[descriptor.field] ?? preview.primary.CustomerID);
      out[descriptor.field] = storedValue(source ?? preview.primary, descriptor.field);
    });
    return out;
  }, [preview, sources, fieldSource]);

  const commit = useCallback(async () => {
    if (!preview || primaryId == null) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch('/api/customers/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryId,
          secondaryIds,
          fieldValues,
          contactIdsToKeep: secondaryContacts
            .filter((contact) => keptContactIds.has(contact.ContactID))
            .map((contact) => contact.ContactID),
          // Everything unticked is switched off, wherever it lives. Disabling
          // the secondary's contacts matters as much as the primary's: the mail
          // exports filter on Contacts.Enabled but not on Customers.Enabled, so
          // one merely left behind on a disabled customer keeps being mailed.
          contactIdsToDisable: preview.contacts
            .filter((contact) => !keptContactIds.has(contact.ContactID))
            .map((contact) => contact.ContactID),
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | ({ ok?: boolean; error?: string } & Partial<CommitResult>)
        | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'The merge could not be completed.');
      }
      setResult({
        primaryId: payload.primaryId ?? primaryId,
        secondaryIds: payload.secondaryIds ?? secondaryIds,
        moved: payload.moved ?? { contacts: 0, offers: 0, children: 0 },
        disabled: payload.disabled ?? 0,
        disabledContacts: payload.disabledContacts ?? 0,
        fieldsUpdated: payload.fieldsUpdated ?? [],
        warnings: payload.warnings ?? [],
      });
      setStep('done');
      showToastMessage('Customers merged', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The merge could not be completed.');
    } finally {
      setCommitting(false);
    }
  }, [preview, primaryId, secondaryIds, fieldValues, keptContactIds, secondaryContacts]);

  // ------------------------------------------------------------------ render

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);

  const renderSources = () => {
    if (!preview) return null;
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Which record survives?</h2>
        <p className={styles.cardHint}>
          The primary keeps its id and receives everything else. The others are disabled — nothing
          is deleted, so any contact you do not move stays on the record it is on today.
        </p>
        <div className={styles.sourceGrid}>
          {sources.map((source) => {
            const isPrimary = source.CustomerID === preview.primary.CustomerID;
            return (
              <div
                key={source.CustomerID}
                className={`${styles.sourceCard} ${isPrimary ? styles.sourceCardPrimary : ''}`}
              >
                <div className={styles.sourceName}>{customerLabel(source)}</div>
                <div className={styles.sourceMeta}>
                  <span className={isPrimary ? `${styles.badge} ${styles.badgePrimary}` : styles.badge}>
                    {isPrimary ? 'Primary' : `#${source.CustomerID}`}
                  </span>
                  {isPrimary ? <span className={styles.badge}>#{source.CustomerID}</span> : null}
                  <span className={styles.badge}>{source.OfferCount} offers</span>
                  <span className={styles.badge}>{source.ContactCount} contacts</span>
                  {source.ChildCount > 0
                    ? <span className={`${styles.badge} ${styles.badgeWarn}`}>{source.ChildCount} children</span>
                    : null}
                  {!(source.Enabled === true || source.Enabled === 1)
                    ? <span className={`${styles.badge} ${styles.badgeDanger}`}>Disabled</span>
                    : null}
                </div>
                <div className={styles.sourceMeta}>
                  {source.TaxID ? <span>Tax {source.TaxID}</span> : null}
                  {source.ERPID != null ? <span>ERP {source.ERPID}</span> : null}
                  {source.City ? <span>{source.City.trim()}</span> : null}
                </div>
                <div className={styles.sourceActions}>
                  {!isPrimary ? (
                    <>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => makePrimary(source.CustomerID)}
                      >
                        Make primary
                      </button>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => dropSecondary(source.CustomerID)}
                        disabled={secondaryIds.length <= 1}
                      >
                        Remove
                      </button>
                    </>
                  ) : null}
                  <Link
                    href={`/customers/${source.CustomerID}/basicdata`}
                    className={styles.smallButton}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderFields = () => {
    if (!preview) return null;
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Pick the value that survives</h2>
        <p className={styles.cardHint}>
          Rows where the sources disagree are highlighted. ERP ID and ERP Code always come from the
          same source — they are two halves of one Soft1 account.
        </p>
        <div className={styles.fieldTableWrap}>
          <table className={styles.fieldTable}>
            <thead>
              <tr>
                <th>Field</th>
                {sources.map((source) => (
                  <th key={source.CustomerID}>
                    {source.CustomerID === preview.primary.CustomerID ? '★ ' : ''}
                    {customerLabel(source)}
                    <div className={styles.contactSub}>#{source.CustomerID}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.fields.map((descriptor) => {
                const shown = sources.map((source) => displayValue(source, descriptor));
                const distinct = new Set(shown.filter((value) => value !== ''));
                const differs = distinct.size > 1;
                return (
                  <tr key={descriptor.field} className={differs ? styles.rowDiffers : undefined}>
                    <td className={styles.fieldLabelCell}>
                      {descriptor.label}
                      {descriptor.required ? ' *' : ''}
                    </td>
                    {sources.map((source, index) => {
                      const chosen = fieldSource[descriptor.field] === source.CustomerID;
                      const text = shown[index];
                      return (
                        <td key={source.CustomerID}>
                          <label
                            className={`${styles.valueOption} ${chosen ? styles.valueOptionChosen : ''}`}
                          >
                            <input
                              type="radio"
                              name={`field-${descriptor.field}`}
                              checked={chosen}
                              onChange={() => chooseField(descriptor.field, source.CustomerID)}
                            />
                            <span className={text ? styles.valueText : styles.valueEmpty}>
                              {text || '(empty)'}
                            </span>
                          </label>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderContacts = () => {
    if (!preview) return null;
    const movingCount = secondaryContacts.filter((c) => keptContactIds.has(c.ContactID)).length;
    const switchedOffCount = preview.contacts.filter((c) => !keptContactIds.has(c.ContactID)).length;
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Which contacts move to the primary?</h2>
        <p className={styles.cardHint}>
          Ticked contacts end up on the surviving customer. Unticking one switches it off
          (Enabled = 0) wherever it lives — the mail exports go by the contact&apos;s own Enabled
          flag, not its customer&apos;s, so simply leaving it on a disabled customer would keep it
          in your mailing lists. Nothing is deleted: the contact, its group memberships and its
          mail history all stay, and re-enabling it undoes this. Everything starts ticked except a
          secondary contact that is already the same person as one on the primary.
        </p>

        <div className={styles.toolbar}>
          <input
            className={styles.input}
            placeholder="Filter by name, email, position…"
            value={contactSearch}
            onChange={(event) => setContactSearch(event.target.value)}
          />
          <select
            className={styles.select}
            value={contactFilter}
            onChange={(event) => setContactFilter(event.target.value as typeof contactFilter)}
          >
            <option value="all">All contacts</option>
            <option value="duplicates">Looks duplicated</option>
            <option value="offers">Named on an offer</option>
          </select>
          <div className={styles.toolbarSpacer} />
          <span className={styles.footerNote}>
            {movingCount} of {secondaryContacts.length} moving
            {switchedOffCount > 0 ? ` · ${switchedOffCount} switched off` : ''}
          </span>
        </div>

        {primaryContacts.length > 0 ? (
          <div className={styles.contactGroup}>
            <div className={styles.contactGroupHead}>
              <span className={styles.contactGroupTitle}>
                Already on {customerLabel(preview.primary)}
              </span>
              <span className={styles.badge}>#{preview.primary.CustomerID}</span>
              <span className={styles.badge}>{primaryContacts.length} contacts</span>
              <span className={styles.staysNote}>unticking switches one off</span>
              <div className={styles.toolbarSpacer} />
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => setContactsForCustomer(preview.primary.CustomerID, true)}
              >
                Keep all
              </button>
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => setContactsForCustomer(preview.primary.CustomerID, false)}
              >
                Drop all
              </button>
            </div>
            {visibleContacts(primaryContacts).map((contact) => {
              const kept = keptContactIds.has(contact.ContactID);
              return (
                <label
                  key={contact.ContactID}
                  className={[
                    styles.contactRow,
                    kept ? '' : styles.contactRowDropped,
                    isDuplicate(contact) ? styles.contactRowDuplicate : '',
                  ].filter(Boolean).join(' ')}
                >
                  <input
                    type="checkbox"
                    checked={kept}
                    onChange={() => toggleContact(contact.ContactID)}
                  />
                  <span className={styles.contactName}>{contactName(contact)}</span>
                  <span className={styles.contactSub}>{contact.Email || '—'}</span>
                  <span className={styles.contactSub}>{contact.Position || ''}</span>
                  <span className={styles.contactBadges}>
                    {isDuplicate(contact)
                      ? <span className={`${styles.badge} ${styles.badgeWarn}`}>duplicate</span>
                      : null}
                    {contact.OfferCount > 0
                      ? <span className={styles.badge}>{contact.OfferCount} offers</span>
                      : null}
                    {contact.MailCount > 0
                      ? <span className={styles.badge}>{contact.MailCount} mails</span>
                      : null}
                    {!kept
                      ? <span className={`${styles.badge} ${styles.badgeDanger}`}>will be switched off</span>
                      : null}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}

        {preview.secondaries.map((secondary) => {
          const own = secondaryContacts.filter((c) => c.CustomerID === secondary.CustomerID);
          const shown = visibleContacts(own);
          if (own.length === 0) return null;
          return (
            <div key={secondary.CustomerID} className={styles.contactGroup}>
              <div className={styles.contactGroupHead}>
                <span className={styles.contactGroupTitle}>{customerLabel(secondary)}</span>
                <span className={styles.badge}>#{secondary.CustomerID}</span>
                <span className={styles.badge}>{own.length} contacts</span>
                <div className={styles.toolbarSpacer} />
                <button
                  type="button"
                  className={styles.smallButton}
                  onClick={() => setContactsForCustomer(secondary.CustomerID, true)}
                >
                  Keep all
                </button>
                <button
                  type="button"
                  className={styles.smallButton}
                  onClick={() => setContactsForCustomer(secondary.CustomerID, false)}
                >
                  Drop all
                </button>
              </div>
              {shown.length === 0
                ? <div className={styles.staysNote}>No contacts match the filter.</div>
                : shown.map((contact) => {
                  const kept = keptContactIds.has(contact.ContactID);
                  return (
                    <label
                      key={contact.ContactID}
                      className={[
                        styles.contactRow,
                        kept ? '' : styles.contactRowDropped,
                        isDuplicate(contact) ? styles.contactRowDuplicate : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <input
                        type="checkbox"
                        checked={kept}
                        onChange={() => toggleContact(contact.ContactID)}
                      />
                      <span className={styles.contactName}>{contactName(contact)}</span>
                      <span className={styles.contactSub}>{contact.Email || '—'}</span>
                      <span className={styles.contactSub}>{contact.Position || ''}</span>
                      <span className={styles.contactBadges}>
                        {isDuplicate(contact)
                          ? <span className={`${styles.badge} ${styles.badgeWarn}`}>duplicate</span>
                          : null}
                        {contact.OfferCount > 0
                          ? <span className={styles.badge}>{contact.OfferCount} offers</span>
                          : null}
                        {contact.MailCount > 0
                          ? <span className={styles.badge}>{contact.MailCount} mails</span>
                          : null}
                        {!(contact.Enabled === true || contact.Enabled === 1)
                          ? <span className={`${styles.badge} ${styles.badgeDanger}`}>already off</span>
                          : !kept
                            ? <span className={`${styles.badge} ${styles.badgeDanger}`}>will be switched off</span>
                            : null}
                      </span>
                    </label>
                  );
                })}
            </div>
          );
        })}
      </div>
    );
  };

  const renderReview = () => {
    if (!preview) return null;
    const movingContacts = secondaryContacts.filter((c) => keptContactIds.has(c.ContactID)).length;
    const switchedOffContacts = preview.contacts.filter(
      (c) => !keptContactIds.has(c.ContactID),
    ).length;
    const changedFields = preview.fields.filter((descriptor) => {
      const chosen = fieldValues[descriptor.field] ?? null;
      const current = storedValue(preview.primary, descriptor.field);
      return String(chosen ?? '') !== String(current ?? '');
    });

    return (
      <>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>What this merge will do</h2>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{preview.totals.offersToRepoint}</div>
              <div className={styles.summaryLabel}>offers moved to the primary</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{movingContacts}</div>
              <div className={styles.summaryLabel}>contacts moved</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{switchedOffContacts}</div>
              <div className={styles.summaryLabel}>contacts switched off</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{preview.totals.childrenToRepoint}</div>
              <div className={styles.summaryLabel}>child customers repointed</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{changedFields.length}</div>
              <div className={styles.summaryLabel}>fields changed on the primary</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{preview.secondaries.length}</div>
              <div className={styles.summaryLabel}>customers disabled</div>
            </div>
          </div>
          {changedFields.length > 0 ? (
            <div className={styles.fieldTableWrap}>
              <table className={styles.fieldTable}>
                <thead>
                  <tr><th>Field</th><th>Now</th><th>After merge</th></tr>
                </thead>
                <tbody>
                  {changedFields.map((descriptor) => (
                    <tr key={descriptor.field}>
                      <td className={styles.fieldLabelCell}>{descriptor.label}</td>
                      <td className={styles.valueText}>
                        {displayValue(preview.primary, descriptor) || <span className={styles.valueEmpty}>(empty)</span>}
                      </td>
                      <td className={styles.valueText}>
                        {(() => {
                          const source = sources.find(
                            (s) => s.CustomerID === fieldSource[descriptor.field],
                          );
                          const text = source ? displayValue(source, descriptor) : '';
                          return text || <span className={styles.valueEmpty}>(empty)</span>;
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {(() => {
          // Switching off a contact an offer is addressed to is allowed, but it
          // is the kind of thing to notice before committing rather than after.
          const offerBearing = primaryContacts.filter(
            (c) => !keptContactIds.has(c.ContactID) && c.OfferCount > 0,
          );
          const allWarnings = [
            ...preview.warnings,
            ...(offerBearing.length > 0
              ? [`${offerBearing.length} contact${offerBearing.length === 1 ? '' : 's'} you are switching off ${offerBearing.length === 1 ? 'is' : 'are'} named on an offer: ${offerBearing.map(contactName).join(', ')}. The offers keep pointing at them.`]
              : []),
          ];
          if (allWarnings.length === 0) return null;
          return (
            <div className={`${styles.card} ${styles.warningCard}`}>
              <h2 className={styles.cardTitle}>Check these first</h2>
              <ul className={styles.warningList}>
                {allWarnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          );
        })()}

        <div className={`${styles.card} ${styles.dangerCard}`}>
          <p className={styles.dangerText}>
            {preview.secondaries.length === 1 ? 'One customer' : `${preview.secondaries.length} customers`}
            {' '}will be disabled and their offers reassigned to{' '}
            <strong>{customerLabel(preview.primary)} (#{preview.primary.CustomerID})</strong>.
            There is no undo button — reversing this means re-enabling the records and moving the
            offers back by hand, using the record written to the log.
          </p>
          <label className={styles.confirmRow}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I have checked the values and contacts above.
          </label>
        </div>
      </>
    );
  };

  const renderDone = () => {
    if (!result) return null;
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Merge complete</h2>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.moved.offers}</div>
            <div className={styles.summaryLabel}>offers moved</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.moved.contacts}</div>
            <div className={styles.summaryLabel}>contacts moved</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.moved.children}</div>
            <div className={styles.summaryLabel}>children repointed</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.disabled}</div>
            <div className={styles.summaryLabel}>customers disabled</div>
          </div>
          {result.disabledContacts > 0 ? (
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{result.disabledContacts}</div>
              <div className={styles.summaryLabel}>contacts switched off</div>
            </div>
          ) : null}
        </div>
        {result.warnings.length > 0 ? (
          <ul className={styles.warningList}>
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}
      </div>
    );
  };

  const canContinue = (() => {
    if (!preview) return false;
    if (step === 'review') return confirmed && !committing;
    return true;
  })();

  const body = (() => {
    if (loading && !preview) return <div className={styles.status}>Loading merge preview…</div>;
    if (error && !preview) return <div className={styles.errorBox}>{error}</div>;
    if (primaryId == null || secondaryIds.length === 0) {
      return (
        <div className={styles.errorBox}>
          Select a customer plus at least one duplicate on the customers grid, then choose
          “Merge duplicate customers”.
        </div>
      );
    }
    if (!preview) return <div className={styles.status}>Loading merge preview…</div>;
    if (step === 'sources') return renderSources();
    if (step === 'fields') return renderFields();
    if (step === 'contacts') return renderContacts();
    if (step === 'review') return renderReview();
    return renderDone();
  })();

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
          Merge duplicate customers
        </h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <Link href="/customers/duplicates" className={`${layoutStyles.headerActionButton} page-header-button`}>
            Possible duplicates
          </Link>
        </div>
      </div>

      <div className={layoutStyles.pageBody}>
        <div className={styles.shell}>
          {step !== 'done' ? (
            <div className={styles.stepBar}>
              {STEPS.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  className={[
                    styles.stepItem,
                    entry.id === step ? styles.stepItemActive : '',
                    index < stepIndex ? styles.stepItemDone : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => setStep(entry.id)}
                  disabled={!preview}
                >
                  <span className={styles.stepIndex}>{index + 1}</span>
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.scrollArea}>
            {error && preview ? <div className={styles.errorBox}>{error}</div> : null}
            {body}
          </div>

          <div className={styles.footer}>
            {step === 'done' ? (
              <>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => router.push(`/customers/${result?.primaryId}/basicdata`)}
                >
                  Open the surviving customer
                </button>
                <div className={styles.footerSpacer} />
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => router.push('/customers/duplicates')}
                >
                  Back to possible duplicates
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id)}
                  disabled={stepIndex <= 0}
                >
                  Back
                </button>
                <div className={styles.footerSpacer} />
                {loading ? <span className={styles.footerNote}>Refreshing preview…</span> : null}
                {step === 'review' ? (
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => void commit()}
                    disabled={!canContinue}
                  >
                    {committing ? 'Merging…' : 'Merge customers'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].id)}
                    disabled={!canContinue}
                  >
                    Continue
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
