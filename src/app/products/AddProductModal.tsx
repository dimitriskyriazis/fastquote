'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LookupModal from '../components/LookupModal';
import AddBrandModal from '../components/AddBrandModal';
import lookupStyles from '../components/LookupModal.module.css';
import lookupButtonStyles from '../components/LookupAddButton.module.css';
import { showToastMessage } from '../../lib/toast';
import { useDuplicateCheck } from '../lib/useDuplicateCheck';
import DuplicateWarning from '../components/DuplicateWarning';

type LookupOption = {
  id: number;
  name: string;
};

type SubCategoryOption = LookupOption & {
  categoryId: number | null;
};

type ProductLookups = {
  brands: LookupOption[];
  categories: LookupOption[];
  subCategories: SubCategoryOption[];
  types: LookupOption[];
};

type ProductLookupResponse = {
  ok?: boolean;
  error?: string;
  brands?: LookupOption[];
  categories?: LookupOption[];
  subCategories?: SubCategoryOption[];
  types?: LookupOption[];
};

type CreateProductResponse = {
  ok?: boolean;
  error?: string;
  productId?: number | null;
};

type ProductFormState = {
  brandId: string;
  modelNumber: string;
  partNumber: string;
  erpCode: string;
  typeId: string;
  categoryId: string;
  subCategoryId: string;
  description: string;
  weblink: string;
  comments: string;
  enabled: boolean;
};

export type AddProductInitialValues = {
  brandName?: string | null;
  modelNumber?: string | null;
  partNumber?: string | null;
  description?: string | null;
  weblink?: string | null;
  comments?: string | null;
};

const PRODUCT_LOOKUP_ENDPOINT = '/api/products/lookups';
const PRODUCT_CREATE_ENDPOINT = '/api/products/create';

const createEmptyProductForm = (): ProductFormState => ({
  brandId: '',
  modelNumber: '',
  partNumber: '',
  erpCode: '',
  typeId: '',
  categoryId: '',
  subCategoryId: '',
  description: '',
  weblink: '',
  comments: '',
  enabled: true,
});

const parseOptionalId = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onAdded?: (result: { productId?: number | null }) => void;
  initialValues?: AddProductInitialValues | null;
};

export default function AddProductModal({ open, onClose, onAdded, initialValues }: Props) {
  const [lookups, setLookups] = useState<ProductLookups | null>(null);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsError, setLookupsError] = useState<string | null>(null);
  const [form, setForm] = useState<ProductFormState>(createEmptyProductForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [brandText, setBrandText] = useState('');
  const [isBrandListOpen, setIsBrandListOpen] = useState(false);
  const brandListTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);
  const { warnings: duplicateWarnings, check: checkDuplicates, clear: clearDuplicates } = useDuplicateCheck('product');
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      checkDuplicates({ partNumber: form.partNumber, modelNumber: form.modelNumber });
    } else {
      clearDuplicates();
    }
  }, [form.partNumber, form.modelNumber, checkDuplicates, clearDuplicates, open]);

  const loadLookups = useCallback(async () => {
    setLookupsLoading(true);
    setLookupsError(null);
    try {
      const response = await fetch(PRODUCT_LOOKUP_ENDPOINT);
      const payload = (await response.json().catch(() => null)) as ProductLookupResponse | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'Unable to load product lookup data.');
      }
      setLookups({
        brands: payload.brands ?? [],
        categories: payload.categories ?? [],
        subCategories: payload.subCategories ?? [],
        types: payload.types ?? [],
      });
    } catch (err) {
      console.error('Failed to load product lookup data', err);
      setLookupsError(err instanceof Error ? err.message : 'Unable to load lookup data.');
    } finally {
      setLookupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    loadLookups();
  }, [loadLookups, open]);

  const applyInitialValues = useCallback(() => {
    if (!initialValues) return;
    const nextBrandText = initialValues.brandName?.trim() ?? '';
    const nextDescription = initialValues.description?.trim() ?? '';
    const hasAnyInitialValue = Boolean(
      nextBrandText
      || (initialValues.modelNumber?.trim() ?? '')
      || (initialValues.partNumber?.trim() ?? '')
      || nextDescription
      || (initialValues.weblink?.trim() ?? '')
      || (initialValues.comments?.trim() ?? ''),
    );
    if (!hasAnyInitialValue) return;
    setForm((prev) => ({
      ...prev,
      brandId: '',
      modelNumber: initialValues.modelNumber?.trim() ?? '',
      partNumber: initialValues.partNumber?.trim() ?? '',
      description: nextDescription,
      weblink: initialValues.weblink?.trim() ?? '',
      comments: initialValues.comments?.trim() ?? '',
    }));
    setBrandText(nextBrandText);
    setFormError(null);
  }, [initialValues]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      applyInitialValues();
    }
    wasOpenRef.current = open;
  }, [applyInitialValues, open]);

  const updateFormField = useCallback((field: keyof ProductFormState, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormError(null);
  }, []);

  const cancelBrandListClose = useCallback(() => {
    if (brandListTimerRef.current) {
      clearTimeout(brandListTimerRef.current);
      brandListTimerRef.current = null;
    }
  }, []);

  const scheduleBrandListClose = useCallback(() => {
    cancelBrandListClose();
    brandListTimerRef.current = setTimeout(() => {
      setIsBrandListOpen(false);
      brandListTimerRef.current = null;
    }, 120);
  }, [cancelBrandListClose]);

  useEffect(() => {
    if (open) return;
    cancelBrandListClose();
    setIsBrandListOpen(false);
  }, [cancelBrandListClose, open]);

  const handleBrandInputFocus = useCallback(() => {
    cancelBrandListClose();
    setIsBrandListOpen(true);
  }, [cancelBrandListClose]);

  const handleBrandInputBlur = useCallback(() => {
    scheduleBrandListClose();
  }, [scheduleBrandListClose]);

  const handleBrandInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setBrandText(value);
      updateFormField('brandId', '');
      setIsBrandListOpen(true);
    },
    [updateFormField],
  );

  const handleBrandOptionSelect = useCallback(
    (option: LookupOption) => {
      cancelBrandListClose();
      updateFormField('brandId', String(option.id));
      setBrandText(option.name || `Brand ${option.id}`);
      setIsBrandListOpen(false);
    },
    [cancelBrandListClose, updateFormField],
  );

  const handleBrandCreated = useCallback(
    (brand: { id: number; name: string }) => {
      setLookups((prev) => {
        const base =
          prev ??
          ({
            brands: [],
            categories: [],
            subCategories: [],
            types: [],
          } as ProductLookups);
        if (base.brands.some((existing) => existing.id === brand.id)) return base;
        return { ...base, brands: [...base.brands, { id: brand.id, name: brand.name }] };
      });
      updateFormField('brandId', String(brand.id));
      setBrandText(brand.name);
      setIsBrandListOpen(false);
    },
    [updateFormField],
  );

  const handleCreateProduct = useCallback(async () => {
    if (!form.brandId) {
      setFormError('Brand is required.');
      return;
    }
    const trimmedDescription = form.description.trim();
    if (!trimmedDescription) {
      setFormError('Description is required.');
      return;
    }
    const trimmedModelNumber = form.modelNumber.trim();
    const trimmedPartNumber = form.partNumber.trim();
    if (!trimmedModelNumber && !trimmedPartNumber) {
      setFormError('Please provide a part number or model number.');
      return;
    }
    setFormError(null);
    setSavingProduct(true);
    try {
      const payload = {
        brandId: parseOptionalId(form.brandId),
        modelNumber: trimmedModelNumber || null,
        partNumber: trimmedPartNumber || null,
        erpCode: form.erpCode.trim() || null,
        typeId: parseOptionalId(form.typeId),
        categoryId: parseOptionalId(form.categoryId),
        subCategoryId: parseOptionalId(form.subCategoryId),
        description: trimmedDescription,
        weblink: form.weblink.trim() || null,
        comments: form.comments.trim() || null,
        enabled: form.enabled,
      };
      const response = await fetch(PRODUCT_CREATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as CreateProductResponse | null;
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error ?? 'Unable to add product. Please try again.');
      }
      showToastMessage('Product added', 'success');
      setForm(createEmptyProductForm());
      setBrandText('');
      setFormError(null);
      onAdded?.({ productId: result.productId ?? null });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to add product. Please try again.';
      setFormError(message);
    } finally {
      setSavingProduct(false);
    }
  }, [form, onAdded, onClose]);

  const isModelOrPartInvalid = formError === 'Please provide a part number or model number.';

  const brandOptions = useMemo(() => lookups?.brands ?? [], [lookups]);
  const selectedBrand = useMemo(
    () => brandOptions.find((option) => String(option.id) === form.brandId) ?? null,
    [brandOptions, form.brandId],
  );
  const filteredBrandOptions = useMemo(() => {
    const query = brandText.trim().toLowerCase();
    if (!query) return brandOptions;
    return brandOptions.filter((option) => {
      const label = (option.name || `Brand ${option.id}`).toLowerCase();
      const idText = String(option.id).toLowerCase();
      return label.includes(query) || idText.includes(query);
    });
  }, [brandOptions, brandText]);
  const typeOptions = lookups?.types ?? [];
  const categoryOptions = lookups?.categories ?? [];
  const subCategoryOptions = (lookups?.subCategories ?? []).filter((option) => option.categoryId === parseOptionalId(form.categoryId));

  const modalError = formError ?? lookupsError;

  useEffect(() => {
    if (!selectedBrand || isBrandListOpen) return;
    const label = selectedBrand.name || `Brand ${selectedBrand.id}`;
    if (brandText !== label) {
      setBrandText(label);
    }
  }, [brandText, isBrandListOpen, selectedBrand]);

  useEffect(() => {
    if (!lookups || form.brandId) return;
    const normalized = brandText.trim().toLocaleLowerCase();
    if (!normalized) return;
    const matched = lookups.brands.find((option) => (option.name || '').trim().toLocaleLowerCase() === normalized);
    if (!matched) return;
    setForm((prev) => {
      if (prev.brandId) return prev;
      return { ...prev, brandId: String(matched.id) };
    });
  }, [brandText, form.brandId, lookups]);

  useEffect(() => () => cancelBrandListClose(), [cancelBrandListClose]);

  return (
    <LookupModal
      open={open}
      title="Add product"
      onClose={onClose}
      onConfirm={handleCreateProduct}
      confirmLabel="Add product"
      saving={savingProduct}
      error={modalError}
      overlayClassName={lookupStyles.overlayHigh}
      cardClassName={lookupStyles.cardWide}
    >
      <div className={lookupStyles.fieldGrid}>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <div className={lookupStyles.labelRow}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-brand">
              <span className={lookupStyles.labelText}>
                Brand <span className={lookupStyles.requiredMark}>*</span>
              </span>
            </label>
            <button
              type="button"
              className={lookupButtonStyles.lookupAddButton}
              onClick={() => setIsAddBrandOpen(true)}
            >
              Add New Brand
            </button>
          </div>
          <div className={lookupStyles.comboWrapper}>
            <input
              id="product-brand"
              autoComplete="off"
              className={`${lookupStyles.fieldControl} ${lookupStyles.comboInput}`}
              value={brandText}
              required
              placeholder="Type to filter brands..."
              onChange={handleBrandInputChange}
              onFocus={handleBrandInputFocus}
              onBlur={handleBrandInputBlur}
              disabled={lookupsLoading}
            />
            {isBrandListOpen && filteredBrandOptions.length > 0 ? (
              <div className={lookupStyles.comboList}>
                {filteredBrandOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={lookupStyles.comboOption}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleBrandOptionSelect(option)}
                  >
                    {option.name || `Brand ${option.id}`}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf} ${lookupStyles.fieldNudgeDown}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-type">
            Type
          </label>
          <select
            id="product-type"
            className={lookupStyles.fieldControl}
            value={form.typeId}
            onChange={(event) => updateFormField('typeId', event.target.value)}
            disabled={lookupsLoading}
          >
            <option value="">Select type...</option>
            {typeOptions.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.name || `Type ${option.id}`}
              </option>
            ))}
          </select>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-category">
            Category
          </label>
          <select
            id="product-category"
            className={lookupStyles.fieldControl}
            value={form.categoryId}
            onChange={(event) => updateFormField('categoryId', event.target.value)}
            disabled={lookupsLoading}
          >
            <option value="">Select category...</option>
            {categoryOptions.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.name || `Category ${option.id}`}
              </option>
            ))}
          </select>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-sub-category">
            Sub-category
          </label>
          <select
            id="product-sub-category"
            className={lookupStyles.fieldControl}
            value={form.subCategoryId}
            onChange={(event) => updateFormField('subCategoryId', event.target.value)}
            disabled={lookupsLoading}
          >
            <option value="">Select sub-category...</option>
            {subCategoryOptions.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.name || `Sub-category ${option.id}`}
              </option>
            ))}
          </select>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-model">
            Model number
          </label>
          <input
            id="product-model"
            className={lookupStyles.fieldControl}
            aria-invalid={isModelOrPartInvalid}
            value={form.modelNumber}
            onChange={(event) => updateFormField('modelNumber', event.target.value)}
          />
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-part">
            Part number
          </label>
          <input
            id="product-part"
            className={lookupStyles.fieldControl}
            aria-invalid={isModelOrPartInvalid}
            value={form.partNumber}
            onChange={(event) => updateFormField('partNumber', event.target.value)}
          />
          <div className={lookupStyles.fieldHint}>
            Provide either a model number or a part number.
          </div>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldFull}`}>
          <DuplicateWarning warnings={duplicateWarnings} />
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-erp">
            ERP Code
          </label>
          <input
            id="product-erp"
            className={lookupStyles.fieldControl}
            value={form.erpCode}
            onChange={(event) => updateFormField('erpCode', event.target.value)}
          />
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-link">
            Web link
          </label>
          <input
            id="product-link"
            className={lookupStyles.fieldControl}
            value={form.weblink}
            onChange={(event) => updateFormField('weblink', event.target.value)}
          />
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldFull}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-description">
            Description <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <textarea
            id="product-description"
            className={lookupStyles.fieldControl}
            rows={3}
            value={form.description}
            required
            onChange={(event) => updateFormField('description', event.target.value)}
          />
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldFull}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-comments">
            Comments
          </label>
          <textarea
            id="product-comments"
            className={lookupStyles.fieldControl}
            rows={2}
            value={form.comments}
            onChange={(event) => updateFormField('comments', event.target.value)}
          />
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldFull}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-enabled">
            Enabled
          </label>
          <label className={lookupStyles.checkboxLabel}>
            <input
              id="product-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => updateFormField('enabled', event.target.checked)}
            />
            Yes
          </label>
        </div>
      </div>
      <AddBrandModal
        open={isAddBrandOpen}
        onClose={() => setIsAddBrandOpen(false)}
        onCreated={handleBrandCreated}
        overlayClassName={lookupStyles.overlayHigh}
      />
    </LookupModal>
  );
}
