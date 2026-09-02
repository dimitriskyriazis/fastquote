// Client-side orchestration for the add-weblinks feature, shared by the Products page,
// the price-list products page and the offer products panel.
//
// Flow: chunked search requests (with a progress toast) → review dialog (nothing is saved
// until the user approves) → chunked apply requests → summary toast + optional undo hook.
// Chunking keeps each HTTP request well under the IIS/proxy timeout and gives real progress
// feedback; the old single 200-product request regularly outlived both the 60s toast and
// the proxy, so the client reported failure while the server kept writing.

import {
  chunkArray,
  countProductsPerLink,
  isRealWebLink,
  normalizedUrlKey,
  type WebLinkStatus,
  type WebLinkVerification,
} from './webLinkResolution';
import { showToastMessage, showProgressToast } from './toast';
import { showConfirmDialog, showMultiChoiceDialog } from './confirm';
import { showWebLinkPreviewDialog, type WebLinkPreviewRow } from './webLinkPreviewDialog';

const ENDPOINT = '/api/products/add-weblinks';
// Sized <= the route's product semaphore so one chunk completes in a single wave,
// keeping each HTTP request well inside the IIS proxy timeout.
export const WEBLINK_CHUNK_SIZE = 10;
// Hard cap per run — mirrors the old client-side cap; chunking would technically allow
// more, but a single click must not be able to launch hours of API spend.
export const WEBLINK_MAX_PRODUCTS = 200;
const MAX_CONSECUTIVE_CHUNK_FAILURES = 2;

export type WebLinkSearchResult = {
  productId: number;
  brand: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  oldWebLink: string | null;
  webLink: string | null;
  status: WebLinkStatus;
  verification?: WebLinkVerification;
  note?: string;
};

type SearchOutcome = {
  results: WebLinkSearchResult[];
  /** True when chunk failures aborted the search early (auth error or repeated failures). */
  aborted: boolean;
};

const errorResult = (productId: number, note: string): WebLinkSearchResult => ({
  productId,
  brand: null,
  partNumber: null,
  modelNumber: null,
  oldWebLink: null,
  webLink: null,
  status: 'error',
  note,
});

async function searchWebLinks(
  productIds: number[],
  onProgress?: (done: number, total: number, found: number) => void,
): Promise<SearchOutcome> {
  const chunks = chunkArray(productIds, WEBLINK_CHUNK_SIZE);
  const results: WebLinkSearchResult[] = [];
  let consecutiveFailures = 0;
  let done = 0;

  for (const chunk of chunks) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // dryRun is required by the route: it proves this client speaks the
        // review-before-save contract (old bundles expected POST to write directly).
        body: JSON.stringify({ productIds: chunk, dryRun: true }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; results?: WebLinkSearchResult[] }
        | null;

      if (res.ok && data?.ok && Array.isArray(data.results)) {
        results.push(...data.results);
        consecutiveFailures = 0;
      } else {
        const note = data?.error ?? `Search failed (status ${res.status}).`;
        chunk.forEach((id) => results.push(errorResult(id, note)));
        if (res.status === 401 || res.status === 403) {
          return { results, aborted: true };
        }
        consecutiveFailures++;
      }
    } catch {
      chunk.forEach((id) => results.push(errorResult(id, 'Network error during search.')));
      consecutiveFailures++;
    }

    done += chunk.length;
    onProgress?.(done, productIds.length, results.filter((r) => r.status === 'previewed').length);

    if (consecutiveFailures >= MAX_CONSECUTIVE_CHUNK_FAILURES) {
      return { results, aborted: true };
    }
  }
  return { results, aborted: false };
}

async function applyWebLinks(
  items: Array<{ productId: number; webLink: string }>,
): Promise<{ updatedCount: number; errorCount: number; authFailed: boolean }> {
  let updatedCount = 0;
  let errorCount = 0;
  let consecutiveFailures = 0;
  const chunks = chunkArray(items, WEBLINK_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applyPrecomputed: chunk }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; updatedCount?: number; errorCount?: number }
        | null;
      if (res.ok && data?.ok) {
        updatedCount += data.updatedCount ?? 0;
        errorCount += data.errorCount ?? 0;
        consecutiveFailures = 0;
        continue;
      }
      errorCount += chunk.length;
      if (res.status === 401 || res.status === 403) {
        // Session expired — the remaining chunks are doomed; don't hammer the endpoint.
        errorCount += chunks.slice(i + 1).reduce((n, c) => n + c.length, 0);
        return { updatedCount, errorCount, authFailed: true };
      }
      consecutiveFailures++;
    } catch {
      errorCount += chunk.length;
      consecutiveFailures++;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_CHUNK_FAILURES) {
      errorCount += chunks.slice(i + 1).reduce((n, c) => n + c.length, 0);
      return { updatedCount, errorCount, authFailed: false };
    }
  }
  return { updatedCount, errorCount, authFailed: false };
}

/** Restores previous WebLink values (used for undo). Returns the number of reverted rows. */
export async function revertWebLinks(
  items: Array<{ productId: number; webLink: string | null }>,
): Promise<number> {
  let reverted = 0;
  for (const chunk of chunkArray(items, WEBLINK_CHUNK_SIZE)) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: chunk }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; revertedCount?: number } | null;
      if (res.ok && data?.ok) reverted += data.revertedCount ?? 0;
    } catch {
      /* keep reverting the remaining chunks */
    }
  }
  return reverted;
}

export type AddWebLinksFlowOptions = {
  productIds: number[];
  /** Called after links were written, so the caller can refresh its grid. */
  onApplied?: (appliedCount: number) => void;
  /** Called with a revert function after a successful apply, so the caller can
   *  register it in its undo system. */
  registerUndo?: (revert: () => Promise<number>, appliedCount: number) => void;
};

const STATUS_ORDER: Record<WebLinkStatus, number> = {
  previewed: 0,
  unverified: 1,
  not_found: 2,
  error: 3,
};

/**
 * Runs the full search → review → apply flow. The caller is responsible for any
 * pre-filtering (overwrite/skip-existing prompts) before passing productIds —
 * or use buildAddWebLinksMenuItem, which wires those prompts consistently.
 */
export async function runAddWebLinksFlow({
  productIds,
  onApplied,
  registerUndo,
}: AddWebLinksFlowOptions): Promise<void> {
  const ids = Array.from(new Set(productIds.filter((id) => Number.isInteger(id))));
  if (ids.length === 0) {
    showToastMessage('No products selected for web link lookup.', 'info');
    return;
  }
  if (ids.length > WEBLINK_MAX_PRODUCTS) {
    showToastMessage(
      `Cannot process more than ${WEBLINK_MAX_PRODUCTS} products at once. Please filter or select fewer rows.`,
      'error',
    );
    return;
  }

  const progress = showProgressToast(`Searching for web links… 0/${ids.length}`);
  const { results, aborted } = await searchWebLinks(ids, (done, total, found) => {
    progress.update(`Searching for web links… ${done}/${total} (${found} found)`);
  });
  progress.dismiss();

  // A row is reviewable if it has a proposed link — verified ("previewed") or bot-blocked
  // ("unverified", presented for manual confirmation). Both open the dialog.
  const isReviewable = (r: WebLinkSearchResult) =>
    (r.status === 'previewed' || r.status === 'unverified') && !!r.webLink;

  if (aborted) {
    const firstError = results.find((r) => r.status === 'error')?.note;
    showToastMessage(firstError ?? 'Web link search aborted after repeated errors.', 'error');
    if (!results.some(isReviewable)) return;
  }

  const sorted = [...results].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.productId - b.productId,
  );

  if (!sorted.some(isReviewable)) {
    const notFound = sorted.filter((r) => r.status === 'not_found').length;
    const errors = sorted.filter((r) => r.status === 'error').length;
    const parts = [
      notFound ? `${notFound} without a findable page` : null,
      errors ? `${errors} failed with errors` : null,
    ].filter(Boolean);
    showToastMessage(`No web links found. ${parts.join(', ')}.`, errors ? 'error' : 'info');
    return;
  }

  // One page proposed for several products means it identifies a family, not a model — whatever
  // tier it was verified at. Counted across the whole run, since the chunked server never sees it.
  const productsPerLink = countProductsPerLink(sorted);

  const previewRows: WebLinkPreviewRow[] = sorted.map((r) => {
    const sharedWith = r.webLink ? (productsPerLink.get(normalizedUrlKey(r.webLink)) ?? 1) : 1;
    return {
      label: `#${r.productId}`,
      brand: r.brand,
      partNumber: r.partNumber?.trim() || r.modelNumber?.trim() || null,
      oldLink: isRealWebLink(r.oldWebLink) ? r.oldWebLink : null,
      newLink: r.webLink,
      status: r.status,
      verification: r.verification,
      note: r.note,
      sharedWith,
    };
  });

  const selected = await showWebLinkPreviewDialog(previewRows);
  if (selected === false) {
    showToastMessage('Web link review cancelled, nothing was saved.', 'info');
    return;
  }

  const chosen = selected
    .map((i) => sorted[i])
    .filter(
      (r): r is WebLinkSearchResult & { webLink: string } =>
        (r?.status === 'previewed' || r?.status === 'unverified') && !!r.webLink,
    );
  if (chosen.length === 0) {
    showToastMessage('No links selected, nothing was saved.', 'info');
    return;
  }

  const undoItems = chosen.map((r) => ({ productId: r.productId, webLink: r.oldWebLink }));
  const dismissApply = showToastMessage(`Saving ${chosen.length} web link(s)…`, 'info', 600000);
  const applied = await applyWebLinks(chosen.map((r) => ({ productId: r.productId, webLink: r.webLink })));
  dismissApply();

  if (applied.authFailed) {
    showToastMessage(
      `Updated ${applied.updatedCount} web link(s) before the session expired. Please log in again and retry the rest.`,
      'error',
    );
  } else {
    const summaryParts = [
      `Updated ${applied.updatedCount} web link(s)`,
      applied.errorCount ? `${applied.errorCount} failed` : null,
    ].filter(Boolean);
    showToastMessage(summaryParts.join(', ') + '.', applied.errorCount ? 'warning' : 'success');
  }

  if (applied.updatedCount > 0) {
    onApplied?.(applied.updatedCount);
    registerUndo?.(() => revertWebLinks(undoItems), applied.updatedCount);
  }
}

// --- Shared context-menu item builder ------------------------------------------

/** Minimal structural type compatible with AG Grid's MenuItemDef, so this lib does not
 *  depend on ag-grid types. */
export type AddWebLinksMenuItem = {
  name: string;
  icon?: string;
  disabled?: boolean;
  action: () => Promise<void> | void;
};

export type BuildAddWebLinksMenuItemOptions = {
  /** Row data of the explicitly targeted rows (must carry ProductID and, when available, WebLink). */
  targetProducts: Array<Record<string, unknown>>;
  isSelectAllActive: boolean;
  /** Resolves every filtered product ID for the select-all path. */
  fetchAllFilteredProductIds: () => Promise<number[]>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  icon?: string;
  onApplied: (appliedCount: number) => void;
  registerUndo?: (revert: () => Promise<number>, appliedCount: number) => void;
};

const toProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

/**
 * Builds the "Add web link(s)" context-menu item with the shared pre-flow UX
 * (select-all confirmation, overwrite/skip prompt for rows that already have a real
 * link) so the three grid pages cannot drift apart. Returns null when there is
 * nothing to act on.
 */
export function buildAddWebLinksMenuItem({
  targetProducts,
  isSelectAllActive,
  fetchAllFilteredProductIds,
  busy,
  setBusy,
  icon,
  onApplied,
  registerUndo,
}: BuildAddWebLinksMenuItemOptions): AddWebLinksMenuItem | null {
  const targetIds = targetProducts
    .map((p) => toProductId(p.ProductID))
    .filter((id): id is number => id !== null);

  if (targetIds.length === 0 && !isSelectAllActive) return null;

  return {
    name: isSelectAllActive
      ? 'Add web links (all filtered)'
      : targetIds.length > 1
        ? `Add web links (${targetIds.length})`
        : 'Add web link',
    icon,
    disabled: busy,
    action: async () => {
      let idsToProcess: number[] = [];

      if (isSelectAllActive) {
        const confirmed = await showConfirmDialog({
          title: 'Search web links for all filtered products',
          message:
            'This will search for web links for all filtered rows. You will review the results before anything is saved.',
          confirmLabel: 'Continue',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
        try {
          idsToProcess = await fetchAllFilteredProductIds();
        } catch (err) {
          showToastMessage(err instanceof Error ? err.message : 'Failed to resolve selected products.', 'error');
          return;
        }
      } else {
        idsToProcess = [...targetIds];
        const productsWithLinks = targetProducts.filter((p) => isRealWebLink(p.WebLink));
        if (productsWithLinks.length > 0) {
          const choice = await showMultiChoiceDialog({
            title: 'Existing web links found',
            message:
              productsWithLinks.length === targetIds.length
                ? `All ${targetIds.length} selected product(s) already have a web link. Overwrite them?`
                : `${productsWithLinks.length} of ${targetIds.length} selected product(s) already have a web link.`,
            choices: [
              { label: 'Overwrite all', value: 'overwrite' },
              { label: 'Skip existing', value: 'skip' },
              { label: 'Cancel', value: 'cancel' },
            ],
          });
          if (!choice || choice === 'cancel') return;
          if (choice === 'skip') {
            idsToProcess = targetProducts
              .filter((p) => !isRealWebLink(p.WebLink))
              .map((p) => toProductId(p.ProductID))
              .filter((id): id is number => id !== null);
          }
        }
      }

      if (idsToProcess.length === 0) {
        showToastMessage('No products selected for web link lookup.', 'info');
        return;
      }

      setBusy(true);
      try {
        await runAddWebLinksFlow({ productIds: idsToProcess, onApplied, registerUndo });
      } finally {
        setBusy(false);
      }
    },
  };
}
