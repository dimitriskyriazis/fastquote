/**
 * Shared contract between the product-merge screens and their API routes.
 *
 * Mirrors customers/merge/customerMergeTypes.ts. The merge is non-destructive
 * for products: the surviving (primary) product takes the field values the user
 * picked, every offer line and every price-list row of the secondaries, and the
 * secondaries are then set Enabled = 0. The one thing that IS removed is a
 * price-list row that would otherwise leave the survivor with two prices in the
 * same price list; the removed row is written in full to the audit log first.
 *
 * Why merge at all, rather than just disabling the duplicate: price-list import
 * matches products on PartNumberCleared, product search hides disabled rows,
 * and a Soft1 link on the disabled twin would make the survivor create a
 * SECOND item in the ERP the next time it was ordered. Moving history and the
 * ERP link onto one row fixes all three.
 */

/**
 * Upper bound on how many products can be folded into one primary in a single
 * pass. Product duplicates come in pairs and small groups (the largest
 * same-brand collision group in the catalogue had 3 members), and the field
 * picker is a table with one column per source, so this stays small on purpose.
 *
 * Lives here rather than next to the merge SQL because the products grid needs
 * it to label its context-menu item, and that is a client component.
 */
export const MAX_MERGE_SECONDARIES = 9;

export type MergeFieldKey =
  | 'BrandID'
  | 'PartNumber'
  | 'ModelNumber'
  | 'LegacyPartNo'
  | 'ERPID'
  | 'ERPCode'
  | 'CategoryID'
  | 'SubCategoryID'
  | 'TypeID'
  | 'IsService'
  | 'ServiceType'
  | 'Description'
  | 'Comments'
  | 'WebLink'
  | 'Origin';

/**
 * Fields that must be picked from ONE source together.
 *
 * - identity: (BrandID, PartNumber) is the product's key. UX_Products_PartNumber_BrandID
 *   makes the pair unique, price-list import matches on it, and a part number
 *   only means something inside its brand.
 * - erp: ERPID (the Soft1 MTRL id) and ERPCode (that item's code) are two halves
 *   of one link; mixing them would point at nothing.
 * - classification: a sub-category belongs to a category.
 * - service: ServiceType only means something when IsService is set.
 */
export type MergeFieldGroup = 'identity' | 'erp' | 'classification' | 'service';

export type MergeFieldDescriptor = {
  field: MergeFieldKey;
  label: string;
  /** Where the human-readable value lives when the stored value is an id. */
  displayField?: keyof MergeProductRecord;
  /** NOT NULL in dbo.Products: the picker must never resolve it to empty. */
  required?: boolean;
  multiline?: boolean;
  group?: MergeFieldGroup;
};

/**
 * The fields offered for side-by-side resolution, in display order.
 *
 * Enabled is intentionally absent: the merge sets it on the losers itself. The
 * three *Cleared search keys are absent too: they are derived from the picked
 * PartNumber / ModelNumber / LegacyPartNo by the commit route, never picked.
 */
export const MERGE_FIELDS: readonly MergeFieldDescriptor[] = [
  { field: 'BrandID', label: 'Brand', displayField: 'BrandName', required: true, group: 'identity' },
  { field: 'PartNumber', label: 'Part number', required: true, group: 'identity' },
  { field: 'ModelNumber', label: 'Model number' },
  { field: 'LegacyPartNo', label: 'Legacy part no' },
  { field: 'ERPID', label: 'Soft1 ID (ERPID)', group: 'erp' },
  { field: 'ERPCode', label: 'ERP Code', group: 'erp' },
  { field: 'CategoryID', label: 'Category', displayField: 'CategoryName', group: 'classification' },
  { field: 'SubCategoryID', label: 'Sub-category', displayField: 'SubCategoryName', group: 'classification' },
  { field: 'TypeID', label: 'Type', displayField: 'TypeName' },
  { field: 'IsService', label: 'Is service', group: 'service' },
  { field: 'ServiceType', label: 'Service type', group: 'service' },
  { field: 'Description', label: 'Description', multiline: true },
  { field: 'Comments', label: 'Comments', multiline: true },
  { field: 'WebLink', label: 'Web link' },
  { field: 'Origin', label: 'Origin' },
];

export type MergeProductRecord = {
  ProductID: number;
  BrandID: number;
  BrandName: string | null;
  PartNumber: string | null;
  PartNumberCleared: string | null;
  ModelNumber: string | null;
  ModelNumberCleared: string | null;
  LegacyPartNo: string | null;
  ERPID: number | null;
  ERPCode: string | null;
  CategoryID: number | null;
  CategoryName: string | null;
  SubCategoryID: number | null;
  SubCategoryName: string | null;
  TypeID: number | null;
  TypeName: string | null;
  IsService: boolean | number | null;
  ServiceType: string | null;
  Description: string | null;
  Comments: string | null;
  WebLink: string | null;
  Origin: string | null;
  Enabled: boolean | number | null;
  CreatedOn: string | null;
  ModifiedOn: string | null;
  /** dbo.OfferDetails rows pointing at this product. All of them move. */
  OfferLineCount: number;
  /** Distinct offers those lines belong to. */
  OfferCount: number;
  /** dbo.PriceListItems rows for this product, in any price list. */
  PriceListItemCount: number;
  /**
   * Of those, rows in an ENABLED price list. Import matches on the part number,
   * so the source whose part number is in a live list is the one the next import
   * will find; the survivor should be keyed that way or the twin comes back.
   */
  EnabledPriceListItemCount: number;
};

export type MergePriceListItemRecord = {
  PriceListItemID: number;
  ProductID: number;
  PriceListID: number;
  PriceListName: string | null;
  PriceListEnabled: boolean | number | null;
  PriceListBrandID: number | null;
  ListPrice: number | null;
  CostPrice: number | null;
  MOQ: number | null;
  Enabled: boolean | number | null;
  Warning: string | null;
  ModifiedOn: string | null;
  /** Offer lines whose PriceListItemID points at this row (no FK, but used). */
  OfferLineCount: number;
};

export type MergePreviewRequest = {
  primaryId: number;
  secondaryIds: number[];
};

export type MergePreview = {
  primary: MergeProductRecord;
  secondaries: MergeProductRecord[];
  /** Every price-list row of the primary and of all secondaries. */
  priceListItems: MergePriceListItemRecord[];
  /** Fields in display order. */
  fields: MergeFieldDescriptor[];
  totals: {
    offerLinesToRepoint: number;
    priceListItemsOnSecondaries: number;
    /** Price lists in which more than one of the sources has a row. */
    priceListConflicts: number;
  };
  /** Things the user should read before committing. Not blocking. */
  warnings: string[];
};

/**
 * What happens to the part number / model number / brand quoted on the offer
 * lines that end up on the survivor.
 *
 * - 'keep': lines stay exactly as quoted. The line is a snapshot of what the
 *   customer was offered; only its ProductID link changes.
 * - 'rewrite': every line of the merged product (the moved ones AND the
 *   primary's own) is updated to the survivor's part number, model number and
 *   brand where it differs, so history reads as one product.
 */
export type OfferLineMode = 'keep' | 'rewrite';

export type MergeCommitRequest = {
  primaryId: number;
  secondaryIds: number[];
  /** Field -> chosen value. Only fields in MERGE_FIELDS are honoured. */
  fieldValues: Partial<Record<MergeFieldKey, string | number | boolean | null>>;
  /**
   * For a price list where more than one source has a row: the ProductID whose
   * row survives, keyed by PriceListID (as a string, it travels through JSON).
   * Missing entries default to the primary's row when it has one.
   */
  priceListWinners: Record<string, number>;
  offerLines: {
    mode: OfferLineMode;
    /**
     * Only with mode 'rewrite': also replace ProductDescription on those lines
     * with the survivor's description. Off by default because sales edit the
     * description per line and that text is what the customer saw.
     */
    rewriteDescription: boolean;
  };
  /**
   * Run the whole merge inside the transaction and ROLL IT BACK, returning the
   * counts it would have produced. Nothing is written, nothing is logged. Exists
   * so the commit path can be exercised end to end without touching data.
   */
  dryRun?: boolean;
};

export type MergeCommitResult = {
  ok: true;
  dryRun: boolean;
  primaryId: number;
  secondaryIds: number[];
  moved: {
    offerLines: number;
    priceListItems: number;
  };
  /** Price-list rows removed because another source's row won that list. */
  deletedPriceListItems: number;
  /** Offer lines whose quoted part/model/brand were rewritten (mode 'rewrite'). */
  rewrittenOfferLines: number;
  /** Products switched off. */
  disabled: number;
  /** True when the primary took a secondary's brand + part number. */
  identitySwapped: boolean;
  fieldsUpdated: MergeFieldKey[];
  warnings: string[];
};

/** "Brand - PartNumber" with sensible fallbacks; matches the grid's labelling. */
export const productLabel = (product: {
  BrandName?: string | null;
  PartNumber?: string | null;
  ModelNumber?: string | null;
  ProductID: number;
}): string => {
  const brand = product.BrandName?.trim() ?? '';
  const part = product.PartNumber?.trim() ?? '';
  const model = product.ModelNumber?.trim() ?? '';
  const key = part || model || `#${product.ProductID}`;
  return brand ? `${brand} - ${key}` : key;
};
