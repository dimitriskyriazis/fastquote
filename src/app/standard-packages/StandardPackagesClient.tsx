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
  CellValueChangedEvent,
} from 'ag-grid-community';
import { GridRowDeletion } from '../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../lib/deletePermissions';
import { useAuditUser } from '../components/AuditUserProvider';
import PageHeader from '../components/PageHeader';
import { GridQuickSearchProvider } from '../components/GridQuickSearchProvider';
import LookupModal from '../components/LookupModal';
import lookupStyles from '../components/LookupModal.module.css';
import { formatDateTime } from '../lib/formatDateTime';
import { showToastMessage } from '../../lib/toast';
import { useUndoStack } from '../hooks/useUndoStack';
import { pushCellEditUndo, makePatternAUndoFn } from '../../lib/undoHelpers';
import styles from './StandardPackagesClient.module.css';

const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid...
    </div>
  ),
});

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === 'true') return 'Yes';
  if (value === 0 || value === false || value === 'false') return 'No';
  if (value === 'Yes' || value === 'No') return value;
  return value == null ? '' : String(value);
};

const normalizeEnabled = (value: unknown): boolean | null => {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'Yes') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'No') return false;
  return null;
};

const duplicateVersionMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 5h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M7 7V5a2 2 0 0 1 2-2h6" />
    </svg>
  </span>
`;

const duplicatePackageMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <rect x="4" y="4" width="11" height="11" rx="2" />
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

const resolveRowLabel = (
  row: { Description?: string | null } | null,
  fallback: string,
) => {
  if (!row) return fallback;
  const description = typeof row.Description === 'string' ? row.Description.trim() : '';
  if (description) return description;
  return fallback;
};

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

type EditableField = 'Description' | 'Comments' | 'Enabled';
type CreateStandardPackageResponse = {
  ok?: boolean;
  error?: string;
  offerId?: number | string;
};

export default function StandardPackagesClient() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { roles, userId } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const [expandedVersionGroups, setExpandedVersionGroups] = useState<Set<number>>(new Set());
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createDescription, setCreateDescription] = useState('');
  const [createComments, setCreateComments] = useState('');
  const [createEnabled, setCreateEnabled] = useState(true);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const expandedVersionGroupsRef = useRef<Set<number>>(expandedVersionGroups);
  expandedVersionGroupsRef.current = expandedVersionGroups;

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api) return;
    gridApiRef.current = api;
    if (defaultEnabledFilterAppliedRef.current) return;
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

  const resetCreateForm = useCallback(() => {
    setCreateDescription('');
    setCreateComments('');
    setCreateEnabled(true);
    setCreateError(null);
  }, []);

  useEffect(() => {
    if (!createModalOpen) {
      resetCreateForm();
    }
  }, [createModalOpen, resetCreateForm]);

  const openCreateModal = useCallback(() => {
    setCreateModalOpen(true);
  }, []);

  const closeCreateModal = useCallback(() => {
    if (createSaving) return;
    setCreateModalOpen(false);
  }, [createSaving]);

  const handleCreateStandardPackage = useCallback(async () => {
    const description = createDescription.trim();
    if (!description) {
      setCreateError('Description is required.');
      return;
    }

    setCreateSaving(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/standard-packages/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          comments: createComments.trim() || null,
          enabled: createEnabled,
        }),
      });
      const payload = (await response.json().catch(() => null)) as CreateStandardPackageResponse | null;
      if (!response.ok || !payload?.ok || payload.offerId == null) {
        throw new Error(payload?.error ?? 'Unable to create standard package.');
      }

      const capturedOfferId = payload.offerId;
      setCreateModalOpen(false);
      resetCreateForm();
      try {
        gridApiRef.current?.refreshServerSide?.({ purge: true });
      } catch {
        /* noop */
      }
      pushCellEditUndo(pushUndo, performUndo, `Standard package "${description}"`, async () => {
        const res = await fetch('/api/standard-packages', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ OfferIDs: [capturedOfferId] }),
        });
        const del = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (!res.ok || !del?.ok) throw new Error('Failed to delete standard package');
        try { gridApiRef.current?.refreshServerSide?.({ purge: true }); } catch { /* noop */ }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create standard package.';
      setCreateError(message);
    } finally {
      setCreateSaving(false);
    }
  }, [createComments, createDescription, createEnabled, resetCreateForm, pushUndo, performUndo]);

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
        const message = payload?.error ?? 'Unable to create new standard package version';
        showToastMessage(message, 'error');
        return;
      }
      showToastMessage('Created new standard package version', 'success');
      routerRef.current.push(`/offers/${encodeURIComponent(String(payload.offerId))}/products`);
    } catch (err) {
      console.error('Failed to create standard package version', err);
      showToastMessage('Unable to create new standard package version', 'error');
    }
  }, []);

  const handleCreatePackageCopy = useCallback(async (offerId: number | null) => {
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
        const message = payload?.error ?? 'Unable to create standard package copy';
        showToastMessage(message, 'error');
        return;
      }
      showToastMessage('Created standard package copy', 'success');
      routerRef.current.push(`/offers/${encodeURIComponent(String(payload.offerId))}/products`);
    } catch (err) {
      console.error('Failed to create standard package copy', err);
      showToastMessage('Unable to create standard package copy', 'error');
    }
  }, []);

  const standardPackageRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: '/api/standard-packages',
        dataEndpoint: '/api/standard-packages',
        idField: 'ID',
        resolveRowId: (row) =>
          normalizeOfferIdValue(
            (row as { ID?: unknown; offerId?: unknown } | null | undefined)?.ID
            ?? (row as { ID?: unknown; offerId?: unknown } | null | undefined)?.offerId
            ?? null,
          ),
        resolveRowLabel: (row, fallback) =>
          resolveRowLabel(
            row as { Description?: string | null } | null,
            fallback,
          ),
        resolveRowTypeLabel: () => 'standard package',
        buildPayload: (ids) => ({ OfferIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? 'Delete standard package' : 'Delete standard packages'),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? 'Delete standard package' : 'Delete standard packages'),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? 'Keep standard package' : 'Keep standard packages'),
        successToastMessage: 'Standard package deleted',
        failureToastMessage: 'Unable to delete standard package. Please try again.',
        canDelete: (count, rows) => {
          const hasRowData = rows != null && rows.length > 0 && rows.some((row) => row != null);
          const isCreator = hasRowData && userId != null && rows!.every((row) => {
            const createdBy = (row as { CreatedByUserId?: string | number | null } | null)?.CreatedByUserId;
            return createdBy != null && String(createdBy) === String(userId);
          });
          // When row data is unavailable (e.g. delete-all), skip client-side creator check — server enforces it
          const options = hasRowData ? { isCreator } : { isCreator: true };
          const result = checkDeletePermissionForClient(roles, count, 'standardPackages', 'editOffers', options);
          if (!result.allowed) {
            console.warn('[FastQuote] Standard package delete blocked:', { reason: result.reason, isCreator, userId, roles, count, firstRowCreatedBy: rows?.[0] ? (rows[0] as Record<string, unknown>).CreatedByUserId : undefined });
          }
          return result;
        },
      }),
    [roles, userId],
  );

  const standardPackagesContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const baseItems = standardPackageRowDeletion.getContextMenuItems(params);
      const items = Array.isArray(baseItems) ? [...baseItems] : [];
      const clickedOfferId = normalizeOfferIdValue(
        (params.node?.data as { ID?: unknown; offerId?: unknown } | null | undefined)?.ID
        ?? (params.node?.data as { ID?: unknown; offerId?: unknown } | null | undefined)?.offerId
        ?? null,
      );
      if (!clickedOfferId) {
        return items;
      }

      const encodedOfferId = encodeURIComponent(String(clickedOfferId));
      const productsHref = `/offers/${encodedOfferId}/products`;
      const productsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>';
      const newTabIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>';
      const viewProductsItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Products',
        icon: productsMenuIcon,
        action: () => { routerRef.current.push(productsHref); },
        subMenu: [
          { name: 'Open', icon: productsMenuIcon, action: () => { routerRef.current.push(productsHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(productsHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };
      items.unshift(viewProductsItem, 'separator');

      const versionMenuItem: MenuItemDef<Record<string, unknown>> = {
        name: 'Create new version',
        icon: duplicateVersionMenuIcon,
        action: () => {
          void handleCreateNewVersion(clickedOfferId);
        },
      };
      const copyMenuItem: MenuItemDef<Record<string, unknown>> = {
        name: 'Create copy of standard package',
        icon: duplicatePackageMenuIcon,
        action: () => {
          void handleCreatePackageCopy(clickedOfferId);
        },
      };

      const customItems: Array<MenuItemDef<Record<string, unknown>>> = [
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
    [handleCreateNewVersion, handleCreatePackageCopy, standardPackageRowDeletion],
  );

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
            {'>'}
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
    const field = event.colDef.field as EditableField | undefined;
    if (!field || !['Description', 'Comments', 'Enabled'].includes(field)) return;
    if (event.newValue === event.oldValue) return;
    const offerId = normalizeOfferIdValue(
      (event.data as { ID?: unknown; offerId?: unknown } | undefined)?.ID
      ?? (event.data as { ID?: unknown; offerId?: unknown } | undefined)?.offerId
      ?? null,
    );
    if (offerId == null) return;

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

    let value: unknown = event.newValue;
    if (field === 'Enabled') {
      const normalizedEnabled = normalizeEnabled(event.newValue);
      if (normalizedEnabled == null) {
        showToastMessage('Enabled must be Yes or No.', 'error');
        revertValue();
        return;
      }
      value = normalizedEnabled;
      if (event.node?.data) {
        (event.node.data as Record<string, unknown>).Enabled = normalizedEnabled;
      }
    }

    const label = field;
    const submit = async () => {
      try {
        const res = await fetch('/api/standard-packages', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferID: offerId, field, value }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${field}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: '/api/standard-packages',
          idField: 'OfferID',
          entityId: offerId,
          field,
          oldValue: event.oldValue,
          node: event.node,
          gridApi: event.api,
        }));
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${field}`, err);
        showToastMessage(`Unable to update ${field}. Please try again.`, 'error');
        revertValue();
      }
    };

    void submit();
  }, [pushUndo, performUndo]);

  const columnDefs: ColDef[] = useMemo(() => [
    {
      field: 'Description',
      headerName: 'Description',
      filter: 'agTextColumnFilter',
      editable: true,
      width: 400,
      comparator: localeStringComparator,
      valueSetter: (params) => {
        params.data = params.data ?? {};
        (params.data as Record<string, unknown>).Description = params.newValue;
        return true;
      },
    },
    {
      field: 'OfferVersion',
      headerName: 'Version',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      cellRenderer: OfferVersionCell,
      suppressNavigable: true,
    },
    {
      field: 'CreatedBy',
      headerName: 'Created By',
      filter: 'agTextColumnFilter',
    },
    {
      field: 'ModifiedBy',
      headerName: 'Last Modified By',
      filter: 'agTextColumnFilter',
    },
    {
      field: 'ModifiedOn',
      headerName: 'Last Modified On',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatLastModifiedValue(params.value),
      filterParams: {
        browserDatePicker: false,
        minValidYear: 2000,
      },
    },
    {
      field: 'Comments',
      headerName: 'Comments',
      filter: 'agTextColumnFilter',
      editable: true,
      width: 400,
      valueSetter: (params) => {
        params.data = params.data ?? {};
        (params.data as Record<string, unknown>).Comments = params.newValue;
        return true;
      },
    },
    {
      field: 'Enabled',
      headerName: 'Enabled',
      filter: 'agSetColumnFilter',
      editable: true,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: ['Yes', 'No'] },
      valueSetter: (params) => {
        const normalized = normalizeEnabled(params.newValue);
        if (normalized == null) return false;
        params.data = params.data ?? {};
        (params.data as Record<string, unknown>).Enabled = normalized;
        return true;
      },
      valueFormatter: (params) => formatEnabledValue(params.value),
      filterParams: {
        values: ['true', 'false'],
        valueFormatter: (params: { value?: unknown }) => formatEnabledValue(params.value),
        comparator: (valueA: string, valueB: string) => (valueA === valueB ? 0 : valueA === 'true' ? -1 : 1),
      },
    },
  ], [OfferVersionCell]);

  return (
    <main className={styles.page}>
      <PageHeader
        title="Standard Packages"
        leftActions={
          canUndo ? (
            <button
              type="button"
              className={`page-header-button`}
              onClick={performUndo}
            >
              ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
            </button>
          ) : undefined
        }
        rightActions={(
          <div className={styles.headerActions}>
            <button
              type="button"
              className={`${styles.primaryButton} page-header-button`}
              onClick={openCreateModal}
            >
              Create Standard Package
            </button>
          </div>
        )}
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/standard-packages"
              columnDefs={columnDefs}
              getContextMenuItems={standardPackagesContextMenuItems}
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              requestPayload={{ expandedVersionGroupIds: expandedVersionGroupIds }}
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
              allowMultiCellDeletion
            />
          </div>
        </GridQuickSearchProvider>
        <LookupModal
          open={createModalOpen}
          title="Create Standard Package"
          onClose={closeCreateModal}
          onConfirm={handleCreateStandardPackage}
          confirmLabel="Create"
          saving={createSaving}
          error={createError}
        >
          <div className={lookupStyles.fieldGrid}>
            <div className={lookupStyles.fieldFull}>
              <label className={lookupStyles.fieldLabel} htmlFor="standard-package-description">
                Description <span className={lookupStyles.requiredMark}>*</span>
              </label>
              <input
                id="standard-package-description"
                className={lookupStyles.fieldControl}
                value={createDescription}
                required
                onChange={(event) => setCreateDescription(event.target.value)}
              />
            </div>
            <div className={lookupStyles.fieldFull}>
              <label className={lookupStyles.fieldLabel} htmlFor="standard-package-comments">
                Comments
              </label>
              <textarea
                id="standard-package-comments"
                className={lookupStyles.fieldControl}
                rows={3}
                value={createComments}
                onChange={(event) => setCreateComments(event.target.value)}
              />
            </div>
            <div className={lookupStyles.fieldFull}>
              <label className={lookupStyles.fieldLabel} htmlFor="standard-package-enabled">
                Enabled
              </label>
              <label className={lookupStyles.checkboxLabel} htmlFor="standard-package-enabled">
                <input
                  id="standard-package-enabled"
                  type="checkbox"
                  checked={createEnabled}
                  onChange={(event) => setCreateEnabled(event.target.checked)}
                />
                Yes
              </label>
            </div>
          </div>
        </LookupModal>
      </PageHeader>
    </main>
  );
}
