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

    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/priced-comments`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = (await res.json()) as {
          ok: boolean;
          comments?: Array<{
            treeOrdering: number | null;
            description: string | null;
            quantity: number | null;
            netUnitPrice: number | null;
            totalPrice: number | null;
          }>;
        };
        const priced = data.ok ? data.comments ?? [] : [];
        if (priced.length > 0) {
          const fmtMoney = (n: number | null) =>
            n == null ? '—' : n.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const fmtQty = (n: number | null) =>
            n == null ? '—' : Number.isInteger(n) ? String(n) : n.toLocaleString('el-GR');
          const pricedConfirmed = await showConfirmDialog({
            title: 'Comments with pricing detected',
            message:
              'The following comment lines have a price set. Comments are NOT sent to Soft1 — their pricing will be ignored in the draft order. Continue anyway?',
            messageHtml:
              'The following comment lines have a price set. Comments are <strong>NOT</strong> sent to Soft1 — their pricing will be ignored in the draft order. Continue anyway?',
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
            tone: 'danger',
            details: {
              columns: ['#', 'Description', 'Qty', 'Net Unit Price', 'Total Price'],
              rows: priced.map((c) => [
                c.treeOrdering != null ? String(c.treeOrdering) : '—',
                c.description ?? '—',
                fmtQty(c.quantity),
                fmtMoney(c.netUnitPrice),
                fmtMoney(c.totalPrice),
              ]),
            },
          });
          if (!pricedConfirmed) {
            return;
          }
        }
      }
    } catch (err) {
      console.error('priced-comments precheck failed', err);
    }

    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/priced-services`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = (await res.json()) as {
          ok: boolean;
          services?: Array<{
            treeOrdering: number | null;
            description: string | null;
            quantity: number | null;
            netUnitPrice: number | null;
            totalPrice: number | null;
          }>;
        };
        const priced = data.ok ? data.services ?? [] : [];
        if (priced.length > 0) {
          const fmtMoney = (n: number | null) =>
            n == null ? '—' : n.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const fmtQty = (n: number | null) =>
            n == null ? '—' : Number.isInteger(n) ? String(n) : n.toLocaleString('el-GR');
          const pricedConfirmed = await showConfirmDialog({
            title: 'Services with pricing detected',
            message:
              'The following service lines have a price set. Services are NOT sent to Soft1 — their pricing will be ignored in the draft order. Continue anyway?',
            messageHtml:
              'The following service lines have a price set. Services are <strong>NOT</strong> sent to Soft1 — their pricing will be ignored in the draft order. Continue anyway?',
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
            tone: 'danger',
            details: {
              columns: ['#', 'Description', 'Qty', 'Net Unit Price', 'Total Price'],
              rows: priced.map((s) => [
                s.treeOrdering != null ? String(s.treeOrdering) : '—',
                s.description ?? '—',
                fmtQty(s.quantity),
                fmtMoney(s.netUnitPrice),
                fmtMoney(s.totalPrice),
              ]),
            },
          });
          if (!pricedConfirmed) {
            return;
          }
        }
      }
    } catch (err) {
      console.error('priced-services precheck failed', err);
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
  }, [currentOrderSignedDate, offerId]);

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
