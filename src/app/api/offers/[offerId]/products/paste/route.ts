
import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import sql, { type ConnectionPool, type Transaction } from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { buildAuditContext } from '../../../../../../lib/auditTrail';
import { requirePermission } from '../../../../../../lib/authz';
import { parseLocaleNumber } from '../../../../../../lib/localeNumber';
import {
  comparePaths,
  formatTreeOrderingPath,
  normalizeOfferDetailId,
  normalizeTreeOrderingValue,
  parseTreeOrderingPath,
} from '../treeOrdering';

type ClipboardRow = {
  productId: number | null;
  isCategory: boolean;
  isComment: boolean;
  isPrintable: boolean | null;
  treeOrdering: string;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  productDescription: string | null;
  quantity: number | null;
  netUnitPrice: number | null;
  listPrice: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netCost: number | null;
  netCostOtherCurrency: number | null;
  margin: number | null;
  grossProfit: number | null;
  comment: string | null;
  delivery: string | null;
  warranty: number | null;
  telmacoWarranty: number | null;
  otherCurrencyId: number | null;
  currencyCostModifier: number | null;
  priceListId: number | null;
  priceListItemId: number | null;
  requestedItemNo: string | null;
  requestedBrand: string | null;
  requestedPartNo: string | null;
  requestedModelNo: string | null;
  requestedWebLink: string | null;
  requestedDescription: string | null;
  requestedDescription2: string | null;
  requestedDescription3: string | null;
  requestedQuantity: number | null;
};

type PasteBody = { rows?: unknown; keepPricing?: unknown; anchorOfferDetailId?: unknown };
type ExistingRow = { OfferDetailID: number; TreeOrdering: string | null; Ordering: number | null };
type PreparedRow = ClipboardRow & { path: string[] };
type InsertRow = PreparedRow & { seq: number; ordering: number; newTreeOrdering: string };
type TreeUpdate = { offerDetailId: number; newTreeOrdering: string };

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const coerceInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const coerceNumber = (value: unknown): number | null => {
  return parseLocaleNumber(value);
};

const coerceString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const coerceBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }
  return false;
};

const startsWithPath = (path: string[], prefix: string[]): boolean => {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
};

const toPreparedRow = (value: unknown): PreparedRow | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const treeOrdering = normalizeTreeOrderingValue(coerceString(row.treeOrdering) ?? coerceString(row.TreeOrdering));
  if (!treeOrdering) return null;
  const path = parseTreeOrderingPath(treeOrdering);
  if (path.length === 0) return null;
  return {
    productId: coerceInt(row.productId ?? row.ProductID),
    isCategory: coerceBool(row.isCategory ?? row.IsCategory),
    isComment: coerceBool(row.isComment ?? row.IsComment),
    isPrintable: row.isPrintable == null && row.IsPrintable == null ? null : coerceBool(row.isPrintable ?? row.IsPrintable),
    treeOrdering,
    partNumber: coerceString(row.partNumber ?? row.PartNumber),
    modelNumber: coerceString(row.modelNumber ?? row.ModelNumber),
    description: coerceString(row.description ?? row.Description),
    productDescription: coerceString(row.productDescription ?? row.ProductDescription),
    quantity: coerceNumber(row.quantity ?? row.Quantity),
    netUnitPrice: coerceNumber(row.netUnitPrice ?? row.NetUnitPrice),
    listPrice: coerceNumber(row.listPrice ?? row.ListPrice),
    customerDiscount: coerceNumber(row.customerDiscount ?? row.CustomerDiscount),
    telmacoDiscount: coerceNumber(row.telmacoDiscount ?? row.TelmacoDiscount),
    netCost: coerceNumber(row.netCost ?? row.NetCost),
    netCostOtherCurrency: coerceNumber(row.netCostOtherCurrency ?? row.NetCostOtherCurrency),
    margin: coerceNumber(row.margin ?? row.Margin),
    grossProfit: coerceNumber(row.grossProfit ?? row.GrossProfit),
    comment: coerceString(row.comment ?? row.Comment),
    delivery: coerceString(row.delivery ?? row.Delivery),
    warranty: coerceInt(row.warranty ?? row.Warranty),
    telmacoWarranty: coerceInt(row.telmacoWarranty ?? row.TelmacoWarranty),
    otherCurrencyId: coerceInt(row.otherCurrencyId ?? row.OtherCurrencyID),
    currencyCostModifier: coerceNumber(row.currencyCostModifier ?? row.CurrencyCostModifier),
    priceListId: coerceInt(row.priceListId ?? row.PriceListID),
    priceListItemId: coerceInt(row.priceListItemId ?? row.PriceListItemID),
    requestedItemNo: coerceString(row.requestedItemNo ?? row.RequestedItemNo),
    requestedBrand: coerceString(row.requestedBrand ?? row.RequestedBrand),
    requestedPartNo: coerceString(row.requestedPartNo ?? row.RequestedPartNo),
    requestedModelNo: coerceString(row.requestedModelNo ?? row.RequestedModelNo),
    requestedWebLink: coerceString(row.requestedWebLink ?? row.RequestedWebLink),
    requestedDescription: coerceString(row.requestedDescription ?? row.RequestedDescription),
    requestedDescription2: coerceString(row.requestedDescription2 ?? row.RequestedDescription2),
    requestedDescription3: coerceString(row.requestedDescription3 ?? row.RequestedDescription3),
    requestedQuantity: coerceNumber(row.requestedQuantity ?? row.RequestedQuantity),
    path,
  };
};

const normalizeClipboardRows = (raw: unknown): PreparedRow[] => {
  if (!Array.isArray(raw)) return [];
  const deduped = new Map<string, PreparedRow>();
  for (const item of raw) {
    const row = toPreparedRow(item);
    if (!row) continue;
    if (!deduped.has(row.treeOrdering)) deduped.set(row.treeOrdering, row);
  }
  return Array.from(deduped.values()).sort((a, b) => comparePaths(a.path, b.path));
};

const computeRoots = (rows: PreparedRow[]): string[][] => {
  const selected = new Set(rows.map((row) => row.treeOrdering));
  const roots: string[][] = [];
  for (const row of rows) {
    const parent = row.path.slice(0, -1);
    const parentKey = parent.length ? formatTreeOrderingPath(parent) : '';
    if (!parentKey || !selected.has(parentKey)) roots.push(row.path);
  }
  return roots.sort(comparePaths);
};

const buildRemap = (rows: PreparedRow[], roots: string[][], targetParent: string[], insertSibling: number): Map<string, string> => {
  const remap = new Map<string, string>();
  for (const row of rows) {
    let rootIndex = -1;
    let root: string[] | null = null;
    for (let i = 0; i < roots.length; i += 1) {
      if (startsWithPath(row.path, roots[i])) {
        root = roots[i];
        rootIndex = i;
        break;
      }
    }
    if (!root || rootIndex < 0) continue;
    const suffix = row.path.slice(root.length);
    remap.set(row.treeOrdering, formatTreeOrderingPath([...targetParent, String(insertSibling + rootIndex), ...suffix]));
  }
  return remap;
};
const buildShiftUpdates = (existingRows: ExistingRow[], parentPath: string[], insertSibling: number, rootCount: number): TreeUpdate[] => {
  const depth = parentPath.length;
  const updates: TreeUpdate[] = [];
  for (const row of existingRows) {
    const tree = normalizeTreeOrderingValue(row.TreeOrdering);
    if (!tree) continue;
    const path = parseTreeOrderingPath(tree);
    if (path.length <= depth) continue;
    if (!startsWithPath(path, parentPath)) continue;
    if (Number(path[depth]) < insertSibling) continue;
    const shifted = [...path];
    shifted[depth] = String(Number(shifted[depth]) + rootCount);
    updates.push({ offerDetailId: row.OfferDetailID, newTreeOrdering: formatTreeOrderingPath(shifted) });
  }
  return updates;
};

const applyTreeUpdates = async (transaction: Transaction, offerId: number, updates: TreeUpdate[]) => {
  if (!updates.length) return;
  const BATCH_SIZE = 200;
  for (let start = 0; start < updates.length; start += BATCH_SIZE) {
    const batch = updates.slice(start, start + BATCH_SIZE);
    const request = transaction.request();
    request.input('__offerId', sql.Int, offerId);
    const values: string[] = [];
    batch.forEach((update, idx) => {
      request.input(`id_${idx}`, sql.Int, update.offerDetailId);
      request.input(`tree_${idx}`, sql.NVarChar(255), update.newTreeOrdering);
      values.push(`(@id_${idx}, @tree_${idx})`);
    });
    await request.query(`
      DECLARE @u TABLE (OfferDetailID INT NOT NULL, TreeOrdering NVARCHAR(255) NOT NULL);
      INSERT INTO @u (OfferDetailID, TreeOrdering) VALUES ${values.join(', ')};
      UPDATE od
      SET od.TreeOrdering = u.TreeOrdering
      FROM dbo.OfferDetails od
      INNER JOIN @u u ON u.OfferDetailID = od.ID
      WHERE od.OfferID = @__offerId;
    `);
  }
};

const prepareInsertRows = (rows: PreparedRow[], remap: Map<string, string>, baseOrdering: number): InsertRow[] => {
  const ordered = rows
    .map((row) => {
      const next = remap.get(row.treeOrdering);
      if (!next) return null;
      return { row, next, path: parseTreeOrderingPath(next) };
    })
    .filter((entry): entry is { row: PreparedRow; next: string; path: string[] } => entry != null)
    .sort((a, b) => comparePaths(a.path, b.path));

  return ordered.map((entry, idx) => ({
    ...entry.row,
    seq: idx + 1,
    ordering: baseOrdering + idx,
    newTreeOrdering: entry.next,
  }));
};

const resolveCreatedBy = (value: string | number | null): number => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
};

const insertNonProductRows = async (transaction: Transaction, offerId: number, rows: InsertRow[], createdBy: number): Promise<number[]> => {
  if (!rows.length) return [];
  const inserted: number[] = [];
  const BATCH_SIZE = 50;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const request = transaction.request();
    request.input('__offerId', sql.Int, offerId);
    request.input('__createdBy', sql.Int, createdBy);
    request.input('__modifiedBy', sql.Int, createdBy);
    const values: string[] = [];
    batch.forEach((row, idx) => {
      const p = `r${idx}`;
      request.input(`${p}_seq`, sql.Int, row.seq);
      request.input(`${p}_tree`, sql.NVarChar(255), row.newTreeOrdering);
      request.input(`${p}_ordering`, sql.Int, row.ordering);
      request.input(`${p}_isPrintable`, sql.Bit, row.isPrintable == null ? null : (row.isPrintable ? 1 : 0));
      request.input(`${p}_isComment`, sql.Bit, row.isComment ? 1 : 0);
      request.input(`${p}_isCategory`, sql.Bit, row.isCategory ? 1 : 0);
      request.input(`${p}_productDescription`, sql.NVarChar(sql.MAX), row.productDescription ?? row.description);
      request.input(`${p}_comment`, sql.NVarChar(sql.MAX), row.comment);
      request.input(`${p}_delivery`, sql.NVarChar(255), row.delivery);
      request.input(`${p}_requestedItemNo`, sql.NVarChar(255), row.requestedItemNo);
      request.input(`${p}_requestedBrand`, sql.NVarChar(255), row.requestedBrand);
      request.input(`${p}_requestedPartNo`, sql.NVarChar(255), row.requestedPartNo);
      request.input(`${p}_requestedModelNo`, sql.NVarChar(255), row.requestedModelNo);
      request.input(`${p}_requestedWebLink`, sql.NVarChar(sql.MAX), row.requestedWebLink);
      request.input(`${p}_requestedDescription`, sql.NVarChar(sql.MAX), row.requestedDescription);
      request.input(`${p}_requestedDescription2`, sql.NVarChar(sql.MAX), row.requestedDescription2);
      request.input(`${p}_requestedDescription3`, sql.NVarChar(sql.MAX), row.requestedDescription3);
      request.input(`${p}_requestedQuantity`, sql.Decimal(18, 4), row.requestedQuantity);
      request.input(`${p}_quantity`, sql.Decimal(18, 4), row.quantity ?? 0);
      values.push(`(@${p}_seq,@${p}_tree,@${p}_ordering,@${p}_isPrintable,@${p}_isComment,@${p}_isCategory,@${p}_productDescription,@${p}_comment,@${p}_delivery,@${p}_requestedItemNo,@${p}_requestedBrand,@${p}_requestedPartNo,@${p}_requestedModelNo,@${p}_requestedWebLink,@${p}_requestedDescription,@${p}_requestedDescription2,@${p}_requestedDescription3,@${p}_requestedQuantity,@${p}_quantity)`);
    });
    const result = await request.query<{ OfferDetailID: number }>(`
      DECLARE @r TABLE (Seq INT, TreeOrdering NVARCHAR(255), Ordering INT, IsPrintable BIT NULL, IsComment BIT, IsCategory BIT, ProductDescription NVARCHAR(MAX) NULL, Comment NVARCHAR(MAX) NULL, Delivery NVARCHAR(255) NULL, RequestedItemNo NVARCHAR(255) NULL, RequestedBrand NVARCHAR(255) NULL, RequestedPartNo NVARCHAR(255) NULL, RequestedModelNo NVARCHAR(255) NULL, RequestedWebLink NVARCHAR(MAX) NULL, RequestedDescription NVARCHAR(MAX) NULL, RequestedDescription2 NVARCHAR(MAX) NULL, RequestedDescription3 NVARCHAR(MAX) NULL, RequestedQuantity DECIMAL(18,4) NULL, Quantity DECIMAL(18,4) NOT NULL);
      INSERT INTO @r VALUES ${values.join(', ')};
      DECLARE @i TABLE (OfferDetailID INT, TreeOrdering NVARCHAR(255));
      INSERT INTO dbo.OfferDetails (OfferID, ParentOfferDetailID, TreeOrdering, Ordering, IsPrintable, IsComment, IsCategory, ProductDescription, Quantity, Comment, Delivery, RequestedItemNo, RequestedBrand, RequestedPartNo, RequestedModelNo, RequestedWebLink, RequestedDescription, RequestedDescription2, RequestedDescription3, RequestedQuantity, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
      OUTPUT INSERTED.ID, INSERTED.TreeOrdering INTO @i (OfferDetailID, TreeOrdering)
      SELECT @__offerId, NULL, src.TreeOrdering, src.Ordering, src.IsPrintable, src.IsComment, src.IsCategory, src.ProductDescription, src.Quantity, src.Comment, src.Delivery, src.RequestedItemNo, src.RequestedBrand, src.RequestedPartNo, src.RequestedModelNo, src.RequestedWebLink, src.RequestedDescription, src.RequestedDescription2, src.RequestedDescription3, src.RequestedQuantity, SYSUTCDATETIME(), @__createdBy, SYSUTCDATETIME(), @__modifiedBy
      FROM @r src
      ORDER BY src.Seq;
      UPDATE child
      SET child.ParentOfferDetailID = parent.ID
      FROM dbo.OfferDetails child
      INNER JOIN @i ins ON ins.OfferDetailID = child.ID
      OUTER APPLY (SELECT CASE WHEN CHARINDEX('.', ins.TreeOrdering) = 0 THEN NULL ELSE LEFT(ins.TreeOrdering, LEN(ins.TreeOrdering) - CHARINDEX('.', REVERSE(ins.TreeOrdering))) END AS ParentTree) p
      LEFT JOIN dbo.OfferDetails parent ON parent.OfferID = @__offerId AND NULLIF(LTRIM(RTRIM(parent.TreeOrdering)), '') = p.ParentTree
      WHERE child.OfferID = @__offerId;
      SELECT OfferDetailID FROM @i;
    `);
    (result.recordset ?? []).forEach((row) => { if (typeof row.OfferDetailID === 'number') inserted.push(row.OfferDetailID); });
  }
  return inserted;
};
const insertProductRowsKeepPricing = async (transaction: Transaction, offerId: number, rows: InsertRow[], createdBy: number): Promise<number[]> => {
  if (!rows.length) return [];
  const inserted: number[] = [];
  const BATCH_SIZE = 50;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const request = transaction.request();
    request.input('__offerId', sql.Int, offerId);
    request.input('__createdBy', sql.Int, createdBy);
    request.input('__modifiedBy', sql.Int, createdBy);
    const values: string[] = [];
    batch.forEach((row, idx) => {
      const p = `r${idx}`;
      request.input(`${p}_seq`, sql.Int, row.seq);
      request.input(`${p}_tree`, sql.NVarChar(255), row.newTreeOrdering);
      request.input(`${p}_ordering`, sql.Int, row.ordering);
      request.input(`${p}_isPrintable`, sql.Bit, row.isPrintable == null ? null : (row.isPrintable ? 1 : 0));
      request.input(`${p}_productId`, sql.Int, coerceInt(row.productId));
      request.input(`${p}_partNo`, sql.NVarChar(255), row.partNumber);
      request.input(`${p}_modelNo`, sql.NVarChar(255), row.modelNumber);
      request.input(`${p}_description`, sql.NVarChar(sql.MAX), row.productDescription ?? row.description);
      request.input(`${p}_quantity`, sql.Decimal(18, 4), row.quantity ?? 1);
      request.input(`${p}_listPrice`, sql.Decimal(18, 4), row.listPrice);
      request.input(`${p}_netUnitPrice`, sql.Decimal(18, 4), row.netUnitPrice);
      request.input(`${p}_telmacoDiscount`, sql.Decimal(18, 4), row.telmacoDiscount);
      request.input(`${p}_customerDiscount`, sql.Decimal(18, 4), row.customerDiscount);
      request.input(`${p}_netCostOtherCurrency`, sql.Decimal(18, 4), row.netCostOtherCurrency);
      request.input(`${p}_otherCurrencyId`, sql.Int, row.otherCurrencyId);
      request.input(`${p}_currencyCostModifier`, sql.Decimal(18, 8), row.currencyCostModifier);
      request.input(`${p}_netCost`, sql.Decimal(18, 4), row.netCost);
      request.input(`${p}_margin`, sql.Decimal(18, 4), row.margin);
      request.input(`${p}_grossProfit`, sql.Decimal(18, 4), row.grossProfit);
      request.input(`${p}_warranty`, sql.Int, row.warranty);
      request.input(`${p}_telmacoWarranty`, sql.Int, row.telmacoWarranty);
      request.input(`${p}_priceListId`, sql.Int, row.priceListId);
      request.input(`${p}_priceListItemId`, sql.Int, row.priceListItemId);
      request.input(`${p}_requestedItemNo`, sql.NVarChar(255), row.requestedItemNo);
      request.input(`${p}_requestedBrand`, sql.NVarChar(255), row.requestedBrand);
      request.input(`${p}_requestedPartNo`, sql.NVarChar(255), row.requestedPartNo);
      request.input(`${p}_requestedModelNo`, sql.NVarChar(255), row.requestedModelNo);
      request.input(`${p}_requestedWebLink`, sql.NVarChar(sql.MAX), row.requestedWebLink);
      request.input(`${p}_requestedDescription`, sql.NVarChar(sql.MAX), row.requestedDescription);
      request.input(`${p}_requestedDescription2`, sql.NVarChar(sql.MAX), row.requestedDescription2);
      request.input(`${p}_requestedDescription3`, sql.NVarChar(sql.MAX), row.requestedDescription3);
      request.input(`${p}_requestedQuantity`, sql.Decimal(18, 4), row.requestedQuantity);
      values.push(`(@${p}_seq,@${p}_tree,@${p}_ordering,@${p}_isPrintable,@${p}_productId,@${p}_partNo,@${p}_modelNo,@${p}_description,@${p}_quantity,@${p}_listPrice,@${p}_netUnitPrice,@${p}_telmacoDiscount,@${p}_customerDiscount,@${p}_netCostOtherCurrency,@${p}_otherCurrencyId,@${p}_currencyCostModifier,@${p}_netCost,@${p}_margin,@${p}_grossProfit,@${p}_warranty,@${p}_telmacoWarranty,@${p}_priceListId,@${p}_priceListItemId,@${p}_requestedItemNo,@${p}_requestedBrand,@${p}_requestedPartNo,@${p}_requestedModelNo,@${p}_requestedWebLink,@${p}_requestedDescription,@${p}_requestedDescription2,@${p}_requestedDescription3,@${p}_requestedQuantity)`);
    });
    const result = await request.query<{ OfferDetailID: number }>(`
      DECLARE @r TABLE (Seq INT, TreeOrdering NVARCHAR(255), Ordering INT, IsPrintable BIT NULL, ProductID INT NULL, PartNumber NVARCHAR(255) NULL, ModelNumber NVARCHAR(255) NULL, ProductDescription NVARCHAR(MAX) NULL, Quantity DECIMAL(18,4) NULL, ListPrice DECIMAL(18,4) NULL, NetUnitPrice DECIMAL(18,4) NULL, TelmacoDiscount DECIMAL(18,4) NULL, CustomerDiscount DECIMAL(18,4) NULL, NetCostOtherCurrency DECIMAL(18,4) NULL, OtherCurrencyID INT NULL, CurrencyCostModifier DECIMAL(18,8) NULL, NetCost DECIMAL(18,4) NULL, Margin DECIMAL(18,4) NULL, GrossProfit DECIMAL(18,4) NULL, Warranty INT NULL, TelmacoWarranty INT NULL, PriceListID INT NULL, PriceListItemID INT NULL, RequestedItemNo NVARCHAR(255) NULL, RequestedBrand NVARCHAR(255) NULL, RequestedPartNo NVARCHAR(255) NULL, RequestedModelNo NVARCHAR(255) NULL, RequestedWebLink NVARCHAR(MAX) NULL, RequestedDescription NVARCHAR(MAX) NULL, RequestedDescription2 NVARCHAR(MAX) NULL, RequestedDescription3 NVARCHAR(MAX) NULL, RequestedQuantity DECIMAL(18,4) NULL);
      INSERT INTO @r VALUES ${values.join(', ')};
      DECLARE @i TABLE (OfferDetailID INT, TreeOrdering NVARCHAR(255));
      INSERT INTO dbo.OfferDetails (OfferID, ParentOfferDetailID, TreeOrdering, Ordering, IsPrintable, IsComment, IsCategory, ProductID, PartNumber, ModelNumber, ProductDescription, Quantity, ListPrice, NetUnitPrice, TotalPrice, TotalNet, TelmacoDiscount, CustomerDiscount, NetCostOtherCurrency, OtherCurrencyID, CurrencyCostModifier, NetCost, Margin, GrossProfit, TotalCost, Warranty, TelmacoWarranty, PriceListID, PriceListItemID, RequestedItemNo, RequestedBrand, RequestedPartNo, RequestedModelNo, RequestedWebLink, RequestedDescription, RequestedDescription2, RequestedDescription3, RequestedQuantity, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
      OUTPUT INSERTED.ID, INSERTED.TreeOrdering INTO @i (OfferDetailID, TreeOrdering)
      SELECT @__offerId, NULL, src.TreeOrdering, src.Ordering, src.IsPrintable, 0, 0, src.ProductID, src.PartNumber, src.ModelNumber, src.ProductDescription, src.Quantity, src.ListPrice, src.NetUnitPrice, CASE WHEN src.ListPrice IS NULL OR src.Quantity IS NULL THEN NULL ELSE src.ListPrice * src.Quantity END, CASE WHEN src.NetUnitPrice IS NULL OR src.Quantity IS NULL THEN NULL ELSE src.NetUnitPrice * src.Quantity END, src.TelmacoDiscount, src.CustomerDiscount, src.NetCostOtherCurrency, src.OtherCurrencyID, src.CurrencyCostModifier, src.NetCost, src.Margin, src.GrossProfit, CASE WHEN src.NetCost IS NULL OR src.Quantity IS NULL THEN NULL ELSE src.NetCost * src.Quantity END, src.Warranty, src.TelmacoWarranty, src.PriceListID, src.PriceListItemID, src.RequestedItemNo, src.RequestedBrand, src.RequestedPartNo, src.RequestedModelNo, src.RequestedWebLink, src.RequestedDescription, src.RequestedDescription2, src.RequestedDescription3, src.RequestedQuantity, SYSUTCDATETIME(), @__createdBy, SYSUTCDATETIME(), @__modifiedBy FROM @r src ORDER BY src.Seq;
      UPDATE child
      SET child.ParentOfferDetailID = parent.ID
      FROM dbo.OfferDetails child
      INNER JOIN @i ins ON ins.OfferDetailID = child.ID
      OUTER APPLY (SELECT CASE WHEN CHARINDEX('.', ins.TreeOrdering) = 0 THEN NULL ELSE LEFT(ins.TreeOrdering, LEN(ins.TreeOrdering) - CHARINDEX('.', REVERSE(ins.TreeOrdering))) END AS ParentTree) p
      LEFT JOIN dbo.OfferDetails parent ON parent.OfferID = @__offerId AND NULLIF(LTRIM(RTRIM(parent.TreeOrdering)), '') = p.ParentTree
      WHERE child.OfferID = @__offerId;
      SELECT OfferDetailID FROM @i;
    `);
    (result.recordset ?? []).forEach((row) => { if (typeof row.OfferDetailID === 'number') inserted.push(row.OfferDetailID); });
  }
  return inserted;
};

const insertProductRowsFreshPricing = async (transaction: Transaction, offerId: number, rows: InsertRow[], createdBy: number): Promise<number[]> => {
  if (!rows.length) return [];
  const inserted: number[] = [];
  const BATCH_SIZE = 50;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const request = transaction.request();
    request.input('__offerId', sql.Int, offerId);
    request.input('__createdBy', sql.Int, createdBy);
    request.input('__modifiedBy', sql.Int, createdBy);
    const values: string[] = [];
    batch.forEach((row, idx) => {
      const p = `r${idx}`;
      request.input(`${p}_seq`, sql.Int, row.seq);
      request.input(`${p}_tree`, sql.NVarChar(255), row.newTreeOrdering);
      request.input(`${p}_ordering`, sql.Int, row.ordering);
      request.input(`${p}_isPrintable`, sql.Bit, row.isPrintable == null ? null : (row.isPrintable ? 1 : 0));
      request.input(`${p}_productId`, sql.Int, coerceInt(row.productId));
      request.input(`${p}_requestedItemNo`, sql.NVarChar(255), row.requestedItemNo);
      request.input(`${p}_requestedBrand`, sql.NVarChar(255), row.requestedBrand);
      request.input(`${p}_requestedPartNo`, sql.NVarChar(255), row.requestedPartNo);
      request.input(`${p}_requestedModelNo`, sql.NVarChar(255), row.requestedModelNo);
      request.input(`${p}_requestedWebLink`, sql.NVarChar(sql.MAX), row.requestedWebLink);
      request.input(`${p}_requestedDescription`, sql.NVarChar(sql.MAX), row.requestedDescription);
      request.input(`${p}_requestedDescription2`, sql.NVarChar(sql.MAX), row.requestedDescription2);
      request.input(`${p}_requestedDescription3`, sql.NVarChar(sql.MAX), row.requestedDescription3);
      request.input(`${p}_requestedQuantity`, sql.Decimal(18, 4), row.requestedQuantity);
      values.push(`(@${p}_seq,@${p}_tree,@${p}_ordering,@${p}_isPrintable,@${p}_productId,@${p}_requestedItemNo,@${p}_requestedBrand,@${p}_requestedPartNo,@${p}_requestedModelNo,@${p}_requestedWebLink,@${p}_requestedDescription,@${p}_requestedDescription2,@${p}_requestedDescription3,@${p}_requestedQuantity)`);
    });
    const result = await request.query<{ OfferDetailID: number }>(`
      DECLARE @pricingPolicyId INT;
      SELECT @pricingPolicyId = o.PricingPolicyID
      FROM dbo.Offer o
      WHERE o.ID = @__offerId;

      DECLARE @r TABLE (
        Seq INT,
        TreeOrdering NVARCHAR(255),
        Ordering INT,
        IsPrintable BIT NULL,
        ProductID INT,
        RequestedItemNo NVARCHAR(255) NULL,
        RequestedBrand NVARCHAR(255) NULL,
        RequestedPartNo NVARCHAR(255) NULL,
        RequestedModelNo NVARCHAR(255) NULL,
        RequestedWebLink NVARCHAR(MAX) NULL,
        RequestedDescription NVARCHAR(MAX) NULL,
        RequestedDescription2 NVARCHAR(MAX) NULL,
        RequestedDescription3 NVARCHAR(MAX) NULL,
        RequestedQuantity DECIMAL(18, 4) NULL
      );
      INSERT INTO @r VALUES ${values.join(', ')};

      -- Resolve legacy products: if product has no enabled pricelist items
      -- but another product's legacy part number matches, use that product instead
      UPDATE r_upd
      SET r_upd.ProductID = resolved.NewProductID
      FROM @r r_upd
      CROSS APPLY (
        SELECT TOP (1) p_new.ID AS NewProductID
        FROM dbo.Products pr
        INNER JOIN dbo.Products p_new
          ON p_new.LegacyPartNoCleaned = pr.PartNumberCleared
          AND p_new.LegacyPartNoCleaned IS NOT NULL
          AND p_new.LegacyPartNoCleaned <> ''
          AND p_new.ID <> pr.ID
        WHERE pr.ID = r_upd.ProductID
          AND NOT EXISTS (
            SELECT 1 FROM dbo.PriceListItems pli_chk
            INNER JOIN dbo.PriceLists pl_chk ON pli_chk.PriceListID = pl_chk.ID AND pl_chk.Enabled = 1
            WHERE pli_chk.ProductID = pr.ID
          )
          AND EXISTS (
            SELECT 1 FROM dbo.PriceListItems pli_chk2
            INNER JOIN dbo.PriceLists pl_chk2 ON pli_chk2.PriceListID = pl_chk2.ID AND pl_chk2.Enabled = 1
            WHERE pli_chk2.ProductID = p_new.ID
          )
        ORDER BY p_new.ID DESC
      ) resolved;

      DECLARE @d TABLE (
        Seq INT,
        TreeOrdering NVARCHAR(255),
        Ordering INT,
        IsPrintable BIT NULL,
        ProductID INT,
        BrandID INT NULL,
        PartNumber NVARCHAR(255) NULL,
        ModelNumber NVARCHAR(255) NULL,
        ProductDescription NVARCHAR(MAX) NULL,
        PriceListID INT NULL,
        PriceListItemID INT NULL,
        ListPrice DECIMAL(18, 4) NULL,
        CostPrice DECIMAL(18, 4) NULL,
        OtherCurrencyID INT NULL,
        CurrencyCostModifier DECIMAL(18, 8) NULL,
        RequestedItemNo NVARCHAR(255) NULL,
        RequestedBrand NVARCHAR(255) NULL,
        RequestedPartNo NVARCHAR(255) NULL,
        RequestedModelNo NVARCHAR(255) NULL,
        RequestedWebLink NVARCHAR(MAX) NULL,
        RequestedDescription NVARCHAR(MAX) NULL,
        RequestedDescription2 NVARCHAR(MAX) NULL,
        RequestedDescription3 NVARCHAR(MAX) NULL,
        RequestedQuantity DECIMAL(18, 4) NULL
      );

      INSERT INTO @d
      SELECT
        src.Seq,
        src.TreeOrdering,
        src.Ordering,
        src.IsPrintable,
        src.ProductID,
        pr.BrandID,
        pr.PartNumber,
        pr.ModelNumber,
        pr.Description,
        price.PriceListID,
        price.PriceListItemID,
        price.ListPrice,
        price.CostPrice,
        price.OtherCurrencyID,
        price.CurrencyCostModifier,
        src.RequestedItemNo,
        src.RequestedBrand,
        src.RequestedPartNo,
        src.RequestedModelNo,
        src.RequestedWebLink,
        src.RequestedDescription,
        src.RequestedDescription2,
        src.RequestedDescription3,
        src.RequestedQuantity
      FROM @r src
      INNER JOIN dbo.Products pr ON pr.ID = src.ProductID
      OUTER APPLY (
        SELECT TOP (1)
          pli.ID AS PriceListItemID,
          pli.PriceListID,
          pli.ListPrice,
          pli.CostPrice,
          COALESCE(pl.CostCurrencyID, pl.CurrencyId) AS OtherCurrencyID,
          COALESCE(pl.CurrencyCostModifier, 1) AS CurrencyCostModifier
        FROM dbo.PriceListItems pli
        INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        WHERE pli.ProductID = src.ProductID
          AND pl.Enabled = 1
        ORDER BY
          CASE WHEN pli.CostPrice IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
          pl.ValidToDate,
          pl.ValidFromDate DESC,
          pli.ID DESC
      ) price;

      DECLARE @i TABLE (OfferDetailID INT, TreeOrdering NVARCHAR(255));
      INSERT INTO dbo.OfferDetails (
        OfferID, ParentOfferDetailID, TreeOrdering, Ordering,
        IsPrintable, IsComment, IsCategory,
        ProductID, BrandID, PartNumber, ModelNumber, ProductDescription,
        TelmacoWarranty, Warranty, Quantity,
        ListPrice, NetUnitPrice, TotalPrice, TotalNet,
        TelmacoDiscount, CustomerDiscount,
        NetCostOtherCurrency, OtherCurrencyID, CurrencyCostModifier,
        NetCost, Margin, GrossProfit, TotalCost,
        PriceListID, PriceListItemID,
        RequestedItemNo, RequestedBrand, RequestedPartNo, RequestedModelNo,
        RequestedWebLink, RequestedDescription, RequestedDescription2, RequestedDescription3, RequestedQuantity,
        CreatedOn, CreatedBy, ModifiedOn, ModifiedBy
      )
      OUTPUT INSERTED.ID, INSERTED.TreeOrdering INTO @i (OfferDetailID, TreeOrdering)
      SELECT
        @__offerId, NULL, p.TreeOrdering, p.Ordering,
        p.IsPrintable, 0, 0,
        p.ProductID, p.BrandID, p.PartNumber, p.ModelNumber, p.ProductDescription,
        0, 0, 1,
        p.ListPrice,
        computed.ComputedNetUnitPrice,
        p.ListPrice,
        computed.ComputedNetUnitPrice,
        CASE
          WHEN p.CostPrice IS NOT NULL AND p.ListPrice IS NOT NULL AND p.ListPrice <> 0
            THEN ROUND(
              (CAST(1 AS DECIMAL(18, 8))
                - (CAST(p.CostPrice * p.CurrencyCostModifier AS DECIMAL(18, 8)) / CAST(p.ListPrice AS DECIMAL(18, 8)))
              ) * 100,
              4
            )
          ELSE COALESCE(discounts.TelmacoDiscountPercentage, 0)
        END,
        COALESCE(discounts.CustomerDiscountPercentage, 0),
        p.CostPrice,
        p.OtherCurrencyID,
        p.CurrencyCostModifier,
        COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
        CASE
          WHEN computed.ComputedNetUnitPrice IS NULL
            OR computed.ComputedNetUnitPrice = 0
            OR COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
            THEN NULL
          ELSE ROUND(
            (CAST(1 AS DECIMAL(18, 8))
              - (CAST(COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) AS DECIMAL(18, 8))
                / CAST(computed.ComputedNetUnitPrice AS DECIMAL(18, 8))
              )
            ) * 100,
            4
          )
        END,
        CASE
          WHEN computed.ComputedNetUnitPrice IS NULL
            OR COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
            THEN NULL
          ELSE ROUND(
            computed.ComputedNetUnitPrice - COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
            4
          )
        END,
        COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
        p.PriceListID, p.PriceListItemID,
        p.RequestedItemNo, p.RequestedBrand, p.RequestedPartNo, p.RequestedModelNo,
        p.RequestedWebLink, p.RequestedDescription, p.RequestedDescription2, p.RequestedDescription3, p.RequestedQuantity,
        SYSUTCDATETIME(), @__createdBy, SYSUTCDATETIME(), @__modifiedBy
      FROM @d p
      OUTER APPLY (
        SELECT TOP (1) ppr.TelmacoDiscountPercentage, ppr.CustomerDiscountPercentage
        FROM (
          SELECT TOP (1) ppr.TelmacoDiscountPercentage, ppr.CustomerDiscountPercentage, 1 AS Priority
          FROM dbo.PriceListPricingPolicy plpp
          INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
          WHERE plpp.PriceListID = p.PriceListID
            AND plpp.PricingPolicyID = @pricingPolicyId
            AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
          ORDER BY CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END, ppr.ID DESC
          UNION ALL
          SELECT TOP (1) ppr.TelmacoDiscountPercentage, ppr.CustomerDiscountPercentage, 2 AS Priority
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.PricingPolicyID = @pricingPolicyId
            AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
          ORDER BY CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END, ppr.ID DESC
        ) ppr
        ORDER BY ppr.Priority
      ) discounts
      OUTER APPLY (
        SELECT
          CASE
            WHEN p.ListPrice IS NULL THEN NULL
            ELSE ROUND(
              p.ListPrice * (
                CAST(1 AS DECIMAL(18, 8))
                - (CAST(COALESCE(discounts.CustomerDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
              ),
              4
            )
          END AS ComputedNetUnitPrice,
          CASE
            WHEN p.CostPrice IS NOT NULL THEN p.CostPrice * p.CurrencyCostModifier
            WHEN p.ListPrice IS NULL THEN NULL
            ELSE ROUND(
              p.ListPrice * (
                CAST(1 AS DECIMAL(18, 8))
                - (CAST(COALESCE(discounts.TelmacoDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
              ),
              4
            )
          END AS ComputedNetCost
      ) computed
      ORDER BY p.Seq;

      UPDATE child
      SET child.ParentOfferDetailID = parent.ID
      FROM dbo.OfferDetails child
      INNER JOIN @i ins ON ins.OfferDetailID = child.ID
      OUTER APPLY (SELECT CASE WHEN CHARINDEX('.', ins.TreeOrdering) = 0 THEN NULL ELSE LEFT(ins.TreeOrdering, LEN(ins.TreeOrdering) - CHARINDEX('.', REVERSE(ins.TreeOrdering))) END AS ParentTree) p
      LEFT JOIN dbo.OfferDetails parent ON parent.OfferID = @__offerId AND NULLIF(LTRIM(RTRIM(parent.TreeOrdering)), '') = p.ParentTree
      WHERE child.OfferID = @__offerId;

      SELECT OfferDetailID FROM @i;
    `);
    (result.recordset ?? []).forEach((row) => { if (typeof row.OfferDetailID === 'number') inserted.push(row.OfferDetailID); });
  }
  return inserted;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/paste');
  let transaction: Transaction | null = null;
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId: offerIdParam } = await params;
    const offerId = normalizeOfferId(decodeURIComponent(String(offerIdParam ?? '')));
    if (offerId == null) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id' }, { status: 400 });
    }

    let body: PasteBody;
    try {
      body = (await req.json()) as PasteBody;
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
    }

    const anchorOfferDetailId = normalizeOfferDetailId(body.anchorOfferDetailId ?? null);

    const clipboardRows = normalizeClipboardRows(body.rows ?? []);
    if (clipboardRows.length === 0) {
      return NextResponse.json({ ok: false, error: 'No rows to paste' }, { status: 400 });
    }

    const keepPricing = coerceBool(body.keepPricing);
    const pool: ConnectionPool = await getPool();

    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const existingReq = transaction.request();
    existingReq.input('__offerId', sql.Int, offerId);
    const existingResult = await existingReq.query<ExistingRow>(`
      SELECT
        od.ID AS OfferDetailID,
        NULLIF(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), '') AS TreeOrdering,
        ISNULL(od.Ordering, 0) AS Ordering
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId;
    `);
    const existingRows = existingResult.recordset ?? [];

    let parentPath: string[] = [];
    let insertSibling = 1;
    if (anchorOfferDetailId != null) {
      const anchor = existingRows.find((row) => row.OfferDetailID === anchorOfferDetailId) ?? null;
      if (!anchor) {
        await transaction.rollback();
        transaction = null;
        return NextResponse.json({ ok: false, error: 'Anchor row is not part of the target offer' }, { status: 400 });
      }

      const anchorTree = normalizeTreeOrderingValue(anchor.TreeOrdering);
      const anchorPath = parseTreeOrderingPath(anchorTree);
      if (anchorPath.length === 0) {
        await transaction.rollback();
        transaction = null;
        return NextResponse.json({ ok: false, error: 'Anchor row has invalid TreeOrdering' }, { status: 400 });
      }

      parentPath = anchorPath.slice(0, -1);
      insertSibling = Number(anchorPath[anchorPath.length - 1]) + 1;
    } else {
      if (existingRows.length > 0) {
        await transaction.rollback();
        transaction = null;
        return NextResponse.json({ ok: false, error: 'Missing anchor row' }, { status: 400 });
      }
      parentPath = [];
      insertSibling = 1;
    }

    const roots = computeRoots(clipboardRows);
    if (roots.length === 0) {
      await transaction.rollback();
      transaction = null;
      return NextResponse.json({ ok: false, error: 'Clipboard rows are invalid' }, { status: 400 });
    }

    const remap = buildRemap(clipboardRows, roots, parentPath, insertSibling);
    if (remap.size !== clipboardRows.length) {
      await transaction.rollback();
      transaction = null;
      return NextResponse.json({ ok: false, error: 'Unable to remap clipboard hierarchy' }, { status: 400 });
    }

    const treeUpdates = buildShiftUpdates(existingRows, parentPath, insertSibling, roots.length);
    await applyTreeUpdates(transaction, offerId, treeUpdates);

    const nextOrdering = existingRows.reduce((max, row) => Math.max(max, row.Ordering ?? 0), 0) + 1;
    const insertRows = prepareInsertRows(clipboardRows, remap, nextOrdering);
    const createdBy = resolveCreatedBy(buildAuditContext(req).userId);

    const nonProductRows = insertRows.filter((row) => row.productId == null || row.isCategory || row.isComment);
    const productRows = insertRows.filter((row) => row.productId != null && !row.isCategory && !row.isComment);

    const insertedOfferDetailIds: number[] = [];
    insertedOfferDetailIds.push(...(await insertNonProductRows(transaction, offerId, nonProductRows, createdBy)));

    if (productRows.length > 0) {
      if (keepPricing) {
        insertedOfferDetailIds.push(...(await insertProductRowsKeepPricing(transaction, offerId, productRows, createdBy)));
      } else {
        insertedOfferDetailIds.push(...(await insertProductRowsFreshPricing(transaction, offerId, productRows, createdBy)));
      }
    }

    await transaction.commit();
    transaction = null;

    return NextResponse.json({ ok: true, inserted: insertedOfferDetailIds.length, insertedOfferDetailIds });
  } catch (err) {
    if (transaction) {
      try {
        await transaction.rollback();
      } catch {
        /* noop */
      }
    }
    console.error('Paste products failed', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
