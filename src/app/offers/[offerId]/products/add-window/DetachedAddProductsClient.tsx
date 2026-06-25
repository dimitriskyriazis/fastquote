'use client';

import React, { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const AddProductsModal = dynamic(() => import('../AddProductsModal'), { ssr: false });

const DETACH_MSG_ADDED = 'fastquote:detached-add-products:added';

type PlacementAnchor = {
  label: string;
  treeOrdering: string;
  isRequested: boolean;
  offerDetailId?: number;
  parentPath?: number[];
  requestedBrand?: string | null;
  requestedPartNo?: string | null;
  requestedModelNo?: string | null;
  requestedDescription?: string | null;
};

type DetachContext = {
  placementAnchor: PlacementAnchor | null;
  defaultPlacementMode: 'fill' | 'below';
  initialRequestedRowId: number | null;
  isStandardPackage: boolean;
  showRequestedColumns: boolean;
};

const readContext = (offerId: string): DetachContext => {
  const fallback: DetachContext = {
    placementAnchor: null,
    defaultPlacementMode: 'fill',
    initialRequestedRowId: null,
    isStandardPackage: false,
    showRequestedColumns: true,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.sessionStorage.getItem(`fastquote-detached-add-products:${offerId}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DetachContext>;
    return {
      placementAnchor: parsed.placementAnchor ?? null,
      defaultPlacementMode: parsed.defaultPlacementMode === 'below' ? 'below' : 'fill',
      initialRequestedRowId: typeof parsed.initialRequestedRowId === 'number' ? parsed.initialRequestedRowId : null,
      isStandardPackage: Boolean(parsed.isStandardPackage),
      showRequestedColumns: parsed.showRequestedColumns !== false,
    };
  } catch {
    return fallback;
  }
};

type Props = {
  offerId: string;
};

export default function DetachedAddProductsClient({ offerId }: Props) {
  const [context] = useState<DetachContext>(() => readContext(offerId));
  const [placementAnchor, setPlacementAnchor] = useState<PlacementAnchor | null>(context.placementAnchor);
  const [placementMode, setPlacementMode] = useState<'fill' | 'below'>(context.defaultPlacementMode);
  const [initialRequestedRowId, setInitialRequestedRowId] = useState<number | null>(context.initialRequestedRowId);

  const postToOpener = useCallback((payload: Record<string, unknown>) => {
    if (typeof window === 'undefined') return;
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) return;
    try {
      opener.postMessage(payload, window.location.origin);
    } catch {
      /* noop */
    }
  }, []);

  const handleAdded = useCallback((count: number, insertedOfferDetailIds?: number[]) => {
    postToOpener({
      type: DETACH_MSG_ADDED,
      offerId,
      count,
      insertedOfferDetailIds: insertedOfferDetailIds ?? [],
    });
    setPlacementAnchor(null);
    setPlacementMode('fill');
    setInitialRequestedRowId(null);
  }, [offerId, postToOpener]);

  const handleClose = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.close();
    }
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Add Products - Offer ${offerId}`;
    return () => {
      document.title = previousTitle;
    };
  }, [offerId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.removeItem(`fastquote-detached-add-products:${offerId}`);
    } catch {
      /* noop */
    }
  }, [offerId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        anchor?: PlacementAnchor | null;
        defaultPlacementMode?: 'fill' | 'below';
        initialRequestedRowId?: number | null;
      } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'fastquote:detached-add-products:anchor') return;
      setPlacementAnchor(data.anchor ?? null);
      setPlacementMode(data.defaultPlacementMode === 'below' ? 'below' : 'fill');
      setInitialRequestedRowId(
        typeof data.initialRequestedRowId === 'number' ? data.initialRequestedRowId : null,
      );
      try { window.focus(); } catch { /* noop */ }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const notifyClose = () => {
      postToOpener({ type: 'fastquote:detached-add-products:closed', offerId });
    };
    window.addEventListener('beforeunload', notifyClose);
    window.addEventListener('pagehide', notifyClose);
    return () => {
      window.removeEventListener('beforeunload', notifyClose);
      window.removeEventListener('pagehide', notifyClose);
    };
  }, [offerId, postToOpener]);

  return (
    <>
      {/* Override layout chrome + pin inner modal card to 100vh so the
          products grid can fill the full popup window. */}
      <style>{`
        html, body { height: 100%; margin: 0; overflow: hidden; background: #f8fafc; }
        .side-nav { display: none !important; }
        .app-shell, .app-content { min-height: 0 !important; height: 100vh !important; overflow: hidden !important; }
        .fastquote-detached-root {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          display: flex;
          flex-direction: column;
          background: #f8fafc;
          z-index: 2147483640;
        }
        /* Force the AddProductsModal's split-view chain to fill the whole popup.
           CSS-modules produce hashed class names, so match on substring. */
        .fastquote-detached-root > [role='dialog'],
        .fastquote-detached-root [class*='splitViewContainer'],
        .fastquote-detached-root [class*='splitViewCard'] {
          flex: 1 1 auto !important;
          min-height: 0 !important;
          height: 100% !important;
          max-height: 100% !important;
          width: 100% !important;
          display: flex !important;
          flex-direction: column !important;
        }
        .fastquote-detached-root [class*='_body'],
        .fastquote-detached-root [class*='_section'],
        .fastquote-detached-root [class*='_sectionInner'],
        .fastquote-detached-root [class*='_productsColumn'],
        .fastquote-detached-root [class*='_productsGridShell'] {
          flex: 1 1 auto !important;
          min-height: 0 !important;
          height: auto !important;
          width: 100% !important;
        }
        .fastquote-detached-root .ag-theme-quartz {
          flex: 1 1 auto !important;
          min-height: 0 !important;
          height: 100% !important;
          width: 100% !important;
        }
      `}</style>
      <div className="fastquote-detached-root">
        <AddProductsModal
          offerId={offerId}
          onClose={handleClose}
          onAdded={handleAdded}
          splitViewMode
          standardPackageMode={context.isStandardPackage}
          showRequestedColumns={context.showRequestedColumns}
          placementAnchor={placementAnchor}
          defaultPlacementMode={placementMode}
          onPlacementModeChange={setPlacementMode}
          initialRequestedRowId={initialRequestedRowId}
          onInitialRequestedRowConsumed={() => setInitialRequestedRowId(null)}
        />
      </div>
    </>
  );
}
