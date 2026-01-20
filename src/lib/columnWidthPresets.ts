export const COLUMN_WIDTH_PRESETS = {
  date: 105,
  1: 85,
  2: 140,
  3: 210,
} as const;

export type ColumnWidthPresetKey = keyof typeof COLUMN_WIDTH_PRESETS;
export type ColumnWidthAssignment = number | ColumnWidthPresetKey;

export const GLOBAL_COLUMN_WIDTH_ASSIGNMENTS: Record<string, ColumnWidthAssignment> = {
  Brand: 2,
  BrandName: 2,
  ModelNumber: 2,
  PartNumber: 2,
  ERPPartNumber: 2,
  PriceListName: 3,
  CustomerName: 3,
  PricingPolicyName: 3,
  PricingPolicy: 3,
  SalesMarket: 2,
  SalesDivision: 2,
  SalesPerson: 2,
  OfferStatus: 2,
  ProjectID: 1,
  Comments: 3,
  ProtocolNo: 1,
  OfferContact: 2,
  OfferDate: 'date',
  OfferVersion: 1,
  ModifiedOn: 3,
  RequestedItemNo: 1,
  RequestedBrand: 2,
  RequestedModelNo: 2,
  RequestedPartNo: 2,
  RequestedDescription: 3,
  RequestedDescription2: 3,
  RequestedDescription3: 3,
  RequestedQuantity: 1,
  TreeOrdering: 1,
  ListPrice: 2,
  UnitPrice: 2,
  CustomerDiscount: 1,
  NetUnitPrice: 1,
  Quantity: 1,
  TotalPrice: 2,
  TotalNet: 2,
  Warranty: 1,
  TelmacoDiscount: 2,
  NetCostOtherCurrency: 2,
  OtherCurrencyName: 1,
  CurrencyCostModifier: 1,
  NetCost: 2,
  Margin: 1,
  GrossProfit: 2,
  TotalCost: 2,
  Name: 3,
  SupplierName: 2,
  ValidFromDate: 'date',
  ValidToDate: 'date',
  Enabled: 2,
  SupplierComment: 3,
  Description: 3,
  Title: 3,
  LastName: 2,
  FirstName: 2,
  Position: 2,
  Email: 2,
  SecondEmail: 2,
  Phone: 2,
  Mobile: 2,
  Importance: 2,
  ParentCustomer: 3,
  IsParent: 1,
  Category: 2,
  SubCategory: 2,
  Type: 2,
  WebLink: 3,
  Warning: 2,
};

export const resolveColumnWidthAssignments = (
  assignments?: Record<string, ColumnWidthAssignment>,
): Record<string, number> => {
  const merged: Record<string, ColumnWidthAssignment> = { ...GLOBAL_COLUMN_WIDTH_ASSIGNMENTS };
  if (assignments) {
    Object.assign(merged, assignments);
  }
  const resolved: Record<string, number> = {};
  Object.entries(merged).forEach(([colId, value]) => {
    const width =
      typeof value === 'number'
        ? COLUMN_WIDTH_PRESETS[String(value) as ColumnWidthPresetKey] ?? value
        : COLUMN_WIDTH_PRESETS[value];
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
      resolved[colId] = width;
    }
  });
  return resolved;
};
