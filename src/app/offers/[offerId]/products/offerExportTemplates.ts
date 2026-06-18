// Template configs that drive ExportOfferProductsModal. Kept in a tiny,
// dependency-free module (no React, no xlsx) so the "Fill <template>" buttons
// can import a config statically WITHOUT pulling the heavy modal (and its lazy
// xlsx/jszip imports) into their own bundle — the modal itself stays behind a
// next/dynamic split.

export type ExportFieldKey =
  | 'no'
  | 'productReference'
  | 'manufacturer'
  | 'descriptionType'
  | 'qty'
  | 'unitPrice'
  | 'additionalDiscount'
  | 'cost'
  | 'delayForDelivery'
  | 'comments';

export type ExportFieldConfig = {
  key: ExportFieldKey;
  label: string;
  // Lowercased substrings matched (via includes) against worksheet header
  // cells to auto-detect and pre-select the target column.
  keywords: string[];
};

export type ExportTemplateConfig = {
  id: string;
  // Which offer-product fields this template writes, in display order. The
  // modal only maps/writes the fields listed here.
  fields: ExportFieldConfig[];
  // When set, the modal auto-selects the worksheet whose name matches this
  // (case-insensitive, trimmed) instead of defaulting to the second sheet.
  preferredSheetName?: string;
  title: string;
  subtitle: string;
  submitLabel: string;
};

// AVC4 — the original "Fill AVC4" template: writes the full row (identity +
// pricing) and auto-picks the second sheet.
export const AVC4_EXPORT_TEMPLATE: ExportTemplateConfig = {
  id: 'avc4',
  title: 'Export Offer Products',
  subtitle: 'Use your own Excel template and map columns automatically.',
  submitLabel: 'Fill AVC4 Offer',
  fields: [
    { key: 'no', label: 'No', keywords: ['no', 'item no', 'item', 'tree', 'ordering'] },
    { key: 'productReference', label: 'Product reference', keywords: ['product reference', 'part number', 'part no', 'reference', 'sku'] },
    { key: 'manufacturer', label: 'Manufacturer', keywords: ['manufacturer', 'brand', 'maker'] },
    { key: 'descriptionType', label: 'Description / Type', keywords: ['description / type', 'description', 'type', 'model', 'details'] },
    { key: 'qty', label: 'Qty', keywords: ['qty', 'quantity', 'pcs', 'pieces'] },
    { key: 'unitPrice', label: 'Unit price (RRP / Euro)', keywords: ['unit price', 'rrp', 'price', 'net unit price', 'euro'] },
    { key: 'additionalDiscount', label: 'Extra Discount Contractor', keywords: ['extra discount contractor', 'extra discount', 'additional discount', 'contractor discount', 'acd'] },
    { key: 'comments', label: 'Comments', keywords: ['comments', 'comment', 'notes', 'remarks'] },
  ],
};

// EP LINC — auto-picks the "Offer_List_Supplies" sheet and writes ONLY the five
// pricing columns onto its pre-filled product rows.
//   UNIT PRICE            <- List Price (ListPrice)
//   DISCOUNT - ADDITIONAL <- Additional Customer Discount
//   CONTRACTOR UNIT COST  <- Cost (NetCost)
//   DELIVERY              <- Delivery
//   COMMENT               <- Comments
export const EP_LINC_EXPORT_TEMPLATE: ExportTemplateConfig = {
  id: 'ep-linc',
  title: 'Fill EP LINC Offer',
  subtitle: 'Auto-fills the pricing columns of the Offer_List_Supplies sheet.',
  submitLabel: 'Fill EP LINC Offer',
  preferredSheetName: 'Offer_List_Supplies',
  fields: [
    { key: 'unitPrice', label: 'Unit price', keywords: ['unit price'] },
    { key: 'additionalDiscount', label: 'Discount - additional', keywords: ['discount - additional', 'discount additional', 'additional discount', 'additional'] },
    // Deliberately NOT a bare 'cost' keyword: 'unit cost'/'contractor cost' both
    // match "CONTRACTOR UNIT COST" while excluding generic NET/TOTAL/LIST COST
    // columns, so NetCost can't be auto-routed to the wrong cost column.
    { key: 'cost', label: 'Contractor unit cost', keywords: ['contractor unit cost', 'contractor cost', 'unit cost'] },
    { key: 'delayForDelivery', label: 'Delivery', keywords: ['delivery'] },
    { key: 'comments', label: 'Comment', keywords: ['comment', 'comments', 'notes', 'remarks'] },
  ],
};
