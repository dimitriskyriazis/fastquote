'use client';

import { useState, useCallback } from 'react';
import { showConfirmDialog } from '../../../../lib/confirm';
import { showToastMessage } from '../../../../lib/toast';
import lookupButtonStyles from '../../../components/LookupAddButton.module.css';
import DraftOrderWizard from './DraftOrderWizard';

type Props = {
  offerId: string;
  orderSignedDate: string | null;
  className?: string;
};

export default function CreateDraftOfferButton({ offerId, orderSignedDate, className }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);

  const handleClick = useCallback(async () => {
    if (!orderSignedDate) {
      window.dispatchEvent(new CustomEvent('fastquote:highlight-order-signed-missing'));
      showToastMessage(
        'Order Signed date is required before creating a draft order in Soft1. Please set the Order Signed date on the offer and try again.',
        'error',
      );
      return;
    }
    const confirmed = await showConfirmDialog({
      title: 'Warning!',
      message:
        'Are you sure that the customer has accepted this offer and you want to create a new draft order in Soft1? Please double check that this is correct.',
      confirmLabel: 'Start Draft Order Process',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    if (confirmed) {
      setWizardOpen(true);
    }
  }, [orderSignedDate]);

  const handleWizardClose = useCallback(() => {
    setWizardOpen(false);
  }, []);

  return (
    <>
      <button
        type="button"
        className={className || lookupButtonStyles.lookupAddButton}
        onClick={handleClick}
        disabled={wizardOpen}
      >
        {wizardOpen ? 'Draft Order in Progress...' : 'Create Draft Order in Soft1'}
      </button>
      {wizardOpen && (
        <DraftOrderWizard
          offerId={offerId}
          open={wizardOpen}
          onClose={handleWizardClose}
        />
      )}
    </>
  );
}
