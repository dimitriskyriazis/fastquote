/**
 * Dry run for a product merge: everything the review screen needs to show what
 * WOULD happen, and nothing is written. The commit route re-derives all of this
 * server-side rather than trusting the numbers echoed back from the client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import { getPool } from '../../../../../lib/sql';
import { requirePermission } from '../../../../../lib/authz';
import { normalizeId } from '../../../../../lib/normalize';
import {
  availableMergeFields,
  collectMergeIds,
  fetchMergePriceListItems,
  fetchMergeProducts,
  MAX_MERGE_SECONDARIES,
} from '../../../../../lib/productMergeSql';
import {
  productLabel,
  type MergePreview,
  type MergePreviewRequest,
  type MergePriceListItemRecord,
  type MergeProductRecord,
} from '../../../../products/merge/productMergeTypes';

const label = (product: MergeProductRecord): string =>
  `${productLabel(product)} (#${product.ProductID})`;

const isOn = (value: boolean | number | null | undefined): boolean =>
  value === true || value === 1;

const hasErpLink = (product: MergeProductRecord): boolean =>
  product.ERPID != null || Boolean(product.ERPCode?.trim());

/**
 * Everything the user should read before committing. Advisory, not blocking:
 * each has a legitimate case (two brands really can carry the same physical
 * product, and a Soft1 link really can be on the wrong twin).
 */
const buildWarnings = (params: {
  primary: MergeProductRecord;
  secondaries: MergeProductRecord[];
  priceListItems: MergePriceListItemRecord[];
}): string[] => {
  const { primary, secondaries, priceListItems } = params;
  const sources = [primary, ...secondaries];
  const warnings: string[] = [];

  if (!isOn(primary.Enabled)) {
    warnings.push(
      `The primary product ${label(primary)} is disabled. The merge will not enable it, so everything will be moved onto a disabled record that search and import ignore.`,
    );
  }

  const brandIds = new Set(sources.map((s) => s.BrandID));
  if (brandIds.size > 1) {
    const names = Array.from(new Set(sources.map((s) => s.BrandName?.trim() || `brand #${s.BrandID}`)));
    warnings.push(
      `These products belong to ${brandIds.size} different brands (${names.join(', ')}). Only the brand + part number pair you pick survives; the other identity is kept on the retired row.`,
    );
  }

  // Same physical product keyed two ways (order code vs model name) is the
  // common duplicate; two products whose cleaned keys are unrelated may still be
  // one product (Farnell order code vs manufacturer part number), but deserve a
  // second look.
  const keyOf = (value: string | null) => (value ?? '').trim().toUpperCase();
  secondaries.forEach((secondary) => {
    const samePart = keyOf(primary.PartNumberCleared) !== ''
      && keyOf(primary.PartNumberCleared) === keyOf(secondary.PartNumberCleared);
    const swapped = (keyOf(primary.ModelNumberCleared) !== ''
        && keyOf(primary.ModelNumberCleared) === keyOf(secondary.PartNumberCleared))
      || (keyOf(secondary.ModelNumberCleared) !== ''
        && keyOf(secondary.ModelNumberCleared) === keyOf(primary.PartNumberCleared));
    const sameModel = keyOf(primary.ModelNumberCleared) !== ''
      && keyOf(primary.ModelNumberCleared) === keyOf(secondary.ModelNumberCleared);
    if (samePart || swapped || sameModel) return;
    warnings.push(
      `${label(secondary)} and the primary share neither a part number nor a model number once separators are ignored. Check they really are the same product before merging.`,
    );
  });

  const linked = sources.filter(hasErpLink);
  const distinctErp = new Set(linked.map((s) => `${s.ERPID ?? ''}|${(s.ERPCode ?? '').trim().toUpperCase()}`));
  if (distinctErp.size > 1) {
    warnings.push(
      `These products are linked to ${distinctErp.size} different Soft1 items (${linked
        .map((s) => `${s.ERPCode?.trim() || s.ERPID} on #${s.ProductID}`)
        .join(', ')}). Only the link you pick survives here; the other Soft1 item is left as it is and a draft order for a retired row would no longer find it. Nothing is changed in the ERP.`,
    );
  }

  const serviceFlags = new Set(sources.map((s) => (isOn(s.IsService) ? 'service' : 'product')));
  if (serviceFlags.size > 1) {
    warnings.push(
      'One of these rows is a service and another is a product. Services are priced and printed differently on offers, so make sure the "Is service" pick is what you want.',
    );
  }

  const byList = new Map<number, MergePriceListItemRecord[]>();
  priceListItems.forEach((item) => {
    const bucket = byList.get(item.PriceListID);
    if (bucket) bucket.push(item);
    else byList.set(item.PriceListID, [item]);
  });
  const conflicts = Array.from(byList.values()).filter((items) => items.length > 1);
  if (conflicts.length > 0) {
    warnings.push(
      `${conflicts.length} price list${conflicts.length === 1 ? ' has' : 's have'} a row for more than one of these products. Only one price per list can survive: pick it on the price-lists step. The row that loses is removed (a full copy goes to the audit log) and any offer line that pointed at it is repointed to the survivor.`,
    );
  }

  return warnings;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/products/merge/preview');
  try {
    const auth = await requirePermission(req, 'mergeProducts');
    if (!auth.ok) return auth.response;

    let body: MergePreviewRequest | null = null;
    try {
      body = (await req.json()) as MergePreviewRequest;
    } catch {
      body = null;
    }

    const primaryId = normalizeId(body?.primaryId);
    const secondaryIds = collectMergeIds(body?.secondaryIds).filter((id) => id !== primaryId);

    if (primaryId == null) {
      return NextResponse.json({ ok: false, error: 'A primary product is required.' }, { status: 400 });
    }
    if (secondaryIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Select at least one other product to merge into the primary.' },
        { status: 400 },
      );
    }
    if (secondaryIds.length > MAX_MERGE_SECONDARIES) {
      return NextResponse.json(
        { ok: false, error: `Merge at most ${MAX_MERGE_SECONDARIES + 1} products at a time.` },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const records = await fetchMergeProducts(pool, [primaryId, ...secondaryIds]);
    const byId = new Map(records.map((record) => [record.ProductID, record]));

    const primary = byId.get(primaryId);
    if (!primary) {
      return NextResponse.json({ ok: false, error: 'Primary product not found.' }, { status: 404 });
    }
    const missing = secondaryIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { ok: false, error: `Product${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}` },
        { status: 404 },
      );
    }
    const secondaries = secondaryIds.map((id) => byId.get(id) as MergeProductRecord);

    const priceListItems = await fetchMergePriceListItems(pool, [primaryId, ...secondaryIds]);

    const listsWithConflicts = new Set<number>();
    const seenLists = new Set<number>();
    priceListItems.forEach((item) => {
      if (seenLists.has(item.PriceListID)) listsWithConflicts.add(item.PriceListID);
      seenLists.add(item.PriceListID);
    });

    const preview: MergePreview = {
      primary,
      secondaries,
      priceListItems,
      fields: availableMergeFields(),
      totals: {
        offerLinesToRepoint: secondaries.reduce((sum, s) => sum + s.OfferLineCount, 0),
        priceListItemsOnSecondaries: priceListItems.filter((i) => i.ProductID !== primaryId).length,
        priceListConflicts: listsWithConflicts.size,
      },
      warnings: buildWarnings({ primary, secondaries, priceListItems }),
    };

    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
