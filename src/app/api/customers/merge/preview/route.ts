/**
 * Dry run for a customer merge: everything the review screen needs to show what
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
  fetchAncestorIds,
  fetchMergeContacts,
  fetchMergeCustomers,
  probeCustomerColumns,
  MAX_MERGE_SECONDARIES,
  collectMergeIds,
} from '../../../../../lib/customerMergeSql';
import { normalizeTaxId } from '../../../../../lib/customerDuplicates';
import type {
  MergeCustomerRecord,
  MergePreview,
  MergePreviewRequest,
} from '../../../../customers/merge/customerMergeTypes';

const label = (customer: MergeCustomerRecord): string =>
  `${customer.Name?.trim() || `#${customer.CustomerID}`} (#${customer.CustomerID})`;

/**
 * Everything the user should read before committing. These are advisory: none of
 * them block the merge, because every one of them has a legitimate case (an ERP
 * id really can be wrong on one of two duplicates, and the whole point of the
 * tool is to fix that).
 */
const buildWarnings = (params: {
  primary: MergeCustomerRecord;
  secondaries: MergeCustomerRecord[];
  ancestorIds: readonly number[];
  duplicateKeyCounts: Map<string, number>;
}): string[] => {
  const { primary, secondaries, ancestorIds } = params;
  const warnings: string[] = [];

  if (!(primary.Enabled === true || primary.Enabled === 1)) {
    warnings.push(
      `The primary customer ${label(primary)} is disabled. The merge will not enable it — everything will be moved onto a disabled record.`,
    );
  }

  const erpIds = new Set<number>();
  if (primary.ERPID != null) erpIds.add(primary.ERPID);
  secondaries.forEach((s) => { if (s.ERPID != null) erpIds.add(s.ERPID); });
  if (erpIds.size > 1) {
    warnings.push(
      `These customers carry ${erpIds.size} different ERP ids (${Array.from(erpIds).join(', ')}). They may be separate accounts in Soft1 — only the value you pick survives here, and nothing is changed in the ERP.`,
    );
  }

  const taxIds = new Set<string>();
  if (normalizeTaxId(primary.TaxID)) taxIds.add(normalizeTaxId(primary.TaxID));
  secondaries.forEach((s) => {
    const key = normalizeTaxId(s.TaxID);
    if (key) taxIds.add(key);
  });
  if (taxIds.size > 1) {
    warnings.push(
      `These customers have ${taxIds.size} different tax ids (${Array.from(taxIds).join(', ')}). Check they really are the same company.`,
    );
  }

  const parentSecondary = secondaries.find((s) => s.CustomerID === primary.ParentCustomerID);
  if (parentSecondary) {
    warnings.push(
      `${label(parentSecondary)} is the parent of the primary. Its parent link will be cleared, since a customer cannot be its own parent.`,
    );
  }

  const cyclic = secondaries.filter((s) => ancestorIds.includes(s.CustomerID));
  if (cyclic.length > 0) {
    warnings.push(
      `${cyclic.map(label).join(', ')} sits above the primary in the parent chain. Any child of it that is also an ancestor of the primary will have its parent cleared instead of repointed, to avoid creating a loop.`,
    );
  }

  const withChildren = secondaries.filter((s) => s.ChildCount > 0);
  if (withChildren.length > 0) {
    const total = withChildren.reduce((sum, s) => sum + s.ChildCount, 0);
    warnings.push(
      `${total} customer${total === 1 ? '' : 's'} currently filed under ${withChildren.map(label).join(', ')} will be repointed to the primary.`,
    );
  }

  const duplicateContactGroups = Array.from(params.duplicateKeyCounts.values())
    .filter((count) => count > 1).length;
  if (duplicateContactGroups > 0) {
    warnings.push(
      `${duplicateContactGroups} contact${duplicateContactGroups === 1 ? ' looks' : 's look'} like they already exist on more than one of these customers. They are marked below — keep one of each.`,
    );
  }

  return warnings;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/customers/merge/preview');
  try {
    const auth = await requirePermission(req, 'mergeCustomers');
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
      return NextResponse.json({ ok: false, error: 'A primary customer is required.' }, { status: 400 });
    }
    if (secondaryIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Select at least one other customer to merge into the primary.' },
        { status: 400 },
      );
    }
    if (secondaryIds.length > MAX_MERGE_SECONDARIES) {
      return NextResponse.json(
        { ok: false, error: `Merge at most ${MAX_MERGE_SECONDARIES} customers at a time.` },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const columns = await probeCustomerColumns(pool);
    const records = await fetchMergeCustomers(pool, [primaryId, ...secondaryIds], columns);
    const byId = new Map(records.map((record) => [record.CustomerID, record]));

    const primary = byId.get(primaryId);
    if (!primary) {
      return NextResponse.json({ ok: false, error: 'Primary customer not found.' }, { status: 404 });
    }
    const missing = secondaryIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { ok: false, error: `Customer${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}` },
        { status: 404 },
      );
    }
    const secondaries = secondaryIds.map((id) => byId.get(id) as MergeCustomerRecord);

    const [contacts, ancestorIds] = await Promise.all([
      fetchMergeContacts(pool, [primaryId, ...secondaryIds]),
      fetchAncestorIds(pool, primaryId),
    ]);

    const duplicateKeyCounts = new Map<string, number>();
    contacts.forEach((contact) => {
      if (!contact.duplicateKey) return;
      duplicateKeyCounts.set(
        contact.duplicateKey,
        (duplicateKeyCounts.get(contact.duplicateKey) ?? 0) + 1,
      );
    });

    const preview: MergePreview = {
      primary,
      secondaries,
      contacts,
      fields: availableMergeFields(columns),
      totals: {
        offersToRepoint: secondaries.reduce((sum, s) => sum + s.OfferCount, 0),
        childrenToRepoint: secondaries.reduce((sum, s) => sum + s.ChildCount, 0),
        contactsOnSecondaries: contacts.filter((c) => c.CustomerID !== primaryId).length,
      },
      warnings: buildWarnings({ primary, secondaries, ancestorIds, duplicateKeyCounts }),
    };

    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
