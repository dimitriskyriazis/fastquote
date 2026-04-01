'use client';

import { useState, useCallback, useEffect } from 'react';
import LookupModal from '../../../components/LookupModal';
import lookupStyles from '../../../components/LookupModal.module.css';
import styles from './DraftOrderWizard.module.css';

// ── Types ──────────────────────────────────────────────────────────────────────

type CustomerMatch = { TRDR: number; CODE: string | null; NAME: string | null };

type CategorizedProduct = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  brandName: string | null;
  categoryName: string | null;
  subCategoryName: string | null;
  typeName: string | null;
  wasAiCategorized: boolean;
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
  matches: Array<{ MTRL: number; CODE: string | null; CODE1: string | null; CODE2: string | null; NAME1: string | null }>;
};

type OrderLine = {
  productId: number | null;
  productCode: string;
  productName: string;
  qty: number;
  price: number;
  lineTotal: number;
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

type WizardStepId = 'resolve-customer' | 'categorize-products' | 'check-brands' | 'match-products' | 'prepare-summary' | 'execute';

const STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'resolve-customer', label: 'Customer' },
  { id: 'categorize-products', label: 'Categories' },
  { id: 'check-brands', label: 'Brands' },
  { id: 'match-products', label: 'Products' },
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

function productLabel(partNumber: string | null, modelNumber: string | null, productId?: number): string {
  const pn = partNumber?.trim();
  const mn = modelNumber?.trim();
  if (pn && mn) return `${pn} / ${mn}`;
  return pn || mn || `Product #${productId ?? '?'}`;
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

  // Step 3: Brand check
  const [missingBrands, setMissingBrands] = useState<string[]>([]);
  const [existingBrands, setExistingBrands] = useState<string[]>([]);
  const [nearMatchBrands, setNearMatchBrands] = useState<Array<{ fastquoteName: string; erpName: string; MTRMANFCTR: number }>>([]);
  const [brandDecisions, setBrandDecisions] = useState<Map<string, 'accept' | 'create'>>(new Map());
  const [brandsCheckComplete, setBrandsCheckComplete] = useState(false);

  // Step 4: Product matching
  const [autoMatched, setAutoMatched] = useState<AutoMatchedProduct[]>([]);
  const [needsSelection, setNeedsSelection] = useState<ProductNeedsSelection[]>([]);
  const [skipped, setSkipped] = useState<SkippedProduct[]>([]);
  const [userSelections, setUserSelections] = useState<Map<number, { MTRL: number; CODE: string | null }>>(new Map());
  const [confirmedCreates, setConfirmedCreates] = useState<number[]>([]);
  const [matchComplete, setMatchComplete] = useState(false);

  // Step 5: Summary
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
    const result = await callStep('categorize-products');
    if (!result) return;
    setCategorizedProducts(result.products ?? []);
    setCategorizeComplete(true);
  }, [callStep]);

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
    const result = await callStep('execute', {
      resolvedCustomer,
      missingBrands,
      matchResults,
    });
    if (!result) return;
    setExecutionResult(result);
  }, [callStep, resolvedCustomer, missingBrands, autoMatched, confirmedCreates, userSelections, skipped]);

  // ── Auto-run step on mount / step change ─────────────────────────────────

  useEffect(() => {
    if (!open) return;
    // Auto-run the step when we land on it (unless it already completed or needs user input)
    if (currentStep.id === 'resolve-customer' && !resolvedCustomer && !customerNeedsSelection.length && !customerNeedsConfirmation && !customerNeedsCode) {
      runResolveCustomer();
    } else if (currentStep.id === 'categorize-products' && !categorizeComplete) {
      runCategorizeProducts();
    } else if (currentStep.id === 'check-brands' && !brandsCheckComplete) {
      runCheckBrands();
    } else if (currentStep.id === 'match-products' && !matchComplete) {
      runMatchProducts();
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
      case 'categorize-products':
        return categorizeComplete;
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
      for (const nm of nearMatchBrands) {
        const decision = brandDecisions.get(nm.fastquoteName);
        if (decision === 'accept') {
          newExisting.push(nm.fastquoteName);
        } else {
          newMissing.push(nm.fastquoteName);
        }
      }
      setExistingBrands(newExisting);
      setMissingBrands(newMissing);
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
  }, [currentStep, needsSelection, userSelections, autoMatched, nearMatchBrands, brandDecisions, existingBrands, missingBrands, onClose]);

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
          <button
            type="button"
            className={lookupStyles.confirmButton}
            style={{ alignSelf: 'flex-end', marginTop: '8px' }}
            onClick={() => {
              if (!selectedCustomer) return;
              runResolveCustomer({
                customerSelection: { TRDR: selectedCustomer.TRDR, CODE: selectedCustomer.CODE },
                customerConfirmed: true,
              });
            }}
            disabled={!selectedCustomer || isLoading}
          >
            {isLoading ? 'Confirming...' : 'Confirm Selection'}
          </button>
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

  const renderCategorizeStep = () => {
    if (isLoading) return renderLoading('Analyzing products and assigning categories...');

    if (categorizedProducts.length === 0) {
      return <div className={styles.noProducts}>No products found in this offer.</div>;
    }

    const aiCount = categorizedProducts.filter(p => p.wasAiCategorized).length;

    return (
      <>
        <p className={styles.sectionTitle}>
          Product Categories
          {aiCount > 0 && <span className={styles.sectionCount}>({aiCount} auto-categorized by AI)</span>}
        </p>
        <table className={styles.table}>
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
            {categorizedProducts.map(p => (
              <tr key={p.productId}>
                <td>{productLabel(p.partNumber, p.modelNumber, p.productId)}</td>
                <td>{p.brandName ?? '—'}</td>
                <td>{[p.modelNumber, p.description].filter(Boolean).join(' - ') || '—'}</td>
                <td>{p.categoryName ?? '—'}{p.wasAiCategorized && <span className={`${styles.badge} ${styles.badgeAi}`}>AI</span>}</td>
                <td>{p.subCategoryName ?? '—'}{p.wasAiCategorized && <span className={`${styles.badge} ${styles.badgeAi}`}>AI</span>}</td>
                <td>{p.typeName ?? '—'}{p.wasAiCategorized && <span className={`${styles.badge} ${styles.badgeAi}`}>AI</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  };

  const renderBrandsStep = () => {
    if (isLoading) return renderLoading('Checking brands in Soft1...');

    if (!brandsCheckComplete) return null;

    if (missingBrands.length === 0 && existingBrands.length === 0) {
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
                      <span style={{ color: '#64748b' }}>{' → '}</span>
                      <span style={{ fontWeight: 700, color: '#166534' }}>{nm.erpName}</span>
                      <span style={{ color: '#64748b', fontSize: '0.75rem' }}> in Soft1</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        style={{
                          padding: '6px 16px', fontSize: '0.85rem', borderRadius: '4px', cursor: 'pointer',
                          border: decision === 'accept' ? '2px solid #166534' : '1px solid #d1d5db',
                          background: decision === 'accept' ? '#dcfce7' : '#fff',
                          color: decision === 'accept' ? '#166534' : '#374151',
                          fontWeight: decision === 'accept' ? 700 : 400,
                        }}
                        onClick={() => setBrandDecisions(prev => { const next = new Map(prev); next.set(nm.fastquoteName, 'accept'); return next; })}
                      >
                        Use &quot;{nm.erpName}&quot;
                      </button>
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
                          if (match.CODE) parts.push(match.CODE);
                          if (match.CODE2) parts.push(match.CODE2);
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
          return (
            <div className={`${styles.card} ${styles.cardRed}`}>
              <p className={styles.sectionTitle} style={{ color: '#991b1b' }}>
                No matches found ({noMatches.length})
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
                {noMatches.map(ns => {
                  const label = productLabel(ns.partNumberActual, ns.modelNumberActual, ns.productId);
                  const desc = [ns.modelNumberActual, ns.description].filter(Boolean).join(' - ');
                  const categoryPath = [ns.categoryName, ns.subCategoryName, ns.typeName].filter(Boolean).join(' > ');
                  const isConfirmed = userSelections.get(ns.productId)?.MTRL === CREATE_NEW_SENTINEL;
                  return (
                    <div key={ns.productId} style={{ borderBottom: '1px solid #fecaca', paddingBottom: '10px' }}>
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
                      {ns.canCreate ? (
                        <button
                          type="button"
                          style={{
                            marginTop: '4px', padding: '5px 14px', fontSize: '0.8rem', borderRadius: '4px', cursor: 'pointer',
                            border: isConfirmed ? '2px solid #166534' : '1px solid #fca5a5',
                            background: isConfirmed ? '#dcfce7' : '#fff',
                            color: isConfirmed ? '#166534' : '#991b1b',
                            fontWeight: isConfirmed ? 700 : 500,
                          }}
                          onClick={() => {
                            setUserSelections(prev => {
                              const next = new Map(prev);
                              if (isConfirmed) {
                                next.delete(ns.productId);
                              } else {
                                next.set(ns.productId, { MTRL: CREATE_NEW_SENTINEL, CODE: null });
                              }
                              return next;
                            });
                          }}
                        >
                          {isConfirmed ? 'Will be created in Soft1' : 'Confirm creation in Soft1'}
                        </button>
                      ) : (
                        <div style={{ fontSize: '0.8rem', color: '#dc2626', marginTop: '4px' }}>
                          Cannot create — missing: {ns.missingFields?.join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
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
              <li>Create 1 order with {summary.totals.lineCount} line(s)</li>
            </ul>
          </>
        )}

        <p className={styles.sectionTitle}>Order Lines ({summary.totals.lineCount})</p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Product</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Price</th>
              <th className={styles.tableRight}>Total</th>
            </tr>
          </thead>
          <tbody>
            {summary.orderLines.map((line, idx) => (
              <tr key={`${line.productId}-${idx}`}>
                <td>{idx + 1}</td>
                <td>{line.productCode !== '(new)' ? `${line.productCode} — ` : ''}{line.productName}</td>
                <td className={styles.tableRight}>{line.qty}</td>
                <td className={styles.tableRight}>{formatCurrency(line.price)}</td>
                <td className={styles.tableRight}>{formatCurrency(line.lineTotal)}</td>
              </tr>
            ))}
            <tr className={styles.totalRow}>
              <td></td>
              <td><strong>Total</strong></td>
              <td className={styles.tableRight}><strong>{summary.orderLines.reduce((s, l) => s + l.qty, 0)}</strong></td>
              <td></td>
              <td className={styles.tableRight}><strong>{formatCurrency(summary.totals.totalValue)}</strong></td>
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

  // Don't show Continue button when waiting for user input in customer step
  const waitingForCustomerInput = (
    currentStep.id === 'resolve-customer' && !resolvedCustomer && (customerNeedsSelection.length > 0 || !!customerNeedsConfirmation || customerNeedsCode)
  );

  // Determine if the confirm button should be disabled
  const confirmDisabled = isLoading || waitingForCustomerInput || (!canContinue() && !error);

  const safeHandleConfirm = useCallback(() => {
    if (confirmDisabled) return;
    handleConfirm();
  }, [confirmDisabled, handleConfirm]);

  return (
    <LookupModal
      open={open}
      title="Create Draft Order in Soft1"
      onClose={() => onClose(false)}
      onConfirm={safeHandleConfirm}
      confirmLabel={getConfirmLabel()}
      cancelLabel={currentStep.id === 'execute' && executionResult ? 'Close' : 'Cancel'}
      saving={isLoading}
      cardClassName={lookupStyles.cardWide}
      cardStyle={{ width: 'min(1200px, calc(100% - 32px))', maxWidth: '95vw', maxHeight: '85vh' }}
    >
      {stepBar}
      <div className={styles.stepContent}>
        {error && !isLoading && <div className={styles.errorBox}>{error}</div>}
        {renderStepContent()}
      </div>
    </LookupModal>
  );
}
