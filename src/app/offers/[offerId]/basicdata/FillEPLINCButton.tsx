'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  buildOfferProductTemplateExportRows,
  OFFER_PRODUCTS_EXPORT_FIELDS,
} from '../offerProductsUtils';
import { EP_LINC_EXPORT_TEMPLATE } from '../products/offerExportTemplates';
import type { OfferExportRow, OfferProductsTemplateExportRow } from '../offerProductsPanelTypes';

const ExportOfferProductsModal = dynamic(
  () => import('../products/ExportOfferProductsModal'),
  { ssr: false },
);

interface Props {
  offerId: string;
  className?: string;
}

export default function FillEPLINCButton({ offerId, className }: Props) {
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

    // EP LINC pricing policy: only lines priced from the cost side (UPLIFT, or
    // COMPARISON picking uplift) reveal their cost in the workbook.
    return buildOfferProductTemplateExportRows(payload.rows, { epLincCostGating: true });
  }, [offerId]);

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setShowModal(true)}
      >
        Fill EP LINC
      </button>
      {showModal && (
        <ExportOfferProductsModal
          onClose={() => setShowModal(false)}
          onRequestRows={handleRequestRows}
          template={EP_LINC_EXPORT_TEMPLATE}
        />
      )}
    </>
  );
}
