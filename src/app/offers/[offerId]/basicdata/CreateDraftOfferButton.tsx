'use client';

import { useState, useCallback, useEffect } from 'react';
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
  const [currentOrderSignedDate, setCurrentOrderSignedDate] = useState<string | null>(orderSignedDate);

  useEffect(() => {
    setCurrentOrderSignedDate(orderSignedDate);
  }, [orderSignedDate]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string | null>).detail;
      setCurrentOrderSignedDate(detail && detail.length > 0 ? detail : null);
    };
    window.addEventListener('fastquote:order-signed-date-changed', handler);
    return () => window.removeEventListener('fastquote:order-signed-date-changed', handler);
  }, []);

  const handleClick = useCallback(async () => {
    if (!currentOrderSignedDate) {
      window.dispatchEvent(new CustomEvent('fastquote:highlight-order-signed-missing'));
      showToastMessage(
        'Order Signed date is required before creating a draft order in Soft1. Please set the Order Signed date on the offer and try again.',
        'error',
      );
      return;
    }
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (currentOrderSignedDate !== todayIso) {
      const formatDate = (iso: string) => {
        const [y, m, d] = iso.split('-');
        return `${d}/${m}/${y}`;
      };
      const dateMismatchConfirmed = await showConfirmDialog({
        title: 'Order Signed date is not today',
        message: `The Order Signed date is ${formatDate(currentOrderSignedDate)}, which is different from today (${formatDate(todayIso)}). Do you want to continue creating the draft order in Soft1?`,
        confirmLabel: 'Continue',
        cancelLabel: 'Cancel',
        tone: 'danger',
      });
      if (!dateMismatchConfirmed) {
        return;
      }
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
  }, [currentOrderSignedDate]);

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
