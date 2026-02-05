'use client';

import { useState, useCallback } from 'react';
import { showToastMessage } from '../../../../lib/toast';
import lookupStyles from '../../../components/LookupModal.module.css';
import LookupModal from '../../../components/LookupModal';
import lookupButtonStyles from '../../../components/LookupAddButton.module.css';

type ProductMatch = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  partNumberActual: string | null;
  modelNumberActual: string | null;
  matches: Array<{
    MTRL: number;
    CODE: string | null;
    CODE1: string | null;
    CODE2: string | null;
    NAME1: string | null;
  }>;
};

type Props = {
  offerId: string;
  className?: string;
};

export default function CreateDraftOfferButton({ offerId, className }: Props) {
  const [isCreatingDraftOffer, setIsCreatingDraftOffer] = useState(false);
  const [productSelections, setProductSelections] = useState<ProductMatch[]>([]);
  const [selectedMatches, setSelectedMatches] = useState<Map<number, { MTRL: number; CODE: string | null }>>(new Map());

  const handleCreateDraftOffer = useCallback(async () => {
    setIsCreatingDraftOffer(true);
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/create-draft-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections: Array.from(selectedMatches.entries()).map(([productId, match]) => ({
            productId,
            MTRL: match.MTRL,
            CODE: match.CODE,
          })),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; needsSelection?: ProductMatch[]; updated?: number[]; error?: string; message?: string }
        | null;
      
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'Failed to create draft offer');
      }

      if (payload.needsSelection && payload.needsSelection.length > 0) {
        // Show selection modal
        setProductSelections(payload.needsSelection);
      } else {
        // All done
        showToastMessage(payload.message ?? 'Draft offer created successfully', 'success');
        setProductSelections([]);
        setSelectedMatches(new Map());
        // Refresh the page to show updated data
        window.location.reload();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create draft offer';
      showToastMessage(message, 'error');
    } finally {
      setIsCreatingDraftOffer(false);
    }
  }, [offerId, selectedMatches]);

  const handleConfirmSelections = useCallback(async () => {
    if (productSelections.length === 0) return;
    
    // Check that all products have selections
    for (const selection of productSelections) {
      if (!selectedMatches.has(selection.productId)) {
        showToastMessage(`Please select a product for ${selection.partNumber || selection.modelNumber || 'Product'}`, 'error');
        return;
      }
    }

    // Call the API again with selections
    await handleCreateDraftOffer();
  }, [productSelections, selectedMatches, handleCreateDraftOffer]);

  return (
    <>
      <button
        type="button"
        className={className || lookupButtonStyles.lookupAddButton}
        onClick={handleCreateDraftOffer}
        disabled={isCreatingDraftOffer}
      >
        {isCreatingDraftOffer ? 'Creating...' : 'Create Draft Offer'}
      </button>
      {productSelections.length > 0 && (
        <LookupModal
          open={productSelections.length > 0}
          title="Select ERP Product"
          onClose={() => {
            setProductSelections([]);
            setSelectedMatches(new Map());
          }}
          onConfirm={handleConfirmSelections}
          confirmLabel="Confirm Selections"
          saving={isCreatingDraftOffer}
          cardClassName={lookupStyles.cardWide}
          cardStyle={{ width: 'min(900px, calc(100% - 32px))', maxWidth: '90vw' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {productSelections.map((selection) => {
              // Use actual (non-cleaned) values for display
              const partNumberActualStr = (selection.partNumberActual != null && String(selection.partNumberActual).trim() !== '') 
                ? String(selection.partNumberActual).trim() 
                : '';
              const modelNumberActualStr = (selection.modelNumberActual != null && String(selection.modelNumberActual).trim() !== '') 
                ? String(selection.modelNumberActual).trim() 
                : '';
              const productLabel = partNumberActualStr || modelNumberActualStr || `ID ${selection.productId}`;
              
              // Check if cleaned values exist (for matching)
              const partNumberClearedStr = (selection.partNumber != null && String(selection.partNumber).trim() !== '') 
                ? String(selection.partNumber).trim() 
                : '';
              const modelNumberClearedStr = (selection.modelNumber != null && String(selection.modelNumber).trim() !== '') 
                ? String(selection.modelNumber).trim() 
                : '';
              const hasPartNumberCleared = partNumberClearedStr.length > 0;
              const hasModelNumberCleared = modelNumberClearedStr.length > 0;
              const missingFields: string[] = [];
              if (!hasPartNumberCleared) missingFields.push('partNumber');
              if (!hasModelNumberCleared) missingFields.push('modelNumber');
              
              return (
              <div key={selection.productId} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                <div style={{ marginBottom: '8px', fontWeight: 600, fontSize: '0.9rem' }}>
                  <span style={{ color: '#000000' }}>Product: {productLabel}</span>
                  {missingFields.length > 0}
                </div>
                <div style={{ marginBottom: '8px', fontSize: '0.85rem', color: '#64748b' }}>
                  Found {selection.matches.length} matching product(s) in ERP
                </div>
                <select
                  className={lookupStyles.fieldControl}
                  value={selectedMatches.get(selection.productId)?.MTRL?.toString() ?? ''}
                  onChange={(e) => {
                    const mtrl = Number.parseInt(e.target.value, 10);
                    const match = selection.matches.find((m) => m.MTRL === mtrl);
                    if (match) {
                      setSelectedMatches((prev) => {
                        const next = new Map(prev);
                        next.set(selection.productId, { MTRL: match.MTRL, CODE: match.CODE });
                        return next;
                      });
                    }
                  }}
                  style={{ 
                    width: '100%', 
                    maxWidth: '100%',
                    whiteSpace: 'normal',
                    wordWrap: 'break-word',
                    overflowWrap: 'break-word'
                  }}
                >
                  <option value="">Select a product...</option>
                  {selection.matches.map((match) => {
                    const parts: string[] = [];
                    if (match.NAME1) parts.push(`Name: ${match.NAME1}`);
                    if (match.CODE) parts.push(`CODE: ${match.CODE}`);
                    if (match.CODE1) parts.push(`CODE1: ${match.CODE1}`);
                    if (match.CODE2) parts.push(`CODE2: ${match.CODE2}`);
                    if (match.MTRL) parts.push(`MTRL: ${match.MTRL}`);
                    const displayText = parts.length > 0 ? parts.join(', ') : `MTRL: ${match.MTRL}`;
                    
                    return (
                      <option key={match.MTRL} value={match.MTRL} title={displayText}>
                        {displayText}
                      </option>
                    );
                  })}
                </select>
              </div>
            );
            })}
          </div>
        </LookupModal>
      )}
    </>
  );
}
