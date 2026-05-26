export type ProductDetailsRecord = {
  ProductID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  LegacyPartNo: string | null;
  ERPCode: string | null;
  Description: string | null;
  WebLink: string | null;
  Origin: string | null;
  Enabled: boolean | null;
  BrandID: number | null;
  BrandName: string | null;
  CategoryID: number | null;
  CategoryName: string | null;
  SubCategoryID: number | null;
  SubCategoryName: string | null;
  TypeID: number | null;
  TypeName: string | null;
  IsService: boolean | null;
  ServiceType: string | null;
};

export type ProductLookupItem = { id: number; name: string };

export type ProductSubCategoryItem = ProductLookupItem & { categoryId: number | null };

export type ProductLookupsPayload = {
  brands: ProductLookupItem[];
  categories: ProductLookupItem[];
  subCategories: ProductSubCategoryItem[];
  types: ProductLookupItem[];
};
