'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  coerceNumber,
  computeDisplayOrderingMap,
  normalizeNoForExport,
  OFFER_PRODUCTS_EXPORT_FIELDS,
} from '../offerProductsUtils';
import { resolveOfferProductRowType, isOfferProductOption } from '../../../../lib/offerProductRows';
import type { OfferExportRow, OfferProductsTemplateExportRow } from '../offerProductsPanelTypes';

const ExportOfferProductsModal = dynamic(
  () => import('../products/ExportOfferProductsModal'),
  { ssr: false },
);

interface Props {
  offerId: string;
  className?: string;
}

export default function FillAVC4Button({ offerId, className }: Props) {
  const [showModal, setShowModal] = useState(false);

  const handleRequestRows = useCallback(async (): Promise<OfferProductsTemplateExportRow[]> => {
    const endpoint = `/api/offers/${encodeURIComponent(offerId)}/products`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: { startRow: 0, endRow: 10000, allRows: true, filterModel: {}, sortModel: [] },
        fields: [...OFFER_PRODUCTS_EXPORT_FIELDS],
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: OfferExportRow[] }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to fetch rows (status ${response.status})`);
    }

    const rows = payload.rows;
    const displayMap = computeDisplayOrderingMap(rows as unknown as Record<string, unknown>[]);
    const included = rows.filter((row) => {
      const t = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
      return t === 'product' || t === 'category' || t === 'printable-comment' || t === 'printable-service';
    });

    return included.map((row): OfferProductsTemplateExportRow => {
      const rowType = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
      const model = (row.ModelNumber ?? '').toString().trim();
      const description = (row.Description ?? '').toString().trim();
      const descriptionType = [model, description].filter((p) => p.length > 0).join(' ').trim();
      const rawQty = coerceNumber(row.Quantity);
      const isServLot = row.ServiceType === 'ServLot';
      const qty = isServLot ? 1 : rawQty;
      const listPrice = coerceNumber(row.ListPrice);
      const additionalDiscount = coerceNumber(row.AdditionalCustomerDiscount);
      const deliveryRaw = row.Delivery == null ? '' : String(row.Delivery).trim();
      const deliveryValue = deliveryRaw.length > 0 ? deliveryRaw : 'unknown';
      const isUnmatchedProduct = rowType === 'product'
        && !row.PartNumber?.toString().trim()
        && !row.BrandName?.toString().trim()
        && !model
        && !description
        && listPrice == null;
      const actualKey = String(row.TreeOrdering ?? '').trim();
      const noBase = normalizeNoForExport(displayMap.get(actualKey) ?? row.TreeOrdering);
      const noWithOption = isOfferProductOption(row as unknown as Record<string, unknown>) && noBase !== ''
        ? `${noBase} (Option)`
        : noBase;
      return {
        no: noWithOption,
        productReference: row.PartNumber?.toString().trim() ?? '',
        manufacturer: (row.AVC4BrandName?.toString().trim() || row.BrandName?.toString().trim()) ?? '',
        descriptionType,
        qty: qty != null && !Object.is(qty, 0) ? qty : '',
        unitPrice: listPrice ?? '',
        additionalDiscount: additionalDiscount ?? '',
        delayForDelivery: deliveryValue,
        comments: row.Comment?.toString() ?? '',
        ...(isUnmatchedProduct ? { skipRow: true } : undefined),
      };
    });
  }, [offerId]);

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setShowModal(true)}
      >
        Fill AVC4
      </button>
      {showModal && (
        <ExportOfferProductsModal
          onClose={() => setShowModal(false)}
          onRequestRows={handleRequestRows}
        />
      )}
    </>
  );
}
