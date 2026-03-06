'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DRAFT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 1500;

type DraftEnvelope<T> = {
  values: T;
  savedAt: string;
};

function getStorageKey(draftKey: string, userId: string | null | undefined) {
  const user = userId?.trim() || 'anon';
  return `fastquote.draft:${draftKey}:${user}`;
}

function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const envelope: DraftEnvelope<T> = JSON.parse(raw);
    const savedAt = new Date(envelope.savedAt).getTime();
    if (Date.now() - savedAt > DRAFT_EXPIRY_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return envelope.values;
  } catch {
    return null;
  }
}

export function useFormDraft<T>(
  draftKey: string,
  initialValues: T,
  userId: string | null | undefined,
) {
  const key = getStorageKey(draftKey, userId);
  const [hasDraft, setHasDraft] = useState(() => readDraft<T>(key) !== null);
  const [restoredValues, setRestoredValues] = useState<T | null>(() => readDraft<T>(key));
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestValuesRef = useRef<T>(initialValues);

  const saveDraft = useCallback(
    (values: T) => {
      latestValuesRef.current = values;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        try {
          const envelope: DraftEnvelope<T> = {
            values,
            savedAt: new Date().toISOString(),
          };
          localStorage.setItem(key, JSON.stringify(envelope));
        } catch { /* ignore */ }
      }, DEBOUNCE_MS);
    },
    [key],
  );

  const clearDraft = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
    setHasDraft(false);
    setRestoredValues(null);
  }, [key]);

  const dismissDraft = useCallback(() => {
    clearDraft();
  }, [clearDraft]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return {
    hasDraft,
    restoredValues,
    saveDraft,
    clearDraft,
    dismissDraft,
  };
}
