'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LookupModal from '../components/LookupModal';
import lookupStyles from '../components/LookupModal.module.css';
import { showToastMessage } from '../../lib/toast';

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
  erpPartNumber: string;
  typeId: string;
  categoryId: string;
  subCategoryId: string;
  description: string;
  weblink: string;
  comments: string;
  enabled: boolean;
};

const PRODUCT_LOOKUP_ENDPOINT = '/api/products/lookups';
const PRODUCT_CREATE_ENDPOINT = '/api/products/create';

const createEmptyProductForm = (): ProductFormState => ({
  brandId: '',
  modelNumber: '',
  partNumber: '',
  erpPartNumber: '',
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
};

export default function AddProductModal({ open, onClose, onAdded }: Props) {
  const [lookups, setLookups] = useState<ProductLookups | null>(null);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsError, setLookupsError] = useState<string | null>(null);
  const [form, setForm] = useState<ProductFormState>(createEmptyProductForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);

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

  const updateFormField = useCallback((field: keyof ProductFormState, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormError(null);
  }, []);

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
        erpPartNumber: form.erpPartNumber.trim() || null,
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

  const brandOptions = lookups?.brands ?? [];
  const typeOptions = lookups?.types ?? [];
  const categoryOptions = lookups?.categories ?? [];
  const subCategoryOptions = (lookups?.subCategories ?? []).filter((option) => option.categoryId === parseOptionalId(form.categoryId));

  const modalError = formError ?? lookupsError;

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
          <label className={lookupStyles.fieldLabel} htmlFor="product-brand">
            Brand <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <select
            id="product-brand"
            className={lookupStyles.fieldControl}
            value={form.brandId}
            onChange={(event) => updateFormField('brandId', event.target.value)}
            disabled={lookupsLoading}
          >
            <option value="">Select brand...</option>
            {brandOptions.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.name || `Brand ${option.id}`}
              </option>
            ))}
          </select>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
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
            value={form.partNumber}
            onChange={(event) => updateFormField('partNumber', event.target.value)}
          />
          <div className={lookupStyles.fieldHint}>
            Provide either a model number or a part number.
          </div>
        </div>
        <div className={`${lookupStyles.field} ${lookupStyles.fieldHalf}`}>
          <label className={lookupStyles.fieldLabel} htmlFor="product-erp">
            ERP part number
          </label>
          <input
            id="product-erp"
            className={lookupStyles.fieldControl}
            value={form.erpPartNumber}
            onChange={(event) => updateFormField('erpPartNumber', event.target.value)}
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
    </LookupModal>
  );
}
