'use client';

import { useCallback, useState } from 'react';
import { showToastMessage } from '../../../../lib/toast';

interface Props {
  offerId: string;
  className?: string;
}

// Downloads the TELMACO project form (.docx) pre-filled with this offer's data.
// The blank template lives on the file server (see the project-form API route),
// so the user just clicks and the completed document downloads — no upload step.
export default function FillProjectFormButton({ offerId, className }: Props) {
  const [busy, setBusy] = useState(false);

  // First verify the required Basic Data fields are filled in (GET). If anything
  // is missing, highlight those controls and stop (same red styling Create Draft
  // Order uses for a missing Order Signed date). Otherwise generate the filled
  // form (POST) and download it.
  const handleClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/project-form`, {
        cache: 'no-store',
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; missing?: Array<{ label: string; fieldId: string }> }
        | null;
      if (!res.ok) {
        throw new Error(payload?.error ?? `Validation failed (status ${res.status})`);
      }
      const missing = payload?.missing ?? [];
      if (missing.length > 0) {
        window.dispatchEvent(
          new CustomEvent('fastquote:highlight-fields-missing', {
            detail: missing.map((m) => m.fieldId),
          }),
        );
        showToastMessage(
          `Cannot generate the project form. Please fill in these Basic Data fields first: ${missing
            .map((m) => m.label)
            .join(', ')}.`,
          'error',
        );
        return;
      }

      const genRes = await fetch(`/api/offers/${encodeURIComponent(offerId)}/project-form`, {
        method: 'POST',
      });
      if (!genRes.ok) {
        const errPayload = (await genRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errPayload?.error ?? `Failed to generate (status ${genRes.status})`);
      }

      const blob = await genRes.blob();
      const disposition = genRes.headers.get('Content-Disposition') ?? '';
      const nameMatch = disposition.match(/filename="?([^"]+)"?/i);
      const filename = nameMatch?.[1] ?? `ProjectForm_${offerId}.docx`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate the project form';
      showToastMessage(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, offerId]);

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={handleClick}
    >
      {busy ? 'Generating…' : 'Download Project Form'}
    </button>
  );
}
