'use client';

import { useState, useCallback } from 'react';
import { showToastMessage } from '../../../../lib/toast';
import { showConfirmDialog } from '../../../../lib/confirm';
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

type CustomerMatch = {
  TRDR: number;
  CODE: string | null;
  NAME: string | null;
};

type Props = {
  offerId: string;
  className?: string;
};

export default function CreateDraftOfferButton({ offerId, className }: Props) {
  const [isCreatingDraftOffer, setIsCreatingDraftOffer] = useState(false);
  const [isInProcess, setIsInProcess] = useState(false); // Tracks the entire multi-step flow
  const [productSelections, setProductSelections] = useState<ProductMatch[]>([]);
  const [selectedMatches, setSelectedMatches] = useState<Map<number, { MTRL: number; CODE: string | null }>>(new Map())
  const [customerSelections, setCustomerSelections] = useState<CustomerMatch[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerMatch | null>(null);
  const [showCustomerCodeInput, setShowCustomerCodeInput] = useState(false);
  const [customerCodeInput, setCustomerCodeInput] = useState('');
  const [customerToConfirm, setCustomerToConfirm] = useState<CustomerMatch | null>(null);

  const handleCreateDraftOffer = useCallback(async (confirmedCustomer?: CustomerMatch) => {
    setIsCreatingDraftOffer(true);
    setIsInProcess(true); // Mark the entire process as started
    try {
      const requestBody: {
        selections?: Array<{ productId: number; MTRL: number; CODE: string | null }>;
        customerSelection?: { TRDR: number; CODE: string | null };
        customerCode?: string;
        customerConfirmed?: boolean;
      } = {};

      // Add product selections if any
      if (selectedMatches.size > 0) {
        requestBody.selections = Array.from(selectedMatches.entries()).map(([productId, match]) => ({
          productId,
          MTRL: match.MTRL,
          CODE: match.CODE,
        }));
      }

      // Add customer selection if any (from confirmation or selection)
      const customerForRequest = confirmedCustomer || selectedCustomer;
      if (customerForRequest) {
        requestBody.customerSelection = {
          TRDR: customerForRequest.TRDR,
          CODE: customerForRequest.CODE,
        };
        requestBody.customerConfirmed = !!confirmedCustomer;
      }

      // Add customer code if provided
      if (customerCodeInput.trim()) {
        requestBody.customerCode = customerCodeInput.trim();
      }

      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/create-draft-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            needsSelection?: ProductMatch[];
            needsCustomerSelection?: CustomerMatch[];
            needsCustomerConfirmation?: CustomerMatch;
            needsCustomerCode?: boolean;
            updated?: number[];
            error?: string;
            message?: string;
          }
        | null;

      if (!response.ok || !payload?.ok) {
        // Check if customer code is needed
        if (payload?.needsCustomerCode) {
          setShowCustomerCodeInput(true);
          showToastMessage(payload?.error ?? 'Customer code required', 'warning');
          setIsCreatingDraftOffer(false);
          return;
        }
        throw new Error(payload?.error ?? 'Failed to create draft offer');
      }

      // Check if customer confirmation is needed
      if (payload.needsCustomerConfirmation) {
        setCustomerToConfirm(payload.needsCustomerConfirmation);
        setIsCreatingDraftOffer(false);
        return;
      }

      // Check if customer selection is needed
      if (payload.needsCustomerSelection && payload.needsCustomerSelection.length > 0) {
        setCustomerSelections(payload.needsCustomerSelection);
        setIsCreatingDraftOffer(false);
        return;
      }

      // Check if product selection is needed
      if (payload.needsSelection && payload.needsSelection.length > 0) {
        setProductSelections(payload.needsSelection);
      } else {
        // All done
        showToastMessage(payload.message ?? 'Draft offer created successfully', 'success');
        setProductSelections([]);
        setSelectedMatches(new Map());
        setCustomerSelections([]);
        setSelectedCustomer(null);
        setShowCustomerCodeInput(false);
        setCustomerCodeInput('');
        setCustomerToConfirm(null);
        setIsInProcess(false); // Reset process flag on success
        // Refresh the page to show updated data
        window.location.reload();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create draft offer';
      showToastMessage(message, 'error');
      setIsInProcess(false); // Reset on error
    } finally {
      setIsCreatingDraftOffer(false);
    }
  }, [offerId, selectedMatches, selectedCustomer, customerCodeInput]);

  const handleCreateDraftOfferWithConfirm = useCallback(async () => {
    const confirmed = await showConfirmDialog({
      title: 'Warning!',
      message:
        'Are you sure that the customer has accepted this offer and you want to create a new draft order in Soft1? Please double check that this is correct.',
      confirmLabel: 'Create draft order',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    await handleCreateDraftOffer();
  }, [handleCreateDraftOffer]);

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

  const handleConfirmCustomerSelection = useCallback(async () => {
    if (!selectedCustomer) {
      showToastMessage('Please select a customer', 'error');
      return;
    }

    // Close the customer selection modal
    setCustomerSelections([]);

    // Call the API again with customer selection
    await handleCreateDraftOffer();
  }, [selectedCustomer, handleCreateDraftOffer]);

  const handleConfirmCustomerCode = useCallback(async () => {
    if (!customerCodeInput.trim()) {
      showToastMessage('Please enter a customer code', 'error');
      return;
    }

    // Close the customer code input modal
    setShowCustomerCodeInput(false);

    // Call the API again with customer code
    await handleCreateDraftOffer();
  }, [customerCodeInput, handleCreateDraftOffer]);

  const handleConfirmCustomer = useCallback(async () => {
    if (!customerToConfirm) return;

    // Close the confirmation modal
    setCustomerToConfirm(null);

    // Call the API with confirmed customer
    await handleCreateDraftOffer(customerToConfirm);
  }, [customerToConfirm, handleCreateDraftOffer]);

  const handleRejectCustomer = useCallback(() => {
    // User rejected the customer, show code input instead
    setCustomerToConfirm(null);
    setShowCustomerCodeInput(true);
  }, []);

  return (
    <>
      <button
        type="button"
        className={className || lookupButtonStyles.lookupAddButton}
        onClick={handleCreateDraftOfferWithConfirm}
        disabled={isCreatingDraftOffer || isInProcess}
      >
        {isCreatingDraftOffer ? 'Creating...' : isInProcess ? 'In Progress...' : 'Create Draft Order in Soft1'}
      </button>
      {productSelections.length > 0 && (
        <LookupModal
          open={productSelections.length > 0}
          title="Select ERP Product"
          onClose={() => {
            setProductSelections([]);
            setSelectedMatches(new Map());
            setIsInProcess(false); // Reset when user cancels
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

      {customerSelections.length > 0 && (
        <LookupModal
          open={customerSelections.length > 0}
          title="Select Customer"
          onClose={() => {
            setCustomerSelections([]);
            setSelectedCustomer(null);
            setIsInProcess(false); // Reset when user cancels
          }}
          onConfirm={handleConfirmCustomerSelection}
          confirmLabel="Confirm Customer"
          saving={isCreatingDraftOffer}
          cardClassName={lookupStyles.cardWide}
          cardStyle={{ width: 'min(700px, calc(100% - 32px))', maxWidth: '90vw' }}
        >
          <div style={{ marginBottom: '16px', fontSize: '0.9rem', color: '#64748b' }}>
            Multiple customers found. Please select the correct one:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {customerSelections.map((customer) => (
              <label
                key={customer.TRDR}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '12px',
                  border: selectedCustomer?.TRDR === customer.TRDR ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  backgroundColor: selectedCustomer?.TRDR === customer.TRDR ? '#eff6ff' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="customer"
                  value={customer.TRDR}
                  checked={selectedCustomer?.TRDR === customer.TRDR}
                  onChange={() => setSelectedCustomer(customer)}
                  style={{ marginRight: '12px' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>{customer.NAME}</div>
                  <div style={{ fontSize: '0.85rem', color: '#64748b' }}>
                    Code: {customer.CODE || 'N/A'} • TRDR: {customer.TRDR}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </LookupModal>
      )}

      {customerToConfirm && (
        <LookupModal
          open={!!customerToConfirm}
          title="Confirm Customer"
          onClose={handleRejectCustomer}
          onConfirm={handleConfirmCustomer}
          confirmLabel="Yes, This is Correct"
          cancelLabel="No, Enter Different Code"
          saving={isCreatingDraftOffer}
          cardClassName={lookupStyles.cardWide}
          cardStyle={{ width: 'min(600px, calc(100% - 32px))', maxWidth: '90vw' }}
        >
          <div style={{ marginBottom: '16px', fontSize: '0.95rem', fontWeight: 500 }}>
            Found this customer. Is this correct?
          </div>
          <div
            style={{
              padding: '16px',
              border: '2px solid #3b82f6',
              borderRadius: '8px',
              backgroundColor: '#eff6ff',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '1.1rem', marginBottom: '8px', color: '#1e40af' }}>
              {customerToConfirm.NAME}
            </div>
            <div style={{ fontSize: '0.9rem', color: '#64748b' }}>
              <div style={{ marginBottom: '4px' }}>
                <strong>Code:</strong> {customerToConfirm.CODE || 'N/A'}
              </div>
              <div>
                <strong>TRDR:</strong> {customerToConfirm.TRDR}
              </div>
            </div>
          </div>
          <div style={{ marginTop: '16px', fontSize: '0.85rem', color: '#64748b', fontStyle: 'italic' }}>
            If this is not the correct customer, click &quot;No&quot; to enter a different customer code.
          </div>
        </LookupModal>
      )}

      {showCustomerCodeInput && (
        <LookupModal
          open={showCustomerCodeInput}
          title="Enter Customer Code"
          onClose={() => {
            setShowCustomerCodeInput(false);
            setCustomerCodeInput('');
            setIsInProcess(false); // Reset when user cancels
          }}
          onConfirm={handleConfirmCustomerCode}
          confirmLabel="Search Customer"
          saving={isCreatingDraftOffer}
          cardClassName={lookupStyles.cardWide}
          cardStyle={{ width: 'min(500px, calc(100% - 32px))', maxWidth: '90vw' }}
        >
          <div style={{ marginBottom: '16px', fontSize: '0.9rem', color: '#64748b' }}>
            No customer found with the provided name. Please enter the customer code to search:
          </div>
          <input
            type="text"
            className={lookupStyles.fieldControl}
            placeholder="Enter customer code (e.g., ΖΓ.1014)..."
            value={customerCodeInput}
            onChange={(e) => setCustomerCodeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirmCustomerCode();
              }
            }}
            style={{ width: '100%', padding: '8px 12px', fontSize: '0.9rem' }}
            autoFocus
          />
        </LookupModal>
      )}
    </>
  );
}
