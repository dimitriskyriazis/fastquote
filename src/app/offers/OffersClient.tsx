"use client";

import React, { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import styles from './OffersClient.module.css';
const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});
import type { ColDef, ICellRendererParams, GetContextMenuItemsParams, GridApi } from 'ag-grid-community';
import { createPortal } from 'react-dom';
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from '../components/actionMenuMarkers';
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from '../components/useActionMenuCoordinator';
import { useActionMenuPosition } from '../components/useActionMenuPosition';
import { GridRowDeletion } from '../../lib/gridRowDeletion';
import PageHeader from '../components/PageHeader';
import { GridQuickSearchProvider } from '../components/GridQuickSearchProvider';

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === 'true') return 'Yes';
  if (value === 0 || value === false || value === 'false') return 'No';
  return value == null ? '' : String(value);
};

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

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api || defaultEnabledFilterAppliedRef.current) return;
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

  const handleViewMarketsClick = useCallback(() => {
    router.push('/markets');
  }, [router]);

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
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      offersRowDeletion.getContextMenuItems(params),
    [offersRowDeletion],
  );

  const formatDateDMY = (value: unknown): string => {
  if (!value) return '';

  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '';

  // dd/mm/yyyy
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  return `${day}/${month}/${year}`;
};

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    // A small React component for the action menu
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
      const navigateTo = (suffix: 'products' | 'basicdata') => {
        if (!encodedId) return;
        setOpen(false);
        router.push(`/offers/${encodedId}/${suffix}`);
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

      // No native listeners needed; React capture handler on the button is sufficient

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
                navigateTo('basicdata');
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
                navigateTo('products');
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
        maxWidth: 52,
        minWidth: 44,
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
    { field: 'ProjectID', headerName: 'Project ID', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    {
      field: 'Comments',
      headerName: 'Comments',
      filter: 'agTextColumnFilter',
      flex: 1,
      minWidth: 220,
      suppressAutoSize: true,
    },
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    { field: 'OfferContact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    { field: 'OfferDate', headerName: 'Offer Date', filter: 'agDateColumnFilter', valueFormatter: (params) => formatDateDMY(params.value),
       width: 107, minWidth: 107, maxWidth: 107, suppressAutoSize: true },
    { field: 'OfferVersion', headerName: 'Offer Version', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    {
      field: 'Enabled',
      headerName: 'Enabled',
      filter: 'agSetColumnFilter',
      valueFormatter: (params) => formatEnabledValue(params.value),
      filterParams: {
        values: ['true', 'false'],
        valueFormatter: (params: { value?: unknown }) => formatEnabledValue(params.value),
        comparator: (valueA: string, valueB: string) => (valueA === valueB ? 0 : valueA === 'true' ? -1 : 1),
        buttons: ['apply'],
        closeOnApply: true,
      },
    },
  ], [ActionCell]);

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
                suppressRowGroup
                rowGroupPanelShow="never"
                suppressMovableColumns
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
    </main>
  );
}
