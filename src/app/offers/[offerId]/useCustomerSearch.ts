import { useCallback, useEffect, useRef } from 'react';
import type { OfferDropdownOption } from './OfferBasicDataTypes';

type OfferLookupPayload = {
  customers?: OfferDropdownOption[];
};

export function useCustomerSearch(
  onResults: (customers: OfferDropdownOption[]) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const searchCustomers = useCallback((query: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const search = new URLSearchParams();
        search.set('keys', 'customers');
        search.set('customerSearch', trimmed);
        const response = await fetch(`/api/offers/lookups?${search.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; lookups?: OfferLookupPayload }
          | null;
        if (payload?.ok && payload.lookups?.customers) {
          onResults(payload.lookups.customers);
        }
      } catch {
        // Ignore abort errors and network failures
      }
    }, 300);
  }, [onResults]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return searchCustomers;
}
