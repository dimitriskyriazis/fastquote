'use client';

import { useState, useCallback, useEffect } from 'react';
import LookupModal from '../../../components/LookupModal';
import lookupStyles from '../../../components/LookupModal.module.css';
import styles from './DraftOrderWizard.module.css';

// ── Types ──────────────────────────────────────────────────────────────────────

type CustomerMatch = { TRDR: number; CODE: string | null; NAME: string | null };

type LookupOption = { id: number; name: string };
type SubCategoryOption = LookupOption & { categoryId: number | null };

type CategorizedProduct = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  brandName: string | null;
  categoryId: number | null;
  subCategoryId: number | null;
  typeId: number | null;
  categoryName: string | null;
  subCategoryName: string | null;
  typeName: string | null;
  wasAiCategorized: boolean;
  wasErpSynced?: boolean;
};

type AutoMatchedProduct = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  brandName: string | null;
  MTRL: number;
  CODE: string | null;
  NAME1: string | null;
};

type SkippedProduct = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  reason: string;
};

type ProductNeedsSelection = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  partNumberActual: string | null;
  modelNumberActual: string | null;
  description: string | null;
  brandName: string | null;
  categoryName: string | null;
  subCategoryName: string | null;
  typeName: string | null;
  canCreate: boolean;
  missingFields: string[];
  matches: Array<{ MTRL: number; CODE: string | null; CODE1: string | null; CODE2: string | null; NAME1: string | null; BRANDNAME?: string | null }>;
};

type OrderLine = {
  productId: number | null;
  productCode: string;
  productName: string;
  qty: number;
  price: number;
  lineTotal: number;
  position: number | null;
  warrantyYears: number | null;
  comment: string | null;
};

type SummaryData = {
  customer: CustomerMatch;
  project: { status: 'existing' | 'will-create'; code: string | null; id: number | null };
  orderLines: OrderLine[];
  totals: { lineCount: number; totalValue: number };
  actions: { brandsToCreate: number; productsToCreate: number; productsToMatch: number; projectToCreate: boolean };
  missingBrands: string[];
};

type ExecutionResult = {
  brandsCreated: string[];
  productsCreated: Array<{ productId: number; mtrl: number; code: string }>;
  productsLinked: Array<{ productId: number; mtrl: number; code: string }>;
  project: { id: number; code: string; isNew: boolean } | null;
  order: { findocId: number; finCode: string } | null;
};

type WizardStepId = 'resolve-customer' | 'check-brands' | 'match-products' | 'categorize-products' | 'prepare-summary' | 'execute';

const STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'resolve-customer', label: 'Customer' },
  { id: 'check-brands', label: 'Brands' },
  { id: 'match-products', label: 'Products' },
  { id: 'categorize-products', label: 'Categories' },
  { id: 'prepare-summary', label: 'Summary' },
  { id: 'execute', label: 'Execute' },
];

// ── Props ──────────────────────────────────────────────────────────────────────

type Props = {
  offerId: string;
  open: boolean;
  onClose: (success?: boolean) => void;
};

// ── Helper ─────────────────────────────────────────────────────────────────────

function productLabel(partNumber: string | null, _modelNumber: string | null, productId?: number): string {
  const pn = partNumber?.trim();
  return pn || `Product #${productId ?? '?'}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(value);
}

const CREATE_NEW_SENTINEL = -1;

// ── Component ──────────────────────────────────────────────────────────────────

export default function DraftOrderWizard({ offerId, open, onClose }: Props) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Customer resolution
  const [resolvedCustomer, setResolvedCustomer] = useState<CustomerMatch | null>(null);
  const [customerNeedsSelection, setCustomerNeedsSelection] = useState<CustomerMatch[]>([]);
  const [customerNeedsConfirmation, setCustomerNeedsConfirmation] = useState<CustomerMatch | null>(null);
  const [customerNeedsCode, setCustomerNeedsCode] = useState(false);
  const [customerCodeInput, setCustomerCodeInput] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerMatch | null>(null);

  // Step 2: Product categorization
  const [categorizedProducts, setCategorizedProducts] = useState<CategorizedProduct[]>([]);
  const [categorizeComplete, setCategorizeComplete] = useState(false);
  const [categoryLookups, setCategoryLookups] = useState<LookupOption[]>([]);
  const [subCategoryLookups, setSubCategoryLookups] = useState<SubCategoryOption[]>([]);
  const [typeLookups, setTypeLookups] = useState<LookupOption[]>([]);

  // Step 3: Brand check
  const [missingBrands, setMissingBrands] = useState<string[]>([]);
  const [existingBrands, setExistingBrands] = useState<string[]>([]);
  const [nearMatchBrands, setNearMatchBrands] = useState<Array<{ fastquoteName: string; matches: Array<{ erpName: string; MTRMANFCTR: number }> }>>([]);
  const [brandDecisions, setBrandDecisions] = useState<Map<string, 'create' | number>>(new Map());
  const [brandsCheckComplete, setBrandsCheckComplete] = useState(false);
  // fastquote brand name → canonical Soft1 brand { erpName, MTRMANFCTR }, captured
  // when the user picks a near-match in step 2 (Brands).
  const [resolvedBrandMap, setResolvedBrandMap] = useState<Map<string, { erpName: string; MTRMANFCTR: number }>>(new Map());

  // Step 4: Product matching
  const [autoMatched, setAutoMatched] = useState<AutoMatchedProduct[]>([]);
  const [needsSelection, setNeedsSelection] = useState<ProductNeedsSelection[]>([]);
  const [skipped, setSkipped] = useState<SkippedProduct[]>([]);
  const [userSelections, setUserSelections] = useState<Map<number, { MTRL: number; CODE: string | null }>>(new Map());
  const [confirmedCreates, setConfirmedCreates] = useState<number[]>([]);
  const [matchComplete, setMatchComplete] = useState(false);
  const [showMatchHint, setShowMatchHint] = useState(false);
  const [showCategorizeHint, setShowCategorizeHint] = useState(false);

  // Manual Soft1 search modal (for unmatched products)
  type ErpMatch = ProductNeedsSelection['matches'][number];
  const [manualSearchProduct, setManualSearchProduct] = useState<ProductNeedsSelection | null>(null);
  const [manualSearchPomQuery, setManualSearchPomQuery] = useState('');
  const [manualSearchDescQuery, setManualSearchDescQuery] = useState('');
  const [manualSearchBrandQuery, setManualSearchBrandQuery] = useState('');
  const [manualSearchResults, setManualSearchResults] = useState<ErpMatch[]>([]);
  const [manualSearchSelectedMtrl, setManualSearchSelectedMtrl] = useState<number | null>(null);
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [manualSearchError, setManualSearchError] = useState<string | null>(null);
  const [manualSearchTouched, setManualSearchTouched] = useState(false);
  const [erpBrandList, setErpBrandList] = useState<Array<{ MTRMANFCTR: number; name: string }>>([]);
  const [erpBrandsLoaded, setErpBrandsLoaded] = useState(false);
  const [brandComboOpen, setBrandComboOpen] = useState(false);

  // Step 4: Summary
  const [summary, setSummary] = useState<SummaryData | null>(null);

  // Step 6: Execution
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);

  const currentStep = STEPS[currentStepIndex];

  // ── API call helper ──────────────────────────────────────────────────────

  const callStep = useCallback(async (step: WizardStepId, extra: Record<string, unknown> = {}) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/create-draft-order-soft1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, ...extra }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok && !payload?.ok) {
        throw new Error(payload?.error ?? `Step failed (${response.status})`);
      }
      return payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Request failed';
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [offerId]);

  // ── Manual Soft1 search ──────────────────────────────────────────────────

  const runManualSearch = useCallback(async (
    partOrModel: string | null,
    description: string | null,
    brandName: string | null,
  ) => {
    setManualSearchLoading(true);
    setManualSearchError(null);
    setManualSearchSelectedMtrl(null);
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/create-draft-order-soft1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step: 'manual-search-product',
          manualSearch: { partOrModel, description, brandName, topN: 50 },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Search failed (${response.status})`);
      }
      setManualSearchResults((payload.matches ?? []) as ErpMatch[]);
    } catch (err) {
      setManualSearchError(err instanceof Error ? err.message : 'Search failed');
      setManualSearchResults([]);
    } finally {
      setManualSearchLoading(false);
      setManualSearchTouched(true);
    }
  }, [offerId]);

  const ensureErpBrandsLoaded = useCallback(async () => {
    if (erpBrandsLoaded) return;
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/create-draft-order-soft1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'list-brands' }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok) {
        setErpBrandList((payload.brands ?? []) as Array<{ MTRMANFCTR: number; name: string }>);
      }
    } catch {
      // Non-fatal — Brand input will still work as a free-text filter.
    } finally {
      setErpBrandsLoaded(true);
    }
  }, [erpBrandsLoaded, offerId]);

  const openManualSearch = useCallback((ns: ProductNeedsSelection) => {
    const pom = (ns.partNumberActual ?? ns.modelNumberActual ?? '').trim();
    const fastquoteBrand = (ns.brandName ?? '').trim();
    // If the Brands step resolved this fastquote brand to a canonical Soft1
    // brand, auto-select that. Otherwise try a case-insensitive match in the
    // already-loaded brand list. Otherwise fall back to the raw fastquote name
    // (an effect below normalizes once the brand list finishes loading).
    const resolved = fastquoteBrand ? resolvedBrandMap.get(fastquoteBrand) : undefined;
    let brand = resolved?.erpName ?? fastquoteBrand;
    if (!resolved && fastquoteBrand && erpBrandList.length > 0) {
      const lower = fastquoteBrand.toLowerCase();
      const ci = erpBrandList.find(b => b.name.toLowerCase() === lower);
      if (ci) brand = ci.name;
    }
    setManualSearchProduct(ns);
    setManualSearchPomQuery(pom);
    setManualSearchDescQuery('');
    setManualSearchBrandQuery(brand);
    setBrandComboOpen(false);
    setManualSearchResults([]);
    setManualSearchSelectedMtrl(null);
    setManualSearchError(null);
    setManualSearchTouched(false);
    void ensureErpBrandsLoaded();
    if (pom.length >= 2) {
      void runManualSearch(pom || null, null, brand || null);
    }
  }, [runManualSearch, ensureErpBrandsLoaded, resolvedBrandMap, erpBrandList]);

  const closeManualSearch = useCallback(() => {
    setManualSearchProduct(null);
    setManualSearchPomQuery('');
    setManualSearchDescQuery('');
    setManualSearchBrandQuery('');
    setManualSearchResults([]);
    setManualSearchSelectedMtrl(null);
    setManualSearchError(null);
    setManualSearchTouched(false);
  }, []);

  const applyManualSearchSelection = useCallback(() => {
    if (!manualSearchProduct || manualSearchSelectedMtrl == null) return;
    const picked = manualSearchResults.find(m => m.MTRL === manualSearchSelectedMtrl);
    if (!picked) return;
    const productId = manualSearchProduct.productId;
    setNeedsSelection(prev => prev.map(ns => {
      if (ns.productId !== productId) return ns;
      const alreadyHas = ns.matches.some(m => m.MTRL === picked.MTRL);
      return alreadyHas ? ns : { ...ns, matches: [picked, ...ns.matches] };
    }));
    setUserSelections(prev => {
      const next = new Map(prev);
      next.set(productId, { MTRL: picked.MTRL, CODE: picked.CODE });
      return next;
    });
    closeManualSearch();
  }, [manualSearchProduct, manualSearchSelectedMtrl, manualSearchResults, closeManualSearch]);

  // ── Step runners ─────────────────────────────────────────────────────────

  const runResolveCustomer = useCallback(async (extra: Record<string, unknown> = {}) => {
    const result = await callStep('resolve-customer', extra);
    if (!result) return;

    if (result.resolved) {
      setResolvedCustomer(result.resolved);
      setCustomerNeedsSelection([]);
      setCustomerNeedsConfirmation(null);
      setCustomerNeedsCode(false);
    } else if (result.needsSelection) {
      setCustomerNeedsSelection(result.needsSelection);
      setCustomerNeedsConfirmation(null);
      setCustomerNeedsCode(false);
    } else if (result.needsConfirmation) {
      setCustomerNeedsConfirmation(result.needsConfirmation);
      setCustomerNeedsSelection([]);
      setCustomerNeedsCode(false);
    } else if (result.needsCode) {
      setCustomerNeedsCode(true);
      setCustomerNeedsSelection([]);
      setCustomerNeedsConfirmation(null);
    }
  }, [callStep]);

  const runCategorizeProducts = useCallback(async () => {
    const matchResults = {
      autoMatched: autoMatched.map(m => ({ productId: m.productId, MTRL: m.MTRL, CODE: m.CODE })),
      userConfirmedCreate: confirmedCreates.map(productId => ({ productId })),
      userSelected: Array.from(userSelections.entries())
        .filter(([, match]) => match.MTRL !== CREATE_NEW_SENTINEL)
        .map(([productId, match]) => ({
          productId, MTRL: match.MTRL, CODE: match.CODE,
        })),
      skipped: skipped.map(s => ({ productId: s.productId })),
    };
    const result = await callStep('categorize-products', { matchResults });
    if (!result) return;
    setCategorizedProducts(result.products ?? []);
    setCategoryLookups(result.categories ?? []);
    setSubCategoryLookups(result.subCategories ?? []);
    setTypeLookups(result.types ?? []);
    setCategorizeComplete(true);
  }, [callStep, autoMatched, confirmedCreates, userSelections, skipped]);

  const runCheckBrands = useCallback(async () => {
    const result = await callStep('check-brands');
    if (!result) return;
    setMissingBrands(result.missingBrands ?? []);
    setExistingBrands(result.existingBrands ?? []);
    setNearMatchBrands(result.nearMatchBrands ?? []);
    setBrandDecisions(new Map());
    setBrandsCheckComplete(true);
  }, [callStep]);

  const runMatchProducts = useCallback(async (selections?: Array<{ productId: number; MTRL: number; CODE: string | null }>) => {
    const extra: Record<string, unknown> = {};
    if (selections && selections.length > 0) {
      extra.selections = selections;
    }
    const result = await callStep('match-products', extra);
    if (!result) return;
    setAutoMatched(result.autoMatched ?? []);
    setNeedsSelection(result.needsSelection ?? []);
    setSkipped(result.skipped ?? []);
    setUserSelections(new Map());
    setConfirmedCreates([]);
    setMatchComplete(true);
  }, [callStep]);

  const runPrepareSummary = useCallback(async () => {
    const matchResults = {
      autoMatched: autoMatched.map(m => ({ productId: m.productId, MTRL: m.MTRL, CODE: m.CODE })),
      userConfirmedCreate: confirmedCreates.map(productId => ({ productId })),
      userSelected: Array.from(userSelections.entries())
        .filter(([, match]) => match.MTRL !== CREATE_NEW_SENTINEL)
        .map(([productId, match]) => ({
          productId, MTRL: match.MTRL, CODE: match.CODE,
        })),
      skipped: skipped.map(s => ({ productId: s.productId })),
    };
    const result = await callStep('prepare-summary', {
      resolvedCustomer,
      missingBrands,
      matchResults,
    });
    if (!result) return;
    setSummary(result);
  }, [callStep, resolvedCustomer, missingBrands, autoMatched, confirmedCreates, userSelections, skipped]);

  const runExecute = useCallback(async () => {
    const matchResults = {
      autoMatched: autoMatched.map(m => ({ productId: m.productId, MTRL: m.MTRL, CODE: m.CODE })),
      userConfirmedCreate: confirmedCreates.map(productId => ({ productId })),
      userSelected: Array.from(userSelections.entries())
        .filter(([, match]) => match.MTRL !== CREATE_NEW_SENTINEL)
        .map(([productId, match]) => ({
          productId, MTRL: match.MTRL, CODE: match.CODE,
        })),
      skipped: skipped.map(s => ({ productId: s.productId })),
    };
    const touched = categorizedProducts.filter(p => p.wasErpSynced || p.wasAiCategorized);
    const newProductIds = new Set<number>([
      ...confirmedCreates,
      ...Array.from(userSelections.entries())
        .filter(([, match]) => match.MTRL === CREATE_NEW_SENTINEL)
        .map(([productId]) => productId),
    ]);
    const toCatPayload = (p: CategorizedProduct) => ({
      productId: p.productId,
      label: p.modelNumber || p.partNumber || p.description || `#${p.productId}`,
      categoryName: p.categoryName,
      subCategoryName: p.subCategoryName,
      typeName: p.typeName,
    });
    const newProductsCategorization = categorizedProducts
      .filter(p => newProductIds.has(p.productId))
      .map(toCatPayload);
    const existingProductsCategorization = categorizedProducts
      .filter(p => !newProductIds.has(p.productId)
        && (p.categoryName || p.subCategoryName || p.typeName))
      .map(toCatPayload);
    const categorizationSummary = {
      categoriesUpdated: touched.filter(p => p.categoryId != null).length,
      subcategoriesUpdated: touched.filter(p => p.subCategoryId != null).length,
      typesUpdated: touched.filter(p => p.typeId != null).length,
      newProducts: newProductsCategorization,
      existingProducts: existingProductsCategorization,
    };
    const brandResolutions = Array.from(resolvedBrandMap.entries()).map(
      ([fastquoteName, info]) => ({
        fastquoteName,
        erpName: info.erpName,
        MTRMANFCTR: info.MTRMANFCTR,
      }),
    );
    const result = await callStep('execute', {
      resolvedCustomer,
      missingBrands,
      brandResolutions,
      matchResults,
      categorizationSummary,
    });
    if (!result) return;
    setExecutionResult(result);
  }, [callStep, resolvedCustomer, missingBrands, resolvedBrandMap, autoMatched, confirmedCreates, userSelections, skipped, categorizedProducts]);

  // ── Manual-search Brand normalization ────────────────────────────────────
  // When the Soft1 brand list finishes loading, normalize the Brand input to
  // the canonical Soft1 spelling (case-insensitive match) so the field reads
  // as a real selected brand instead of free text.
  useEffect(() => {
    if (!manualSearchProduct || erpBrandList.length === 0) return;
    const current = manualSearchBrandQuery.trim();
    if (!current) return;
    const exact = erpBrandList.find(b => b.name === current);
    if (exact) return;
    const lower = current.toLowerCase();
    const ci = erpBrandList.find(b => b.name.toLowerCase() === lower);
    if (ci) setManualSearchBrandQuery(ci.name);
  }, [manualSearchProduct, erpBrandList, manualSearchBrandQuery]);

  // ── Auto-run step on mount / step change ─────────────────────────────────

  useEffect(() => {
    if (!open) return;
    // Auto-run the step when we land on it (unless it already completed or needs user input)
    if (currentStep.id === 'resolve-customer' && !resolvedCustomer && !customerNeedsSelection.length && !customerNeedsConfirmation && !customerNeedsCode) {
      runResolveCustomer();
    } else if (currentStep.id === 'check-brands' && !brandsCheckComplete) {
      runCheckBrands();
    } else if (currentStep.id === 'match-products' && !matchComplete) {
      runMatchProducts();
    } else if (currentStep.id === 'categorize-products' && !categorizeComplete) {
      runCategorizeProducts();
    } else if (currentStep.id === 'prepare-summary' && !summary) {
      runPrepareSummary();
    } else if (currentStep.id === 'execute' && !executionResult) {
      runExecute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStepIndex, open]);

  // ── Navigation ───────────────────────────────────────────────────────────

  const canContinue = (): boolean => {
    if (isLoading) return false;
    if (error) return false;
    switch (currentStep.id) {
      case 'resolve-customer':
        return resolvedCustomer !== null;
      case 'categorize-products': {
        if (!categorizeComplete) return false;
        const newProductIds = new Set<number>([
          ...confirmedCreates,
          ...Array.from(userSelections.entries())
            .filter(([, match]) => match.MTRL === CREATE_NEW_SENTINEL)
            .map(([id]) => id),
        ]);
        return Array.from(newProductIds).every(id => {
          const p = categorizedProducts.find(cp => cp.productId === id);
          return p && p.description && p.brandName && p.subCategoryId && p.typeId;
        });
      }
      case 'check-brands':
        return brandsCheckComplete && nearMatchBrands.every(nm => brandDecisions.has(nm.fastquoteName));
      case 'match-products':
        // Must be complete AND all needsSelection items must have a user selection
        return matchComplete && needsSelection.every(ns => userSelections.has(ns.productId));
      case 'prepare-summary':
        return summary !== null;
      case 'execute':
        return executionResult !== null;
      default:
        return false;
    }
  };

  const handleContinue = useCallback(() => {
    if (currentStep.id === 'execute') {
      // Done — close wizard and reload
      onClose(true);
      window.location.reload();
      return;
    }

    if (currentStep.id === 'check-brands' && nearMatchBrands.length > 0) {
      // Resolve near-match brand decisions before moving to match-products
      const newExisting = [...existingBrands];
      const newMissing = [...missingBrands];
      const newResolved = new Map(resolvedBrandMap);
      for (const nm of nearMatchBrands) {
        const decision = brandDecisions.get(nm.fastquoteName);
        if (typeof decision === 'number') {
          // User picked a specific ERP match — record the canonical Soft1 brand
          // so we can auto-select it in downstream steps (e.g. manual search).
          const picked = nm.matches.find(m => m.MTRMANFCTR === decision);
          if (picked) {
            newResolved.set(nm.fastquoteName, { erpName: picked.erpName, MTRMANFCTR: picked.MTRMANFCTR });
          }
          newExisting.push(nm.fastquoteName);
        } else {
          newMissing.push(nm.fastquoteName);
        }
      }
      setExistingBrands(newExisting);
      setMissingBrands(newMissing);
      setResolvedBrandMap(newResolved);
      setNearMatchBrands([]);
    }

    if (currentStep.id === 'match-products' && needsSelection.length > 0) {
      // Split user selections into matched products vs confirmed creates
      const newAutoMatched = [...autoMatched];
      const newConfirmedCreates: number[] = [];
      for (const ns of needsSelection) {
        const sel = userSelections.get(ns.productId);
        if (!sel) continue;
        if (sel.MTRL === CREATE_NEW_SENTINEL) {
          newConfirmedCreates.push(ns.productId);
        } else {
          newAutoMatched.push({
            productId: ns.productId,
            partNumber: ns.partNumberActual,
            modelNumber: ns.modelNumberActual,
            description: ns.description,
            brandName: ns.brandName,
            MTRL: sel.MTRL,
            CODE: sel.CODE,
            NAME1: ns.matches.find(m => m.MTRL === sel.MTRL)?.NAME1 ?? null,
          });
        }
      }
      setAutoMatched(newAutoMatched);
      setConfirmedCreates(newConfirmedCreates);
      setNeedsSelection([]);
    }

    setCurrentStepIndex(i => i + 1);
  }, [currentStep, needsSelection, userSelections, autoMatched, nearMatchBrands, brandDecisions, existingBrands, missingBrands, resolvedBrandMap, onClose]);

  const handleRetry = useCallback(() => {
    setError(null);
    // Re-trigger the current step
    if (currentStep.id === 'resolve-customer') runResolveCustomer();
    else if (currentStep.id === 'categorize-products') runCategorizeProducts();
    else if (currentStep.id === 'check-brands') runCheckBrands();
    else if (currentStep.id === 'match-products') runMatchProducts();
    else if (currentStep.id === 'prepare-summary') runPrepareSummary();
    else if (currentStep.id === 'execute') runExecute();
  }, [currentStep, runResolveCustomer, runCategorizeProducts, runCheckBrands, runMatchProducts, runPrepareSummary, runExecute]);

  // ── Confirm label ────────────────────────────────────────────────────────

  const getConfirmLabel = (): string => {
    if (error) return 'Retry';
    if (isLoading) return 'Loading...';
    if (currentStep.id === 'execute') return executionResult ? 'Done' : 'Loading...';
    if (currentStep.id === 'prepare-summary') return 'Create Order in Soft1';
    return 'Continue';
  };

  const handleConfirm = useCallback(() => {
    if (error) {
      handleRetry();
      return;
    }
    handleContinue();
  }, [error, handleRetry, handleContinue]);

  // ── Step bar ─────────────────────────────────────────────────────────────

  const stepBar = (
    <div className={styles.stepBar}>
      {STEPS.map((step, idx) => {
        let cls = styles.stepItem;
        if (idx < currentStepIndex) cls += ` ${styles.stepItemDone}`;
        else if (idx === currentStepIndex) cls += ` ${styles.stepItemActive}`;
        return <div key={step.id} className={cls}>{idx + 1}. {step.label}</div>;
      })}
    </div>
  );

  // ── Step content renderers ───────────────────────────────────────────────

  const renderLoading = (message: string) => (
    <div className={styles.loadingBox}>
      <div className={styles.spinner} />
      {message}
    </div>
  );

  const renderCustomerStep = () => {
    if (isLoading && !customerNeedsSelection.length && !customerNeedsConfirmation && !customerNeedsCode) {
      return renderLoading('Searching for customer in Soft1...');
    }

    if (resolvedCustomer) {
      return (
        <>
          <p className={styles.sectionTitle}>Customer Found</p>
          <div className={styles.customerCard}>
            <div className={styles.customerName}>{resolvedCustomer.NAME ?? 'Unknown'}</div>
            <div className={styles.customerMeta}>
              <strong>Code:</strong> {resolvedCustomer.CODE ?? 'N/A'} &bull; <strong>TRDR:</strong> {resolvedCustomer.TRDR}
            </div>
          </div>
        </>
      );
    }

    // Customer needs confirmation
    if (customerNeedsConfirmation) {
      return (
        <>
          <p className={styles.sectionTitle}>Is this the correct customer?</p>
          <div className={styles.customerCard}>
            <div className={styles.customerName}>{customerNeedsConfirmation.NAME ?? 'Unknown'}</div>
            <div className={styles.customerMeta}>
              <strong>Code:</strong> {customerNeedsConfirmation.CODE ?? 'N/A'} &bull; <strong>TRDR:</strong> {customerNeedsConfirmation.TRDR}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
            <button
              type="button"
              className={lookupStyles.cancelButton}
              onClick={() => {
                setCustomerNeedsConfirmation(null);
                setCustomerNeedsCode(true);
              }}
            >
              No, Enter Different Code
            </button>
            <button
              type="button"
              className={lookupStyles.confirmButton}
              onClick={() => {
                runResolveCustomer({
                  customerSelection: { TRDR: customerNeedsConfirmation.TRDR, CODE: customerNeedsConfirmation.CODE },
                  customerConfirmed: true,
                });
              }}
              disabled={isLoading}
            >
              {isLoading ? 'Confirming...' : 'Yes, This is Correct'}
            </button>
          </div>
        </>
      );
    }

    // Customer needs selection
    if (customerNeedsSelection.length > 0) {
      return (
        <>
          <p className={styles.sectionTitle}>Multiple customers found. Please select:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {customerNeedsSelection.map(c => (
              <label
                key={c.TRDR}
                style={{
                  display: 'flex', alignItems: 'center', padding: '12px',
                  border: selectedCustomer?.TRDR === c.TRDR ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  borderRadius: '8px', cursor: 'pointer',
                  backgroundColor: selectedCustomer?.TRDR === c.TRDR ? '#eff6ff' : 'transparent',
                }}
              >
                <input type="radio" name="wizardCustomer" value={c.TRDR} checked={selectedCustomer?.TRDR === c.TRDR}
                  onChange={() => setSelectedCustomer(c)} style={{ marginRight: '12px' }} />
                <div>
                  <div style={{ fontWeight: 600 }}>{c.NAME}</div>
                  <div style={{ fontSize: '0.85rem', color: '#64748b' }}>Code: {c.CODE || 'N/A'} &bull; TRDR: {c.TRDR}</div>
                </div>
              </label>
            ))}
          </div>
        </>
      );
    }

    // Customer needs code input
    if (customerNeedsCode) {
      return (
        <>
          <p className={styles.sectionTitle}>Enter Customer Code</p>
          <p style={{ fontSize: '0.85rem', color: '#64748b' }}>No customer found by name. Please enter the customer code:</p>
          <input
            type="text"
            className={lookupStyles.fieldControl}
            placeholder="e.g., ΖΓ.1014"
            value={customerCodeInput}
            onChange={e => setCustomerCodeInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && customerCodeInput.trim()) {
                e.preventDefault();
                runResolveCustomer({ customerCode: customerCodeInput.trim() });
              }
            }}
            style={{ width: '100%', padding: '8px 12px', fontSize: '0.9rem' }}
            autoFocus
          />
          <button
            type="button"
            className={lookupStyles.confirmButton}
            style={{ alignSelf: 'flex-end', marginTop: '8px' }}
            onClick={() => {
              if (customerCodeInput.trim()) {
                runResolveCustomer({ customerCode: customerCodeInput.trim() });
              }
            }}
            disabled={!customerCodeInput.trim() || isLoading}
          >
            {isLoading ? 'Searching...' : 'Search Customer'}
          </button>
        </>
      );
    }

    return null;
  };

  const handleCategoryChange = useCallback(async (
    productId: number,
    field: 'categoryId' | 'subCategoryId' | 'typeId',
    value: number | null,
  ) => {
    // Build the update payload
    const product = categorizedProducts.find(p => p.productId === productId);
    if (!product) return;

    const update: Record<string, number | null> = { productId, [field]: value };

    // When category changes, clear subcategory if it no longer belongs
    if (field === 'categoryId') {
      const currentSub = product.subCategoryId;
      if (currentSub) {
        const subBelongs = subCategoryLookups.some(sc => sc.id === currentSub && sc.categoryId === value);
        if (!subBelongs) {
          update.subCategoryId = null;
        }
      }
    }

    // Optimistically update local state
    setCategorizedProducts(prev => prev.map(p => {
      if (p.productId !== productId) return p;
      const updated = { ...p, [field]: value };
      if (field === 'categoryId') {
        updated.categoryName = value ? (categoryLookups.find(c => c.id === value)?.name ?? null) : null;
        if (update.subCategoryId === null) {
          updated.subCategoryId = null;
          updated.subCategoryName = null;
        }
      }
      if (field === 'subCategoryId') {
        updated.subCategoryName = value ? (subCategoryLookups.find(sc => sc.id === value)?.name ?? null) : null;
      }
      if (field === 'typeId') {
        updated.typeName = value ? (typeLookups.find(t => t.id === value)?.name ?? null) : null;
      }
      return updated;
    }));

    // Persist to backend (fire-and-forget)
    try {
      await fetch(`/api/offers/${encodeURIComponent(offerId)}/create-draft-order-soft1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'update-product-category', categoryUpdate: update }),
      });
    } catch {
      // silent — optimistic update stays
    }
  }, [categorizedProducts, categoryLookups, subCategoryLookups, typeLookups, offerId]);

  const renderCategoryTable = (products: CategorizedProduct[]) => (
    <table className={styles.table} style={{ marginTop: '6px' }}>
      <thead>
        <tr>
          <th>Part No</th>
          <th>Brand</th>
          <th>Description</th>
          <th>Category</th>
          <th>SubCategory</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {products.map(p => {
          const filteredSubCategories = p.categoryId
            ? subCategoryLookups.filter(sc => sc.categoryId === p.categoryId)
            : subCategoryLookups;

          return (
            <tr key={p.productId}>
              <td>{productLabel(p.partNumber, p.modelNumber, p.productId)}</td>
              <td>{p.brandName ?? '—'}</td>
              <td>{[p.modelNumber, p.description].filter(Boolean).join(' - ') || '—'}</td>
              <td>
                <select
                  className={styles.select}
                  value={p.categoryId ?? ''}
                  onChange={e => handleCategoryChange(p.productId, 'categoryId', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">—</option>
                  {categoryLookups.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  className={styles.select}
                  value={p.subCategoryId ?? ''}
                  onChange={e => handleCategoryChange(p.productId, 'subCategoryId', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">—</option>
                  {filteredSubCategories.map(sc => (
                    <option key={sc.id} value={sc.id}>{sc.name}</option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  className={styles.select}
                  value={p.typeId ?? ''}
                  onChange={e => handleCategoryChange(p.productId, 'typeId', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">—</option>
                  {typeLookups.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const renderCategorizeStep = () => {
    if (isLoading) return renderLoading('Analyzing products and assigning categories...');

    if (categorizedProducts.length === 0) {
      return <div className={styles.noProducts}>No products found in this offer.</div>;
    }

    const erpProducts = categorizedProducts.filter(p => p.wasErpSynced);
    const aiProducts = categorizedProducts.filter(p => p.wasAiCategorized && !p.wasErpSynced);
    const otherProducts = categorizedProducts.filter(p => !p.wasErpSynced && !p.wasAiCategorized);

    return (
      <>
        {erpProducts.length > 0 && (
          <div className={`${styles.card} ${styles.cardGreen}`}>
            <p className={styles.sectionTitle} style={{ color: '#166534' }}>
              Categories from Soft1 ({erpProducts.length})
            </p>
            {renderCategoryTable(erpProducts)}
          </div>
        )}

        {aiProducts.length > 0 && (
          <div className={`${styles.card}`} style={{ borderLeft: '3px solid #3b82f6' }}>
            <p className={styles.sectionTitle} style={{ color: '#1d4ed8' }}>
              Auto-categorized by AI ({aiProducts.length})
            </p>
            {renderCategoryTable(aiProducts)}
          </div>
        )}

        {otherProducts.length > 0 && (
          <div className={`${styles.card} ${styles.cardGray}`}>
            <p className={styles.sectionTitle} style={{ color: '#64748b' }}>
              {erpProducts.length > 0 || aiProducts.length > 0 ? 'Already categorized in FastQuote' : 'Product Categories'} ({otherProducts.length})
            </p>
            {renderCategoryTable(otherProducts)}
          </div>
        )}
      </>
    );
  };

  const renderBrandsStep = () => {
    if (isLoading) return renderLoading('Checking brands in Soft1...');

    if (!brandsCheckComplete) return null;

    if (missingBrands.length === 0 && existingBrands.length === 0 && nearMatchBrands.length === 0) {
      return (
        <div className={`${styles.card} ${styles.cardGreen}`}>
          <p className={styles.sectionTitle} style={{ color: '#166534' }}>No brands to check</p>
          <div style={{ fontSize: '0.85rem', color: '#166534', marginTop: '4px' }}>
            All products either have no brand or brands are already in Soft1.
          </div>
        </div>
      );
    }

    return (
      <>
        {existingBrands.length > 0 && (
          <div className={`${styles.card} ${styles.cardGreen}`}>
            <p className={styles.sectionTitle} style={{ color: '#166534' }}>
              Brands found in Soft1 ({existingBrands.length})
            </p>
            <div style={{ fontSize: '0.85rem', color: '#166534', marginTop: '4px' }}>
              {existingBrands.join(', ')}
            </div>
          </div>
        )}
        {nearMatchBrands.length > 0 && (
          <div className={`${styles.card} ${styles.cardAmber}`}>
            <p className={styles.sectionTitle} style={{ color: '#92400e' }}>
              Possible matches ({nearMatchBrands.length})
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
              {nearMatchBrands.map(nm => {
                const decision = brandDecisions.get(nm.fastquoteName);
                return (
                  <div key={nm.fastquoteName} style={{ borderBottom: '1px solid #fde68a', paddingBottom: '10px' }}>
                    <div style={{ fontSize: '0.85rem', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>{nm.fastquoteName}</span>
                      <span style={{ color: '#64748b', fontSize: '0.75rem' }}> — select a match from Soft1</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {nm.matches.map(m => {
                        const isSelected = decision === m.MTRMANFCTR;
                        return (
                          <button
                            key={m.MTRMANFCTR}
                            type="button"
                            style={{
                              padding: '6px 16px', fontSize: '0.85rem', borderRadius: '4px', cursor: 'pointer',
                              border: isSelected ? '2px solid #166534' : '1px solid #d1d5db',
                              background: isSelected ? '#dcfce7' : '#fff',
                              color: isSelected ? '#166534' : '#374151',
                              fontWeight: isSelected ? 700 : 400,
                            }}
                            onClick={() => setBrandDecisions(prev => { const next = new Map(prev); next.set(nm.fastquoteName, m.MTRMANFCTR); return next; })}
                          >
                            {m.erpName}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        style={{
                          padding: '6px 16px', fontSize: '0.85rem', borderRadius: '4px', cursor: 'pointer',
                          border: decision === 'create' ? '2px solid #92400e' : '1px solid #d1d5db',
                          background: decision === 'create' ? '#fef3c7' : '#fff',
                          color: decision === 'create' ? '#92400e' : '#374151',
                          fontWeight: decision === 'create' ? 700 : 400,
                        }}
                        onClick={() => setBrandDecisions(prev => { const next = new Map(prev); next.set(nm.fastquoteName, 'create'); return next; })}
                      >
                        Create new
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {missingBrands.length > 0 && (
          <div className={`${styles.card} ${styles.cardAmber}`}>
            <p className={styles.sectionTitle} style={{ color: '#92400e' }}>
              Brands missing from Soft1 ({missingBrands.length})
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
              {missingBrands.map(b => (
                <div key={b} style={{ fontWeight: 600, fontSize: '0.9rem', color: '#92400e' }}>{b}</div>
              ))}
            </div>
            <p className={styles.warningText} style={{ marginTop: '10px' }}>
              These brands will be created in Soft1 when you execute the order.
            </p>
          </div>
        )}
      </>
    );
  };

  const renderMatchProductsStep = () => {
    if (isLoading) return renderLoading('Searching for products in Soft1 ERP...');

    if (!matchComplete) return null;

    const total = autoMatched.length + needsSelection.length + skipped.length;
    if (total === 0) return <div className={styles.noProducts}>No products to match.</div>;

    return (
      <>
        {autoMatched.length > 0 && (
          <div className={`${styles.card} ${styles.cardGreen}`}>
            <p className={styles.sectionTitle} style={{ color: '#166534' }}>
              Matched automatically ({autoMatched.length})
            </p>
            <table className={styles.table} style={{ marginTop: '6px' }}>
              <thead>
                <tr>
                  <th>Part No</th>
                  <th>Brand</th>
                  <th>Description</th>
                  <th>ERP Code</th>
                </tr>
              </thead>
              <tbody>
                {autoMatched.map(m => (
                  <tr key={m.productId}>
                    <td>{productLabel(m.partNumber, m.modelNumber, m.productId)}</td>
                    <td>{m.brandName ?? '—'}</td>
                    <td>{[m.modelNumber, m.description].filter(Boolean).join(' - ') || '—'}</td>
                    <td>{m.CODE ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {needsSelection.filter(ns => ns.matches.length > 0).length > 0 && (() => {
          const withMatches = needsSelection.filter(ns => ns.matches.length > 0);
          return (
            <div className={`${styles.card} ${styles.cardAmber}`}>
              <p className={styles.sectionTitle} style={{ color: '#92400e' }}>
                Needs your selection ({withMatches.length})
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '8px' }}>
                {withMatches.map(ns => {
                  const label = productLabel(ns.partNumberActual, ns.modelNumberActual, ns.productId);
                  const desc = [ns.modelNumberActual, ns.description].filter(Boolean).join(' - ');
                  const categoryPath = [ns.categoryName, ns.subCategoryName, ns.typeName].filter(Boolean).join(' > ');
                  const selectedMtrl = userSelections.get(ns.productId)?.MTRL;
                  const selectValue = selectedMtrl === CREATE_NEW_SENTINEL
                    ? 'CREATE_NEW'
                    : selectedMtrl?.toString() ?? '';
                  return (
                    <div key={ns.productId} style={{ borderBottom: '1px solid #fde68a', paddingBottom: '14px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '2px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#0f172a' }}>{label}</span>
                        {ns.brandName && <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#0f172a' }}>{ns.brandName}</span>}
                      </div>
                      {desc && (
                        <div style={{ fontSize: '0.85rem', color: '#475569', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }} title={desc}>
                          {desc}
                        </div>
                      )}
                      {categoryPath && (
                        <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '4px' }}>
                          {categoryPath}
                        </div>
                      )}
                      <div style={{ fontSize: '0.75rem', color: '#92400e', marginBottom: '6px' }}>
                        Found {ns.matches.length} near-match(es) in ERP
                      </div>
                      <select
                        className={styles.select}
                        value={selectValue}
                        onChange={e => {
                          const val = e.target.value;
                          if (val === 'CREATE_NEW') {
                            setUserSelections(prev => {
                              const next = new Map(prev);
                              next.set(ns.productId, { MTRL: CREATE_NEW_SENTINEL, CODE: null });
                              return next;
                            });
                          } else if (val) {
                            const mtrl = Number.parseInt(val, 10);
                            const match = ns.matches.find(m => m.MTRL === mtrl);
                            if (match) {
                              setUserSelections(prev => {
                                const next = new Map(prev);
                                next.set(ns.productId, { MTRL: match.MTRL, CODE: match.CODE });
                                return next;
                              });
                            }
                          } else {
                            setUserSelections(prev => {
                              const next = new Map(prev);
                              next.delete(ns.productId);
                              return next;
                            });
                          }
                        }}
                      >
                        <option value="">Select a product...</option>
                        {ns.matches.map(match => {
                          const parts: string[] = [];
                          if (match.BRANDNAME) parts.push(match.BRANDNAME);
                          if (match.CODE2) parts.push(match.CODE2);
                          if (match.CODE) parts.push(match.CODE);
                          if (match.NAME1) parts.push(match.NAME1);
                          const displayText = parts.length > 0 ? parts.join(', ') : `MTRL: ${match.MTRL}`;
                          return <option key={match.MTRL} value={match.MTRL} title={displayText}>{displayText}</option>;
                        })}
                        <option value="CREATE_NEW" disabled={!ns.canCreate}>
                          {ns.canCreate
                            ? '+ Create new product'
                            : `+ Create new (missing: ${ns.missingFields.join(', ')})`}
                        </option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {needsSelection.filter(ns => ns.matches.length === 0).length > 0 && (() => {
          const noMatches = needsSelection.filter(ns => ns.matches.length === 0);
          const creatableNoMatches = noMatches.filter(ns => ns.canCreate);
          const allConfirmed = creatableNoMatches.length > 0 && creatableNoMatches.every(ns => userSelections.get(ns.productId)?.MTRL === CREATE_NEW_SENTINEL);
          return (
            <div className={`${styles.card} ${styles.cardRed}`}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <p className={styles.sectionTitle} style={{ color: '#991b1b', margin: 0 }}>
                  No matches found ({noMatches.length})
                </p>
                {creatableNoMatches.length > 0 && (
                  <button
                    type="button"
                    style={{
                      padding: '5px 16px', fontSize: '0.8rem', borderRadius: '4px', cursor: 'pointer',
                      border: allConfirmed ? '2px solid #166534' : '1px solid #fca5a5',
                      background: allConfirmed ? '#dcfce7' : '#fff',
                      color: allConfirmed ? '#166534' : '#991b1b',
                      fontWeight: 700,
                    }}
                    onClick={() => {
                      setUserSelections(prev => {
                        const next = new Map(prev);
                        if (allConfirmed) {
                          for (const ns of creatableNoMatches) next.delete(ns.productId);
                        } else {
                          for (const ns of creatableNoMatches) next.set(ns.productId, { MTRL: CREATE_NEW_SENTINEL, CODE: null });
                        }
                        return next;
                      });
                    }}
                  >
                    {allConfirmed ? `All ${creatableNoMatches.length} confirmed` : `Confirm all ${creatableNoMatches.length} for creation`}
                  </button>
                )}
              </div>
              <table className={styles.table} style={{ marginTop: '8px' }}>
                <thead>
                  <tr>
                    <th>Part No</th>
                    <th>Brand</th>
                    <th>Description</th>
                    <th style={{ width: '140px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {noMatches.map(ns => {
                    const label = productLabel(ns.partNumberActual, ns.modelNumberActual, ns.productId);
                    const desc = [ns.modelNumberActual, ns.description].filter(Boolean).join(' - ') || '—';
                    return (
                      <tr key={ns.productId}>
                        <td>{label}</td>
                        <td>{ns.brandName ?? '—'}</td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '500px' }} title={desc}>{desc}</td>
                        <td>
                          <button
                            type="button"
                            onClick={() => openManualSearch(ns)}
                            style={{
                              padding: '4px 10px',
                              fontSize: '0.75rem',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              border: '1px solid #1d4ed8',
                              background: '#fff',
                              color: '#1d4ed8',
                              fontWeight: 600,
                            }}
                          >
                            Search Soft1
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()}

        {skipped.length > 0 && (
          <div className={`${styles.card} ${styles.cardGray}`}>
            <p className={styles.sectionTitle} style={{ color: '#64748b' }}>
              Skipped ({skipped.length})
            </p>
            <table className={styles.table} style={{ marginTop: '6px' }}>
              <thead>
                <tr>
                  <th>Part No</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {skipped.map(s => (
                  <tr key={s.productId}>
                    <td>{productLabel(s.partNumber, s.modelNumber, s.productId)}</td>
                    <td style={{ color: '#64748b' }}>{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </>
    );
  };

  const renderSummaryStep = () => {
    if (isLoading) return renderLoading('Preparing order summary...');
    if (!summary) return null;

    const categorizedFromSoft1 = categorizedProducts.filter(p => p.wasErpSynced);
    const categorizedByAi = categorizedProducts.filter(p => p.wasAiCategorized && !p.wasErpSynced);

    const newProductIds = new Set<number>([
      ...confirmedCreates,
      ...Array.from(userSelections.entries())
        .filter(([, match]) => match.MTRL === CREATE_NEW_SENTINEL)
        .map(([productId]) => productId),
    ]);
    const productsToCreateCategorized = categorizedProducts.filter(p => newProductIds.has(p.productId));
    const existingProductsCategorized = categorizedProducts.filter(
      p => !newProductIds.has(p.productId)
        && (p.categoryName || p.subCategoryName || p.typeName),
    );

    const formatAssignment = (p: CategorizedProduct) => {
      const label = p.modelNumber || p.partNumber || p.description || `#${p.productId}`;
      const parts = [p.categoryName, p.subCategoryName, p.typeName].filter(Boolean).join(' › ');
      return { label, parts: parts || '—' };
    };

    return (
      <>
        <p className={styles.sectionTitle}>Customer</p>
        <div className={styles.customerCard}>
          <div className={styles.customerName}>{summary.customer.NAME ?? 'Unknown'}</div>
          <div className={styles.customerMeta}>
            <strong>Code:</strong> {summary.customer.CODE ?? 'N/A'} &bull; <strong>TRDR:</strong> {summary.customer.TRDR}
          </div>
        </div>

        <p className={styles.sectionTitle}>Project</p>
        <div className={styles.card}>
          {summary.project.status === 'existing' ? (
            <span>Existing project: <strong>{summary.project.code}</strong></span>
          ) : (
            <span>New project will be created <span style={{ color: '#64748b' }}>(prefix: COV)</span></span>
          )}
        </div>

        {(summary.actions.brandsToCreate > 0 || summary.actions.productsToCreate > 0 || summary.actions.productsToMatch > 0) && (
          <>
            <p className={styles.sectionTitle}>Actions to perform in Soft1</p>
            <ul className={styles.actionsList}>
              {summary.actions.brandsToCreate > 0 && (
                <li>Create {summary.actions.brandsToCreate} brand(s): {summary.missingBrands.join(', ')}</li>
              )}
              {summary.actions.productsToCreate > 0 && (
                <li>Create {summary.actions.productsToCreate} new product(s) in ERP</li>
              )}
              {summary.actions.productsToMatch > 0 && (
                <li>Link {summary.actions.productsToMatch} matched product(s)</li>
              )}
              {summary.actions.projectToCreate && <li>Create 1 new project</li>}
              {categorizedFromSoft1.length > 0 && (
                <li>Category/subcategory/type synced from Soft1 for {categorizedFromSoft1.length} product(s)</li>
              )}
              {categorizedByAi.length > 0 && (
                <li>Category/subcategory/type auto-assigned by AI for {categorizedByAi.length} product(s)</li>
              )}
              <li>Create 1 order with {summary.totals.lineCount} line(s)</li>
            </ul>
          </>
        )}

        {(productsToCreateCategorized.length > 0 || existingProductsCategorized.length > 0) && (
          <>
            <p className={styles.sectionTitle}>Category assignments</p>
            {productsToCreateCategorized.length > 0 && (
              <div className={styles.card}>
                <p className={styles.sectionTitle}>
                  For new products ({productsToCreateCategorized.length})
                </p>
                <ul className={styles.actionsList}>
                  {productsToCreateCategorized.map(p => {
                    const { label, parts } = formatAssignment(p);
                    return <li key={p.productId}><strong>{label}</strong>: {parts}</li>;
                  })}
                </ul>
              </div>
            )}
            {existingProductsCategorized.length > 0 && (
              <div className={styles.card}>
                <p className={styles.sectionTitle}>
                  For existing products ({existingProductsCategorized.length})
                </p>
                <ul className={styles.actionsList}>
                  {existingProductsCategorized.map(p => {
                    const { label, parts } = formatAssignment(p);
                    return <li key={p.productId}><strong>{label}</strong>: {parts}</li>;
                  })}
                </ul>
              </div>
            )}
          </>
        )}

        <p className={styles.sectionTitle}>Order Lines ({summary.totals.lineCount})</p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Position</th>
              <th>Product</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Price</th>
              <th className={styles.tableRight}>Total</th>
              <th className={styles.tableRight}>Warranty</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {summary.orderLines.map((line, idx) => (
              <tr key={`${line.productId}-${idx}`}>
                <td>{idx + 1}</td>
                <td>{line.position ?? ''}</td>
                <td>{line.productCode !== '(new)' ? `${line.productCode} — ` : ''}{line.productName}</td>
                <td className={styles.tableRight}>{line.qty}</td>
                <td className={styles.tableRight}>{formatCurrency(line.price)}</td>
                <td className={styles.tableRight}>{formatCurrency(line.lineTotal)}</td>
                <td className={styles.tableRight}>{line.warrantyYears != null ? `${line.warrantyYears}y (${line.warrantyYears * 12}m)` : ''}</td>
                <td>{line.comment ?? ''}</td>
              </tr>
            ))}
            <tr className={styles.totalRow}>
              <td></td>
              <td></td>
              <td><strong>Total</strong></td>
              <td className={styles.tableRight}><strong>{summary.orderLines.reduce((s, l) => s + l.qty, 0)}</strong></td>
              <td></td>
              <td className={styles.tableRight}><strong>{formatCurrency(summary.totals.totalValue)}</strong></td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </>
    );
  };

  const renderExecuteStep = () => {
    if (isLoading) {
      return (
        <div className={styles.progressList}>
          <div className={`${styles.progressItem} ${styles.progressItemActive}`}>
            <div className={styles.progressIcon}><div className={styles.spinner} /></div>
            Creating order in Soft1... This may take a moment.
          </div>
        </div>
      );
    }

    if (!executionResult) return null;

    return (
      <div className={styles.progressList}>
        {executionResult.brandsCreated.length > 0 && (
          <div className={`${styles.progressItem} ${styles.progressItemDone}`}>
            <div className={styles.progressIcon}>&#10003;</div>
            Created {executionResult.brandsCreated.length} brand(s): {executionResult.brandsCreated.join(', ')}
          </div>
        )}
        {executionResult.productsCreated.length > 0 && (
          <div className={`${styles.progressItem} ${styles.progressItemDone}`}>
            <div className={styles.progressIcon}>&#10003;</div>
            Created {executionResult.productsCreated.length} product(s) in Soft1
          </div>
        )}
        {executionResult.productsLinked.length > 0 && (
          <div className={`${styles.progressItem} ${styles.progressItemDone}`}>
            <div className={styles.progressIcon}>&#10003;</div>
            Linked {executionResult.productsLinked.length} product(s)
          </div>
        )}
        {executionResult.project && (
          <div className={`${styles.progressItem} ${styles.progressItemDone}`}>
            <div className={styles.progressIcon}>&#10003;</div>
            {executionResult.project.isNew ? 'Created' : 'Using existing'} project: {executionResult.project.code}
          </div>
        )}
        {executionResult.order && (
          <div className={styles.successBox}>
            <div className={styles.successTitle}>Order created successfully!</div>
            <div className={styles.successCode}>Order code: {executionResult.order.finCode}</div>
          </div>
        )}
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'resolve-customer': return renderCustomerStep();
      case 'categorize-products': return renderCategorizeStep();
      case 'check-brands': return renderBrandsStep();
      case 'match-products': return renderMatchProductsStep();
      case 'prepare-summary': return renderSummaryStep();
      case 'execute': return renderExecuteStep();
      default: return null;
    }
  };

  // Footer Continue is disabled only when user has not yet provided the input
  // the customer step needs. Once a customer is picked / a code is typed, the
  // footer button drives resolution (no separate inline confirm button).
  const waitingForCustomerInput = (
    currentStep.id === 'resolve-customer' && !resolvedCustomer && (
      (customerNeedsSelection.length > 0 && !selectedCustomer) ||
      (customerNeedsCode && !customerCodeInput.trim())
    )
  );

  const customerInputReady = (
    currentStep.id === 'resolve-customer' && !resolvedCustomer && (
      (customerNeedsSelection.length > 0 && !!selectedCustomer) ||
      !!customerNeedsConfirmation ||
      (customerNeedsCode && !!customerCodeInput.trim())
    )
  );

  // Determine if the confirm button should be disabled
  const confirmDisabled = isLoading || waitingForCustomerInput || (!customerInputReady && !canContinue() && !error);

  const safeHandleConfirm = useCallback(() => {
    if (confirmDisabled) {
      // Show hint if on match-products step and not all selections are made
      if (currentStep.id === 'match-products' && matchComplete && !isLoading && !error) {
        setShowMatchHint(true);
      }
      if (currentStep.id === 'categorize-products' && categorizeComplete && !isLoading && !error) {
        setShowCategorizeHint(true);
      }
      return;
    }
    // Footer Continue resolves customer input when actionable
    if (currentStep.id === 'resolve-customer' && !resolvedCustomer) {
      if (customerNeedsSelection.length > 0 && selectedCustomer) {
        runResolveCustomer({
          customerSelection: { TRDR: selectedCustomer.TRDR, CODE: selectedCustomer.CODE },
          customerConfirmed: true,
        });
        return;
      }
      if (customerNeedsConfirmation) {
        runResolveCustomer({
          customerSelection: { TRDR: customerNeedsConfirmation.TRDR, CODE: customerNeedsConfirmation.CODE },
          customerConfirmed: true,
        });
        return;
      }
      if (customerNeedsCode && customerCodeInput.trim()) {
        runResolveCustomer({ customerCode: customerCodeInput.trim() });
        return;
      }
    }
    setShowMatchHint(false);
    setShowCategorizeHint(false);
    handleConfirm();
  }, [
    confirmDisabled, handleConfirm, currentStep.id, matchComplete, categorizeComplete, isLoading, error,
    resolvedCustomer, customerNeedsSelection, selectedCustomer,
    customerNeedsConfirmation, customerNeedsCode, customerCodeInput,
    runResolveCustomer,
  ]);

  return (
    <>
      <LookupModal
        open={open}
        title="Create Draft Order in Soft1"
        onClose={() => onClose(false)}
        onConfirm={safeHandleConfirm}
        confirmLabel={getConfirmLabel()}
        cancelLabel={currentStep.id === 'execute' && executionResult ? 'Close' : 'Cancel'}
        saving={isLoading}
        footerHint={(() => {
          if (showMatchHint && needsSelection.filter(ns => !userSelections.has(ns.productId)).length > 0) {
            return `Confirm creation for the above (${needsSelection.filter(ns => !userSelections.has(ns.productId)).length}) products before continuing`;
          }
          if (showCategorizeHint) {
            const newProductIds = new Set<number>([
              ...confirmedCreates,
              ...Array.from(userSelections.entries())
                .filter(([, match]) => match.MTRL === CREATE_NEW_SENTINEL)
                .map(([id]) => id),
            ]);
            const incomplete = Array.from(newProductIds).filter(id => {
              const p = categorizedProducts.find(cp => cp.productId === id);
              return !p || !p.description || !p.brandName || !p.subCategoryId || !p.typeId;
            });
            if (incomplete.length > 0) {
              return `${incomplete.length} product${incomplete.length > 1 ? 's are' : ' is'} missing SubCategory or Type — fill in all fields before continuing`;
            }
          }
          return undefined;
        })()}
        cardClassName={lookupStyles.cardWide}
        cardStyle={{ width: 'min(1500px, calc(100% - 32px))', maxWidth: '95vw', maxHeight: '85vh' }}
      >
        {stepBar}
        <div className={styles.stepContent}>
          {error && !isLoading && <div className={styles.errorBox}>{error}</div>}
          {renderStepContent()}
        </div>
      </LookupModal>

      {manualSearchProduct && (
        <LookupModal
          open={true}
          title={`Search Soft1: ${productLabel(manualSearchProduct.partNumberActual, manualSearchProduct.modelNumberActual, manualSearchProduct.productId)}`}
          onClose={closeManualSearch}
          onConfirm={applyManualSearchSelection}
          confirmLabel="Use this match"
          saving={false}
          error={manualSearchError}
          cardStyle={{ width: 'min(1100px, calc(100% - 32px))', maxWidth: '92vw', maxHeight: '80vh' }}
        >
          <div className={styles.manualSearchBody}>
            {(() => {
              const pomTrim = manualSearchPomQuery.trim();
              const descTrim = manualSearchDescQuery.trim();
              const brandTrim = manualSearchBrandQuery.trim();
              const canSearch = !manualSearchLoading && (pomTrim.length >= 2 || descTrim.length >= 2);
              const triggerSearch = () => {
                if (!canSearch) return;
                setBrandComboOpen(false);
                void runManualSearch(pomTrim || null, descTrim || null, brandTrim || null);
              };
              const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') { e.preventDefault(); triggerSearch(); }
              };
              const filteredBrands = brandTrim
                ? erpBrandList.filter(b => b.name.toLowerCase().includes(brandTrim.toLowerCase())).slice(0, 100)
                : erpBrandList.slice(0, 100);
              const ctxDesc = manualSearchProduct.description?.trim();
              return (
                <>
                  {(manualSearchProduct.brandName || manualSearchProduct.partNumberActual || ctxDesc) && (
                    <div className={styles.manualContextChips}>
                      {manualSearchProduct.brandName && (
                        <span><strong>Brand:</strong>{manualSearchProduct.brandName}</span>
                      )}
                      {manualSearchProduct.partNumberActual && (
                        <span><strong>Part No:</strong>{manualSearchProduct.partNumberActual}</span>
                      )}
                      {ctxDesc && (
                        <span title={ctxDesc} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '600px' }}>
                          <strong>Desc:</strong>{ctxDesc}
                        </span>
                      )}
                    </div>
                  )}

                  <div className={styles.manualFieldsGrid}>
                    <div className={styles.manualField}>
                      <span className={styles.manualFieldLabel}>Brand</span>
                      <div className={styles.comboWrapper}>
                        <input
                          type="text"
                          autoComplete="off"
                          className={styles.manualInput}
                          value={manualSearchBrandQuery}
                          onChange={e => {
                            setManualSearchBrandQuery(e.target.value);
                            setBrandComboOpen(true);
                          }}
                          onFocus={() => {
                            void ensureErpBrandsLoaded();
                            // Don't auto-open the dropdown if the brand is
                            // already an exact Soft1 brand (i.e. selected).
                            const isCanonical = erpBrandList.some(b => b.name === manualSearchBrandQuery);
                            if (!isCanonical) setBrandComboOpen(true);
                          }}
                          onBlur={() => { window.setTimeout(() => setBrandComboOpen(false), 150); }}
                          onKeyDown={e => {
                            if (e.key === 'Escape') { setBrandComboOpen(false); return; }
                            if (e.key === 'Enter' && brandComboOpen && filteredBrands.length > 0) {
                              e.preventDefault();
                              setManualSearchBrandQuery(filteredBrands[0].name);
                              setBrandComboOpen(false);
                              return;
                            }
                            onKey(e);
                          }}
                          placeholder={erpBrandsLoaded ? 'Type to filter Soft1 brands...' : 'Loading brands...'}
                        />
                        {brandComboOpen && erpBrandsLoaded && (
                          <div className={styles.comboList} role="listbox">
                            {filteredBrands.length === 0 ? (
                              <div className={styles.comboOptionEmpty}>No matching brands</div>
                            ) : (
                              filteredBrands.map(b => (
                                <button
                                  key={b.MTRMANFCTR}
                                  type="button"
                                  className={styles.comboOption}
                                  onMouseDown={e => e.preventDefault()}
                                  onClick={() => {
                                    setManualSearchBrandQuery(b.name);
                                    setBrandComboOpen(false);
                                  }}
                                >
                                  {b.name}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={styles.manualField}>
                      <span className={styles.manualFieldLabel}>Part / Model No</span>
                      <input
                        type="text"
                        autoComplete="off"
                        className={styles.manualInput}
                        value={manualSearchPomQuery}
                        onChange={e => setManualSearchPomQuery(e.target.value)}
                        onKeyDown={onKey}
                        placeholder="e.g. 48-4319 or MRB-M-X400-C-DXS5"
                        autoFocus
                      />
                    </div>

                    <div className={styles.manualField}>
                      <span className={styles.manualFieldLabel}>Description</span>
                      <input
                        type="text"
                        autoComplete="off"
                        className={styles.manualInput}
                        value={manualSearchDescQuery}
                        onChange={e => setManualSearchDescQuery(e.target.value)}
                        onKeyDown={onKey}
                        placeholder="Keywords from the product name"
                      />
                    </div>
                  </div>

                  <div className={styles.manualToolbar}>
                    <button
                      type="button"
                      className={styles.manualSearchButton}
                      disabled={!canSearch}
                      onClick={triggerSearch}
                    >
                      {manualSearchLoading ? 'Searching...' : 'Search Soft1'}
                    </button>
                    <span className={styles.manualHint}>
                      Smart match — dashes, spaces, dots, slashes and case are ignored.
                    </span>
                    <span className={styles.manualHintRight}>Press Enter in any field to search</span>
                  </div>
                </>
              );
            })()}

            <div className={styles.manualResultsCard}>
              <div className={styles.manualResultsScroll}>
                {manualSearchLoading ? (
                  <div className={styles.manualResultsEmpty}>Searching Soft1...</div>
                ) : manualSearchResults.length === 0 ? (
                  <div className={styles.manualResultsEmpty}>
                    {manualSearchTouched
                      ? 'No results — try a different value or shorten the input.'
                      : 'Enter a Part/Model number or a Description and press Search.'}
                  </div>
                ) : (
                  <table className={styles.table} style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Brand</th>
                        <th>CODE2</th>
                        <th>CODE</th>
                        <th>Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manualSearchResults.map(r => {
                        const selected = r.MTRL === manualSearchSelectedMtrl;
                        return (
                          <tr
                            key={r.MTRL}
                            className={`${styles.manualResultRow} ${selected ? styles.manualResultRowSelected : ''}`}
                            onClick={() => setManualSearchSelectedMtrl(r.MTRL)}
                          >
                            <td>{r.BRANDNAME ?? '—'}</td>
                            <td>{r.CODE2 ?? '—'}</td>
                            <td>{r.CODE ?? '—'}</td>
                            <td title={r.NAME1 ?? ''}>{r.NAME1 ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className={styles.manualFooterCount}>
              {manualSearchResults.length > 0
                ? `${manualSearchResults.length} result(s). Click a row to select, then "Use this match".`
                : ''}
            </div>
          </div>
        </LookupModal>
      )}
    </>
  );
}
