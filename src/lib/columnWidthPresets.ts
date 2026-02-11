export const COLUMN_WIDTH_PRESETS = {
  date: 105,
  1: 110,
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
  ERPCode: 2,
  PriceListName: 3,
  CustomerName: 3,
  PricingPolicyName: 3,
  PricingPolicy: 3,
  SalesMarket: 2,
  SalesDivision: 2,
  SalesPerson: 3,
  OfferStatus: 2,
  ERPProjectID: 2,
  ERPFWCProjectID: 2,
  ERPFWCProjectShortName: 2,
  Comments: 3,
  Comment: 3,
  ProtocolNo: 2,
  OfferContact: 2,
  OfferDate: 'date',
  OfferVersion: 1,
  ModifiedOn: 3,
  RequestedItemNo: 2,
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
  CustomerDiscount: 2,
  NetUnitPrice: 2,
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
  Email: 3,
  EmailStatus: 2,
  SecondEmail: 3,
  SecondEmailStatus: 2,
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
  Address: 3,
  Country: 3,
  City1: 2,
  City2: 2,
  Website: 3,
  UserName: 2,
  FullName: 3,
  FullNameGR: 3,
  SalesSeniority: 2,
  SignTitle: 3,
  WindowsUserName: 3,
  NameCode: 1,
  Role1: 2,
  Role2: 2,
  Qty: 1,
  ResponsibleUserName: 2
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
