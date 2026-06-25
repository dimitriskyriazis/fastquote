'use client';

import { useCallback, useRef, useState } from 'react';
import { showToastMessage } from '../../../../lib/toast';

interface Props {
  offerId: string;
  className?: string;
}

// Lets the user upload the blank TELMACO project form (.docx) and download it
// pre-filled with this offer's data. The fill happens server-side.
export default function FillProjectFormButton({ offerId, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  // On click, first verify the required Basic Data fields are filled in; only
  // then open the file picker. Points out anything missing (like Order Signed is
  // required for Create Draft Order).
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
        // Highlight the missing controls in the Basic Data form (same red styling
        // Create Draft Order uses for a missing Order Signed date).
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
      inputRef.current?.click();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to validate the offer';
      showToastMessage(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, offerId]);

  const handleFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Allow re-picking the same file next time.
      event.target.value = '';
      if (!file) return;

      setBusy(true);
      try {
        const formData = new FormData();
        formData.append('file', file, file.name);

        const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/project-form`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `Failed to generate (status ${res.status})`);
        }

        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') ?? '';
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
    },
    [offerId],
  );

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        onClick={handleClick}
      >
        {busy ? 'Generating…' : 'Fill Project Form'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
    </>
  );
}
