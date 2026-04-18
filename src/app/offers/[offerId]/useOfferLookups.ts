import { useState, useEffect, useCallback, useRef } from 'react';
import type { OfferDropdownOption, MarketOption } from './OfferBasicDataTypes';

type UserOption = OfferDropdownOption & { salesSeniorityName?: string | null };

export type LookupKey =
  | 'customers'
  | 'statuses'
  | 'pricingPolicies'
  | 'markets'
  | 'salesDivisions'
  | 'users'
  | 'fwcProjects'
  | 'currencies';

export type LookupState = {
  customers: OfferDropdownOption[];
  statuses: OfferDropdownOption[];
  pricingPolicies: OfferDropdownOption[];
  markets: MarketOption[];
  salesDivisions: OfferDropdownOption[];
  users: UserOption[];
  fwcProjects: OfferDropdownOption[];
  currencies: OfferDropdownOption[];
};

type OfferLookupPayload = {
  [K in LookupKey]?: LookupState[K];
};

export function useOfferLookups(props: LookupState) {
  const [lookups, setLookups] = useState<LookupState>(props);
  const lookupRefreshInFlightRef = useRef(new Set<LookupKey>());

  useEffect(() => {
    setLookups({
      customers: props.customers,
      statuses: props.statuses,
      pricingPolicies: props.pricingPolicies,
      markets: props.markets,
      salesDivisions: props.salesDivisions,
      users: props.users,
      fwcProjects: props.fwcProjects,
      currencies: props.currencies,
    });
  }, [
    props.customers,
    props.statuses,
    props.pricingPolicies,
    props.markets,
    props.salesDivisions,
    props.users,
    props.fwcProjects,
    props.currencies,
  ]);

  const updateLookup = useCallback(<K extends LookupKey>(
    key: K,
    value: LookupState[K],
  ) => {
    setLookups((prev) => ({ ...prev, [key]: value }));
  }, []);

  const refreshLookups = useCallback(async (keys: LookupKey[]) => {
    const uniqueKeys = Array.from(new Set(keys));
    const pendingKeys = uniqueKeys.filter((key) => !lookupRefreshInFlightRef.current.has(key));
    if (pendingKeys.length === 0) return;
    pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.add(key));
    try {
      const search = new URLSearchParams();
      pendingKeys.forEach((key) => search.append('keys', key));
      const response = await fetch(`/api/offers/lookups?${search.toString()}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; lookups?: OfferLookupPayload }
        | null;
      if (!response.ok || !payload?.ok || !payload.lookups) {
        throw new Error(payload?.error ?? 'Unable to refresh lookup options');
      }
      setLookups((prev) => {
        const next = { ...prev };
        if (payload.lookups!.customers) next.customers = payload.lookups!.customers;
        if (payload.lookups!.statuses) next.statuses = payload.lookups!.statuses;
        if (payload.lookups!.pricingPolicies) next.pricingPolicies = payload.lookups!.pricingPolicies;
        if (payload.lookups!.markets) next.markets = payload.lookups!.markets as MarketOption[];
        if (payload.lookups!.salesDivisions) next.salesDivisions = payload.lookups!.salesDivisions;
        if (payload.lookups!.users) next.users = payload.lookups!.users as UserOption[];
        if (payload.lookups!.fwcProjects) next.fwcProjects = payload.lookups!.fwcProjects;
        if (payload.lookups!.currencies) next.currencies = payload.lookups!.currencies;
        return next;
      });
    } catch (err) {
      console.error(err);
      throw err;
    } finally {
      pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.delete(key));
    }
  }, []);

  return { lookups, updateLookup, refreshLookups };
}
