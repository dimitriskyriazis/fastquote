"use client";

import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type ChangeEvent,
  type DragEvent,
} from "react";
import Link from "next/link";
import AddBrandModal from "../../components/AddBrandModal";
import AddSupplierModal from "../../components/AddSupplierModal";
import lookupButtonStyles from "../../components/LookupAddButton.module.css";
import { useRouter } from "next/navigation";
import type { DropdownOption } from "../../../lib/dropdownOptions";
import { showToastMessage } from "../../../lib/toast";
import { showConfirmDialog, showSelectableConfirmDialog } from "../../../lib/confirm";
import layoutStyles from "../priceListDetail.module.css";
import styles from "./PriceListImport.module.css";
import lookupStyles from "../../components/LookupModal.module.css";
import LookupModal from "../../components/LookupModal";
import type { PricingPolicyRuleOption } from "../../../lib/lookupTypes";
import UKDatePicker from "../../components/DatePicker";
import {
  PRICE_LIST_DECIMAL_FORMAT_OPTIONS,
  type PriceListDecimalFormat,
} from "../../../lib/priceListDecimalFormats";
import { getUserNumberLocale, parseLocaleNumber } from "../../../lib/localeNumber";
import { matchesCountrySearch } from "../../../lib/countryAliases";
import { useAuditUser } from "../../components/AuditUserProvider";
import { useFormDraft } from "../../hooks/useFormDraft";
import {
  COLUMN_DISPLAY,
  PREVIEW_COLUMN_KEYS,
  INITIAL_VALIDATION,
  evaluateSelection,
  validateFileStructure,
  type HeaderColumnKey,
  type FileValidation,
} from "../../../lib/priceListColumnDetection";

const numberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const formatDiscountValue = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "";
  return numberFormatter.format(value);
};

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatPrice = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "";
  return `${currencyFormatter.format(value)} €`;
};

export type PreviousPriceListOption = DropdownOption & {
  brandId: number | null;
  brandName: string | null;
};

export type PrefillData = {
  name: string;
  previousPriceListId: string;
  brandId: string;
  supplierId: string;
  costCurrencyId: string;
  currencyCostModifier: string;
  countryId: string;
  hasDuty: boolean | null;
  isService: boolean | null;
  responsibleUserId: string;
  comments: string;
  supplierComments: string;
  pricingPolicyIds: number[];
};

type Props = {
  brands: DropdownOption[];
  suppliers: DropdownOption[];
  currencies: DropdownOption[];
  countries: DropdownOption[];
  pricingPolicies: DropdownOption[];
  pricingPolicyRules: PricingPolicyRuleOption[];
  users: DropdownOption[];
  previousPriceLists: PreviousPriceListOption[];
  prefill?: PrefillData | null;
  appendMode?: boolean;
  appendToPriceListId?: number | null;
  appendToPriceListName?: string | null;
};

type PricingPolicySelection = {
  pricingPolicyId: number;
  pricingPolicyRuleId: number | null;
};

type PricingPolicyPickerRow = {
  pricingPolicyId: number;
  pricingPolicyName: string;
  telmacoDiscountPercentage: number | null;
  customerDiscountPercentage: number | null;
  telmacoWarrantyYears: number | null;
  customerWarrantyYears: number | null;
};

type FormValues = {
  name: string;
  brandId: string;
  pricingPolicies: PricingPolicySelection[];
  responsibleUserId: string;
  supplierId: string;
  hasDuty: boolean | null;
  isService: boolean | null;
  costCurrencyId: string;
  currencyCostModifier: string;
  countryId: string;
  validFromDate: string;
  validToDate: string;
  comments: string;
  supplierComments: string;
  previousPriceListId: string;
  decimalFormat: PriceListDecimalFormat;
};

type PreviewColumn = {
  key: HeaderColumnKey;
  label: string;
  columnIndex: number;
  isListPrice: boolean;
};

const REQUIRED_FIELDS: Array<keyof FormValues> = [
  "name",
  "brandId",
  "responsibleUserId",
  "validFromDate",
  "validToDate",
];

const normalizeDate = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // For type="date" inputs, value is already in ISO format (YYYY-MM-DD)
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export default function PriceListImportClient({
  brands,
  suppliers,
  currencies,
  countries,
  pricingPolicies,
  pricingPolicyRules,
  users,
  previousPriceLists,
  prefill,
  appendMode = false,
  appendToPriceListId = null,
  appendToPriceListName = null,
}: Props) {
  const router = useRouter();
  const { userId: currentUserId } = useAuditUser();
  const euroCurrencyLabel = "€";

  // Stable initial values — computed once (like a useState lazy initializer).
  // useRef gives us a stable reference without any dependency-array concerns.
  const initialValuesRef = useRef<FormValues | null>(null);
  if (initialValuesRef.current === null) {
    const initialEuro =
      currencies.find((c) => (c.label ?? "").trim() === "€") ??
      currencies.find((c) => (c.label ?? "").toLowerCase().includes("eur")) ??
      null;
    const initialPolicies: PricingPolicySelection[] = prefill?.pricingPolicyIds
      ? prefill.pricingPolicyIds.map((id) => ({ pricingPolicyId: id, pricingPolicyRuleId: null }))
      : [];
    initialValuesRef.current = {
      name: prefill?.name ?? "",
      brandId: prefill?.brandId ?? "",
      pricingPolicies: initialPolicies,
      responsibleUserId: prefill?.responsibleUserId ?? "",
      supplierId: prefill?.supplierId ?? "",
      hasDuty: prefill?.hasDuty ?? false,
      isService: prefill?.isService ?? false,
      costCurrencyId: prefill?.costCurrencyId || (initialEuro?.value ?? ""),
      currencyCostModifier: prefill?.currencyCostModifier ?? "1",
      countryId: prefill?.countryId ?? "",
      validFromDate: new Date().toISOString().slice(0, 10),
      validToDate: "",
      comments: prefill?.comments ?? "",
      supplierComments: prefill?.supplierComments ?? "",
      previousPriceListId: prefill?.previousPriceListId ?? "",
      decimalFormat: "commaDecimal",
    };
  }
  const initialValues = initialValuesRef.current;

  const [values, setValues] = useState<FormValues>(initialValues);

  // Draft save/restore (disabled in append mode — it's a short targeted action).
  const { hasDraft, restoredValues, saveDraft: saveDraftValues, clearDraft } = useFormDraft<FormValues>(
    'price-list-import',
    initialValues,
    appendMode ? null : currentUserId,
  );
  const [isRulePickerOpen, setIsRulePickerOpen] = useState(false);
  const [policyPickerSelection, setPolicyPickerSelection] = useState<Set<number>>(
    () => new Set(prefill?.pricingPolicyIds ?? []),
  );
  const [rulePickerError, setRulePickerError] = useState<string | null>(null);
  const [discountDrafts, setDiscountDrafts] = useState<Record<number, { telmaco: string; customer: string; telmacoWarranty: string; customerWarranty: string }>>({});
  const policyPickerSelectionInitializedRef = useRef(false);
  const [policyDiscountOverrides, setPolicyDiscountOverrides] = useState<
    Record<string, { telmaco: number | null; customer: number | null; telmacoWarranty: number | null; customerWarranty: number | null }>
  >({});
  const [file, setFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const validationRunId = useRef(0);
  const [showSheetSelector, setShowSheetSelector] = useState(false);
  const [multiSelectEnabled, setMultiSelectEnabled] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{
    priceListId: string | null;
    totalRows: number;
    createdProductCount: number;
    matchedProductCount: number;
    skippedRows: number;
    priceChanges: Array<{
      partNumber: string | null;
      description: string | null;
      oldListPrice: number | null;
      newListPrice: number | null;
      oldCostPrice: number | null;
      newCostPrice: number | null;
    }>;
    newProducts: Array<{
      partNumber: string | null;
      description: string | null;
      listPrice: number | null;
      costPrice: number | null;
    }>;
    skippedRowDetails: Array<{
      partNumber: string | null;
      modelNumber: string | null;
      description: string | null;
      listPrice: number | null;
      reason: string;
    }>;
  } | null>(null);
  const [summaryTab, setSummaryTab] = useState<"priceChanges" | "newProducts" | "skipped">("priceChanges");
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [brandText, setBrandText] = useState(() => {
    if (prefill?.brandId) {
      const match = brands.find((b) => b.value === prefill.brandId);
      return match?.label ?? "";
    }
    return "";
  });
  const [brandError, setBrandError] = useState<string | null>(null);
  const [showBrandList, setShowBrandList] = useState(false);
  const [localBrands, setLocalBrands] = useState<DropdownOption[]>(brands);
  const [localSuppliers, setLocalSuppliers] = useState<DropdownOption[]>(suppliers);
  const [localCurrencies, setLocalCurrencies] = useState<DropdownOption[]>(currencies);
  const [localCountries, setLocalCountries] = useState<DropdownOption[]>(countries);
  const [localUsers, setLocalUsers] = useState<DropdownOption[]>(users);
  const lookupRefreshInFlightRef = useRef(new Set<string>());
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [brandsError, setBrandsError] = useState<string | null>(null);
  const [countryText, setCountryText] = useState(() => {
    if (prefill?.countryId) {
      const match = countries.find((c) => c.value === prefill.countryId);
      return match?.label ?? "";
    }
    return "";
  });
  const [showCountryList, setShowCountryList] = useState(false);
  const countryListCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);
  const [isAddSupplierOpen, setIsAddSupplierOpen] = useState(false);
  const [localPricingPolicies, setLocalPricingPolicies] = useState(pricingPolicies);
  const [localPricingPolicyRules, setLocalPricingPolicyRules] = useState(pricingPolicyRules);
  const [isAddPricingPolicyRuleOpen, setIsAddPricingPolicyRuleOpen] = useState(false);
  const [newRuleName, setNewRuleName] = useState("");
  const [newRulePricingPolicyId, setNewRulePricingPolicyId] = useState("");
  const [newRuleBrandId, setNewRuleBrandId] = useState("");
  const [newRuleTelmaco, setNewRuleTelmaco] = useState("");
  const [newRuleCustomer, setNewRuleCustomer] = useState("");
  const [newRuleTelmacoWarranty, setNewRuleTelmacoWarranty] = useState("1");
  const [newRuleCustomerWarranty, setNewRuleCustomerWarranty] = useState("1");
  const [newRuleResponsibleUserId, setNewRuleResponsibleUserId] = useState("");
  const [newRuleComments, setNewRuleComments] = useState("");
  const [pricingPolicyRuleSaving, setPricingPolicyRuleSaving] = useState(false);
  const [pricingPolicyRuleError, setPricingPolicyRuleError] = useState<string | null>(null);

  useEffect(() => {
    setLocalPricingPolicies(pricingPolicies);
  }, [pricingPolicies]);

  useEffect(() => {
    setLocalPricingPolicyRules(pricingPolicyRules);
  }, [pricingPolicyRules]);

  useEffect(() => {
    setLocalBrands(brands);
  }, [brands]);

  useEffect(() => {
    setLocalSuppliers(suppliers);
  }, [suppliers]);

  useEffect(() => {
    setLocalCurrencies(currencies);
  }, [currencies]);

  useEffect(() => {
    setLocalCountries(countries);
  }, [countries]);

  useEffect(() => {
    setLocalUsers(users);
  }, [users]);

  // Automatically select current user as responsible user
  useEffect(() => {
    if (currentUserId && !values.responsibleUserId) {
      setValues((prev) => ({ ...prev, responsibleUserId: currentUserId }));
    }
  }, [currentUserId, values.responsibleUserId]);

  // Restore draft on mount (non-append mode only)
  useEffect(() => {
    if (appendMode || !hasDraft || !restoredValues) return;
    // When importing a new version of an existing pricelist (prefill with previousPriceListId),
    // discard any stale draft so the fresh prefill data is used instead.
    if (prefill?.previousPriceListId) {
      clearDraft();
      return;
    }
    setValues(restoredValues);
    // Restore display text for typeahead fields
    const brandMatch = brands.find((b) => b.value === restoredValues.brandId);
    if (brandMatch) setBrandText(brandMatch.label);
    const countryMatch = countries.find((c) => c.value === restoredValues.countryId);
    if (countryMatch) setCountryText(countryMatch.label);
    showToastMessage('Draft restored', 'info', 5500, {
      label: 'Discard',
      onClick: () => {
        clearDraft();
        setValues(initialValues);
        setBrandText(prefill?.brandId ? (brands.find((b) => b.value === prefill.brandId)?.label ?? '') : '');
        setCountryText(prefill?.countryId ? (countries.find((c) => c.value === prefill.countryId)?.label ?? '') : '');
      },
    });
  }, [hasDraft, restoredValues]); // eslint-disable-line react-hooks/exhaustive-deps -- run once on restore

  // Auto-save draft whenever form values change (non-append mode)
  useEffect(() => {
    if (appendMode) return;
    saveDraftValues(values);
  }, [values, saveDraftValues, appendMode]);

  const euroCurrencyId = useMemo(() => {
    const match =
      localCurrencies.find((c) => (c.label ?? "").trim() === "€") ??
      localCurrencies.find((c) => (c.label ?? "").toLowerCase().includes("eur")) ??
      null;
    return match?.value ?? "";
  }, [localCurrencies]);

  const countriesForModal = useMemo(() =>
    localCountries.map((country) => ({
      id: Number(country.value),
      name: country.label,
    })),
    [localCountries]
  );

  const isCostCurrencyEuro = !values.costCurrencyId || values.costCurrencyId === euroCurrencyId;

  // Default cost currency to EUR when available.
  useEffect(() => {
    if (!euroCurrencyId) return;
    if (values.costCurrencyId) return;
    setValues((prev) => ({ ...prev, costCurrencyId: euroCurrencyId }));
  }, [euroCurrencyId, values.costCurrencyId]);

  // When cost currency is EUR (default), keep modifier at 1.
  useEffect(() => {
    if (!isCostCurrencyEuro) return;
    if (values.currencyCostModifier === "1") return;
    setValues((prev) => ({ ...prev, currencyCostModifier: "1" }));
  }, [isCostCurrencyEuro, values.currencyCostModifier]);

  const parseDecimalInput = (value: string): number | null => {
    return parseLocaleNumber(value);
  };


  const handleCreatePricingPolicyRule = useCallback(async () => {
    const trimmedName = newRuleName.trim();
    if (!trimmedName) {
      setPricingPolicyRuleError("Rule name is required");
      return;
    }
    const pricingPolicyId = Number(newRulePricingPolicyId);
    if (!pricingPolicyId) {
      setPricingPolicyRuleError("Pricing policy is required");
      return;
    }
    const brandId = newRuleBrandId.trim() ? Number(newRuleBrandId) : null;
    if (newRuleBrandId.trim() && !brandId) {
      setPricingPolicyRuleError("Brand is invalid");
      return;
    }
    const telmacoValue = parseDecimalInput(newRuleTelmaco);
    if (telmacoValue == null) {
      setPricingPolicyRuleError("Telmaco discount is required");
      return;
    }
    const customerValue = parseDecimalInput(newRuleCustomer);
    if (customerValue == null) {
      setPricingPolicyRuleError("Customer discount is required");
      return;
    }
    const telmacoWarrantyValue = parseDecimalInput(newRuleTelmacoWarranty);
    const customerWarrantyValue = parseDecimalInput(newRuleCustomerWarranty);
    setPricingPolicyRuleSaving(true);
    setPricingPolicyRuleError(null);
    try {
      const response = await fetch("/api/pricing-policy-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          pricingPolicyId,
          brandId,
          telmacoDiscountPercentage: telmacoValue,
          customerDiscountPercentage: customerValue,
          telmacoWarrantyYears: telmacoWarrantyValue ?? 1,
          customerWarrantyYears: customerWarrantyValue ?? 1,
          responsibleUserId: newRuleResponsibleUserId || null,
          comments: newRuleComments.trim() || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; option?: PricingPolicyRuleOption; error?: string }
        | null;
      const option = payload?.option;
      if (!response.ok || !payload?.ok || !option) {
        throw new Error(payload?.error ?? "Unable to add pricing policy rule");
      }
      setLocalPricingPolicyRules((prev) => [...prev, option]);
      showToastMessage("Pricing policy rule added", "success");
      setIsAddPricingPolicyRuleOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to add pricing policy rule";
      setPricingPolicyRuleError(message);
      showToastMessage(message, "error");
    } finally {
      setPricingPolicyRuleSaving(false);
    }
  }, [
    newRuleName,
    newRulePricingPolicyId,
    newRuleBrandId,
    newRuleTelmaco,
    newRuleCustomer,
    newRuleTelmacoWarranty,
    newRuleCustomerWarranty,
    newRuleResponsibleUserId,
    newRuleComments,
  ]);

  const selectedBrandId = useMemo(() => {
    const rawBrand = values.brandId.trim();
    if (!rawBrand) return null;
    const parsed = Number(rawBrand);
    return Number.isFinite(parsed) ? parsed : null;
  }, [values.brandId]);

  const hasBrandSelection = useMemo(() => selectedBrandId != null, [selectedBrandId]);

  const pricingPolicyNameById = useMemo(() => {
    const map = new Map<number, string>();
    localPricingPolicies.forEach((policy) => {
      const id = Number(policy.value);
      if (Number.isFinite(id)) {
        map.set(id, policy.label);
      }
    });
    return map;
  }, [localPricingPolicies]);

  const rulesByPolicyId = useMemo(() => {
    const map = new Map<number, PricingPolicyRuleOption[]>();
    localPricingPolicyRules.forEach((rule) => {
      const id = Number(rule.pricingPolicyId);
      if (!Number.isFinite(id)) return;
      const list = map.get(id) ?? [];
      list.push(rule);
      map.set(id, list);
    });
    return map;
  }, [localPricingPolicyRules]);

  const policiesForPicker = useMemo(() => {
    const brandId = selectedBrandId;
    const rows: PricingPolicyPickerRow[] = [];
    localPricingPolicies.forEach((policy) => {
      const policyId = Number(policy.value);
      if (!Number.isFinite(policyId)) return;

      const policyName = policy.label?.trim() || `Policy ${policyId}`;
      const allRules = rulesByPolicyId.get(policyId) ?? [];
      const brandRules = brandId != null
        ? allRules.filter((rule) => rule.brandId === brandId)
        : [];
      const defaultRules = allRules.filter((rule) => rule.brandId == null);
      const applicableRules = brandRules.length > 0 ? brandRules : defaultRules;

      const telmacoValues = applicableRules
        .map((rule) => rule.telmacoDiscountPercentage)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const customerValues = applicableRules
        .map((rule) => rule.customerDiscountPercentage)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const telmacoWarrantyValues = applicableRules
        .map((rule) => rule.telmacoWarrantyYears)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const customerWarrantyValues = applicableRules
        .map((rule) => rule.customerWarrantyYears)
        .filter((value): value is number => value != null && Number.isFinite(value));

      const key = `${brandId ?? "none"}:${policyId}`;
      const override = policyDiscountOverrides[key];
      rows.push({
        pricingPolicyId: policyId,
        pricingPolicyName: policyName,
        telmacoDiscountPercentage:
          override?.telmaco ?? (telmacoValues.length > 0 ? Math.min(...telmacoValues) : null),
        customerDiscountPercentage:
          override?.customer ?? (customerValues.length > 0 ? Math.min(...customerValues) : null),
        telmacoWarrantyYears:
          override?.telmacoWarranty ?? (telmacoWarrantyValues.length > 0 ? Math.min(...telmacoWarrantyValues) : null),
        customerWarrantyYears:
          override?.customerWarranty ?? (customerWarrantyValues.length > 0 ? Math.min(...customerWarrantyValues) : null),
      });
    });

    rows.sort((a, b) => a.pricingPolicyName.localeCompare(b.pricingPolicyName));
    return rows;
  }, [localPricingPolicies, policyDiscountOverrides, rulesByPolicyId, selectedBrandId]);

  const selectedPolicyIds = useMemo(() => {
    return new Set(
      values.pricingPolicies
        .map((entry) => entry.pricingPolicyId)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id)),
    );
  }, [values.pricingPolicies]);

  const selectedPolicySummary = useMemo(() => {
    const entries = values.pricingPolicies
      .map((entry) => {
        const name = pricingPolicyNameById.get(entry.pricingPolicyId);
        return name ? { id: entry.pricingPolicyId, name } : null;
      })
      .filter((entry): entry is { id: number; name: string } => Boolean(entry));

    const seen = new Set<number>();
    return entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [pricingPolicyNameById, values.pricingPolicies]);

  useEffect(() => {
    if (!isRulePickerOpen) {
      policyPickerSelectionInitializedRef.current = false;
      return;
    }
    setRulePickerError(null);
    const visiblePolicyIds = new Set(policiesForPicker.map((row) => row.pricingPolicyId));
    setPolicyPickerSelection((prev) => {
      if (!policyPickerSelectionInitializedRef.current) {
        policyPickerSelectionInitializedRef.current = true;
        return new Set(Array.from(selectedPolicyIds).filter((id) => visiblePolicyIds.has(id)));
      }
      return new Set(Array.from(prev).filter((id) => visiblePolicyIds.has(id)));
    });
  }, [isRulePickerOpen, policiesForPicker, selectedPolicyIds]);

  useEffect(() => {
    if (!isRulePickerOpen) return;
    const next: Record<number, { telmaco: string; customer: string; telmacoWarranty: string; customerWarranty: string }> = {};
    policiesForPicker.forEach((row) => {
      next[row.pricingPolicyId] = {
        telmaco: formatDiscountValue(row.telmacoDiscountPercentage ?? null),
        customer: formatDiscountValue(row.customerDiscountPercentage ?? null),
        telmacoWarranty: row.telmacoWarrantyYears != null ? String(row.telmacoWarrantyYears) : "",
        customerWarranty: row.customerWarrantyYears != null ? String(row.customerWarrantyYears) : "",
      };
    });
    setDiscountDrafts(next);
  }, [isRulePickerOpen, policiesForPicker]);

  const filteredPreviousPriceLists = useMemo(() => {
    const rawBrand = values.brandId.trim();
    const brandId = rawBrand ? Number(rawBrand) : null;
    if (brandId == null || !Number.isFinite(brandId)) return previousPriceLists;
    return previousPriceLists.filter(
      (pl) => pl.brandId == null || pl.brandId === brandId,
    );
  }, [previousPriceLists, values.brandId]);

  const filteredBrandOptions = useMemo(() => {
    const search = brandText.trim().toLowerCase();
    if (!search) return localBrands;
    return localBrands.filter((option) => {
      const label = option.label?.toLowerCase() ?? "";
      const value = option.value?.toLowerCase() ?? "";
      return label.includes(search) || value.includes(search);
    });
  }, [brandText, localBrands]);

  const refreshBrands = useCallback(async () => {
    if (brandsLoading) return;
    setBrandsLoading(true);
    setBrandsError(null);
    try {
      const response = await fetch("/api/products/lookups");
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; brands?: Array<{ id: number; name: string }> | null; error?: string }
        | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.brands)) {
        throw new Error(payload?.error ?? "Unable to load brands");
      }
      setLocalBrands(
        payload.brands.map((brand) => ({
          value: String(brand.id),
          label: brand.name?.trim() || `Brand ${brand.id}`,
        })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load brands";
      setBrandsError(message);
      showToastMessage("Unable to refresh brands. Please try again.", "error");
    } finally {
      setBrandsLoading(false);
    }
  }, [brandsLoading]);

  const refreshLookups = useCallback(async (keys: string[]) => {
    const pendingKeys = keys.filter((k) => !lookupRefreshInFlightRef.current.has(k));
    if (pendingKeys.length === 0) return;
    pendingKeys.forEach((k) => lookupRefreshInFlightRef.current.add(k));
    try {
      const search = new URLSearchParams();
      pendingKeys.forEach((k) => search.append("keys", k));
      const response = await fetch(`/api/price-lists/lookups?${search.toString()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; lookups?: { brands?: DropdownOption[]; countries?: DropdownOption[]; suppliers?: DropdownOption[]; currencies?: DropdownOption[]; users?: DropdownOption[] } }
        | null;
      if (!response.ok || !payload?.ok || !payload.lookups) {
        throw new Error(payload?.error ?? "Unable to refresh lookup options");
      }
      if (payload.lookups.brands) setLocalBrands(payload.lookups.brands);
      if (payload.lookups.countries) setLocalCountries(payload.lookups.countries);
      if (payload.lookups.suppliers) setLocalSuppliers(payload.lookups.suppliers);
      if (payload.lookups.currencies) setLocalCurrencies(payload.lookups.currencies);
      if (payload.lookups.users) setLocalUsers(payload.lookups.users);
    } catch (err) {
      console.error(err);
    } finally {
      pendingKeys.forEach((k) => lookupRefreshInFlightRef.current.delete(k));
    }
  }, []);

  const updateField = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearCountryListCloseTimer = useCallback(() => {
    if (countryListCloseTimerRef.current) {
      clearTimeout(countryListCloseTimerRef.current);
      countryListCloseTimerRef.current = null;
    }
  }, []);

  const filteredCountries = useMemo(() => {
    const search = countryText.trim();
    if (!search) return localCountries;
    return localCountries.filter((option) => matchesCountrySearch(option.label, search));
  }, [localCountries, countryText]);

  const handleCountryInputChange = useCallback((text: string) => {
    clearCountryListCloseTimer();
    setCountryText(text);
    setShowCountryList(true);
    const normalized = text.trim().toLowerCase();
    const exactMatch = normalized
      ? localCountries.find((opt) => opt.label.trim().toLowerCase() === normalized)
      : null;
    updateField("countryId", exactMatch?.value ?? "");
  }, [clearCountryListCloseTimer, localCountries, updateField]);

  const handleCountrySelect = useCallback((option: DropdownOption) => {
    clearCountryListCloseTimer();
    setCountryText(option.label);
    setShowCountryList(false);
    updateField("countryId", option.value);
  }, [clearCountryListCloseTimer, updateField]);

  const handleCountryBlur = useCallback(() => {
    clearCountryListCloseTimer();
    countryListCloseTimerRef.current = setTimeout(() => {
      setShowCountryList(false);
      countryListCloseTimerRef.current = null;
    }, 120);
    const trimmed = countryText.trim();
    if (!trimmed) {
      setCountryText("");
      updateField("countryId", "");
      return;
    }
    const match = localCountries.find(
      (opt) => opt.label.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (match) {
      setCountryText(match.label);
      updateField("countryId", match.value);
    } else {
      const selectedOption = localCountries.find((opt) => opt.value === values.countryId);
      setCountryText(selectedOption?.label ?? "");
    }
  }, [clearCountryListCloseTimer, localCountries, countryText, updateField, values.countryId]);

  const handleBrandCreated = useCallback(
    (brand: { id: number; name: string }) => {
      const option = { value: String(brand.id), label: brand.name };
      setLocalBrands((prev) => {
        if (prev.some((existing) => existing.value === option.value)) return prev;
        return [...prev, option];
      });
      updateField("brandId", option.value);
      setBrandText(option.label);
      setBrandError(null);
      setBrandsError(null);
    },
    [updateField],
  );

  const handleSupplierCreated = useCallback(
    (supplier: { id: number; name: string }) => {
      const option = { value: String(supplier.id), label: supplier.name };
      setLocalSuppliers((prev) => {
        if (prev.some((existing) => existing.value === option.value)) return prev;
        return [...prev, option];
      });
      updateField("supplierId", option.value);
    },
    [updateField],
  );

  const togglePolicySelection = useCallback((policyId: number) => {
    setPolicyPickerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(policyId)) {
        next.delete(policyId);
      } else {
        next.add(policyId);
      }
      return next;
    });
  }, []);

  const applyRuleSelection = useCallback(() => {
    const nextPolicies = Array.from(policyPickerSelection)
      .filter((policyId) => Number.isFinite(policyId))
      .map((policyId) => ({ pricingPolicyId: policyId, pricingPolicyRuleId: null }));

    if (nextPolicies.length === 0) {
      setRulePickerError("Please select at least one pricing policy.");
      return;
    }

    setValues((prev) => ({ ...prev, pricingPolicies: nextPolicies }));
    setIsRulePickerOpen(false);
  }, [policyPickerSelection]);

  const handlePolicyDiscountChange = useCallback(
    (policyId: number, field: "telmaco" | "customer" | "telmacoWarranty" | "customerWarranty", value: string) => {
      setDiscountDrafts((prev) => ({
        ...prev,
        [policyId]: {
          telmaco: prev[policyId]?.telmaco ?? "",
          customer: prev[policyId]?.customer ?? "",
          telmacoWarranty: prev[policyId]?.telmacoWarranty ?? "",
          customerWarranty: prev[policyId]?.customerWarranty ?? "",
          [field]: value,
        },
      }));
    },
    [],
  );

  const handlePolicyDiscountSave = useCallback(
    async (row: PricingPolicyPickerRow, field: "telmaco" | "customer" | "telmacoWarranty" | "customerWarranty") => {
      const brandId = selectedBrandId;
      if (brandId == null) {
        showToastMessage("Please select a brand first.", "error");
        return;
      }

      const policyId = row.pricingPolicyId;
      if (!Number.isFinite(policyId)) return;

      const isWarrantyField = field === "telmacoWarranty" || field === "customerWarranty";
      const draft = discountDrafts[policyId]?.[field] ?? "";
      const parsed = parseLocaleNumber(draft);
      if (parsed == null && !isWarrantyField) {
        showToastMessage("Discount is required", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [policyId]: {
            telmaco: formatDiscountValue(row.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(row.customerDiscountPercentage ?? null),
            telmacoWarranty: row.telmacoWarrantyYears != null ? String(row.telmacoWarrantyYears) : "",
            customerWarranty: row.customerWarrantyYears != null ? String(row.customerWarrantyYears) : "",
          },
        }));
        return;
      }

      const currentValue =
        field === "telmaco"
          ? row.telmacoDiscountPercentage ?? null
          : field === "customer"
            ? row.customerDiscountPercentage ?? null
            : field === "telmacoWarranty"
              ? row.telmacoWarrantyYears ?? null
              : row.customerWarrantyYears ?? null;
      if (currentValue != null && parsed === currentValue) {
        return;
      }

      const apiField = isWarrantyField ? field : field;
      const apiValue = isWarrantyField ? (parsed ?? 1) : parsed;

      try {
        const response = await fetch("/api/pricing-policies/matrix", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId,
            pricingPolicyId: policyId,
            field: apiField,
            value: apiValue,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? isWarrantyField ? "Unable to update warranty" : "Unable to update discounts");
        }
        const overrideKey = `${brandId}:${policyId}`;
        setPolicyDiscountOverrides((prev) => {
          const current = prev[overrideKey] ?? {
            telmaco: row.telmacoDiscountPercentage ?? null,
            customer: row.customerDiscountPercentage ?? null,
            telmacoWarranty: row.telmacoWarrantyYears ?? null,
            customerWarranty: row.customerWarrantyYears ?? null,
          };
          return {
            ...prev,
            [overrideKey]: {
              ...current,
              [field]: apiValue,
            },
          };
        });
        setDiscountDrafts((prev) => ({
          ...prev,
          [policyId]: {
            telmaco:
              field === "telmaco" ? formatDiscountValue(parsed) : prev[policyId]?.telmaco ?? "",
            customer:
              field === "customer" ? formatDiscountValue(parsed) : prev[policyId]?.customer ?? "",
            telmacoWarranty:
              field === "telmacoWarranty" ? String(apiValue) : prev[policyId]?.telmacoWarranty ?? "",
            customerWarranty:
              field === "customerWarranty" ? String(apiValue) : prev[policyId]?.customerWarranty ?? "",
          },
        }));
        showToastMessage(isWarrantyField ? "Warranty updated" : "Discount updated", "success");
      } catch (err) {
        console.error("Failed to update", err);
        showToastMessage(isWarrantyField ? "Unable to update warranty. Please try again." : "Unable to update discount. Please try again.", "error");
        setDiscountDrafts((prev) => ({
          ...prev,
          [policyId]: {
            telmaco: formatDiscountValue(row.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(row.customerDiscountPercentage ?? null),
            telmacoWarranty: row.telmacoWarrantyYears != null ? String(row.telmacoWarrantyYears) : "",
            customerWarranty: row.customerWarrantyYears != null ? String(row.customerWarrantyYears) : "",
          },
        }));
      }
    },
    [discountDrafts, selectedBrandId],
  );

  const findBrandOption = useCallback(
    (text: string) => {
      const normalized = text.trim().toLowerCase();
      if (!normalized) return null;
      return (
        localBrands.find((option) => {
          const label = option.label?.trim().toLowerCase();
          const value = option.value?.trim().toLowerCase();
          return label === normalized || value === normalized;
        }) ?? null
      );
    },
    [localBrands],
  );

  const setBrandSelection = useCallback(
    (option: DropdownOption | null, rawText: string) => {
      setBrandText(rawText);
      setShowBrandList(false);
      updateField("brandId", option?.value ?? "");
      setBrandError(option ? null : brandError);
    },
    [brandError, updateField],
  );

  const handleBrandInputChange = useCallback(
    (text: string) => {
      const match = findBrandOption(text);
      setBrandSelection(match, text);
      if (!match) {
        setBrandError(null);
        updateField("brandId", "");
      }
      setShowBrandList(true);
    },
    [findBrandOption, setBrandSelection, updateField],
  );

  const handleBrandBlur = useCallback(() => {
    const match = findBrandOption(brandText);
    setBrandSelection(match, match?.label ?? brandText);
    if (!match && brandText.trim()) {
      setBrandError("Please choose a valid brand");
    } else {
      setBrandError(null);
    }
    setShowBrandList(false);
  }, [brandText, findBrandOption, setBrandSelection]);

  const activeSheet = useMemo(
    () => fileValidation.sheets[fileValidation.activeSheetIndex] ?? null,
    [fileValidation.activeSheetIndex, fileValidation.sheets],
  );

  const invalidDateRange = useMemo(() => {
    const from = normalizeDate(values.validFromDate);
    const to = normalizeDate(values.validToDate);
    return Boolean(from && to && from > to);
  }, [values.validFromDate, values.validToDate]);

  const previewColumns = useMemo<PreviewColumn[]>(() => {
    if (!activeSheet) return [];
    const activeKeys = PREVIEW_COLUMN_KEYS.filter((key) =>
      key !== "servicePriceGR" && key !== "servicePriceOutGR" && key !== "serviceType" || values.isService,
    );
    return activeKeys.map((key) => {
      const columnIndex = activeSheet.selection[key];
      if (columnIndex == null) return null;
      const column = activeSheet.columns.find((col) => col.index === columnIndex);
      return {
        key,
        label: column?.label ?? `Column ${columnIndex + 1}`,
        columnIndex,
        isListPrice: key === "listPrice",
      };
    }).filter((col): col is PreviewColumn => Boolean(col));
  }, [activeSheet, values.isService]);

  const displayPreviewRows = useMemo<Record<number, unknown>[]>(() => {
    if (!activeSheet) return [];
    const partCol = activeSheet.selection.partNumber;
    const priceCol = activeSheet.selection.listPrice;
    const rows = activeSheet.previewRows;
    if (partCol == null || priceCol == null) return rows.slice(0, 3);
    const isFilled = (value: unknown) => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (typeof value === "number") return Number.isFinite(value);
      return true;
    };
    return rows.filter((row) => isFilled(row[partCol]) && isFilled(row[priceCol])).slice(0, 3);
  }, [activeSheet]);

  const formatPreviewCell = useCallback(
    (value: unknown): string => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      if (typeof value === "boolean") return String(value);
      if (typeof value === "number" && Number.isFinite(value)) {
        // Format using the locale that matches the user's decimal format choice
        // so the preview mirrors what Excel shows (e.g. "6.050,00" for commaDecimal).
        const locale = values.decimalFormat === "commaDecimal" ? "de-DE" : "en-US";
        return value.toLocaleString(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      }
      return "";
    },
    [values.decimalFormat],
  );

  const handleSheetChange = useCallback((nextIndex: number) => {
    setFileValidation((prev) => {
      const boundedIndex = Math.max(0, Math.min(nextIndex, prev.sheets.length - 1));
      const evaluation = evaluateSelection(prev.sheets, boundedIndex);
      return { ...prev, ...evaluation, activeSheetIndex: boundedIndex };
    });
  }, []);

  const updateColumnSelection = useCallback((key: HeaderColumnKey, columnIndex: number | null) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) =>
        idx === prev.activeSheetIndex
          ? { ...sheet, selection: { ...sheet.selection, [key]: columnIndex } }
          : sheet,
      );
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const toggleSheetEnabled = useCallback((index: number, enabled: boolean) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) =>
        idx === index ? { ...sheet, enabled } : sheet,
      );
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const handleFileSelection = useCallback((nextFile: File | null) => {
    validationRunId.current += 1;
    const runId = validationRunId.current;
    setFile(nextFile);

    if (!nextFile) {
      setFileValidation(INITIAL_VALIDATION);
      return;
    }

    setFileValidation({
      status: "checking",
      message: "Checking file format…",
      columns: {},
      rowCount: 0,
      sheetName: null,
      sheets: [],
      activeSheetIndex: 0,
    });

    void validateFileStructure(nextFile)
      .then((result) => {
        if (runId !== validationRunId.current) return;
        setFileValidation(result);
        if (result.sheets.length > 1) {
          setShowSheetSelector(true);
        }
      })
      .catch(() => {
        if (runId !== validationRunId.current) return;
        setFileValidation({
          ...INITIAL_VALIDATION,
          status: "invalid",
          message: "Unable to read the file. Please try a different upload.",
        });
      });
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextFile = event.target.files?.[0] ?? null;
      if (event.target) {
        event.target.value = "";
      }
      handleFileSelection(nextFile);
    },
    [handleFileSelection],
  );

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const droppedFile = event.dataTransfer?.files?.[0] ?? null;
      handleFileSelection(droppedFile);
    },
    [handleFileSelection],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setShowValidationErrors(true);

    if (!euroCurrencyId) {
      setError('EUR currency is not configured. Please add "€" (EUR) in Currencies and try again.');
      return;
    }

    const missing: string[] = [];
    if (!appendMode) {
      REQUIRED_FIELDS.forEach((field) => {
        const value = values[field];
        if (typeof value === "string" && !value.trim()) {
          missing.push(field);
        }
      });
    }

    if (!file) {
      missing.push("file");
    }

    if (fileValidation.status === "checking") {
      setError("Please wait for the file check to finish.");
      return;
    }

    if (fileValidation.status === "invalid") {
      setError(
        fileValidation.message ??
          "Please attach a file with Part Number and List Price columns (Model Number optional).",
      );
      return;
    }

    const activeSheet = fileValidation.sheets[fileValidation.activeSheetIndex];
    const selectedSheets = fileValidation.sheets.filter(
      (sheet) =>
        sheet.enabled &&
        sheet.selection.partNumber != null &&
        sheet.selection.listPrice != null,
    );
    if (!activeSheet || selectedSheets.length === 0) {
      setError("Please upload a file and select the correct columns on at least one enabled sheet.");
      return;
    }

    if (!appendMode) {
      const from = normalizeDate(values.validFromDate);
      const to = normalizeDate(values.validToDate);
      if (from && to && from > to) {
        setError("Valid From date cannot be after Valid To date.");
        return;
      }

      if (values.pricingPolicies.length === 0) {
        setError("Please add at least one pricing policy.");
        return;
      }
    }

    if (missing.length > 0) {
      setError(appendMode
        ? "Please attach a file."
        : "Please complete all required fields and attach the file.");
      return;
    }

    // If the file has an Excel filter active (hidden rows), ask the user which rows to import.
    let importFilteredIndices: number[] | null = null;
    if (activeSheet.visibleDataRowIndices !== null) {
      const visibleCount = activeSheet.visibleDataRowIndices.length;
      const totalCount = activeSheet.allRows.length;
      const importVisible = await showConfirmDialog({
        title: "Excel filter detected",
        message: `This file has an Excel filter active, ${visibleCount} of ${totalCount} rows are visible. Import only the visible rows, or all rows?`,
        confirmLabel: `Import ${visibleCount} visible rows only`,
        cancelLabel: `Import all ${totalCount} rows`,
      });
      if (importVisible) {
        importFilteredIndices = activeSheet.visibleDataRowIndices;
      }
    }

    setSubmitting(true);
    try {
      const currentFile = file;
      if (!currentFile) {
        throw new Error("Please attach an Excel file.");
      }

      // On Windows, a file can become unreadable while it's open in another program (e.g. Excel),
      // causing the browser upload stream to fail with a generic "Failed to fetch".
      // Do a tiny read upfront so we can show a meaningful message.
      try {
        await currentFile.slice(0, 64 * 1024).arrayBuffer();
      } catch {
        throw new Error(
          "Unable to read the selected file. It may be open in another program (e.g. Excel). Please close it and try again.",
        );
      }

      if (!appendMode && values.pricingPolicies.length === 0) {
        throw new Error("At least one pricing policy is required.");
      }

      const formData = new FormData();
      formData.append("name", values.name);
      formData.append("brandId", values.brandId);
      formData.append("pricingPolicies", JSON.stringify(values.pricingPolicies));
      formData.append("responsibleUserId", values.responsibleUserId);
      formData.append("supplierId", values.supplierId);
      formData.append("hasDuty", values.hasDuty ? "1" : "0");
      formData.append("isService", values.isService ? "1" : "0");
      // Currency is always EUR.
      formData.append("currencyId", euroCurrencyId);
      formData.append("costCurrencyId", values.costCurrencyId || euroCurrencyId);
      formData.append("currencyCostModifier", isCostCurrencyEuro ? "1" : (values.currencyCostModifier || "1"));
      if (values.countryId) formData.append("countryId", values.countryId);
      // Values are already in ISO format (YYYY-MM-DD) from type="date" inputs
      formData.append("validFromDate", values.validFromDate);
      formData.append("validToDate", values.validToDate);
      formData.append("comments", values.comments);
      formData.append("supplierComments", values.supplierComments);
      formData.append("decimalFormat", values.decimalFormat);
      if (values.previousPriceListId && !appendMode) {
        formData.append("previousPriceListId", values.previousPriceListId);
      }
      if (appendMode && appendToPriceListId != null) {
        formData.append("appendToPriceListId", String(appendToPriceListId));
      }
      if (values.hasDuty !== null) {
        formData.append("hasDuty", values.hasDuty ? "1" : "0");
      }
      if (values.isService !== null) {
        formData.append("isService", values.isService ? "1" : "0");
      }
      formData.append("file", currentFile, currentFile.name);
      const columnMappings = selectedSheets.map((sheet) => ({
        sheetName: sheet.name,
        headerRowIndex: sheet.headerRowIndex,
        columns: {
          partNumber: sheet.selection.partNumber ?? null,
          modelNumber: sheet.selection.modelNumber ?? null,
          description: sheet.selection.description ?? null,
          listPrice: sheet.selection.listPrice ?? null,
          costPrice: sheet.selection.costPrice ?? null,
          warning: sheet.selection.warning ?? null,
          weblink: sheet.selection.weblink ?? null,
          legacyPartNumber: sheet.selection.legacyPartNumber ?? null,
          servicePriceGR: sheet.selection.servicePriceGR ?? null,
          servicePriceOutGR: sheet.selection.servicePriceOutGR ?? null,
          serviceType: sheet.selection.serviceType ?? null,
        },
        // Only pass rowIndices for the active sheet when filtering is used;
        // other sheets (multi-sheet import) are always imported in full.
        rowIndices: (importFilteredIndices && activeSheet && sheet.name === activeSheet.name)
          ? importFilteredIndices
          : null,
      }));
      formData.append("columnMappings", JSON.stringify(columnMappings));

      type ImportResponse = {
        ok?: boolean;
        error?: string;
        priceListId?: string | number;
        createdProductCount?: number;
        matchedProductCount?: number;
        skippedRows?: number;
        totalRows?: number;
        blockers?: Array<{
          rowIndex: number;
          partNumber: string;
          modelNumber: string | null;
          description: string | null;
          conflictProductId: number;
          conflictBrandId: number | null;
          conflictBrandName: string | null;
        }>;
        descriptionMismatches?: { productId: number; partNumber: string; oldDescription: string; newDescription: string }[];
        modelNumberMismatches?: { productId: number; partNumber: string; oldModelNumber: string; newModelNumber: string }[];
        partModelSwapWarnings?: Array<{
          rowIndex: number;
          importedPart: string | null;
          importedModel: string | null;
          description: string | null;
          matchedProductId: number;
          matchedPart: string | null;
          matchedModel: string | null;
          kind: "fullSwap" | "partIsExistingModel" | "modelIsExistingPart";
          alreadyExists: boolean;
        }>;
        priceChanges?: Array<{
          partNumber: string | null;
          description: string | null;
          oldListPrice: number | null;
          newListPrice: number | null;
          oldCostPrice: number | null;
          newCostPrice: number | null;
        }>;
        newProducts?: Array<{
          partNumber: string | null;
          description: string | null;
          listPrice: number | null;
          costPrice: number | null;
        }>;
        skippedRowDetails?: Array<{
          partNumber: string | null;
          modelNumber: string | null;
          description: string | null;
          listPrice: number | null;
          reason: string;
        }>;
        allCapsProductIds?: number[];
        allCapsDescriptionCount?: number;
      };
      let response!: Response;
      let raw = "";
      let typedPayload: ImportResponse | null = null;
      let swapAcknowledged = false;
      // The first POST can return Part/Model swap warnings (409) without
      // committing. After the user decides (cancel / import as-is / auto-fix the
      // selected rows) we re-submit ONCE with the acknowledgement + corrections.
      for (;;) {
        response = await fetch("/api/price-lists/import", {
          method: "POST",
          body: formData,
        });
        raw = await response.text().catch(() => "");
        typedPayload = (() => {
          try {
            return JSON.parse(raw) as ImportResponse;
          } catch {
            return null;
          }
        })();

        if (response.status === 409 && typedPayload?.blockers && typedPayload.blockers.length > 0) {
          const blockers = typedPayload.blockers;
          await showConfirmDialog({
            title: "Import cancelled - duplicate part numbers",
            message: `${blockers.length} row${blockers.length > 1 ? "s" : ""} in the file have part numbers that already exist in the database under a different brand. Fix or remove these rows and re-upload.`,
            confirmLabel: "OK",
            cancelLabel: "Close",
            tone: "danger",
            details: {
              columns: ["Row", "Part Number", "Description", "Existing Brand", "Existing Product ID"],
              rows: blockers.map((b) => [
                String(b.rowIndex + 1),
                b.partNumber || "-",
                b.description || "-",
                b.conflictBrandName || (b.conflictBrandId != null ? `#${b.conflictBrandId}` : "-"),
                String(b.conflictProductId),
              ]),
            },
          });
          setError(typedPayload.error ?? "Import cancelled: duplicate part numbers.");
          return;
        }

        const swapWarnings = typedPayload?.partModelSwapWarnings;
        if (response.status === 409 && swapWarnings && swapWarnings.length > 0 && !swapAcknowledged) {
          const kindLabel = (k: string) =>
            k === "fullSwap"
              ? "Part⇄Model both match"
              : k === "partIsExistingModel"
                ? "Part = existing Model"
                : "Model = existing Part";
          // Rows that would CREATE a new reversed duplicate can be auto-fixed
          // (swap Part/Model so they match the existing product). Rows that
          // already match an existing reversed duplicate are warn-only — swapping
          // them is ambiguous, so we don't offer auto-fix for those.
          const correctable = swapWarnings.filter((w) => !w.alreadyExists);
          const existing = swapWarnings.filter((w) => w.alreadyExists);
          let correctionRowIndices: number[] = [];

          if (correctable.length > 0) {
            const selected = await showSelectableConfirmDialog({
              title: "Possible Part / Model swap",
              message:
                `${correctable.length} imported row${correctable.length > 1 ? "s" : ""} look like the Part and Model columns are swapped versus existing products. ` +
                "Checked rows are imported with Part and Model swapped back to match the existing product; unchecked rows import as-is. " +
                "Select none to import everything as-is, or Cancel to fix the file and re-upload." +
                (existing.length > 0
                  ? ` (${existing.length} more already exist as reversed duplicates and will import as-is.)`
                  : ""),
              confirmLabel: "Import - fix",
              cancelLabel: "Cancel & fix file",
              columns: ["Imported Part", "Imported Model", "Matches existing product", "Signal"],
              columnWidths: ["23%", "23%", "34%", "20%"],
              allowEmpty: true,
              rows: correctable.map((w) => [
                w.importedPart || "-",
                w.importedModel || "-",
                `#${w.matchedProductId} · Part ${w.matchedPart || "-"} / Model ${w.matchedModel || "-"}`,
                kindLabel(w.kind),
              ]),
            });
            if (selected === false) {
              setError(
                "Import cancelled - Part/Model columns look swapped. Fix the file and re-upload, or re-run to auto-correct.",
              );
              return;
            }
            correctionRowIndices = selected.map((i) => correctable[i].rowIndex);
          } else {
            // Only already-existing reversed duplicates — warn-only (auto-swap is
            // ambiguous when both directions already exist in the catalog).
            const proceed = await showConfirmDialog({
              title: "Reversed-duplicate product detected",
              message:
                `${existing.length} imported product${existing.length > 1 ? "s are" : " is a"} reversed duplicate${existing.length > 1 ? "s" : ""} of existing product${existing.length > 1 ? "s" : ""}` +
                ", the imported Part matches an existing product's Model and/or vice-versa. They'll import as-is, matching the existing reversed product. Consider cleaning up the duplicate afterward.",
              confirmLabel: "Import anyway",
              cancelLabel: "Cancel",
              tone: "danger",
              details: {
                columns: ["Imported Part", "Imported Model", "Mirrors existing product"],
                rows: existing.map((w) => [
                  w.importedPart || "-",
                  w.importedModel || "-",
                  `#${w.matchedProductId} · Part ${w.matchedPart || "-"} / Model ${w.matchedModel || "-"}`,
                ]),
              },
            });
            if (!proceed) {
              setError("Import cancelled - reversed-duplicate products detected.");
              return;
            }
          }

          formData.set("acknowledgeSwapWarnings", "1");
          formData.set("swapCorrections", JSON.stringify(correctionRowIndices));
          swapAcknowledged = true;
          continue;
        }

        break;
      }

      if (!response.ok || !typedPayload?.ok) {
        const serverError =
          typedPayload?.error ||
          (raw && raw.trim() ? raw.trim() : null) ||
          "Unable to import price list. Please try again.";
        throw new Error(serverError);
      }

      const summary = [
        `Imported ${typedPayload.totalRows ?? 0} rows`,
        `${typedPayload.createdProductCount ?? 0} new products`,
        `${typedPayload.matchedProductCount ?? 0} matched`,
        `${typedPayload.skippedRows ?? 0} skipped`,
      ].join(" • ");
      showToastMessage(summary);

      // Prompt user if product descriptions don't match
      const mismatches = typedPayload.descriptionMismatches;
      if (mismatches && mismatches.length > 0) {
        const selected = await showSelectableConfirmDialog({
          title: "Description Mismatch",
          message: `${mismatches.length} product(s) don't match the products' original descriptions. Select which ones to overwrite.`,
          confirmLabel: "Overwrite",
          cancelLabel: "Cancel",
          columns: ["Part Number", "Current Description", "New Description"],
          columnWidths: ["14%", "43%", "43%"],
          highlightColumn: 2,
          rows: mismatches.map((m) => [m.partNumber || "-", m.oldDescription || "-", m.newDescription || "-"]),
        });
        if (selected && selected.length > 0) {
          const chosenMismatches = selected.map((i) => mismatches[i]);
          try {
            const updateRes = await fetch("/api/products/update-descriptions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mismatches: chosenMismatches }),
            });
            const updateData = await updateRes.json().catch(() => null);
            if (updateRes.ok && updateData?.ok) {
              showToastMessage(`Updated ${updateData.updatedCount} product description(s).`);
            } else {
              showToastMessage(updateData?.error || "Failed to update descriptions.");
            }
          } catch {
            showToastMessage("Failed to update descriptions.");
          }
        }
      }

      // Prompt user if product model numbers don't match
      const modelMismatches = typedPayload.modelNumberMismatches;
      if (modelMismatches && modelMismatches.length > 0) {
        const selected = await showSelectableConfirmDialog({
          title: "Model Number Mismatch",
          message: `${modelMismatches.length} product(s) don't match the products' original model numbers. Select which ones to overwrite.`,
          confirmLabel: "Overwrite",
          cancelLabel: "Cancel",
          columns: ["Part Number", "Current Model", "New Model"],
          columnWidths: ["34%", "33%", "33%"],
          highlightColumn: 2,
          rows: modelMismatches.map((m) => [m.partNumber || "-", m.oldModelNumber || "-", m.newModelNumber || "-"]),
        });
        if (selected && selected.length > 0) {
          const chosenMismatches = selected.map((i) => modelMismatches[i]);
          try {
            const updateRes = await fetch("/api/products/update-model-numbers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mismatches: chosenMismatches }),
            });
            const updateData = await updateRes.json().catch(() => null);
            if (updateRes.ok && updateData?.ok) {
              showToastMessage(`Updated ${updateData.updatedCount} product model number(s).`);
            } else {
              showToastMessage(updateData?.error || "Failed to update model numbers.");
            }
          } catch {
            showToastMessage("Failed to update model numbers.");
          }
        }
      }

      // Prompt user to fix ALL CAPS descriptions detected in the import
      const allCapsProductIds = typedPayload.allCapsProductIds;
      const allCapsCount = typedPayload.allCapsDescriptionCount ?? 0;
      if (allCapsProductIds && allCapsProductIds.length > 0 && allCapsCount >= 2) {
        const confirmed = await showConfirmDialog({
          title: "Capitalisation Issues Detected",
          message: `${allCapsCount} imported product${allCapsCount !== 1 ? "s" : ""} appear to have badly-capitalised descriptions (e.g. "CLICKSHARE HUB PRO EU WITH 2 BUTTONS" or "CLICKSHARE BAR CB Core EU WITH 1 BUTTON"). Would you like to use AI to fix the capitalisation for all of them?`,
          confirmLabel: "Yes, fix capitalisation",
          cancelLabel: "Skip",
        });
        if (confirmed) {
          const dismissCapsFix = showToastMessage("Fixing capitalisation…", "info", 300000);
          try {
            // API handles up to 5000 per call; one call covers almost any real price list
            const BATCH_SIZE = 5000;
            let totalFixed = 0;
            let batchError: string | null = null;
            for (let i = 0; i < allCapsProductIds.length; i += BATCH_SIZE) {
              const batch = allCapsProductIds.slice(i, i + BATCH_SIZE);
              const capsRes = await fetch("/api/products/fix-capitalisation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productIds: batch }),
              });
              const capsData = await capsRes.json().catch(() => null);
              if (capsRes.ok && capsData?.ok) {
                totalFixed += capsData.updatedCount ?? 0;
              } else {
                batchError = capsData?.error || "Failed to fix capitalisation.";
                break;
              }
            }
            dismissCapsFix();
            if (batchError) {
              showToastMessage(batchError);
            } else {
              showToastMessage(`Fixed capitalisation for ${totalFixed} description(s).`);
            }
          } catch {
            dismissCapsFix();
            showToastMessage("Failed to fix capitalisation.");
          }
        }
      }

      const hasSummaryData =
        (typedPayload.priceChanges && typedPayload.priceChanges.length > 0) ||
        (typedPayload.newProducts && typedPayload.newProducts.length > 0) ||
        (typedPayload.skippedRowDetails && typedPayload.skippedRowDetails.length > 0);

      // Import succeeded — clear saved draft so it doesn't restore on next visit.
      clearDraft();

      if (hasSummaryData) {
        const targetId =
          typedPayload.priceListId != null ? String(typedPayload.priceListId) : null;
        setImportSummary({
          priceListId: targetId,
          totalRows: typedPayload.totalRows ?? 0,
          createdProductCount: typedPayload.createdProductCount ?? 0,
          matchedProductCount: typedPayload.matchedProductCount ?? 0,
          skippedRows: typedPayload.skippedRows ?? 0,
          priceChanges: typedPayload.priceChanges ?? [],
          newProducts: typedPayload.newProducts ?? [],
          skippedRowDetails: typedPayload.skippedRowDetails ?? [],
        });
        setSummaryTab(
          typedPayload.priceChanges && typedPayload.priceChanges.length > 0
            ? "priceChanges"
            : typedPayload.newProducts && typedPayload.newProducts.length > 0
              ? "newProducts"
              : "skipped",
        );
      } else {
        const targetId =
          typedPayload.priceListId != null ? encodeURIComponent(String(typedPayload.priceListId)) : null;
        if (targetId) {
          router.push(`/price-lists/${targetId}/products`);
        }
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "";
      const normalized = rawMessage.trim().toLowerCase();
      const message =
        normalized === "failed to fetch" || normalized.includes("networkerror")
          ? "Upload failed. If the file is open in another program (e.g. Excel), close it and try again."
          : rawMessage || "Unable to import price list. Please try again.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [appendMode, appendToPriceListId, clearDraft, euroCurrencyId, file, fileValidation, isCostCurrencyEuro, router, values]);

  const renderOption = (option: DropdownOption) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  );

  const costCurrencyOptions = useMemo(() => {
    if (!euroCurrencyId) return localCurrencies;
    const rest = localCurrencies.filter((c) => c.value !== euroCurrencyId);
    return [{ value: euroCurrencyId, label: euroCurrencyLabel }, ...rest];
  }, [localCurrencies, euroCurrencyId]);

  return (
    <>
      <main className={`${layoutStyles.page} ${styles.importPage}`}>
      <div className={`${layoutStyles.headerRow} ${layoutStyles.headerRowCentered}`}>
        <Link href="/price-lists" className={`${layoutStyles.backLink} ${layoutStyles.backLinkAbsolute} ${styles.backLinkCentered} page-header-button`}>
          ← Back to price lists
        </Link>
        <h1 className={layoutStyles.heading}>
          {appendMode
            ? `Appending products to ${appendToPriceListName?.trim() || `price list #${appendToPriceListId ?? ""}`}`
            : "Import Price List"}
        </h1>
        <div className={styles.headerActions}>
          {error && <div className={styles.error}>{error}</div>}
          <button form="price-list-import-form" type="submit" className={`${styles.submitButton} page-header-button`} disabled={submitting}>
            {submitting
              ? (appendMode ? "Appending…" : "Importing…")
              : (appendMode ? "Append Products" : "Create Price List")}
          </button>
        </div>
      </div>

      <section className={styles.card}>
        <form
          id="price-list-import-form"
          className={styles.form}
          onSubmit={handleSubmit}
          autoComplete="off"
          noValidate
          data-show-validation={showValidationErrors ? "true" : "false"}
        >
          <div className={styles.formGrid}>
            {!appendMode && (
            <div className={styles.fieldStack}>
              <div className={styles.sectionHeading}>Price List Details</div>
              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Name <span className={styles.requiredMark}>*</span>
                  </span>
                  <input
                    autoComplete="off"
                    className={styles.input}
                    value={values.name}
                    required
                    onChange={(e) => updateField("name", e.target.value)}
                  />
                </label>
                <div className={`${styles.field} ${styles.comboWrapper}`}>
                  <span className={styles.lookupLabelRow}>
                    <span className={styles.labelText}>
                      <span className={styles.label}>
                        Brand <span className={styles.requiredMark}>*</span>
                      </span>
                    </span>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={lookupButtonStyles.lookupAddButton}
                      onClick={() => setIsAddBrandOpen(true)}
                    >
                      Add New Brand
                    </button>
                  </span>
                  <input
                    autoComplete="off"
                    className={`${styles.input} ${styles.comboInput}`}
                    value={brandText}
                    aria-invalid={showValidationErrors && !values.brandId.trim()}
                    placeholder="Type to filter brands"
                    onChange={(e) => handleBrandInputChange(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && showBrandList && filteredBrandOptions.length > 0) {
                        event.preventDefault();
                        setBrandSelection(filteredBrandOptions[0], filteredBrandOptions[0].label);
                        setBrandError(null);
                      }
                    }}
                    onFocus={(e) => {
                      e.target.select();
                      void refreshBrands();
                      setShowBrandList(true);
                    }}
                    onBlur={handleBrandBlur}
                    disabled={submitting}
                  />
                  {showBrandList && filteredBrandOptions.length > 0 ? (
                    <div className={styles.comboList}>
                      {filteredBrandOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          tabIndex={-1}
                          className={styles.comboOption}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setBrandSelection(option, option.label);
                            setBrandError(null);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {brandError ? <div className={styles.fieldError}>{brandError}</div> : null}
                  {brandsError ? <div className={styles.fieldError}>{brandsError}</div> : null}
                </div>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                  <div className={styles.lookupLabelRow}>
                    <div className={styles.labelText}>
                      <label className={styles.label}>
                        Pricing Policies <span className={styles.requiredMark}>*</span>
                      </label>
                    </div>
                  </div>
                  {selectedPolicySummary.length > 0 ? (
                    <div className={styles.ruleSummaryList}>
                      {selectedPolicySummary.map((policy) => (
                        <span key={policy.id} className={styles.ruleSummaryItem}>
                          {policy.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.chipListEmpty} style={{ marginBottom: "8px" }}>
                      No pricing policies selected.
                    </div>
                  )}
                  <span
                    className={styles.tooltipWrapper}
                    data-tooltip={
                      !hasBrandSelection
                        ? "Select a brand first."
                        : policiesForPicker.length === 0
                          ? "No pricing policies are available."
                          : ""
                    }
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`${styles.buttonSecondary} ${styles.rulePickerButton}`}
                      onClick={() => {
                        if (!hasBrandSelection) {
                          showToastMessage("Please select a brand first.", "error");
                          return;
                        }
                        setIsRulePickerOpen(true);
                      }}
                      disabled={!hasBrandSelection || policiesForPicker.length === 0}
                    >
                      Select Pricing Policies
                    </button>
                  </span>
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Responsible User <span className={styles.requiredMark}>*</span>
                  </span>
                  <select
                    className={styles.input}
                    value={values.responsibleUserId}
                    required
                    onMouseDown={() => void refreshLookups(["users"])}
                    onFocus={() => void refreshLookups(["users"])}
                    onChange={(e) => updateField("responsibleUserId", e.target.value)}
                  >
                    <option value="">Select responsible user</option>
                    {localUsers.map(renderOption)}
                  </select>
                </label>
                <div className={styles.field}>
                  <span className={styles.lookupLabelRow}>
                    <span className={styles.labelText}>
                      <span className={styles.label}>
                        Supplier
                      </span>
                    </span>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={lookupButtonStyles.lookupAddButton}
                      onClick={() => setIsAddSupplierOpen(true)}
                    >
                      Add New Supplier
                    </button>
                  </span>
                  <select
                    className={styles.input}
                    value={values.supplierId}
                    onMouseDown={() => void refreshLookups(["suppliers"])}
                    onFocus={() => void refreshLookups(["suppliers"])}
                    onChange={(e) => updateField("supplierId", e.target.value)}
                  >
                    <option value="">Select supplier</option>
                    {localSuppliers.map(renderOption)}
                  </select>
                </div>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Country</span>
                  <div className={`${styles.controlStack ?? ''} ${styles.comboWrapper}`}>
                    <input
                      autoComplete="off"
                      className={`${styles.input} ${styles.comboInput}`}
                      value={countryText}
                      placeholder="Type to filter countries"
                      onChange={(e) => handleCountryInputChange(e.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && showCountryList && filteredCountries.length > 0) {
                          event.preventDefault();
                          handleCountrySelect(filteredCountries[0]);
                        }
                      }}
                      onBlur={handleCountryBlur}
                      onFocus={(e) => {
                        clearCountryListCloseTimer();
                        e.target.select();
                        void refreshLookups(["countries"]);
                        setShowCountryList(true);
                      }}
                    />
                    {showCountryList && filteredCountries.length > 0 ? (
                      <div className={styles.comboList}>
                        {filteredCountries.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            tabIndex={-1}
                            className={styles.comboOption}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleCountrySelect(option)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Cost Currency</span>
                  <select
                    className={styles.input}
                    value={values.costCurrencyId}
                    onMouseDown={() => void refreshLookups(["currencies"])}
                    onFocus={() => void refreshLookups(["currencies"])}
                    onChange={(e) => updateField("costCurrencyId", e.target.value)}
                  >
                    {costCurrencyOptions.map(renderOption)}
                  </select>
                  <span className={styles.helpText}>
                    The cost price column is in this currency. Cost price is converted to € using the modifier.
                  </span>
                </label>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.field} />
                {!isCostCurrencyEuro ? (
                  <label className={styles.field}>
                    <span className={styles.label}>Currency Cost Modifier</span>
                    <input
                      autoComplete="off"
                      className={styles.input}
                      inputMode="decimal"
                      placeholder="1"
                      value={values.currencyCostModifier}
                      onChange={(e) => updateField("currencyCostModifier", e.target.value)}
                    />
                    <span className={styles.helpText}>
                      EUR cost = Cost Price × Modifier
                    </span>
                  </label>
                ) : null}
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Valid From <span className={styles.requiredMark}>*</span>
                  </span>
                  <UKDatePicker
                    value={values.validFromDate}
                    onChange={(value) => updateField("validFromDate", value)}
                    placeholder="DD/MM/YYYY"
                    className={styles.input}
                    invalid={showValidationErrors && invalidDateRange}
                    required
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>
                    Valid To <span className={styles.requiredMark}>*</span>
                  </span>
                  <UKDatePicker
                    value={values.validToDate}
                    onChange={(value) => updateField("validToDate", value)}
                    placeholder="DD/MM/YYYY"
                    className={styles.input}
                    invalid={showValidationErrors && invalidDateRange}
                    required
                  />
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Comments</span>
                  <textarea
                    autoComplete="off"
                    className={`${styles.input} ${styles.textarea}`}
                    value={values.comments}
                    onChange={(e) => updateField("comments", e.target.value)}
                    rows={3}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Validity Comments</span>
                  <textarea
                    autoComplete="off"
                    className={`${styles.input} ${styles.textarea}`}
                    value={values.supplierComments}
                    onChange={(e) => updateField("supplierComments", e.target.value)}
                    rows={3}
                  />
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Has Duty</span>
                  <select
                    className={styles.input}
                    value={values.hasDuty === null ? "" : values.hasDuty ? "1" : "0"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "") {
                        updateField("hasDuty", null);
                      } else {
                        updateField("hasDuty", val === "1");
                      }
                    }}
                  >
                    <option value="">Select</option>
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Is Service</span>
                  <select
                    className={styles.input}
                    value={values.isService === null ? "" : values.isService ? "1" : "0"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "") {
                        updateField("isService", null);
                      } else {
                        updateField("isService", val === "1");
                      }
                    }}
                  >
                    <option value="">Select</option>
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </label>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>Previous Version</span>
                <select
                  className={styles.input}
                  value={values.previousPriceListId}
                  onChange={(e) => updateField("previousPriceListId", e.target.value)}
                >
                  <option value="">No previous price list</option>
                  {filteredPreviousPriceLists.map(renderOption)}
                </select>
                <span className={styles.helpText}>
                  If selected, the previous price list will be disabled and replaced by this one.
                </span>
              </label>
            </div>
            )}

          <div className={styles.fieldStack}>
            <div className={styles.sectionHeading}>Upload</div>
            <div className={styles.field}>
              <span className={styles.label}>Price list decimal format</span>
              <select
                className={styles.input}
                value={values.decimalFormat}
                onChange={(event) =>
                  updateField("decimalFormat", event.target.value as PriceListDecimalFormat)
                }
              >
                {PRICE_LIST_DECIMAL_FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {`${option.label} - ${option.description}`}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.uploadCard}>
              <label
                className={`${styles.uploadArea} ${showValidationErrors && !file ? 'fastquote-invalid-outline' : ''} ${isDragging ? styles.uploadAreaDragging : ""}`}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleFileDrop}
              >
                <input
                  autoComplete="off"
                  type="file"
                  accept=".xlsx,.xlsm,.xls,.csv"
                  className={styles.fileInput}
                  onChange={handleFileChange}
                />
                <div className={styles.uploadText}>
                  <div className={styles.uploadTitle}>Drop your Excel file here</div>
                    <div className={styles.uploadSubtitle}>
                      Required columns: Part Number and List Price. Model Number, Name/Description, Cost Price and Warning are optional.
                    </div>
                    {file ? (
                      <div className={styles.selectedFile}>
                        Selected: <strong>{file.name}</strong>
                      </div>
                    ) : (
                      <div className={styles.selectedFile}>Accepted: .xlsx, .xlsm, .xls, .csv</div>
                    )}
                    <div
                      className={`${styles.validationStatus} ${
                        fileValidation.status === "valid"
                          ? styles.validationValid
                          : fileValidation.status === "invalid"
                            ? styles.validationInvalid
                            : fileValidation.status === "checking"
                              ? styles.validationChecking
                              : styles.validationIdle
                      }`}
                    >
                      <div
                        className={`${styles.statusIcon} ${
                          fileValidation.status === "valid"
                            ? styles.statusIconValid
                            : fileValidation.status === "invalid"
                              ? styles.statusIconInvalid
                              : fileValidation.status === "checking"
                                ? styles.statusIconChecking
                                : styles.statusIconIdle
                        }`}
                        aria-hidden="true"
                      >
                        {fileValidation.status === "valid"
                          ? "✓"
                          : fileValidation.status === "invalid"
                            ? "!"
                            : fileValidation.status === "checking"
                              ? "…"
                              : "○"}
                      </div>
                      <div className={styles.validationContent}>
                        <div className={styles.validationTitle}>
                          {fileValidation.status === "valid"
                            ? "File looks good"
                            : fileValidation.status === "invalid"
                              ? "Check the columns"
                              : fileValidation.status === "checking"
                                ? "Checking file format"
                                : "Waiting for a file"}
                        </div>
                        <div className={styles.validationMessage}>
                          {fileValidation.message ??
                            "Choose columns for the fields below."}
                          {activeSheet ? (
                            <span className={styles.validationHint}>
                              {`Detected ${activeSheet.columns.length} column${activeSheet.columns.length === 1 ? "" : "s"} in ${activeSheet.name}. `}
                              {activeSheet.rowCount > 0
                                ? activeSheet.visibleDataRowIndices !== null
                                  ? `${activeSheet.visibleRowCount} visible row${activeSheet.visibleRowCount === 1 ? "" : "s"} of ${activeSheet.rowCount} total (Excel filter active).`
                                  : `${activeSheet.rowCount} data row${activeSheet.rowCount === 1 ? "" : "s"} after the header.`
                                : "No data rows detected yet."}
                            </span>
                          ) : null}
                        </div>
                        {fileValidation.sheets.length > 0 ? (
                          <div className={styles.sheetSelector}>
                            {fileValidation.sheets.length > 1 ? (
                              <div className={styles.sheetToggle}>
                                <span>Multi-select</span>
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  className={`${styles.toggleSwitch} ${multiSelectEnabled ? styles.toggleSwitchOn : ""}`}
                                  onClick={() => setMultiSelectEnabled((prev) => !prev)}
                                >
                                  <span className={styles.toggleKnob} />
                                </button>
                              </div>
                            ) : null}
                            <div className={styles.sheetTabs}>
                              {fileValidation.sheets.map((sheet, idx) => {
                                const isActive = idx === fileValidation.activeSheetIndex;
                                const included = sheet.enabled;
                                return (
                                  <button
                                    type="button"
                                    tabIndex={-1}
                                    key={sheet.name || idx}
                                    className={`${styles.sheetTab} ${isActive ? styles.sheetTabActive : ""} ${included ? styles.sheetTabIncluded : ""}`}
                                    onClick={() => {
                                      if (!multiSelectEnabled && fileValidation.sheets.length > 1) {
                                        setFileValidation((prev) => {
                                          const sheets = prev.sheets.map((s, i) => ({ ...s, enabled: i === idx }));
                                          const evaluation = evaluateSelection(sheets, idx);
                                          return { ...prev, ...evaluation, sheets, activeSheetIndex: idx };
                                        });
                                      } else {
                                        handleSheetChange(idx);
                                      }
                                    }}
                                  >
                                    {multiSelectEnabled && fileValidation.sheets.length > 1 ? (
                                      <input
                                        type="checkbox"
                                        tabIndex={-1}
                                        checked={included}
                                        className={styles.sheetTabCheckbox}
                                        onChange={(e) => {
                                          e.stopPropagation();
                                          toggleSheetEnabled(idx, e.target.checked);
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    ) : null}
                                    {sheet.name || `Sheet ${idx + 1}`}
                                    <span className={styles.sheetTabRows}>
                                      {sheet.visibleDataRowIndices !== null
                                        ? `${sheet.visibleRowCount} / ${sheet.rowCount} rows`
                                        : `${sheet.rowCount} rows`}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            <div className={styles.helpText}>
                              <strong>{activeSheet?.name || "Sheet"}</strong> — Choose columns for the fields below.
                            </div>
                            <div className={styles.mappingGrid}>
                              {COLUMN_DISPLAY.filter((column) => !column.serviceOnly || values.isService).map((column) => {
                                const selectionValue =
                                  activeSheet?.selection[column.key] != null
                                    ? String(activeSheet.selection[column.key])
                                    : "";
                                const suggestions = activeSheet?.suggestions[column.key] ?? [];
                                const suggestedIndexes = new Set(suggestions.map((opt) => opt.index));
                                const otherOptions =
                                  activeSheet?.columns.filter((col) => !suggestedIndexes.has(col.index)) ?? [];
                                return (
                                  <label key={column.key} className={styles.mappingField}>
                                    <span className={styles.mappingLabel}>
                                      {column.label}{column.key === "listPrice" && values.isService ? " (Ath price for services)" : ""} {column.required ? <span className={styles.requiredMark}>*</span> : null}
                                    </span>
                                    <select
                                      className={styles.input}
                                      required={Boolean(column.required)}
                                      value={selectionValue}
                                      onChange={(e) =>
                                        updateColumnSelection(
                                          column.key,
                                          e.target.value === "" ? null : Number(e.target.value),
                                        )
                                      }
                                      disabled={!activeSheet}
                                    >
                                      <option value="">Choose a column</option>
                                      {suggestions.length > 0 ? (
                                        <optgroup label="Suggested">
                                          {suggestions.map((opt) => (
                                            <option key={opt.index} value={opt.index}>
                                              {opt.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ) : null}
                                      {otherOptions.length > 0 ? (
                                        <optgroup label="All columns">
                                          {otherOptions.map((opt) => (
                                            <option key={opt.index} value={opt.index}>
                                              {opt.label}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ) : null}
                                    </select>
                                  </label>
                                );
                              })}
                            </div>
                            {activeSheet ? (
                              <div className={styles.previewSection}>
                                <div className={styles.previewHeading}>
                                  <span>
                                    {activeSheet.visibleDataRowIndices !== null
                                      ? `Sample rows - ${activeSheet.visibleRowCount} visible of ${activeSheet.rowCount} total (Excel filter active)`
                                      : `Sample rows (first ${displayPreviewRows.length > 0 ? displayPreviewRows.length : 3})`}
                                  </span>
                                  <span className={styles.previewHint}>
                                    Showing mapped columns; the list price column is bold.
                                  </span>
                                </div>
                                {previewColumns.length === 0 ? (
                                  <div className={styles.previewEmpty}>
                                    Select columns for Part Number and List Price to see a preview.
                                  </div>
                                ) : displayPreviewRows.length === 0 ? (
                                  <div className={styles.previewEmpty}>
                                    No preview data available for this sheet yet.
                                  </div>
                                ) : (
                                  <div className={styles.previewTableWrapper}>
                                    <table className={styles.previewTable}>
                                      <thead>
                                        <tr>
                                          {previewColumns.map((column) => (
                                            <th key={column.key}>{column.label}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {displayPreviewRows.map((row, rowIndex) => (
                                          <tr key={rowIndex}>
                                            {previewColumns.map((column) => (
                                              <td
                                                key={`${rowIndex}-${column.key}`}
                                                className={column.isListPrice ? styles.previewListPrice : ""}
                                              >
                                                {formatPreviewCell(row[column.columnIndex])}
                                              </td>
                                            ))}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className={styles.validationColumns}>
                          {COLUMN_DISPLAY.filter((column) => !column.serviceOnly || values.isService).map((column) => {
                            const found = Boolean(fileValidation.columns[column.key]);
                            const pillState = found
                              ? styles.columnPillGood
                              : column.required
                                ? styles.columnPillWarn
                                : styles.columnPillMuted;
                            return (
                              <div
                                key={column.key}
                                className={`${styles.columnPill} ${pillState}`}
                              >
                                <span className={styles.columnPillIcon}>
                                  {found ? "✓" : column.required ? "!" : "•"}
                                </span>
                                {column.label}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>

        </form>
      </section>
      <AddBrandModal
        open={isAddBrandOpen}
        onClose={() => setIsAddBrandOpen(false)}
        onCreated={handleBrandCreated}
      />
      <AddSupplierModal
        open={isAddSupplierOpen}
        onClose={() => setIsAddSupplierOpen(false)}
        onCreated={handleSupplierCreated}
        countries={countriesForModal}
      />
    </main>
      <LookupModal
        open={isRulePickerOpen}
        title="Select Pricing Policies"
        onClose={() => setIsRulePickerOpen(false)}
        onConfirm={applyRuleSelection}
        confirmLabel="Apply"
        error={rulePickerError}
        cardClassName={styles.rulePickerModal}
        bodyClassName={styles.rulePickerBody}
      >
        {policiesForPicker.length > 0 ? (
          <table className={styles.ruleTable}>
            <thead>
              <tr>
                <th className={styles.ruleCheckboxCell} />
                <th>Pricing Policy</th>
                <th>Telmaco Discount</th>
                <th>Customer Discount</th>
                <th>Telmaco Warranty</th>
                <th>Customer Warranty</th>
              </tr>
            </thead>
            <tbody>
              {policiesForPicker.map((row) => {
                const policyId = row.pricingPolicyId;
                const isSelected = policyPickerSelection.has(policyId);
                const draft = discountDrafts[policyId] ?? null;
                return (
                  <tr key={policyId} className={isSelected ? styles.ruleRowSelected : ""}>
                    <td className={styles.ruleCheckboxCell}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          togglePolicySelection(policyId);
                        }}
                      />
                    </td>
                    <td className={styles.rulePolicy}>{row.pricingPolicyName}</td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.telmaco ?? formatDiscountValue(row.telmacoDiscountPercentage ?? null)}
                        onChange={(event) => {
                          handlePolicyDiscountChange(policyId, "telmaco", event.target.value);
                        }}
                        onBlur={() => handlePolicyDiscountSave(row, "telmaco")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!hasBrandSelection}
                        aria-label={`Telmaco discount for ${row.pricingPolicyName}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.customer ?? formatDiscountValue(row.customerDiscountPercentage ?? null)}
                        onChange={(event) => {
                          handlePolicyDiscountChange(policyId, "customer", event.target.value);
                        }}
                        onBlur={() => handlePolicyDiscountSave(row, "customer")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!hasBrandSelection}
                        aria-label={`Customer discount for ${row.pricingPolicyName}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.telmacoWarranty ?? (row.telmacoWarrantyYears != null ? String(row.telmacoWarrantyYears) : "")}
                        onChange={(event) => {
                          handlePolicyDiscountChange(policyId, "telmacoWarranty", event.target.value);
                        }}
                        onBlur={() => handlePolicyDiscountSave(row, "telmacoWarranty")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!hasBrandSelection}
                        aria-label={`Telmaco warranty for ${row.pricingPolicyName}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.customerWarranty ?? (row.customerWarrantyYears != null ? String(row.customerWarrantyYears) : "")}
                        onChange={(event) => {
                          handlePolicyDiscountChange(policyId, "customerWarranty", event.target.value);
                        }}
                        onBlur={() => handlePolicyDiscountSave(row, "customerWarranty")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!hasBrandSelection}
                        aria-label={`Customer warranty for ${row.pricingPolicyName}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className={styles.ruleTableEmpty}>No pricing policies available.</div>
        )}
      </LookupModal>
      <LookupModal
        open={isAddPricingPolicyRuleOpen}
        title="Add Pricing Policy Rule"
        onClose={() => setIsAddPricingPolicyRuleOpen(false)}
        onConfirm={handleCreatePricingPolicyRule}
        confirmLabel="Create"
        saving={pricingPolicyRuleSaving}
        error={pricingPolicyRuleError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-name">
            Name
          </label>
          <input
            id="import-rule-name"
            className={lookupStyles.fieldControl}
            value={newRuleName}
            required
            onChange={(event) => setNewRuleName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-pricing-policy">
            Pricing policy
          </label>
          <select
            id="import-rule-pricing-policy"
            className={lookupStyles.fieldControl}
            value={newRulePricingPolicyId}
            required
            onChange={(event) => setNewRulePricingPolicyId(event.target.value)}
          >
            <option value="">Select pricing policy</option>
            {localPricingPolicies.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-brand">
            Brand
          </label>
          <select
            id="import-rule-brand"
            className={lookupStyles.fieldControl}
            value={newRuleBrandId}
            onChange={(event) => setNewRuleBrandId(event.target.value)}
          >
            <option value="">All brands (default)</option>
            {localBrands.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-telmaco">
            Telmaco discount (%)
          </label>
          <input
            id="import-rule-telmaco"
            className={lookupStyles.fieldControl}
            value={newRuleTelmaco}
            required
            onChange={(event) => setNewRuleTelmaco(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-customer">
            Customer discount (%)
          </label>
          <input
            id="import-rule-customer"
            className={lookupStyles.fieldControl}
            value={newRuleCustomer}
            required
            onChange={(event) => setNewRuleCustomer(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-telmaco-warranty">
            Telmaco warranty (years)
          </label>
          <input
            id="import-rule-telmaco-warranty"
            className={lookupStyles.fieldControl}
            value={newRuleTelmacoWarranty}
            onChange={(event) => setNewRuleTelmacoWarranty(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-customer-warranty">
            Customer warranty (years)
          </label>
          <input
            id="import-rule-customer-warranty"
            className={lookupStyles.fieldControl}
            value={newRuleCustomerWarranty}
            onChange={(event) => setNewRuleCustomerWarranty(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-user">
            Responsible user
          </label>
          <select
            id="import-rule-user"
            className={lookupStyles.fieldControl}
            value={newRuleResponsibleUserId}
            onMouseDown={() => void refreshLookups(["users"])}
            onFocus={() => void refreshLookups(["users"])}
            onChange={(event) => setNewRuleResponsibleUserId(event.target.value)}
          >
            <option value="">Select responsible user </option>
            {localUsers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="import-rule-comments">
            Comments
          </label>
          <textarea
            id="import-rule-comments"
            className={`${lookupStyles.fieldControl} ${lookupStyles.textarea}`}
            value={newRuleComments}
            onChange={(event) => setNewRuleComments(event.target.value)}
          />
        </div>
      </LookupModal>
      {showSheetSelector && fileValidation.sheets.length > 1 ? (
        <div className={styles.sheetSelectorOverlay}>
          <div className={styles.sheetSelectorPopup} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetSelectorHeader}>
              <div className={styles.sheetSelectorTitle}>Sheet Selection</div>
              <button
                type="button"
                className={styles.sheetSelectorClose}
                aria-label="Close dialog"
                onClick={() => setShowSheetSelector(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.sheetSelectorDescription}>
              {`I have found ${fileValidation.sheets.length} sheets. Please select the appropriate sheet or multiple ones, after you close this window.`}
            </div>
            <div className={styles.sheetSelectorList}>
              {fileValidation.sheets.map((sheet, idx) => {
                const selected = sheet.enabled;
                return (
                  <div
                    key={sheet.name || idx}
                    className={`${styles.sheetSelectorItem} ${selected ? styles.sheetSelectorItemSelected : ""}`}
                  >
                    <span className={styles.sheetSelectorItemName}>{sheet.name || `Sheet ${idx + 1}`}</span>
                    <span className={styles.sheetSelectorItemRows}>{sheet.rowCount} rows</span>
                  </div>
                );
              })}
            </div>
            {(() => {
              const enabled = fileValidation.sheets.filter((s) => s.enabled);
              if (enabled.length === 1) {
                return (
                  <div className={styles.sheetSelectorDescription}>
                    {"Auto-selected "}
                    <strong>{enabled[0].name}</strong>
                    {` with ${enabled[0].rowCount} rows (largest sheet).`}
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>
      ) : null}
      {importSummary ? (
        <div className={styles.summaryOverlay}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryHeader}>
              <div className={styles.summaryTitle}>Import Summary</div>
            </div>
            <div className={styles.summaryStats}>
              <span className={styles.summaryStat}>
                Total: <span className={styles.summaryStatValue}>{importSummary.totalRows}</span>
              </span>
              <span className={styles.summaryStat}>
                New: <span className={styles.summaryStatValue}>{importSummary.createdProductCount}</span>
              </span>
              <span className={styles.summaryStat}>
                Matched: <span className={styles.summaryStatValue}>{importSummary.matchedProductCount}</span>
              </span>
              <span className={styles.summaryStat}>
                Skipped: <span className={styles.summaryStatValue}>{importSummary.skippedRows}</span>
              </span>
            </div>
            <div className={styles.summaryTabs}>
              <button
                type="button"
                className={`${styles.summaryTab} ${summaryTab === "priceChanges" ? styles.summaryTabActive : ""}`}
                onClick={() => setSummaryTab("priceChanges")}
              >
                Price Changes
                <span className={styles.summaryTabBadge}>{importSummary.priceChanges.length}</span>
              </button>
              <button
                type="button"
                className={`${styles.summaryTab} ${summaryTab === "newProducts" ? styles.summaryTabActive : ""}`}
                onClick={() => setSummaryTab("newProducts")}
              >
                New Products
                <span className={styles.summaryTabBadge}>{importSummary.newProducts.length}</span>
              </button>
              <button
                type="button"
                className={`${styles.summaryTab} ${summaryTab === "skipped" ? styles.summaryTabActive : ""}`}
                onClick={() => setSummaryTab("skipped")}
              >
                Skipped
                <span className={styles.summaryTabBadge}>{importSummary.skippedRowDetails.length}</span>
              </button>
            </div>
            <div className={styles.summaryBody}>
              {summaryTab === "priceChanges" ? (
                importSummary.priceChanges.length > 0 ? (
                  <div className={styles.summaryTableWrapper}>
                    <table className={styles.summaryTable}>
                      <thead>
                        <tr>
                          <th>Part Number</th>
                          <th>Description</th>
                          <th style={{ textAlign: "right" }}>Old List</th>
                          <th style={{ textAlign: "right" }}>New List</th>
                          <th style={{ textAlign: "right" }}>List %</th>
                          <th style={{ textAlign: "right" }}>Old Cost</th>
                          <th style={{ textAlign: "right" }}>New Cost</th>
                          <th style={{ textAlign: "right" }}>Cost %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importSummary.priceChanges.map((item, idx) => {
                          const listDiff =
                            item.oldListPrice != null && item.newListPrice != null
                              ? item.newListPrice - item.oldListPrice
                              : null;
                          const listPct =
                            listDiff != null && item.oldListPrice
                              ? (listDiff / item.oldListPrice) * 100
                              : null;
                          const costDiff =
                            item.oldCostPrice != null && item.newCostPrice != null
                              ? item.newCostPrice - item.oldCostPrice
                              : null;
                          const costPct =
                            costDiff != null && item.oldCostPrice
                              ? (costDiff / item.oldCostPrice) * 100
                              : null;
                          return (
                            <tr key={idx}>
                              <td>{item.partNumber ?? ""}</td>
                              <td>{item.description ?? ""}</td>
                              <td className={styles.summaryPriceValue}>
                                {formatPrice(item.oldListPrice)}
                              </td>
                              <td className={styles.summaryPriceValue}>
                                {formatPrice(item.newListPrice)}
                              </td>
                              <td
                                className={`${styles.summaryPriceValue} ${
                                  listDiff != null && listDiff > 0
                                    ? styles.summaryPriceUp
                                    : listDiff != null && listDiff < 0
                                      ? styles.summaryPriceDown
                                      : ""
                                }`}
                              >
                                {listPct != null
                                  ? `${listPct > 0 ? "+" : ""}${listPct.toFixed(1)}%`
                                  : ""}
                              </td>
                              <td className={styles.summaryPriceValue}>
                                {formatPrice(item.oldCostPrice)}
                              </td>
                              <td className={styles.summaryPriceValue}>
                                {formatPrice(item.newCostPrice)}
                              </td>
                              <td
                                className={`${styles.summaryPriceValue} ${
                                  costDiff != null && costDiff > 0
                                    ? styles.summaryPriceUp
                                    : costDiff != null && costDiff < 0
                                      ? styles.summaryPriceDown
                                      : ""
                                }`}
                              >
                                {costPct != null
                                  ? `${costPct > 0 ? "+" : ""}${costPct.toFixed(1)}%`
                                  : ""}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.summaryEmpty}>No price changes detected.</div>
                )
              ) : summaryTab === "newProducts" ? (
                importSummary.newProducts.length > 0 ? (
                  <div className={styles.summaryTableWrapper}>
                    <table className={styles.summaryTable}>
                      <thead>
                        <tr>
                          <th>Part Number</th>
                          <th>Description</th>
                          <th style={{ textAlign: "right" }}>List Price</th>
                          <th style={{ textAlign: "right" }}>Cost Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importSummary.newProducts.map((item, idx) => (
                          <tr key={idx}>
                            <td>{item.partNumber ?? ""}</td>
                            <td>{item.description ?? ""}</td>
                            <td className={styles.summaryPriceValue}>
                              {formatPrice(item.listPrice)}
                            </td>
                            <td className={styles.summaryPriceValue}>
                              {formatPrice(item.costPrice)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.summaryEmpty}>No new products.</div>
                )
              ) : importSummary.skippedRowDetails.length > 0 ? (
                <div className={styles.summaryTableWrapper}>
                  <table className={styles.summaryTable}>
                    <thead>
                      <tr>
                        <th>Part Number</th>
                        <th>Model Number</th>
                        <th>Description</th>
                        <th style={{ textAlign: "right" }}>List Price</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importSummary.skippedRowDetails.map((item, idx) => (
                        <tr key={idx}>
                          <td>{item.partNumber ?? ""}</td>
                          <td>{item.modelNumber ?? ""}</td>
                          <td>{item.description ?? ""}</td>
                          <td className={styles.summaryPriceValue}>
                            {formatPrice(item.listPrice)}
                          </td>
                          <td>{item.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className={styles.summaryEmpty}>No skipped rows.</div>
              )}
            </div>
            <div className={styles.summaryFooter}>
              <button
                type="button"
                className={styles.summaryCloseButton}
                onClick={() => {
                  const targetId = importSummary.priceListId;
                  setImportSummary(null);
                  if (targetId) {
                    router.push(`/price-lists/${encodeURIComponent(targetId)}/products`);
                  }
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
