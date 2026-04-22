import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'fastquote.smartFiltering';

const readPersisted = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'off') return false;
    if (raw === 'on') return true;
  } catch {
    /* noop */
  }
  return true;
};

// Shared toggle for "Smart filtering" — when ON, the match / add-products
// flow populates Description, fuzzy-expanded tokens, AI synonym expansion
// and semantic search; when OFF the UI only emits plain PartNumber /
// ModelNumber column filters and the server falls back to its built-in
// cross-column search.  Persists per-browser via localStorage.
export function useSmartFiltering(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readPersisted());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const listener = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setEnabled(event.newValue === 'on');
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, []);

  const setAndPersist = useCallback((next: boolean) => {
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      /* noop */
    }
  }, []);

  return [enabled, setAndPersist];
}
