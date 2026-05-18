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
  onRequestAddStandardPackage?: (anchorOfferDetailId: number, anchorTreeOrdering: string) => void;
  onUndoStateChange?: (state: { canUndo: boolean; lastLabel: string | undefined }) => void;
  offerCreatedByUserId?: string | null;
  onMainGridSelectionChanged?: (selectedRow: { offerDetailId: number; treeOrdering: string; label: string; isRequested: boolean; parentPath: number[]; requestedBrand?: string | null; requestedPartNo?: string | null; requestedModelNo?: string | null; requestedDescription?: string | null } | null) => void;
  onRequestInsertProduct?: (anchor: { offerDetailId: number; parentPath: number[]; label: string; treeOrdering: string; isRequested: boolean }) => void;
  showInsertLineOnHover?: boolean;
  extraBottomScrollSpace?: boolean;
  onStartingItemNoChanged?: (current: number | null) => void;
  collapseAllCategories?: boolean;
  onCollapseAllSuppressed?: () => void;
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
  pinInsertLineBelowRowId: (offerDetailId: number) => void;
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
};

export type OfferProductsTemplateExportRow = {
  no: string | number;
  productReference: string;
  manufacturer: string;
  descriptionType: string;
  qty: number | '';
  unitPrice: number | '';
  additionalDiscount: number | '';
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
  AdditionalCustomerDiscount: number | null;
  Delivery: string | null;
  Comment: string | null;
  IsPrintable?: boolean | null;
  IsComment?: boolean | null;
  IsCategory?: boolean | null;
  IsOption?: boolean | number | null;
  IsService?: boolean | number | null;
  ServiceType?: string | null;
};
