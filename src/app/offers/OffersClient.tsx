"use client";

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type {
  ColDef,
  ICellRendererParams,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
} from 'ag-grid-community';
import { createPortal } from 'react-dom';
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from '../components/actionMenuMarkers';
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from '../components/useActionMenuCoordinator';
import { useActionMenuPosition } from '../components/useActionMenuPosition';
import { GridRowDeletion } from '../../lib/gridRowDeletion';
import PageHeader from '../components/PageHeader';
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

export default function OffersClient() {
  const router = useRouter();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const [expandedVersionGroups, setExpandedVersionGroups] = useState<Set<number>>(new Set());
  const [statusHistoryModalOpen, setStatusHistoryModalOpen] = useState(false);
  const [statusHistoryOfferId, setStatusHistoryOfferId] = useState<number | null>(null);

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api || defaultEnabledFilterAppliedRef.current) return;
    gridApiRef.current = api;
    const existingModel = api.getFilterModel() as Record<string, unknown> | null;
    const nextModel = existingModel && typeof existingModel === 'object' ? { ...existingModel } : {};
    if ('Enabled' in nextModel) {
      defaultEnabledFilterAppliedRef.current = true;
      return;
    }
    api.setFilterModel({
      ...nextModel,
      Enabled: { filterType: 'set', values: ['true'] },
    });
    defaultEnabledFilterAppliedRef.current = true;
  }, []);
  const handleCreateOfferClick = useCallback(() => {
    router.push('/offers/create');
  }, [router]);
  const toggleVersionGroup = useCallback((groupId: number | null) => {
    if (!groupId) return;
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

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    api.refreshServerSide?.({ purge: false });
  }, [expandedVersionGroups]);
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
      router.push(`/offers/${encodeURIComponent(String(payload.offerId))}/basicdata`);
    } catch (err) {
      console.error('Failed to create offer version', err);
      showToastMessage('Unable to create new version', 'error');
    }
  }, [router]);

  const handleViewMarketsClick = useCallback(() => {
    router.push('/markets');
  }, [router]);

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
      }),
    [],
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

      const customerId = normalizeOfferIdValue(
        (params.node?.data as { CustomerID?: unknown } | null | undefined)?.CustomerID ?? null,
      );

      const viewCustomerMenuItem: MenuItemDef<Record<string, unknown>> | null = customerId != null
        ? {
            name: 'View Customer',
            icon: viewCustomerMenuIcon,
            action: () => {
              router.push(`/customers/${customerId}/basicdata`);
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

      const customItems: Array<MenuItemDef<Record<string, unknown>>> = [
        ...(viewCustomerMenuItem ? [viewCustomerMenuItem] : []),
        statusHistoryMenuItem,
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
    [offersRowDeletion, handleCreateNewVersion, handleViewStatusHistory, router],
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

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const ActionMenu: React.FC = () => {
      const [open, setOpen] = useState(false);
      const closeMenu = useCallback(() => setOpen(false), []);
      const instanceId = useActionMenuCloseListener(closeMenu);
      const { buttonRef, menuRef, menuPos } = useActionMenuPosition(open);
      const id = params?.data?.offerId as string | number | undefined;
      const encodedId = id != null ? encodeURIComponent(String(id)) : '';

      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };
      const openInNewWindow = (suffix: 'products' | 'basicdata') => {
        if (!encodedId) return;
        const url = `/offers/${encodedId}/${suffix}`;
        setOpen(false);
        if (typeof window !== 'undefined') {
          window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        router.push(url);
      };

      useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
          if (!(e.target instanceof Node)) return setOpen(false);
          if (buttonRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
          setOpen(false);
        };
        window.addEventListener('click', onDocClick);
        return () => window.removeEventListener('click', onDocClick);
      }, [open, buttonRef, menuRef]);

      const lines = (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="3" y="10.5" width="10" height="1.5" rx="0.75" fill="currentColor"/>
        </svg>
      );

      return (
        <div
          className={styles.actionCell}
          {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            className={styles.actionButton}
            {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
            onClick={(event) => {
              event.stopPropagation();
              if (!open) {
                dispatchActionMenuCloseEvent(instanceId);
              }
              setOpen((v) => !v);
            }}
            onMouseDownCapture={preventRangeSelection}
            onPointerDownCapture={preventRangeSelection}
            onContextMenuCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
            disabled={!encodedId}
            title={encodedId ? 'Open menu' : 'Missing offer ID'}
            ref={buttonRef}
          >
            {lines}
          </button>
          {open && menuPos && createPortal(
            <div
              role="menu"
              className={styles.actionMenu}
              style={{ top: menuPos.top, left: menuPos.left }}
              ref={menuRef}
              {...{ [ACTION_MENU_PANEL_ATTRIBUTE]: 'true' }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
            <button
              type="button"
              role="menuitem"
              className={styles.actionMenuItem}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openInNewWindow('basicdata');
              }}
            >
              View Basic Data
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.actionMenuItem}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openInNewWindow('products');
              }}
            >
              View Products
            </button>
            </div>,
            document.body
          )}
        </div>
      );
    };

    return <ActionMenu />;
  }, [router]);

  const OfferVersionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const data = params.data as Record<string, unknown> | null | undefined;
    const versionValue = params.value ?? data?.OfferVersion ?? '';
    const groupId = normalizeOfferIdValue(data?.VersionGroupId ?? null);
    const isLatest = data?.IsLatestVersion === 1 || data?.IsLatestVersion === true || data?.IsLatestVersion === 'true';
    const hasOtherVersions = data?.HasOtherVersions === 1
      || data?.HasOtherVersions === true
      || data?.HasOtherVersions === 'true';
    const isExpanded = groupId != null && expandedVersionGroups.has(groupId);
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
  }, [expandedVersionGroups, toggleVersionGroup]);

  const columnDefs: ColDef[] = useMemo(() => [
      {
        headerName: '',
        field: '__actions__',
        pinned: 'left',
        lockPinned: true,
        lockPosition: true,
        suppressNavigable: true,
        resizable: false,
        sortable: false,
        filter: false,
        suppressMovable: true,
        suppressSizeToFit: true,
        suppressColumnsToolPanel: true,
        width: 48,
        cellClass: styles.actionCellContainer,
        cellRenderer: ActionCell,
      },
    {
      field: 'Description',
      headerName: 'Description',
      filter: 'agTextColumnFilter',
      comparator: localeStringComparator,
    },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter' },
    { field: 'CustomerName', headerName: 'Customer Name', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesMarket', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesDivision', headerName: 'Sales Division', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesPerson', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'OfferStatus', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'ERPProjectID', headerName: 'ERP Project ID', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    { field: 'ERPFWCProjectShortName', headerName: 'ERP FWC Project', filter: 'agTextColumnFilter' },
    {field: 'Comments',  headerName: 'Comments', filter: 'agTextColumnFilter'},
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    { field: 'OfferContact', headerName: 'Contact', filter: 'agTextColumnFilter' },
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
      field: 'ModifiedOn',
      headerName: 'Last Modified',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatLastModifiedValue(params.value),
      filterParams: { 
        browserDatePicker: false, 
        minValidYear: 2000,
      },
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
  ], [ActionCell, OfferVersionCell]);

  return (
    <main className={styles.page}>
        <PageHeader
          title="Offers"
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.primaryButton} page-header-button`}
                onClick={handleViewMarketsClick}
              >
                View Markets
              </button>
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
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/offers"
                columnDefs={columnDefs}
                getContextMenuItems={offersContextMenuItems}
                onGridReady={handleGridReady}
                requestPayload={{ expandedVersionGroupIds: expandedVersionGroupIds }}
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
