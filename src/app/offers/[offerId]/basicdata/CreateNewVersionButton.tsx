'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { showToastMessage } from '../../../../lib/toast';

type Props = {
  offerId: string;
  className?: string;
};

export default function CreateNewVersionButton({ offerId, className }: Props) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  const handleClick = useCallback(async () => {
    if (isPending) return;
    setIsPending(true);
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/duplicate`, {
        method: 'POST',
      });
      let payload: { ok?: boolean; error?: string; offerId?: number | string } | null = null;
      try {
        payload = (await response.json()) as { ok?: boolean; error?: string; offerId?: number | string };
      } catch {
        payload = null;
      }
      if (!response.ok || !payload?.ok || payload.offerId == null) {
        const message = payload?.error ?? 'Unable to create new version';
        showToastMessage(message, 'error');
        return;
      }
      showToastMessage('Created new offer version', 'success');
      router.push(`/offers/${encodeURIComponent(String(payload.offerId))}/basicdata`);
    } catch (err) {
      console.error('Failed to create offer version', err);
      showToastMessage('Unable to create new version', 'error');
    } finally {
      setIsPending(false);
    }
  }, [isPending, offerId, router]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      disabled={isPending}
    >
      {isPending ? 'Creating...' : 'Create new version'}
    </button>
  );
}
