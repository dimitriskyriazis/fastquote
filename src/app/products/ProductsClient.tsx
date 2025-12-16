"use client";

import React, { useMemo, useCallback, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import type { ColDef, DefaultMenuItem, GetContextMenuItemsParams, MenuItemDef } from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { openLinkInNewTab } from "../../lib/navigation";
import { showToastMessage } from "../../lib/toast";
import styles from "./ProductsClient.module.css";
import LookupModal from "../components/LookupModal";
import lookupStyles from "../components/LookupModal.module.css";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>Loading products…</div>
  ),
});

const productHistoryMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--history" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5a7 7 0 1 1-7 7" />
      <path d="M12 9v4l2.6 1.5" />
      <path d="M5 7 4 4l3 1" />
    </svg>
  </span>
`;

const HISTORY_BACK_HREF = "/products";
const HISTORY_BACK_LABEL = "products";

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const resolveProductLabel = (row: Record<string, unknown> | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const brand = typeof row.Brand === "string" ? row.Brand.trim() : "";
  const model = typeof row.ModelNumber === "string" ? row.ModelNumber.trim() : "";
  const part = typeof row.PartNumber === "string" ? row.PartNumber.trim() : "";
  const segments = [part, model].filter((segment) => segment.length > 0);
  const prefix = brand.length > 0 ? `${brand} – ` : "";
  if (segments.length > 0) return `${prefix}${segments.join(" – ")}`;
  if (brand.length > 0) return brand;
  const description = typeof row.Description === "string" ? row.Description.trim() : "";
  if (description.length > 0) return description;
  return fallback;
};

const PRODUCT_ROW_TYPE = "product";

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

const PRODUCT_LOOKUP_ENDPOINT = "/api/products/lookups";
const PRODUCT_CREATE_ENDPOINT = "/api/products/create";

const createEmptyProductForm = (): ProductFormState => ({
  brandId: "",
  modelNumber: "",
  partNumber: "",
  erpPartNumber: "",
  typeId: "",
  categoryId: "",
  subCategoryId: "",
  description: "",
  weblink: "",
  comments: "",
  enabled: true,
});

const parseOptionalId = (value: string | null | undefined): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
};

export default function ProductsClient() {
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [lookups, setLookups] = useState<ProductLookups | null>(null);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsError, setLookupsError] = useState<string | null>(null);
  const [form, setForm] = useState<ProductFormState>(createEmptyProductForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const columnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Brand",
      headerName: "Brand",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "ModelNumber",
      headerName: "Model",
      filter: "agTextColumnFilter",
      minWidth: 180,
      flex: 1,
    },
    {
      field: "PartNumber",
      headerName: "Part number",
      filter: "agTextColumnFilter",
      minWidth: 180,
    },
    {
      field: "ERPPartNumber",
      headerName: "ERP part number",
      filter: "agTextColumnFilter",
      minWidth: 180,
    },
    {
      field: "Description",
      headerName: "Description",
      filter: "agTextColumnFilter",
      minWidth: 280,
      width: 320,
    },
    {
      field: "Category",
      headerName: "Category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "SubCategory",
      headerName: "Sub-category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "Type",
      headerName: "Type",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "WebLink",
      headerName: "Web link",
      filter: "agTextColumnFilter",
      minWidth: 220,
      flex: 1,
    },
  ], []);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/products",
        resolveRowId: (row) => normalizeProductId((row as { ProductID?: unknown } | null)?.ProductID ?? null),
        resolveRowLabel: (row, fallback) => resolveProductLabel(row, fallback),
        resolveRowTypeLabel: () => PRODUCT_ROW_TYPE,
        buildPayload: (ids) => ({ ProductIDs: ids }),
        confirmTitle: "Delete product",
        confirmConfirmLabel: "Delete product",
        confirmCancelLabel: "Keep product",
        successToastMessage: "Product deleted",
        failureToastMessage: "Unable to delete product. Please try again.",
      }),
    [],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> =
        (productRowDeletion.getContextMenuItems(params) ?? []).map((item) => item);
      const rowData = params.node?.data ?? null;
      if (!rowData) {
        return items;
      }
      const rawProductId = (rowData as { ProductID?: unknown }).ProductID;
      const productId =
        typeof rawProductId === "number"
          ? rawProductId
          : typeof rawProductId === "string"
            ? Number.parseInt(rawProductId, 10)
            : null;
      if (!productId || !Number.isInteger(productId)) {
        return items;
      }

      const historyItem: MenuItemDef = {
        name: "View product history",
        icon: productHistoryMenuIcon,
        action: () => {
          const qs = new URLSearchParams();
          qs.set("backHref", HISTORY_BACK_HREF);
          qs.set("backLabel", HISTORY_BACK_LABEL);
          openLinkInNewTab(
            `/products/${encodeURIComponent(String(productId))}/history?${qs.toString()}`,
          );
        },
      };

      const deleteIndex = items.findIndex(
        (item) =>
          typeof item === "object" &&
          item != null &&
          (item as MenuItemDef).name === "Delete row",
      );
      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, historyItem);
      } else {
        items.push(historyItem);
      }

      return items;
    },
    [productRowDeletion],
  );

  useEffect(() => {
    let cancelled = false;
    const loadLookups = async () => {
      setLookupsLoading(true);
      setLookupsError(null);
      try {
        const response = await fetch(PRODUCT_LOOKUP_ENDPOINT);
        const payload = (await response.json().catch(() => null)) as
          | ProductLookupResponse
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to load product lookup data.");
        }
        if (cancelled) return;
        setLookups({
          brands: payload.brands ?? [],
          categories: payload.categories ?? [],
          subCategories: payload.subCategories ?? [],
          types: payload.types ?? [],
        });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Unable to load product lookup data.";
        setLookupsError(message);
        setLookups(null);
      } finally {
        if (!cancelled) {
          setLookupsLoading(false);
        }
      }
    };
    void loadLookups();
    return () => {
      cancelled = true;
    };
  }, []);

  const openAddProduct = useCallback(() => {
    setIsAddProductOpen(true);
    setFormError(null);
  }, []);

  const closeAddProduct = useCallback(() => {
    setIsAddProductOpen(false);
    setFormError(null);
    setForm(createEmptyProductForm());
  }, []);

  const updateFormField = useCallback(
    <K extends keyof ProductFormState>(field: K, value: ProductFormState[K]) => {
      setForm((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const selectedCategoryId = form.categoryId ? parseOptionalId(form.categoryId) : null;

  const filteredSubCategories = useMemo(() => {
    if (!lookups) return [];
    if (selectedCategoryId == null) return lookups.subCategories;
    return lookups.subCategories.filter(
      (option) => option.categoryId == null || option.categoryId === selectedCategoryId,
    );
  }, [lookups, selectedCategoryId]);

  const handleCreateProduct = useCallback(async () => {
    const brandId = parseOptionalId(form.brandId);
    if (brandId == null) {
      setFormError("Please select a brand.");
      return;
    }
    setSavingProduct(true);
    setFormError(null);
    try {
      const payload = {
        brandId,
        modelNumber: form.modelNumber.trim(),
        partNumber: form.partNumber.trim(),
        erpPartNumber: form.erpPartNumber.trim(),
        typeId: parseOptionalId(form.typeId),
        categoryId: parseOptionalId(form.categoryId),
        subCategoryId: parseOptionalId(form.subCategoryId),
        description: form.description.trim(),
        weblink: form.weblink.trim(),
        comments: form.comments.trim(),
        enabled: form.enabled,
      };
      const response = await fetch(PRODUCT_CREATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as CreateProductResponse | null;
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error ?? "Unable to add product. Please try again.");
      }
      closeAddProduct();
      setRefreshToken((prev) => prev + 1);
      showToastMessage("Product added", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to add product. Please try again.";
      setFormError(message);
    } finally {
      setSavingProduct(false);
    }
  }, [form, closeAddProduct]);

  const brandOptions = lookups?.brands ?? [];
  const typeOptions = lookups?.types ?? [];
  const categoryOptions = lookups?.categories ?? [];

  const modalError = formError ?? lookupsError;

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Products"
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.headerButton} page-header-button`}
                onClick={openAddProduct}
              >
                Add Product
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/products"
                columnDefs={columnDefs}
                getContextMenuItems={getContextMenuItems}
                rowGroupPanelShow="always"
                autoSizeExclusions={["Description"]}
                columnStateNamespace="products-v2"
                refreshToken={refreshToken}
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
      </main>
      <LookupModal
        open={isAddProductOpen}
        title="Add product"
        onClose={closeAddProduct}
        onConfirm={handleCreateProduct}
        confirmLabel="Add product"
        saving={savingProduct}
        error={modalError}
      >
        <div className={styles.modalGrid}>
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-brand">
              Brand <span className={lookupStyles.requiredMark}>*</span>
            </label>
            <select
              id="product-brand"
              className={lookupStyles.fieldControl}
              value={form.brandId}
              onChange={(event) => updateFormField("brandId", event.target.value)}
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
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-type">
              Type
            </label>
            <select
              id="product-type"
              className={lookupStyles.fieldControl}
              value={form.typeId}
              onChange={(event) => updateFormField("typeId", event.target.value)}
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
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-category">
              Category
            </label>
            <select
              id="product-category"
              className={lookupStyles.fieldControl}
              value={form.categoryId}
              onChange={(event) => updateFormField("categoryId", event.target.value)}
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
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-sub-category">
              Sub-category
            </label>
            <select
              id="product-sub-category"
              className={lookupStyles.fieldControl}
              value={form.subCategoryId}
              onChange={(event) => updateFormField("subCategoryId", event.target.value)}
              disabled={lookupsLoading}
            >
              <option value="">Select sub-category...</option>
              {filteredSubCategories.map((option) => (
                <option key={option.id} value={String(option.id)}>
                  {option.name || `Sub-category ${option.id}`}
                </option>
              ))}
            </select>
          </div>
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-model">
              Model number
            </label>
            <input
              id="product-model"
              className={lookupStyles.fieldControl}
              value={form.modelNumber}
              onChange={(event) => updateFormField("modelNumber", event.target.value)}
            />
          </div>
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-part">
              Part number
            </label>
            <input
              id="product-part"
              className={lookupStyles.fieldControl}
              value={form.partNumber}
              onChange={(event) => updateFormField("partNumber", event.target.value)}
            />
          </div>
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-erp-part">
              ERP part number
            </label>
            <input
              id="product-erp-part"
              className={lookupStyles.fieldControl}
              value={form.erpPartNumber}
              onChange={(event) => updateFormField("erpPartNumber", event.target.value)}
            />
          </div>
          <div className={`${lookupStyles.field} ${styles.modalField}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-weblink">
              Web link
            </label>
            <input
              id="product-weblink"
              className={lookupStyles.fieldControl}
              value={form.weblink}
              onChange={(event) => updateFormField("weblink", event.target.value)}
            />
          </div>
          <div className={`${lookupStyles.field} ${styles.modalFieldFull}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-description">
              Description
            </label>
            <textarea
              id="product-description"
              className={`${lookupStyles.fieldControl} ${lookupStyles.textarea}`}
              value={form.description}
              onChange={(event) => updateFormField("description", event.target.value)}
              rows={3}
            />
          </div>
          <div className={`${lookupStyles.field} ${styles.modalFieldFull}`}>
            <label className={lookupStyles.fieldLabel} htmlFor="product-comments">
              Comments
            </label>
            <textarea
              id="product-comments"
              className={`${lookupStyles.fieldControl} ${lookupStyles.textarea}`}
              value={form.comments}
              onChange={(event) => updateFormField("comments", event.target.value)}
              rows={3}
            />
          </div>
          <div className={styles.modalToggleRow}>
            <label className={styles.modalToggleLabel} htmlFor="product-enabled">
              Enabled
            </label>
            <label className={styles.toggleControl} htmlFor="product-enabled">
              <input
                type="checkbox"
                id="product-enabled"
                checked={form.enabled}
                onChange={(event) => updateFormField("enabled", event.target.checked)}
              />
              <span>{form.enabled ? "Yes" : "No"}</span>
            </label>
          </div>
        </div>
      </LookupModal>
    </>
  );
}
