'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  buildOfferProductTemplateExportRows,
  OFFER_PRODUCTS_EXPORT_FIELDS,
} from '../offerProductsUtils';
import { AVC4_EXPORT_TEMPLATE } from '../products/offerExportTemplates';
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

    // No collapseServLotQty: AVC4 writes Qty alongside a per-unit price column
    // and has no total column, so a lump-sum service line must carry its real
    // quantity or the workbook's line total prices just one unit of it.
    return buildOfferProductTemplateExportRows(payload.rows);
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
          template={AVC4_EXPORT_TEMPLATE}
        />
      )}
    </>
  );
}
