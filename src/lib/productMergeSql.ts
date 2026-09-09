/**
 * Shared SQL for the product-merge preview and commit routes.
 *
 * Companion to customerMergeSql.ts. Products have no optional columns to probe
 * for (every column read here exists on both dev and prod), so this file is
 * plainer: the record SELECT, the price-list rows, the field/column mapping and
 * the parameter binding the commit route uses to write picked values.
 */
import sql from 'mssql';
import type { ConnectionPool, Request as SqlRequest } from 'mssql';
import {
  MERGE_FIELDS,
  MAX_MERGE_SECONDARIES,
  type MergeFieldKey,
  type MergePriceListItemRecord,
  type MergeProductRecord,
} from '../app/products/merge/productMergeTypes';
import { collectMergeIds } from './customerMergeSql';

type FieldColumn = {
  column: string;
  type: 'string' | 'number' | 'boolean';
  /** Characters, for NVARCHAR(n) columns; absent means NVARCHAR(MAX). */
  length?: number;
  /** NOT NULL in dbo.Products: a null pick has to be ignored, not written. */
  notNull?: boolean;
};

/**
 * Column mapping and bind types, aligned with the PATCH in
 * /api/products/[productId] so a value written through the merge is
 * indistinguishable from one written through the grid.
 *
 * Lengths are the real column sizes (nvarchar(510) bytes = 255 chars, ERPCode is
 * nvarchar(100) bytes = 50 chars, ServiceType 40 bytes = 20 chars, Origin 200
 * bytes = 100 chars). The *Cleared columns are not here: the commit route
 * derives them from the picked PartNumber / ModelNumber / LegacyPartNo.
 */
export const MERGE_FIELD_COLUMNS: Record<MergeFieldKey, FieldColumn> = {
  BrandID: { column: 'BrandID', type: 'number', notNull: true },
  PartNumber: { column: 'PartNumber', type: 'string', length: 255, notNull: true },
  ModelNumber: { column: 'ModelNumber', type: 'string', length: 255 },
  LegacyPartNo: { column: 'LegacyPartNo', type: 'string', length: 255 },
  ERPID: { column: 'ERPID', type: 'number' },
  ERPCode: { column: 'ERPCode', type: 'string', length: 50 },
  CategoryID: { column: 'CategoryID', type: 'number' },
  SubCategoryID: { column: 'SubCategoryID', type: 'number' },
  TypeID: { column: 'TypeID', type: 'number' },
  IsService: { column: 'IsService', type: 'boolean' },
  ServiceType: { column: 'ServiceType', type: 'string', length: 20 },
  Description: { column: 'Description', type: 'string' },
  Comments: { column: 'Comments', type: 'string' },
  WebLink: { column: 'WebLink', type: 'string', length: 255 },
  Origin: { column: 'Origin', type: 'string', length: 100 },
};

export const bindMergeField = (
  request: SqlRequest,
  paramName: string,
  field: MergeFieldKey,
  value: string | number | boolean | null,
): void => {
  const config = MERGE_FIELD_COLUMNS[field];
  if (config.type === 'number') {
    request.input(paramName, sql.Int, value === null || value === '' ? null : Number(value));
    return;
  }
  if (config.type === 'boolean') {
    request.input(paramName, sql.Bit, value === null || value === '' ? null : (value ? 1 : 0));
    return;
  }
  request.input(
    paramName,
    config.length ? sql.NVarChar(config.length) : sql.NVarChar(sql.MAX),
    value === null || value === '' ? null : String(value),
  );
};

const buildIdList = (request: SqlRequest, prefix: string, ids: readonly number[]): string => {
  const names = ids.map((id, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.Int, id);
    return `@${name}`;
  });
  // An empty IN () is a syntax error; SELECT NULL never matches, which is the
  // behaviour every caller wants for an empty set.
  return names.length > 0 ? names.join(', ') : 'SELECT NULL';
};

export const fetchMergeProducts = async (
  pool: ConnectionPool,
  ids: readonly number[],
): Promise<MergeProductRecord[]> => {
  if (ids.length === 0) return [];
  const request = pool.request();
  const idList = buildIdList(request, 'pid', ids);

  const result = await request.query<MergeProductRecord>(`
    SELECT
      p.ID AS ProductID,
      p.BrandID, b.Name AS BrandName,
      p.PartNumber, p.PartNumberCleared,
      p.ModelNumber, p.ModelNumberCleared,
      p.LegacyPartNo,
      p.ERPID, p.ERPCode,
      p.CategoryID, pc.Name AS CategoryName,
      p.SubCategoryID, psc.Name AS SubCategoryName,
      p.TypeID, pt.Name AS TypeName,
      p.IsService, p.ServiceType,
      p.Description, p.Comments, p.WebLink, p.Origin,
      p.Enabled, p.CreatedOn, p.ModifiedOn,
      ISNULL(lines.n, 0) AS OfferLineCount,
      ISNULL(lines.offers, 0) AS OfferCount,
      ISNULL(pli.n, 0) AS PriceListItemCount,
      ISNULL(pli.live, 0) AS EnabledPriceListItemCount
    FROM dbo.Products AS p
    LEFT JOIN dbo.Brands AS b ON b.ID = p.BrandID
    LEFT JOIN dbo.ProductCategories AS pc ON pc.ID = p.CategoryID
    LEFT JOIN dbo.ProductSubCategories AS psc ON psc.ID = p.SubCategoryID
    LEFT JOIN dbo.ProductTypes AS pt ON pt.ID = p.TypeID
    OUTER APPLY (
      SELECT COUNT(*) AS n, COUNT(DISTINCT od.OfferID) AS offers
      FROM dbo.OfferDetails AS od WHERE od.ProductID = p.ID
    ) AS lines
    OUTER APPLY (
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN ISNULL(pl.Enabled, 0) = 1 THEN 1 ELSE 0 END) AS live
      FROM dbo.PriceListItems AS i
      LEFT JOIN dbo.PriceLists AS pl ON pl.ID = i.PriceListID
      WHERE i.ProductID = p.ID
    ) AS pli
    WHERE p.ID IN (${idList})
  `);
  return result.recordset ?? [];
};

export const fetchMergePriceListItems = async (
  pool: ConnectionPool,
  productIds: readonly number[],
): Promise<MergePriceListItemRecord[]> => {
  if (productIds.length === 0) return [];
  const request = pool.request();
  const idList = buildIdList(request, 'ppid', productIds);

  const result = await request.query<MergePriceListItemRecord>(`
    SELECT
      i.ID AS PriceListItemID,
      i.ProductID,
      i.PriceListID,
      pl.Name AS PriceListName,
      pl.Enabled AS PriceListEnabled,
      pl.BrandID AS PriceListBrandID,
      i.ListPrice, i.CostPrice, i.MOQ,
      i.Enabled, i.Warning, i.ModifiedOn,
      ISNULL(lines.n, 0) AS OfferLineCount
    FROM dbo.PriceListItems AS i
    LEFT JOIN dbo.PriceLists AS pl ON pl.ID = i.PriceListID
    OUTER APPLY (
      SELECT COUNT(*) AS n FROM dbo.OfferDetails AS od WHERE od.PriceListItemID = i.ID
    ) AS lines
    WHERE i.ProductID IN (${idList})
    ORDER BY pl.Enabled DESC, pl.Name, i.PriceListID, i.ProductID
  `);
  return result.recordset ?? [];
};

/** Field descriptors in display order (all of them exist on every database). */
export const availableMergeFields = () => [...MERGE_FIELDS];

// Re-exported so the merge routes keep one import for their shared pieces.
export { MAX_MERGE_SECONDARIES, collectMergeIds };
