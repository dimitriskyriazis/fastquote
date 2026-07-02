// Template configs that drive ExportOfferProductsModal. Kept in a tiny,
// dependency-free module (no React, no xlsx) so the "Fill <template>" buttons
// can import a config statically WITHOUT pulling the heavy modal (and its lazy
// xlsx/jszip imports) into their own bundle — the modal itself stays behind a
// next/dynamic split.

export type ExportFieldKey =
  | 'no'
  | 'productReference'
  | 'manufacturer'
  | 'epLincManufacturer'
  | 'descriptionType'
  | 'productName'
  | 'freeDescription'
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

// A single value cell on a form-style admin sheet (labels in one column,
// values in another). Located primarily by the template's machine-key cell
// (e.g. the EP LINC workbook carries stable keys like OF_CP in column D),
// falling back to the human label; the value is written in `valueColumn` of
// the matched row.
export type AdminSheetFieldConfig = {
  // Key into the adminValues map the "Fill" button supplies to the modal.
  key: string;
  label: string;
  // Exact (trimmed, lowercased) machine-key cell texts. Matched with strict
  // equality anywhere on the sheet — 'of_cp' must NOT match 'of_cpy'.
  cellKeys: string[];
  // Fallback label matching: every keyword must appear in the label cell text.
  labelKeywords: string[];
};

export type AdminSheetConfig = {
  // Worksheet name (matched case-insensitively, trimmed).
  sheetName: string;
  // 0-based column index the values are written into (EP LINC: column B).
  valueColumn: number;
  fields: AdminSheetFieldConfig[];
};

// A second product-rows sheet the export also fills (same aligned row set as
// the main sheet — rows land at Table-data-start + No − 1). Columns are
// resolved automatically by exact (trimmed, lowercased) header-cell text —
// anchor on the template's machine-key header row (e.g. Product_reference)
// rather than the human labels, which get reworded between versions. No UI
// mapping: unresolvable columns are reported in a toast and skipped.
export type SecondaryRowSheetFieldConfig = {
  key: ExportFieldKey;
  label: string;
  headerKeys: string[];
};

export type SecondaryRowSheetConfig = {
  sheetName: string;
  fields: SecondaryRowSheetFieldConfig[];
};

export type ExportTemplateConfig = {
  id: string;
  // Which offer-product fields this template writes, in display order. The
  // modal only maps/writes the fields listed here.
  fields: ExportFieldConfig[];
  // When set, the modal auto-selects the worksheet whose name matches this
  // (case-insensitive, trimmed) instead of defaulting to the second sheet.
  preferredSheetName?: string;
  // Optional form-style sheet whose labelled value cells the modal also fills
  // (from the adminValues prop) alongside the product rows.
  adminSheet?: AdminSheetConfig;
  // Optional second product-rows sheet filled with the same aligned rows.
  secondaryRowSheet?: SecondaryRowSheetConfig;
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
  // The workbook's Offer_Admin form sheet: labels in column A, values in
  // column B, stable machine keys (OF_*) in column D — the keys are the
  // primary anchors since labels may be reworded between template versions.
  adminSheet: {
    sheetName: 'Offer_Admin',
    valueColumn: 1,
    fields: [
      { key: 'contactPerson', label: 'Contact person', cellKeys: ['of_cp'], labelKeywords: ['contact', 'person'] },
      { key: 'phone', label: 'Phone', cellKeys: ['of_phone'], labelKeywords: ['phone'] },
      { key: 'contractorOfferReference', label: "Contractor's Offer reference", cellKeys: ['of_ref_ext'], labelKeywords: ['contractor', 'offer', 'reference'] },
    ],
  },
  // The Request_List_Supplies sheet gets the product identity from FastQuote.
  // Its Excel Table (RQ_SPY_LIST) carries a machine-key header row
  // (Manufacturer_name / Product_reference / ...) directly under the human
  // labels — those keys anchor the columns. "Manufacturer Listed?"
  // (Manufacturer_Listed) is a workbook formula column and is left alone.
  secondaryRowSheet: {
    sheetName: 'Request_List_Supplies',
    fields: [
      // epLincManufacturer = Brands.EPLINCName when set, else the brand name.
      { key: 'epLincManufacturer', label: 'Manufacturer', headerKeys: ['manufacturer_name'] },
      { key: 'productReference', label: 'Product Reference', headerKeys: ['product_reference'] },
      { key: 'productName', label: 'Product Name', headerKeys: ['product_name'] },
      { key: 'freeDescription', label: 'Free description', headerKeys: ['description'] },
      { key: 'qty', label: 'Quantity', headerKeys: ['product_qty'] },
      { key: 'comments', label: 'Comments', headerKeys: ['comments'] },
    ],
  },
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
