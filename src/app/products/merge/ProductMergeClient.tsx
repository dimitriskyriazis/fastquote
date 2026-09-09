'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import layoutStyles from '../../offers/offersDetail.module.css';
// The wizard chrome (shell, step bar, cards, field table, badges, summary tiles,
// footer) is the customer merge's stylesheet, reused as is so the two merge
// tools look and behave the same. Product-specific bits live in own.
import styles from '../../customers/merge/CustomerMerge.module.css';
import own from './ProductMerge.module.css';
import { showToastMessage } from '../../../lib/toast';
import {
  productLabel,
  type MergeFieldDescriptor,
  type MergeFieldGroup,
  type MergeFieldKey,
  type MergePreview,
  type MergePriceListItemRecord,
  type MergeProductRecord,
  type OfferLineMode,
} from './productMergeTypes';

type Step = 'sources' | 'fields' | 'lists' | 'review' | 'done';

const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: 'sources', label: 'Sources' },
  { id: 'fields', label: 'Fields' },
  { id: 'lists', label: 'Price lists & offers' },
  { id: 'review', label: 'Review & merge' },
];

type CommitResult = {
  primaryId: number;
  secondaryIds: number[];
  moved: { offerLines: number; priceListItems: number };
  deletedPriceListItems: number;
  rewrittenOfferLines: number;
  disabled: number;
  identitySwapped: boolean;
  fieldsUpdated: MergeFieldKey[];
  warnings: string[];
};

type FieldValue = string | number | boolean | null;

const parseIdList = (value: string | null): number[] => {
  if (!value) return [];
  const out = new Set<number>();
  value.split(',').forEach((part) => {
    const parsed = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) out.add(parsed);
  });
  return Array.from(out);
};

const isOn = (value: boolean | number | null | undefined): boolean =>
  value === true || value === 1;

const money = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatMoney = (value: number | null | undefined): string =>
  value == null ? '-' : money.format(Number(value));

/** The model number, when it adds something the label does not already show. */
const modelLine = (product: MergeProductRecord): string => {
  const model = product.ModelNumber?.trim() ?? '';
  if (!model) return '';
  return model === (product.PartNumber?.trim() ?? '') ? '' : model;
};

/**
 * What the picker shows for a field. FK fields store an id but must be shown by
 * name, otherwise the user is choosing between two meaningless integers.
 */
const displayValue = (
  product: MergeProductRecord,
  descriptor: MergeFieldDescriptor,
): string => {
  if (descriptor.displayField) {
    const shown = product[descriptor.displayField];
    if (shown !== null && shown !== undefined && String(shown).trim() !== '') {
      return String(shown).trim();
    }
  }
  const raw = product[descriptor.field as keyof MergeProductRecord];
  if (raw === null || raw === undefined) return '';
  if (descriptor.field === 'IsService') return isOn(raw as boolean | number) ? 'Yes' : 'No';
  return String(raw).trim();
};

const storedValue = (product: MergeProductRecord, field: MergeFieldKey): FieldValue => {
  const raw = product[field as keyof MergeProductRecord];
  if (raw === null || raw === undefined) return null;
  if (field === 'IsService') return isOn(raw as boolean | number);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Whether a source has anything at all in a field group (for default picks). */
const groupHasValue = (
  product: MergeProductRecord,
  fields: readonly MergeFieldDescriptor[],
): boolean => fields.some((descriptor) => {
  const value = storedValue(product, descriptor.field);
  // IsService=false is "no value" for seeding purposes: a source that never set
  // it should not beat one that did.
  if (descriptor.field === 'IsService') return value === true;
  return value !== null;
});

export default function ProductMergeClient() {
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

  /** field -> the source product whose value wins. */
  const [fieldSource, setFieldSource] = useState<Record<string, number>>({});
  /** PriceListID -> ProductID whose row survives that list. */
  const [priceListWinners, setPriceListWinners] = useState<Record<string, number>>({});
  const [offerLineMode, setOfferLineMode] = useState<OfferLineMode>('keep');
  const [rewriteDescription, setRewriteDescription] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

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
      const res = await fetch('/api/products/merge/preview', {
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

  const sources = useMemo<MergeProductRecord[]>(
    () => (preview ? [preview.primary, ...preview.secondaries] : []),
    [preview],
  );

  const fieldsByGroup = useMemo(() => {
    const map = new Map<MergeFieldGroup, MergeFieldDescriptor[]>();
    (preview?.fields ?? []).forEach((descriptor) => {
      if (!descriptor.group) return;
      const bucket = map.get(descriptor.group);
      if (bucket) bucket.push(descriptor);
      else map.set(descriptor.group, [descriptor]);
    });
    return map;
  }, [preview]);

  // Seed every field from the primary, falling back to the first source that
  // actually has a value. Grouped fields are seeded per GROUP so a pair never
  // starts split across two sources; the identity pair always starts on the
  // primary, because taking another row's brand + part number is a deliberate
  // decision, never a default.
  useEffect(() => {
    if (!preview) return;
    setFieldSource((current) => {
      const next = { ...current };
      const valid = (id: number | undefined) => id != null && sources.some((s) => s.ProductID === id);

      const seeded = new Set<MergeFieldKey>();
      fieldsByGroup.forEach((fields, group) => {
        if (fields.every((f) => valid(next[f.field]))) {
          fields.forEach((f) => seeded.add(f.field));
          return;
        }
        const source = group === 'identity'
          ? preview.primary
          : sources.find((s) => groupHasValue(s, fields)) ?? preview.primary;
        fields.forEach((f) => {
          next[f.field] = source.ProductID;
          seeded.add(f.field);
        });
      });

      preview.fields.forEach((descriptor) => {
        if (seeded.has(descriptor.field)) return;
        if (valid(next[descriptor.field])) return;
        const withValue = sources.find((source) => storedValue(source, descriptor.field) !== null);
        next[descriptor.field] = (withValue ?? preview.primary).ProductID;
      });
      return next;
    });
  }, [preview, sources, fieldsByGroup]);

  const chooseField = useCallback((descriptor: MergeFieldDescriptor, productId: number) => {
    setFieldSource((current) => {
      const next = { ...current, [descriptor.field]: productId };
      if (descriptor.group) {
        (fieldsByGroup.get(descriptor.group) ?? []).forEach((paired) => {
          next[paired.field] = productId;
        });
      }
      return next;
    });
  }, [fieldsByGroup]);

  const makePrimary = useCallback((productId: number) => {
    if (primaryId == null || productId === primaryId) return;
    setSecondaryIds((current) => [
      ...current.filter((id) => id !== productId),
      primaryId,
    ].sort((a, b) => a - b));
    setPrimaryId(productId);
    setFieldSource({});
    setPriceListWinners({});
  }, [primaryId]);

  const dropSecondary = useCallback((productId: number) => {
    setSecondaryIds((current) => current.filter((id) => id !== productId));
  }, []);

  const fieldValues = useMemo(() => {
    if (!preview) return {} as Partial<Record<MergeFieldKey, FieldValue>>;
    const byId = new Map(sources.map((source) => [source.ProductID, source]));
    const out: Partial<Record<MergeFieldKey, FieldValue>> = {};
    preview.fields.forEach((descriptor) => {
      const source = byId.get(fieldSource[descriptor.field] ?? preview.primary.ProductID);
      out[descriptor.field] = storedValue(source ?? preview.primary, descriptor.field);
    });
    return out;
  }, [preview, sources, fieldSource]);

  /** The source whose brand + part number the survivor will carry. */
  const identitySource = useMemo(() => {
    if (!preview) return null;
    return sources.find((s) => s.ProductID === (fieldSource.PartNumber ?? preview.primary.ProductID)) ?? preview.primary;
  }, [preview, sources, fieldSource]);

  // ------------------------------------------------------------ price lists

  const priceListGroups = useMemo(() => {
    const byList = new Map<number, { name: string; enabled: boolean; items: MergePriceListItemRecord[] }>();
    (preview?.priceListItems ?? []).forEach((item) => {
      const bucket = byList.get(item.PriceListID);
      if (bucket) bucket.items.push(item);
      else {
        byList.set(item.PriceListID, {
          name: item.PriceListName?.trim() || `Price list #${item.PriceListID}`,
          enabled: isOn(item.PriceListEnabled),
          items: [item],
        });
      }
    });
    return Array.from(byList.entries()).map(([listId, group]) => ({ listId, ...group }));
  }, [preview]);

  const defaultWinner = useCallback((items: MergePriceListItemRecord[]): number => {
    if (!preview) return items[0]?.ProductID;
    if (items.some((i) => i.ProductID === preview.primary.ProductID)) return preview.primary.ProductID;
    return secondaryIds.find((id) => items.some((i) => i.ProductID === id)) ?? items[0].ProductID;
  }, [preview, secondaryIds]);

  const winnerFor = useCallback((listId: number, items: MergePriceListItemRecord[]): number => {
    const chosen = priceListWinners[String(listId)];
    if (chosen != null && items.some((i) => i.ProductID === chosen)) return chosen;
    return defaultWinner(items);
  }, [priceListWinners, defaultWinner]);

  const conflictGroups = useMemo(
    () => priceListGroups.filter((group) => group.items.length > 1),
    [priceListGroups],
  );

  const losingItems = useMemo(
    () => conflictGroups.flatMap((group) => {
      const winner = winnerFor(group.listId, group.items);
      return group.items.filter((item) => item.ProductID !== winner);
    }),
    [conflictGroups, winnerFor],
  );

  const totalOfferLines = useMemo(
    () => sources.reduce((sum, s) => sum + s.OfferLineCount, 0),
    [sources],
  );

  const commit = useCallback(async () => {
    if (!preview || primaryId == null) return;
    setCommitting(true);
    setError(null);
    try {
      const winners: Record<string, number> = {};
      conflictGroups.forEach((group) => {
        winners[String(group.listId)] = winnerFor(group.listId, group.items);
      });
      const res = await fetch('/api/products/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryId,
          secondaryIds,
          fieldValues,
          priceListWinners: winners,
          offerLines: { mode: offerLineMode, rewriteDescription: offerLineMode === 'rewrite' && rewriteDescription },
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
        moved: payload.moved ?? { offerLines: 0, priceListItems: 0 },
        deletedPriceListItems: payload.deletedPriceListItems ?? 0,
        rewrittenOfferLines: payload.rewrittenOfferLines ?? 0,
        disabled: payload.disabled ?? 0,
        identitySwapped: payload.identitySwapped ?? false,
        fieldsUpdated: payload.fieldsUpdated ?? [],
        warnings: payload.warnings ?? [],
      });
      setStep('done');
      showToastMessage('Products merged', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The merge could not be completed.');
    } finally {
      setCommitting(false);
    }
  }, [preview, primaryId, secondaryIds, fieldValues, conflictGroups, winnerFor, offerLineMode, rewriteDescription]);

  // ------------------------------------------------------------------ render

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);

  const sourceHeading = (source: MergeProductRecord, isPrimary: boolean) => (
    <>
      {isPrimary ? '★ ' : ''}
      {productLabel(source)}
      {modelLine(source) ? <div className={own.modelLine}>{modelLine(source)}</div> : null}
      <div className={styles.contactSub}>#{source.ProductID}</div>
    </>
  );

  const renderSources = () => {
    if (!preview) return null;
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>Which product survives?</h2>
        <p className={styles.cardHint}>
          The primary keeps its id and receives every offer line and price-list row of the others,
          which are then disabled. Nothing is deleted except a duplicate price in the same price list,
          and that goes to the audit log first. Tip: keep the row whose part number matches the way
          the brand&apos;s live price list is keyed, or the next import recreates the twin. You can
          still take the other row&apos;s brand + part number on the Fields step.
        </p>
        <div className={styles.sourceGrid}>
          {sources.map((source) => {
            const isPrimary = source.ProductID === preview.primary.ProductID;
            return (
              <div
                key={source.ProductID}
                className={`${styles.sourceCard} ${isPrimary ? styles.sourceCardPrimary : ''}`}
              >
                <div className={styles.sourceName}>{productLabel(source)}</div>
                {modelLine(source) ? <div className={own.modelLine}>Model {modelLine(source)}</div> : null}
                {source.Description?.trim() ? (
                  <div className={own.descriptionClamp} title={source.Description.trim()}>
                    {source.Description.trim()}
                  </div>
                ) : null}
                <div className={styles.sourceMeta}>
                  <span className={isPrimary ? `${styles.badge} ${styles.badgePrimary}` : styles.badge}>
                    {isPrimary ? 'Primary' : `#${source.ProductID}`}
                  </span>
                  {isPrimary ? <span className={styles.badge}>#{source.ProductID}</span> : null}
                  <span className={styles.badge}>
                    {source.OfferLineCount} offer line{source.OfferLineCount === 1 ? '' : 's'}
                    {source.OfferCount > 0 ? ` in ${source.OfferCount} offer${source.OfferCount === 1 ? '' : 's'}` : ''}
                  </span>
                  <span className={source.EnabledPriceListItemCount > 0 ? `${styles.badge} ${styles.badgeOk}` : styles.badge}>
                    {source.PriceListItemCount} price list{source.PriceListItemCount === 1 ? '' : 's'}
                    {source.PriceListItemCount > 0 ? ` (${source.EnabledPriceListItemCount} live)` : ''}
                  </span>
                  {source.ERPID != null || source.ERPCode?.trim() ? (
                    <span className={`${styles.badge} ${styles.badgeWarn}`}>
                      Soft1 {source.ERPCode?.trim() || source.ERPID}
                    </span>
                  ) : null}
                  {isOn(source.IsService) ? <span className={styles.badge}>Service</span> : null}
                  {!isOn(source.Enabled)
                    ? <span className={`${styles.badge} ${styles.badgeDanger}`}>Disabled</span>
                    : null}
                </div>
                <div className={styles.sourceMeta}>
                  {source.CategoryName ? <span>{source.CategoryName}{source.SubCategoryName ? ` / ${source.SubCategoryName}` : ''}</span> : null}
                  {source.LegacyPartNo?.trim() ? <span>Legacy {source.LegacyPartNo.trim()}</span> : null}
                </div>
                <div className={styles.sourceActions}>
                  {!isPrimary ? (
                    <>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => makePrimary(source.ProductID)}
                      >
                        Make primary
                      </button>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => dropSecondary(source.ProductID)}
                        disabled={secondaryIds.length <= 1}
                      >
                        Remove
                      </button>
                    </>
                  ) : null}
                  <Link
                    href={`/products/${source.ProductID}/details`}
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
          Rows where the sources disagree are highlighted. Brand and part number always come from
          the same source: they are the product&apos;s key, and picking another row&apos;s pair swaps
          the two identities (the primary&apos;s old part number is kept as its legacy part number).
          Soft1 ID / ERP Code, Category / Sub-category and Is service / Service type move together too.
        </p>
        <div className={styles.fieldTableWrap}>
          <table className={styles.fieldTable}>
            <thead>
              <tr>
                <th>Field</th>
                {sources.map((source) => (
                  <th key={source.ProductID}>
                    {sourceHeading(source, source.ProductID === preview.primary.ProductID)}
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
                      const chosen = fieldSource[descriptor.field] === source.ProductID;
                      const text = shown[index];
                      return (
                        <td key={source.ProductID}>
                          <label
                            className={`${styles.valueOption} ${chosen ? styles.valueOptionChosen : ''}`}
                          >
                            <input
                              type="radio"
                              name={`field-${descriptor.field}`}
                              checked={chosen}
                              onChange={() => chooseField(descriptor, source.ProductID)}
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

  const renderLists = () => {
    if (!preview) return null;
    const movedLines = preview.totals.offerLinesToRepoint;
    return (
      <>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>What should the offer lines say?</h2>
          <p className={styles.cardHint}>
            {movedLines} offer line{movedLines === 1 ? '' : 's'} move{movedLines === 1 ? 's' : ''} to the
            primary, which already has {preview.primary.OfferLineCount}. Each line stores the part number,
            model number and brand as they were quoted; you decide whether that history stays or is
            brought in line with the surviving product.
          </p>
          <div className={own.optionList}>
            <label className={`${own.optionRow} ${offerLineMode === 'keep' ? own.optionRowChosen : ''}`}>
              <input
                type="radio"
                name="offer-lines"
                checked={offerLineMode === 'keep'}
                onChange={() => setOfferLineMode('keep')}
              />
              <span>
                <span className={own.optionTitle}>Keep the lines as quoted</span>
                <div className={own.optionHint}>
                  Only the link to the product changes. Old offers keep showing exactly what the customer
                  was offered, part number included.
                </div>
              </span>
            </label>
            <label className={`${own.optionRow} ${offerLineMode === 'rewrite' ? own.optionRowChosen : ''}`}>
              <input
                type="radio"
                name="offer-lines"
                checked={offerLineMode === 'rewrite'}
                onChange={() => setOfferLineMode('rewrite')}
              />
              <span>
                <span className={own.optionTitle}>Rewrite the lines to the surviving product</span>
                <div className={own.optionHint}>
                  Every line of the merged product, moved or already on the primary, is updated to the
                  surviving part number, model number and brand where it differs
                  (up to {totalOfferLines} line{totalOfferLines === 1 ? '' : 's'}). The old values go to
                  the audit log. Prices and quantities are never touched.
                </div>
              </span>
            </label>
            <label className={`${own.optionSub} ${offerLineMode !== 'rewrite' ? own.optionSubDisabled : ''}`}>
              <input
                type="checkbox"
                checked={offerLineMode === 'rewrite' && rewriteDescription}
                disabled={offerLineMode !== 'rewrite'}
                onChange={(event) => setRewriteDescription(event.target.checked)}
              />
              <span>
                Also replace the line description with the surviving product&apos;s description.
                <div className={own.optionHint}>
                  Off by default: sales often edit the description per line, and that text is what was printed.
                </div>
              </span>
            </label>
          </div>
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Price lists</h2>
          {priceListGroups.length === 0 ? (
            <p className={styles.cardHint}>None of these products is in a price list. Nothing to decide here.</p>
          ) : (
            <>
              <p className={styles.cardHint}>
                Every price-list row of a secondary moves to the primary. Where two sources are in the
                SAME list, only one price can survive: pick it. The other row is removed (a full copy
                is written to the audit log) and any offer line that pointed at it is repointed to the
                surviving row.
              </p>
              <div className={styles.fieldTableWrap}>
                <table className={styles.fieldTable}>
                  <thead>
                    <tr>
                      <th>Price list</th>
                      {sources.map((source) => (
                        <th key={source.ProductID}>
                          {sourceHeading(source, source.ProductID === preview.primary.ProductID)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {priceListGroups.map((group) => {
                      const conflict = group.items.length > 1;
                      const winner = conflict ? winnerFor(group.listId, group.items) : null;
                      return (
                        <tr key={group.listId} className={conflict ? styles.rowDiffers : undefined}>
                          <td className={styles.fieldLabelCell}>
                            <div className={own.listName}>{group.name}</div>
                            <div className={own.listMeta}>
                              <span className={group.enabled ? `${styles.badge} ${styles.badgeOk}` : styles.badge}>
                                {group.enabled ? 'live' : 'disabled list'}
                              </span>
                              <span className={styles.badge}>#{group.listId}</span>
                              {conflict ? <span className={`${styles.badge} ${styles.badgeWarn}`}>pick one</span> : null}
                            </div>
                          </td>
                          {sources.map((source) => {
                            const item = group.items.find((i) => i.ProductID === source.ProductID);
                            if (!item) {
                              return <td key={source.ProductID}><span className={own.priceMuted}>not in this list</span></td>;
                            }
                            const isPrimary = source.ProductID === preview.primary.ProductID;
                            const wins = conflict ? winner === source.ProductID : true;
                            const details = (
                              <div className={own.priceCell}>
                                <span className={own.priceMain}>List {formatMoney(item.ListPrice)}</span>
                                <span>Cost {formatMoney(item.CostPrice)}{item.MOQ != null ? ` · MOQ ${item.MOQ}` : ''}</span>
                                <span className={styles.contactBadges}>
                                  {item.OfferLineCount > 0
                                    ? <span className={styles.badge}>{item.OfferLineCount} offer line{item.OfferLineCount === 1 ? '' : 's'}</span>
                                    : null}
                                  {!isOn(item.Enabled)
                                    ? <span className={`${styles.badge} ${styles.badgeDanger}`}>row disabled</span>
                                    : null}
                                  {conflict
                                    ? (wins
                                      ? <span className={`${styles.badge} ${styles.badgeOk}`}>survives</span>
                                      : <span className={`${styles.badge} ${styles.badgeDanger}`}>will be removed</span>)
                                    : (isPrimary
                                      ? <span className={styles.badge}>stays</span>
                                      : <span className={styles.badge}>moves to primary</span>)}
                                </span>
                              </div>
                            );
                            if (!conflict) return <td key={source.ProductID}>{details}</td>;
                            return (
                              <td key={source.ProductID}>
                                <label className={own.priceOption}>
                                  <input
                                    type="radio"
                                    name={`list-${group.listId}`}
                                    checked={wins}
                                    onChange={() => setPriceListWinners((current) => ({
                                      ...current,
                                      [String(group.listId)]: source.ProductID,
                                    }))}
                                  />
                                  {details}
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
            </>
          )}
        </div>
      </>
    );
  };

  const renderReview = () => {
    if (!preview || !identitySource) return null;
    const changedFields = preview.fields.filter((descriptor) => {
      const chosen = fieldValues[descriptor.field] ?? null;
      const current = storedValue(preview.primary, descriptor.field);
      return String(chosen ?? '') !== String(current ?? '');
    });
    const movedPriceRows = preview.priceListItems.filter(
      (item) => item.ProductID !== preview.primary.ProductID
        && !losingItems.some((loser) => loser.PriceListItemID === item.PriceListItemID),
    ).length;
    const identitySwapped = identitySource.ProductID !== preview.primary.ProductID;

    const clientWarnings: string[] = [];
    if (identitySwapped) {
      clientWarnings.push(
        `The primary will take the brand + part number of ${productLabel(identitySource)} (#${identitySource.ProductID}). That row is retired under the primary's old part number "${preview.primary.PartNumber ?? ''}", which is also kept as the primary's legacy part number so old searches still find it.`,
      );
    }
    const liveElsewhere = sources.filter(
      (s) => s.ProductID !== identitySource.ProductID && s.EnabledPriceListItemCount > 0,
    );
    if (identitySource.EnabledPriceListItemCount === 0 && liveElsewhere.length > 0) {
      clientWarnings.push(
        `The surviving part number "${identitySource.PartNumber ?? ''}" is in no enabled price list, but ${liveElsewhere
          .map((s) => `"${s.PartNumber ?? ''}"`)
          .join(', ')} ${liveElsewhere.length === 1 ? 'is' : 'are'}. Price-list import matches on the part number, so the next import of that list would recreate the duplicate. Consider taking that brand + part number on the Fields step.`,
      );
    }
    const losingWithLines = losingItems.filter((item) => item.OfferLineCount > 0);
    if (losingWithLines.length > 0) {
      const total = losingWithLines.reduce((sum, item) => sum + item.OfferLineCount, 0);
      clientWarnings.push(
        `${total} offer line${total === 1 ? '' : 's'} point at a price-list row that is being removed. They will be repointed to the row that survives in that list; their stored prices are not changed.`,
      );
    }
    if (offerLineMode === 'rewrite' && rewriteDescription) {
      clientWarnings.push(
        'You chose to replace the description on every offer line of the merged product. Any per-line wording sales wrote for a customer is overwritten with the surviving product\'s description.',
      );
    }
    const allWarnings = [...preview.warnings, ...clientWarnings];

    return (
      <>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>What this merge will do</h2>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{preview.totals.offerLinesToRepoint}</div>
              <div className={styles.summaryLabel}>offer lines moved to the primary</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{offerLineMode === 'rewrite' ? `≤ ${totalOfferLines}` : '0'}</div>
              <div className={styles.summaryLabel}>
                {offerLineMode === 'rewrite' ? 'offer lines rewritten to the survivor' : 'offer lines rewritten (kept as quoted)'}
              </div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{movedPriceRows}</div>
              <div className={styles.summaryLabel}>price-list rows moved</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{losingItems.length}</div>
              <div className={styles.summaryLabel}>price-list rows removed</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{changedFields.length}</div>
              <div className={styles.summaryLabel}>fields changed on the primary</div>
            </div>
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>{preview.secondaries.length}</div>
              <div className={styles.summaryLabel}>products disabled</div>
            </div>
          </div>
          {changedFields.length > 0 ? (
            <div className={styles.fieldTableWrap}>
              <table className={styles.fieldTable}>
                <thead>
                  <tr><th>Field</th><th>Now</th><th>After merge</th></tr>
                </thead>
                <tbody>
                  {changedFields.map((descriptor) => {
                    const source = sources.find((s) => s.ProductID === fieldSource[descriptor.field]);
                    const after = source ? displayValue(source, descriptor) : '';
                    return (
                      <tr key={descriptor.field}>
                        <td className={styles.fieldLabelCell}>{descriptor.label}</td>
                        <td className={styles.valueText}>
                          {displayValue(preview.primary, descriptor) || <span className={styles.valueEmpty}>(empty)</span>}
                        </td>
                        <td className={styles.valueText}>
                          {after || <span className={styles.valueEmpty}>(empty)</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {allWarnings.length > 0 ? (
          <div className={`${styles.card} ${styles.warningCard}`}>
            <h2 className={styles.cardTitle}>Check these first</h2>
            <ul className={styles.warningList}>
              {allWarnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </div>
        ) : null}

        <div className={`${styles.card} ${styles.dangerCard}`}>
          <p className={styles.dangerText}>
            {preview.secondaries.length === 1 ? 'One product' : `${preview.secondaries.length} products`}
            {' '}will be disabled and their offer lines and price-list rows reassigned to{' '}
            <strong>{productLabel(identitySource)} (#{preview.primary.ProductID})</strong>.
            There is no undo button. Reversing this means re-enabling the rows and moving things back
            by hand, using the record written to the log.
          </p>
          <label className={styles.confirmRow}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I have checked the values, price lists and offer-line choice above.
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
            <div className={styles.summaryValue}>{result.moved.offerLines}</div>
            <div className={styles.summaryLabel}>offer lines moved</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.rewrittenOfferLines}</div>
            <div className={styles.summaryLabel}>offer lines rewritten</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.moved.priceListItems}</div>
            <div className={styles.summaryLabel}>price-list rows moved</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.deletedPriceListItems}</div>
            <div className={styles.summaryLabel}>price-list rows removed</div>
          </div>
          <div className={styles.summaryTile}>
            <div className={styles.summaryValue}>{result.disabled}</div>
            <div className={styles.summaryLabel}>products disabled</div>
          </div>
          {result.identitySwapped ? (
            <div className={styles.summaryTile}>
              <div className={styles.summaryValue}>1</div>
              <div className={styles.summaryLabel}>brand + part number swapped</div>
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
          Tick two or more products on the products grid, right-click the one that should survive and
          choose “Merge … products into …”.
        </div>
      );
    }
    if (!preview) return <div className={styles.status}>Loading merge preview…</div>;
    if (step === 'sources') return renderSources();
    if (step === 'fields') return renderFields();
    if (step === 'lists') return renderLists();
    if (step === 'review') return renderReview();
    return renderDone();
  })();

  const survivingPartNumber = typeof fieldValues.PartNumber === 'string'
    ? fieldValues.PartNumber
    : preview?.primary.PartNumber ?? '';

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/products" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to products
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>
          Merge duplicate products
        </h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`} />
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
                  onClick={() => router.push(`/products/${result?.primaryId}/details`)}
                >
                  Open the surviving product
                </button>
                <div className={styles.footerSpacer} />
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => router.push(
                    survivingPartNumber
                      ? `/products?partNumber=${encodeURIComponent(survivingPartNumber)}`
                      : '/products',
                  )}
                >
                  Back to products
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
                    {committing ? 'Merging…' : 'Merge products'}
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
