'use client';

import { useEffect, useState } from 'react';
import CustomerBasicDataClient from './CustomerBasicDataClient';
import styles from './CustomerBasicDataPanel.module.css';
import type { CustomerBasicRecord, CustomerDropdownOption, CustomerCityOption } from './CustomerBasicDataTypes';

type Props = {
  customerId: string;
  initialRecord?: CustomerBasicRecord | null;
};

type LookupKey =
  | 'customerGroups'
  | 'parentCustomers'
  | 'pricingPolicies'
  | 'importanceOptions'
  | 'countries'
  | 'cities';

type CustomerLookupsPayload = {
  customerGroups?: CustomerDropdownOption[];
  parentCustomers?: CustomerDropdownOption[];
  pricingPolicies?: CustomerDropdownOption[];
  importanceOptions?: CustomerDropdownOption[];
  countries?: CustomerDropdownOption[];
  cities?: CustomerCityOption[];
};

type CustomerBasicDataResponse = {
  ok?: boolean;
  error?: string;
  record?: CustomerBasicRecord | null;
};

type CustomerLookupsResponse = {
  ok?: boolean;
  error?: string;
  lookups?: CustomerLookupsPayload;
};

const LOOKUP_KEYS: LookupKey[] = [
  'customerGroups',
  'parentCustomers',
  'pricingPolicies',
  'importanceOptions',
  'countries',
  'cities',
];

export default function CustomerBasicDataPanel({ customerId, initialRecord }: Props) {
  const decodedId = customerId;
  const encodedId = encodeURIComponent(decodedId);
  const [record, setRecord] = useState<CustomerBasicRecord | null>(initialRecord ?? null);
  const [customerGroups, setCustomerGroups] = useState<CustomerDropdownOption[]>([]);
  const [parentCustomers, setParentCustomers] = useState<CustomerDropdownOption[]>([]);
  const [pricingPolicies, setPricingPolicies] = useState<CustomerDropdownOption[]>([]);
  const [importanceOptions, setImportanceOptions] = useState<CustomerDropdownOption[]>([]);
  const [countries, setCountries] = useState<CustomerDropdownOption[]>([]);
  const [cities, setCities] = useState<CustomerCityOption[]>([]);
  const [loading, setLoading] = useState(initialRecord == null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        LOOKUP_KEYS.forEach((key) => params.append('keys', key));

        const [recordResponse, lookupsResponse] = await Promise.all([
          fetch(`/api/customers/${encodedId}/basicdata`, { cache: 'no-store' }),
          fetch(`/api/customers/lookups?${params.toString()}`, { cache: 'no-store' }),
        ]);

        const recordPayload = (await recordResponse
          .json()
          .catch(() => null)) as CustomerBasicDataResponse | null;
        if (!recordResponse.ok || !recordPayload?.ok || !recordPayload.record) {
          throw new Error(recordPayload?.error ?? 'Unable to load customer basic data.');
        }

        const lookupsPayload = (await lookupsResponse
          .json()
          .catch(() => null)) as CustomerLookupsResponse | null;
        if (!lookupsResponse.ok || !lookupsPayload?.ok || !lookupsPayload.lookups) {
          throw new Error(lookupsPayload?.error ?? 'Unable to load customer lookups.');
        }

        if (!active) return;

        setRecord(recordPayload.record);
        setCustomerGroups(
          Array.isArray(lookupsPayload.lookups.customerGroups) ? lookupsPayload.lookups.customerGroups : [],
        );
        setParentCustomers(
          Array.isArray(lookupsPayload.lookups.parentCustomers) ? lookupsPayload.lookups.parentCustomers : [],
        );
        setPricingPolicies(
          Array.isArray(lookupsPayload.lookups.pricingPolicies) ? lookupsPayload.lookups.pricingPolicies : [],
        );
        setImportanceOptions(
          Array.isArray(lookupsPayload.lookups.importanceOptions) ? lookupsPayload.lookups.importanceOptions : [],
        );
        setCountries(Array.isArray(lookupsPayload.lookups.countries) ? lookupsPayload.lookups.countries : []);
        setCities(Array.isArray(lookupsPayload.lookups.cities) ? lookupsPayload.lookups.cities : []);
      } catch (err) {
        if (!active) return;
        console.error('Failed to load customer basic data page payload', err);
        setRecord(null);
        setLoadError(err instanceof Error ? err.message : 'Unable to load customer basic data.');
      } finally {
        if (!active) return;
        setLoading(false);
      }
    };

    void loadData();

    return () => {
      active = false;
    };
  }, [encodedId]);

  if (loading && !record) {
    return <section className={styles.emptyState}>Loading customer basic data…</section>;
  }

  if (!record) {
    return (
      <section className={styles.emptyState}>
        {loadError ?? 'This customer could not be found or has been removed.'}
      </section>
    );
  }

  const filteredParents =
    record.CustomerID != null
      ? parentCustomers.filter((option) => option.value !== String(record.CustomerID))
      : parentCustomers;

  return (
    <CustomerBasicDataClient
      customerId={decodedId}
      record={record}
      customerGroups={customerGroups}
      parentCustomers={filteredParents}
      pricingPolicies={pricingPolicies}
      importanceOptions={importanceOptions}
      countries={countries}
      cities={cities}
    />
  );
}
