'use client';

import { useEffect, useRef, useState } from 'react';
import {
  hasGridStateInUrl,
  parseGridSearchParams,
  writeGridStateToUrl,
} from '@/lib/gridUrlState';

type SortEntry = { colId: string; sort: 'asc' | 'desc' };

type UseGridUrlStateOptions = {
  /** Master switch — when false the hook is inert. */
  enabled: boolean;
  /** Namespace for URL params (for multi-grid pages). */
  namespace?: string;
};

export type GridUrlState = {
  /** Whether the URL contained grid state params on first render. */
  hasUrlState: boolean;

  /** Read the initial filter model from URL (call once during grid init). */
  readInitialFilterModel: () => Record<string, unknown> | null;
  /** Read the initial sort model from URL (call once during grid init). */
  readInitialSortModel: () => SortEntry[] | null;
  /** Read the initial quick search from URL (call once during grid init). */
  readInitialQuickSearch: () => string | null;

  /** Schedule a debounced URL write for the filter model. */
  writeFilterModelToUrl: (model: Record<string, unknown> | null) => void;
  /** Schedule a debounced URL write for the sort model. */
  writeSortModelToUrl: (model: SortEntry[] | null) => void;
  /** Schedule a debounced URL write for quick search text. */
  writeQuickSearchToUrl: (text: string) => void;

  /** Subscribe to popstate events. Returns an unsubscribe function. */
  onPopState: (callback: () => void) => () => void;
};

const DEBOUNCE_MS = 300;

/**
 * Hook that manages bidirectional sync between AG Grid state and URL params.
 *
 * Returns a **referentially stable** object (same identity across renders)
 * so it can safely appear in useCallback / useEffect dependency arrays
 * without triggering re-runs.
 */
export function useGridUrlState(options: UseGridUrlStateOptions): GridUrlState {
  const { enabled, namespace } = options;

  // Capture the initial URL search on first render (before any replaceState)
  const initialSearchRef = useRef<string>(
    typeof window !== 'undefined' ? window.location.search : '',
  );

  // Close over mutable option values so the stable methods always read fresh values
  const enabledRef = useRef(enabled);
  const namespaceRef = useRef(namespace);

  // Sync refs in an effect (not during render) so closures always read fresh values
  useEffect(() => {
    enabledRef.current = enabled;
    namespaceRef.current = namespace;
  });

  // Pending state for debounced writes
  const pendingFilterRef = useRef<Record<string, unknown> | null | undefined>(undefined);
  const pendingSortRef = useRef<SortEntry[] | null | undefined>(undefined);
  const pendingQuickSearchRef = useRef<string | undefined>(undefined);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest known state (so debounced flush always uses the most recent values)
  const latestFilterRef = useRef<Record<string, unknown> | null>(null);
  const latestSortRef = useRef<SortEntry[] | null>(null);
  const latestQuickSearchRef = useRef<string>('');

  // Build the stable object once via useState lazy initializer
  const [state] = useState<GridUrlState>(() => {
    // Capture initial values directly (not through refs) since this is the first render
    const initialSearch = typeof window !== 'undefined' ? window.location.search : '';

    const flush = () => {
      debounceTimerRef.current = null;
      const filterModel = pendingFilterRef.current !== undefined
        ? pendingFilterRef.current
        : latestFilterRef.current;
      const sortModel = pendingSortRef.current !== undefined
        ? pendingSortRef.current
        : latestSortRef.current;
      const quickSearch = pendingQuickSearchRef.current !== undefined
        ? pendingQuickSearchRef.current
        : latestQuickSearchRef.current;

      if (pendingFilterRef.current !== undefined) latestFilterRef.current = pendingFilterRef.current;
      if (pendingSortRef.current !== undefined) latestSortRef.current = pendingSortRef.current;
      if (pendingQuickSearchRef.current !== undefined) latestQuickSearchRef.current = pendingQuickSearchRef.current;

      pendingFilterRef.current = undefined;
      pendingSortRef.current = undefined;
      pendingQuickSearchRef.current = undefined;

      writeGridStateToUrl({ filterModel, sortModel, quickSearch }, namespaceRef.current);
    };

    const scheduleFlush = () => {
      if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(flush, DEBOUNCE_MS);
    };

    return {
      hasUrlState: enabled && hasGridStateInUrl(initialSearch, namespace),

      readInitialFilterModel: () => {
        const search = initialSearchRef.current;
        if (!search) return null;
        return parseGridSearchParams(search, namespaceRef.current).filterModel;
      },

      readInitialSortModel: () => {
        const search = initialSearchRef.current;
        if (!search) return null;
        const params = new URLSearchParams(search);
        const key = namespaceRef.current ? `s_${namespaceRef.current}` : 's';
        const raw = params.get(key);
        if (!raw) return null;
        const entries: SortEntry[] = [];
        for (const part of raw.split(',')) {
          const idx = part.lastIndexOf(':');
          if (idx < 1) continue;
          const colId = part.slice(0, idx);
          const sort = part.slice(idx + 1);
          if (sort !== 'asc' && sort !== 'desc') continue;
          entries.push({ colId, sort });
        }
        return entries.length > 0 ? entries : null;
      },

      readInitialQuickSearch: () => {
        const search = initialSearchRef.current;
        if (!search) return null;
        const params = new URLSearchParams(search);
        const key = namespaceRef.current ? `q_${namespaceRef.current}` : 'q';
        return params.get(key) ?? null;
      },

      writeFilterModelToUrl: (model: Record<string, unknown> | null) => {
        if (!enabledRef.current) return;
        pendingFilterRef.current = model;
        latestFilterRef.current = model;
        scheduleFlush();
      },

      writeSortModelToUrl: (model: SortEntry[] | null) => {
        if (!enabledRef.current) return;
        pendingSortRef.current = model;
        latestSortRef.current = model;
        scheduleFlush();
      },

      writeQuickSearchToUrl: (text: string) => {
        if (!enabledRef.current) return;
        pendingQuickSearchRef.current = text;
        latestQuickSearchRef.current = text;
        scheduleFlush();
      },

      onPopState: (callback: () => void) => {
        if (!enabledRef.current || typeof window === 'undefined') return () => {};
        const handler = () => callback();
        window.addEventListener('popstate', handler);
        return () => window.removeEventListener('popstate', handler);
      },
    };
  });

  // Flush pending writes on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  return state;
}
