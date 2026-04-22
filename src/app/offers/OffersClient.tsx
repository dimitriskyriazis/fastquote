"use client";

import React, { useMemo, useCallback, useContext, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import type {
  ColDef,
  ICellRendererParams,
  GetContextMenuItemsParams,
  GridApi,
  ColumnState,
  MenuItemDef,
  CellValueChangedEvent,
} from 'ag-grid-community';
import { GridRowDeletion } from '../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../lib/deletePermissions';
import { useAuditUser } from '../components/AuditUserProvider';
import PageHeader, { PageHeaderContext } from '../components/PageHeader';
import { GridQuickSearchProvider } from '../components/GridQuickSearchProvider';
import { formatDateTime } from '../lib/formatDateTime';
import { showToastMessage } from '../../lib/toast';
import OfferStatusHistoryModal from './[offerId]/OfferStatusHistoryModal';
import styles from './OffersClient.module.css';

const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === 'true') return 'Yes';
  if (value === 0 || value === false || value === 'false') return 'No';
  return value == null ? '' : String(value);
};

const duplicateVersionMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 5h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M7 7V5a2 2 0 0 1 2-2h6" />
    </svg>
  </span>
`;

const duplicateOfferMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <rect x="4" y="4" width="11" height="11" rx="2" />
    </svg>
  </span>
`;

const historyMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  </span>
`;

const viewCustomerMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  </span>
`;

const normalizeOfferIdValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const resolveOfferRowLabel = (
  row: { Description?: string | null; Title?: string | null } | null,
  fallback: string,
) => {
  if (!row) return fallback;
  const normalize = (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim() : value ? String(value) : '';
  const description = normalize(row.Description);
  const title = normalize(row.Title);
  if (description && title) return `${description} – ${title}`;
  if (description) return description;
  if (title) return title;
  return fallback;
};

const OFFER_ROW_TYPE_LABEL = 'offer';
const normalizeSortText = (value: unknown) => {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.trim();
};
const localeStringComparator = (a: unknown, b: unknown) => {
  const left = normalizeSortText(a);
  const right = normalizeSortText(b);
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
};

const normalizeProbability = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

function ClearCustomerFilterPortalButton({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  const slot = useContext(PageHeaderContext);
  if (!slot) return null;
  return createPortal(
    <button
      type="button"
      className={styles.clearCustomerFilterButton}
      onClick={onClear}
      title={label ? `Customer: ${label}` : undefined}
    >
      Clear customer filter{label ? `: ${label}` : ''}
    </button>,
    slot,
  );
}

export default function OffersClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { roles, userId } = useAuditUser();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const initialSalesPersonRef = useRef((searchParams.get('salesPerson') ?? '').trim());
  const initialCustomerIdRef = useRef((searchParams.get('customerId') ?? '').trim());
  const [customerFilterActive, setCustomerFilterActive] = useState(false);
  const [customerFilterLabel, setCustomerFilterLabel] = useState<string>('');
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const pendingColumnStateRestoreRef = useRef<ColumnState[] | null>(null);
  const [expandedVersionGroups, setExpandedVersionGroups] = useState<Set<number>>(new Set());
  const expandedVersionGroupsRef = useRef<Set<number>>(expandedVersionGroups);
  expandedVersionGroupsRef.current = expandedVersionGroups;
  const [statusHistoryModalOpen, setStatusHistoryModalOpen] = useState(false);
  const [statusHistoryOfferId, setStatusHistoryOfferId] = useState<number | null>(null);

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api) return;
    gridApiRef.current = api;
    if (defaultEnabledFilterAppliedRef.current) return;
    const salesPerson = initialSalesPersonRef.current;
    const hasSalesPersonFilter = Boolean(salesPerson);
    const customerIdParam = initialCustomerIdRef.current;
    const customerIdNumber = Number.parseInt(customerIdParam, 10);
    const hasCustomerIdFilter = Number.isInteger(customerIdNumber) && customerIdNumber > 0;
    const hasUrlFilter = hasSalesPersonFilter || hasCustomerIdFilter;
    const existingModel = api.getFilterModel() as Record<string, unknown> | null;
    const baseModel: Record<string, unknown> = hasUrlFilter
      ? {}
      : (existingModel && typeof existingModel === 'object' ? { ...existingModel } : {});
    const needsEnabledDefault = !('Enabled' in baseModel);
    if (!needsEnabledDefault && !hasUrlFilter) {
      defaultEnabledFilterAppliedRef.current = true;
      return;
    }
    if (needsEnabledDefault) {
      baseModel.Enabled = { filterType: 'set', values: ['true'] };
    }
    if (hasSalesPersonFilter) {
      baseModel.SalesPerson = { filterType: 'text', type: 'contains', filter: salesPerson };
    }
    if (hasCustomerIdFilter) {
      baseModel.CustomerID = { filterType: 'number', type: 'equals', filter: customerIdNumber };
      setCustomerFilterActive(true);
      setCustomerFilterLabel(String(customerIdNumber));
    }
    api.setFilterModel(baseModel);
    defaultEnabledFilterAppliedRef.current = true;
  }, []);

  useEffect(() => {
    if (!customerFilterActive) return;
    const id = customerFilterLabel;
    if (!id || !/^\d+$/.test(id)) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/customers/${encodeURIComponent(id)}/basicdata`, { cache: 'no-store' });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; record?: { Name?: string | null } | null } | null;
        const name = payload?.record?.Name;
        if (!cancelled && response.ok && payload?.ok && typeof name === 'string' && name.trim()) {
          setCustomerFilterLabel(name.trim());
        }
      } catch {
        /* keep numeric label */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerFilterActive, customerFilterLabel]);

  const handleClearCustomerFilter = useCallback(() => {
    const api = gridApiRef.current;
    if (api && !api.isDestroyed?.()) {
      const current = (api.getFilterModel() as Record<string, unknown> | null) ?? {};
      if ('CustomerID' in current) {
        const next = { ...current };
        delete next.CustomerID;
        api.setFilterModel(next);
      }
    }
    setCustomerFilterActive(false);
    setCustomerFilterLabel('');
    initialCustomerIdRef.current = '';
    const params = new URLSearchParams(searchParams.toString());
    params.delete('customerId');
    const query = params.toString();
    routerRef.current.replace(query ? `/offers?${query}` : '/offers');
  }, [searchParams]);
  const handleCreateOfferClick = useCallback(() => {
    routerRef.current.push('/offers/create');
  }, []);
  const toggleVersionGroup = useCallback((groupId: number | null) => {
    if (!groupId) return;
    const api = gridApiRef.current;
    if (api && !api.isDestroyed?.() && typeof api.getColumnState === 'function') {
      const columnState = api.getColumnState();
      pendingColumnStateRestoreRef.current = Array.isArray(columnState) && columnState.length > 0
        ? columnState.map((entry) => ({ ...entry }))
        : null;
    }
    setExpandedVersionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);
  const expandedVersionGroupIds = useMemo(
    () => Array.from(expandedVersionGroups),
    [expandedVersionGroups],
  );

  const restorePendingColumnState = useCallback((api: GridApi<Record<string, unknown>> | null) => {
    if (!api || api.isDestroyed?.()) return;
    const state = pendingColumnStateRestoreRef.current;
    if (!state || state.length === 0) return;
    try {
      api.applyColumnState({
        state,
        applyOrder: true,
      });
    } catch {
      /* noop */
    } finally {
      pendingColumnStateRestoreRef.current = null;
    }
  }, []);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    api.refreshCells?.({ columns: ['OfferVersion'], force: true });
    api.refreshServerSide?.({ purge: false });
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => restorePendingColumnState(api));
    } else {
      setTimeout(() => restorePendingColumnState(api), 0);
    }
  }, [expandedVersionGroups, restorePendingColumnState]);

  const handleModelUpdated = useCallback((api: GridApi<Record<string, unknown>>) => {
    restorePendingColumnState(api);
  }, [restorePendingColumnState]);
  const handleCreateNewVersion = useCallback(async (offerId: number | null) => {
    if (offerId == null) return;
    const encodedId = encodeURIComponent(String(offerId));
    try {
      const response = await fetch(`/api/offers/${encodedId}/duplicate`, {
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
      routerRef.current.push(`/offers/${encodeURIComponent(String(payload.offerId))}/basicdata`);
    } catch (err) {
      console.error('Failed to create offer version', err);
      showToastMessage('Unable to create new version', 'error');
    }
  }, []);
  const handleCreateOfferCopy = useCallback(async (offerId: number | null) => {
    if (offerId == null) return;
    const encodedId = encodeURIComponent(String(offerId));
    try {
      const response = await fetch(`/api/offers/${encodedId}/duplicate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'copy' }),
      });
      let payload: { ok?: boolean; error?: string; offerId?: number | string } | null = null;
      try {
        payload = (await response.json()) as { ok?: boolean; error?: string; offerId?: number | string };
      } catch {
        payload = null;
      }
      if (!response.ok || !payload?.ok || payload.offerId == null) {
        const message = payload?.error ?? 'Unable to create offer copy';
        showToastMessage(message, 'error');
        return;
      }
      showToastMessage('Created offer copy', 'success');
      routerRef.current.push(`/offers/${encodeURIComponent(String(payload.offerId))}/basicdata`);
    } catch (err) {
      console.error('Failed to create offer copy', err);
      showToastMessage('Unable to create offer copy', 'error');
    }
  }, []);

  const handleViewStatusHistory = useCallback((offerId: number | null) => {
    if (offerId == null) return;
    setStatusHistoryOfferId(offerId);
    setStatusHistoryModalOpen(true);
  }, []);

  const handleCloseStatusHistory = useCallback(() => {
    setStatusHistoryModalOpen(false);
    setStatusHistoryOfferId(null);
  }, []);

  const offersRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: '/api/offers',
        dataEndpoint: '/api/offers',
        idField: 'offerId',
        resolveRowId: (row) =>
          normalizeOfferIdValue((row as { offerId?: unknown } | null | undefined)?.offerId ?? null),
        resolveRowLabel: (row, fallback) =>
          resolveOfferRowLabel(
            row as { Description?: string | null; Title?: string | null } | null,
            fallback,
          ),
        resolveRowTypeLabel: () => OFFER_ROW_TYPE_LABEL,
        buildPayload: (ids) => ({ OfferIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? 'Delete offer' : 'Delete offers'),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? 'Delete offer' : 'Delete offers'),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? 'Keep offer' : 'Keep offers'),
        successToastMessage: 'Offer deleted',
        failureToastMessage: 'Unable to delete offer. Please try again.',
        canDelete: (count, rows) => {
          const hasRowData = rows != null && rows.length > 0 && rows.some((row) => row != null);
          const isCreator = hasRowData && userId != null && rows!.every((row) => {
            const createdBy = (row as { CreatedByUserId?: string | number | null } | null)?.CreatedByUserId;
            return createdBy != null && String(createdBy) === String(userId);
          });
          // When row data is unavailable (e.g. delete-all), skip client-side creator check — server enforces it
          const options = hasRowData ? { isCreator } : { isCreator: true };
          const result = checkDeletePermissionForClient(roles, count, 'offers', 'editOffers', options);
          if (!result.allowed) {
            console.warn('[FastQuote] Offer delete blocked:', { reason: result.reason, isCreator, userId, roles, count, firstRowCreatedBy: rows?.[0] ? (rows[0] as Record<string, unknown>).CreatedByUserId : undefined });
          }
          return result;
        },
      }),
    [roles, userId],
  );

  const offersContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const baseItems = offersRowDeletion.getContextMenuItems(params);
      const items = Array.isArray(baseItems) ? [...baseItems] : [];
      const clickedOfferId = normalizeOfferIdValue(
        (params.node?.data as { offerId?: unknown } | null | undefined)?.offerId ?? null,
      );
      if (!clickedOfferId) {
        return items;
      }

      const encodedOfferId = encodeURIComponent(String(clickedOfferId));
      const basicDataHref = `/offers/${encodedOfferId}/basicdata`;
      const productsHref = `/offers/${encodedOfferId}/products`;
      const basicDataIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';
      const productsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>';
      const newTabIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>';
      const viewBasicDataItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Basic Data',
        icon: basicDataIcon,
        action: () => { routerRef.current.push(basicDataHref); },
        subMenu: [
          { name: 'Open', icon: basicDataIcon, action: () => { routerRef.current.push(basicDataHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(basicDataHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };
      const viewProductsItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Products',
        icon: productsMenuIcon,
        action: () => { routerRef.current.push(productsHref); },
        subMenu: [
          { name: 'Open', icon: productsMenuIcon, action: () => { routerRef.current.push(productsHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(productsHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };
      items.unshift(viewBasicDataItem, viewProductsItem, 'separator');

      const customerId = normalizeOfferIdValue(
        (params.node?.data as { CustomerID?: unknown } | null | undefined)?.CustomerID ?? null,
      );

      const viewCustomerMenuItem: MenuItemDef<Record<string, unknown>> | null = customerId != null
        ? {
            name: 'View Customer',
            icon: viewCustomerMenuIcon,
            action: () => {
              routerRef.current.push(`/customers/${customerId}/basicdata`);
            },
          }
        : null;

      const statusHistoryMenuItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View offer\'s status history',
        icon: historyMenuIcon,
        action: () => {
          void handleViewStatusHistory(clickedOfferId);
        },
      };

      const versionMenuItem: MenuItemDef<Record<string, unknown>> = {
        name: 'Create new version',
        icon: duplicateVersionMenuIcon,
        action: () => {
          void handleCreateNewVersion(clickedOfferId);
        },
      };
      const copyMenuItem: MenuItemDef<Record<string, unknown>> = {
        name: 'Create copy of offer',
        icon: duplicateOfferMenuIcon,
        action: () => {
          void handleCreateOfferCopy(clickedOfferId);
        },
      };

      const customItems: Array<MenuItemDef<Record<string, unknown>>> = [
        ...(viewCustomerMenuItem ? [viewCustomerMenuItem] : []),
        statusHistoryMenuItem,
        copyMenuItem,
        versionMenuItem,
      ];

      const deleteIndex = items.findIndex((item) => (
        typeof item === 'object'
        && item
        && typeof item.name === 'string'
        && item.name.trim().toLowerCase().startsWith('delete')
      ));
      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, ...customItems);
      } else {
        const separatorIndex = items.lastIndexOf('separator');
        if (separatorIndex >= 0) {
          items.splice(separatorIndex + 1, 0, ...customItems);
        } else {
          if (items.length > 0 && items[items.length - 1] !== 'separator') {
            items.push('separator');
          }
          items.push(...customItems);
        }
      }

      return items;
    },
    [offersRowDeletion, handleCreateNewVersion, handleCreateOfferCopy, handleViewStatusHistory],
  );

  const formatDateDMY = (value: unknown): string => {
  if (!value) return '';

  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '';

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  return `${day}/${month}/${year}`;
};

  const formatLastModifiedValue = (value: unknown): string => {
    if (value == null || value === '') return '-';
    return formatDateTime(value as string | Date);
  };

  const OfferVersionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const data = params.data as Record<string, unknown> | null | undefined;
    const versionValue = params.value ?? data?.OfferVersion ?? '';
    const groupId = normalizeOfferIdValue(data?.VersionGroupId ?? null);
    const isLatest = data?.IsLatestVersion === 1 || data?.IsLatestVersion === true || data?.IsLatestVersion === 'true';
    const hasOtherVersions = data?.HasOtherVersions === 1
      || data?.HasOtherVersions === true
      || data?.HasOtherVersions === 'true';
    const isExpanded = groupId != null && expandedVersionGroupsRef.current.has(groupId);
    const showToggle = Boolean(groupId) && isLatest && hasOtherVersions;
    const isHistorical = Boolean(groupId) && !isLatest;

    return (
      <div className={styles.versionCell}>
        {showToggle ? (
          <button
            type="button"
            className={`${styles.versionToggle} ${isExpanded ? styles.versionToggleExpanded : ''}`.trim()}
            aria-label={isExpanded ? 'Collapse versions' : 'Expand versions'}
            title={isExpanded ? 'Collapse versions' : 'Expand versions'}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleVersionGroup(groupId ?? null);
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            ▸
          </button>
        ) : (
          <span className={styles.versionToggleSpacer} />
        )}
        <span className={`${styles.versionValue} ${isHistorical ? styles.versionValueMuted : ''}`}>
          {versionValue ?? ''}
        </span>
      </div>
    );
  }, [toggleVersionGroup]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (field !== 'Probability') return;
    if (event.newValue === event.oldValue) return;
    const offerId = normalizeOfferIdValue(
      (event.data as { offerId?: unknown } | undefined)?.offerId ?? null,
    );
    if (offerId == null) return;
    const normalizedValue = normalizeProbability(event.newValue);
    const label = 'Probability';

    const revertValue = () => {
      if (event.node) {
        try {
          event.node.setDataValue(field, event.oldValue);
          return;
        } catch {
          /* noop */
        }
      }
      event.api.refreshCells({ force: true });
    };

    if (normalizedValue == null) {
      showToastMessage('Probability must be an integer value.', 'error');
      revertValue();
      return;
    }

    if (event.node && event.node.data) {
      (event.node.data as Record<string, unknown>).Probability = normalizedValue;
    }

    const submit = async () => {
      try {
        const res = await fetch('/api/offers', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferID: offerId, field, value: normalizedValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        showToastMessage(`${label} updated`, 'success');
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, 'error');
        revertValue();
      }
    };

    void submit();
  }, []);

  const columnDefs: ColDef[] = useMemo(() => [
    { field: 'ERPProjectCode', headerName: 'ERP Project Code', filter: 'agTextColumnFilter' },
    { field: 'ERPFWCProjectShortName', headerName: 'ERP FWC Project', filter: 'agTextColumnFilter' },
    { field: 'CustomerName', headerName: 'Customer Name', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerID', headerName: 'Customer ID', filter: 'agNumberColumnFilter', type: 'numericColumn', hide: true },
    {
      field: 'Description',
      headerName: 'Description',
      filter: 'agTextColumnFilter',
      comparator: localeStringComparator,
    },
    {
      field: 'OfferVersion',
      headerName: 'Offer Version',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      cellRenderer: OfferVersionCell,
      suppressNavigable: true,
    },
    {
      field: 'ModifiedOn',
      headerName: 'Last Modified (You)',
      width: 180,
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatLastModifiedValue(params.value),
      filterParams: {
        browserDatePicker: false,
        minValidYear: 2000,
      },
    },
    {
      field: 'ModifiedOnAny',
      headerName: 'Last Modified',
      width: 180,
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatLastModifiedValue(params.value),
      filterParams: {
        browserDatePicker: false,
        minValidYear: 2000,
      },
    },
    { field: 'OfferStatus', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerGroup', headerName: 'Customer Group', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesPerson', headerName: 'Sales Person', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesMarket', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesDivision', headerName: 'Sales Division', filter: 'agSetColumnFilter', filterParams: { values: ['AVS', 'TVS'] }, enableRowGroup: true },
    {
      field: 'Probability',
      headerName: 'Probability',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: true,
      valueSetter: (params) => {
        const normalizedValue = normalizeProbability(params.newValue);
        if (normalizedValue == null) return false;
        params.data = params.data ?? {};
        (params.data as Record<string, unknown>).Probability = normalizedValue;
        return true;
      },
    },
    { field: 'SalesCreationPerson', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter', enableRowGroup: true },
    {
      field: 'OfferDate',
      headerName: 'Offer Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: {
        browserDatePicker: false,
        minValidYear: 2000,
      }
    },
    {
      field: 'CreatedOn',
      headerName: 'Created On',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: {
        browserDatePicker: false,
        minValidYear: 2000,
      },
    },
    { field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter', enableRowGroup: true, hide: true },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter', width: 210 },
    {field: 'Comments',  headerName: 'Telmaco Note', filter: 'agTextColumnFilter'},
{ field: 'OfferContact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    {
      field: 'Enabled',
      headerName: 'Enabled',
      filter: 'agSetColumnFilter',
      valueFormatter: (params) => formatEnabledValue(params.value),
      filterParams: {
        values: ['true', 'false'],
        valueFormatter: (params: { value?: unknown }) => formatEnabledValue(params.value),
        comparator: (valueA: string, valueB: string) => (valueA === valueB ? 0 : valueA === 'true' ? -1 : 1),
      },
    },
    { field: 'CustomerRef', headerName: 'Customer Ref', filter: 'agTextColumnFilter', hide: true },
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agNumberColumnFilter', type: 'numericColumn', hide: true },
    { field: 'PaymentTerms', headerName: 'Payment Terms', filter: 'agTextColumnFilter', hide: true },
    { field: 'InstallationSchedule', headerName: 'Installation Schedule', filter: 'agTextColumnFilter', hide: true },
    { field: 'OfferNotesClosing', headerName: 'Offer Notes Closing', filter: 'agTextColumnFilter', hide: true },
    { field: 'OfferValidity', headerName: 'Offer Validity', filter: 'agTextColumnFilter', hide: true },
    { field: 'DeliveryTime', headerName: 'Delivery Time', filter: 'agTextColumnFilter', hide: true },
    { field: 'OfferNotesIntroduction', headerName: 'Offer Notes Introduction', filter: 'agTextColumnFilter', hide: true },
    { field: 'ContactFullName', headerName: 'Contact Full Name', filter: 'agTextColumnFilter', hide: true },
    { field: 'ApprovalUserName', headerName: 'Approval User', filter: 'agTextColumnFilter', hide: true },
    {
      field: 'DraftRequestDate',
      headerName: 'Draft Request Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
      hide: true,
    },
    {
      field: 'DraftOfferDate',
      headerName: 'Draft Offer Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
      hide: true,
    },
    {
      field: 'RequestDate',
      headerName: 'Request Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
      hide: true,
    },
    {
      field: 'OfferDeadlineDate',
      headerName: 'Offer Deadline Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
      hide: true,
    },
    {
      field: 'OrderSignedDate',
      headerName: 'Order Signed Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
      hide: true,
    },
    {
      field: 'DeliveryDueDate',
      headerName: 'Delivery Due Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
      hide: true,
    },
  ], [OfferVersionCell]);

  return (
    <main className={styles.page}>
        <PageHeader
          title="Offers"
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.primaryButton} page-header-button`}
                onClick={handleCreateOfferClick}
              >
                Create Offer
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            {customerFilterActive ? (
              <ClearCustomerFilterPortalButton
                label={customerFilterLabel}
                onClear={handleClearCustomerFilter}
              />
            ) : null}
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/offers"
                columnDefs={columnDefs}
                getContextMenuItems={offersContextMenuItems}
                onGridReady={handleGridReady}
                onModelUpdated={handleModelUpdated}
                onCellValueChanged={handleCellEdit}
                requestPayload={{ expandedVersionGroupIds: expandedVersionGroupIds }}
                suppressColumnMoveAnimation
                rowGroupPanelShow="always"
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
        <OfferStatusHistoryModal
          open={statusHistoryModalOpen}
          offerId={statusHistoryOfferId ? String(statusHistoryOfferId) : ''}
          onClose={handleCloseStatusHistory}
        />
    </main>
  );
}
