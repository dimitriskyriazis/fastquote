import type { IRowNode, RowNode } from 'ag-grid-community';

export type GridRowNode = RowNode<Record<string, unknown>> | IRowNode<Record<string, unknown>>;

export type OfferProductsPanelProps = {
  offerId: string;
  endpoint?: string;
  manualMode?: boolean;
  standardPackageMode?: boolean;
  refreshToken?: number;
  showRequestedColumns?: boolean;
  tableLayout?: 'cust' | 'wCost' | 'wReq';
  pricingPolicyName?: string | null;
  hideTotals?: boolean;
  initialSelectedOfferDetailIds?: number[];
  initialViewportScrollTop?: number | null;
  onRequestPaste?: (anchorOfferDetailId: number | null, anchorTreeOrdering: string | null) => void;
  onRequestAddStandardPackage?: (anchorOfferDetailId: number | null, anchorTreeOrdering: string | null) => void;
  onUndoStateChange?: (state: { canUndo: boolean; lastLabel: string | undefined }) => void;
  offerCreatedByUserId?: string | null;
  onMainGridSelectionChanged?: (selectedRow: { offerDetailId: number; treeOrdering: string; label: string; isRequested: boolean; parentPath: number[]; requestedBrand?: string | null; requestedPartNo?: string | null; requestedModelNo?: string | null; requestedDescription?: string | null } | null) => void;
  onRequestInsertProduct?: (anchor: { offerDetailId: number; parentPath: number[]; label: string; treeOrdering: string; isRequested: boolean }) => void;
  showInsertLineOnHover?: boolean;
  extraBottomScrollSpace?: boolean;
  onStartingItemNoChanged?: (current: number | null) => void;
  collapseAllCategories?: boolean;
  offerPricingHoldMarginOnCost?: boolean;
  onOfferPricingHoldMarginOnCostChange?: (next: boolean) => void;
  offerExtraNetDiscount?: number | null;
  offerExtraNetDiscountMode?: 'pct' | 'abs';
  onOfferExtraDiscountsChange?: (next: {
    netValue: number | null;
    netMode: 'pct' | 'abs';
  }) => Promise<void> | void;
  readOnly?: boolean;
};

export type OfferProductsPanelHandle = {
  populateOffer: () => Promise<void>;
  updateProductData: () => Promise<void>;
  getTemplateExportRows: () => Promise<OfferProductsTemplateExportRow[]>;
  getAddInsertionAnchor: () => { offerDetailId: number; parentPath: number[]; label: string; treeOrdering: string; isRequested: boolean } | null;
  getSelectedOfferDetailIdsForPriceUpdate: () => Promise<number[]>;
  getSelectedOfferDetailIds: () => Promise<number[]>;
  getSelectedRequestedOfferDetailId: () => number | null;
  forceReapplyRequestedColumnsVisibility: () => void;
  getViewportScrollTop: () => number;
  getSelectedRowData: () => Array<Record<string, unknown>>;
  getAllVisibleRowData: () => Array<Record<string, unknown>>;
  canUndo: boolean;
  performUndo: () => Promise<void>;
  lastUndoLabel: string | undefined;
  pushUndo: (entry: { label: string; undo: () => Promise<void> }) => void;
  setInsertLineVisible: (visible: boolean, atEnd?: boolean) => void;
  pinInsertLineBelowRowId: (offerDetailId: number, notifyParent?: boolean) => void;
  hasPendingInsertLinePin: () => boolean;
  deselectAllRows: () => void;
  flashRows: (offerDetailIds: number[]) => void;
  refreshAfterRowsAdded: () => void;
  applyAddedRows: (rows: Array<Record<string, unknown>>) => void;
  getLastClickedRowId: () => number | null;
  clearSelectedRowHighlight: () => void;
  getStartingItemNo: () => Promise<number>;
  applyStartingItemNoShift: (newStart: number) => Promise<{ ok: boolean; error?: string }>;
  findItemNoDuplicates: () => Promise<Array<{
    treeOrdering: string;
    rows: Array<{ OfferDetailID: number; description: string | null }>;
  }>>;
  // Excel-style cell fill: paint the currently-selected cell range with the
  // given hex colour, or pass null to clear the fill. Returns the number of
  // cells changed (0 if nothing was selected). Persisted per user + offer in
  // localStorage (purely visual — never sent to the server).
  paintSelectedCells: (color: string | null) => number;
};

export type OfferProductsTemplateExportRow = {
  no: string | number;
  productReference: string;
  manufacturer: string;
  descriptionType: string;
  qty: number | '';
  unitPrice: number | '';
  additionalDiscount: number | '';
  // Net cost (FastQuote "Cost" / NetCost). Used by the EP LINC template's
  // "Contractor unit cost" column; unused by the AVC4 template.
  cost: number | '';
  delayForDelivery: string;
  comments: string;
  skipRow?: boolean;
};

export type OfferExportRow = {
  TreeOrdering: string | null;
  PartNumber: string | null;
  BrandName: string | null;
  AVC4BrandName: string | null;
  ModelNumber: string | null;
  Description: string | null;
  Quantity: number | null;
  ListPrice: number | null;
  // Policy customer discount — drives the EP LINC price method (null/0 →
  // UPLIFT) and the export's cost gating.
  CustomerDiscount: number | null;
  // Server-computed whole-offer RRP net total of the row's manufacturer (the
  // EP LINC COMPARISON threshold input); null on non-EP LINC fetches.
  EpLincBrandRrpTotal?: number | null;
  AdditionalCustomerDiscount: number | null;
  NetCost: number | null;
  Delivery: string | null;
  Comment: string | null;
  IsPrintable?: boolean | null;
  IsComment?: boolean | null;
  IsCategory?: boolean | null;
  IsOption?: boolean | number | null;
  IsService?: boolean | number | null;
  ServiceType?: string | null;
};
