'use client';

import { useEffect } from 'react';

/**
 * Shows a browser-native "unsaved changes" warning when the user tries to
 * close the tab or navigate away (hard navigation) while `isDirty` is true.
 */
export function useUnsavedChanges(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);
}
