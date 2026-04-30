import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql, { ConnectionPool } from 'mssql';
import { buildAuditContext, type AuditContext } from '../../../../../lib/auditTrail';
import { getRequestId } from '../../../../../lib/requestId';
import {
  logAddAuditDetails,
  logDeleteAuditDetails,
  logEditAuditDetails,
  type FieldChange,
} from '../../../../../lib/mutationAudit';
import { getPool } from '../../../../../lib/sql';
import {
  buildQuickFilterClause,
  buildTextMatchPredicate,
  isSensitiveColumn,
  mergeWhereClauses,
  QueryParam,
} from '../../../../../lib/gridFilters';
import { clearPartModelNumber, stripXBetweenDigitsSql } from '../../../../../lib/partModelNumber';
import { realtimeEvents } from '../../../../../lib/realtimeEvents';
import { requirePermission } from '../../../../../lib/authz';
import { checkDeletePermission } from '../../../../../lib/deletePermissions';
import { ALL_ROWS_LIMIT } from '../../../../../lib/constants';
import type {
  TextCondition as TextFilterModel,
  CompoundTextFilter as CompoundTextFilterModel,
  NumberCondition as NumberFilterModel,
  CompoundNumberFilter as CompoundNumberFilterModel,
  KnownFilterModel,
} from '../../../../../lib/filterTypes';
import {
  buildTreeFromRows,
  collectResequencedUpdates,
  formatTreeOrderingPath,
  normalizeOfferDetailId,
  normalizeTreeOrderingValue,
  TreeOrderingNode,
  TreeOrderingRow,
  TreeOrderingUpdateInput,
} from './treeOrdering';

const getDecimalType = () => {
  const decimalFactory = (sql as unknown as { Decimal: (precision: number, scale: number) => unknown }).Decimal;
  return decimalFactory(18, 4);
};

type GridRequest = {
  startRow?: number;
  endRow?: number;
  allRows?: boolean;
  view?: 'grid' | 'pivot';
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
};

type GridRequestEnvelope = {
  request?: GridRequest;
  fields?: string[] | null;
};

const TREE_ORDERING_RAW_EXPRESSION = 'NULLIF(LTRIM(RTRIM(od.TreeOrdering)), \'\')';
const TREE_ORDERING_HIERARCHY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    ELSE TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/'))
  END
`;
const TREE_ORDERING_SORT_PRIORITY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN 1
    WHEN TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/')) IS NOT NULL THEN 0
    ELSE 2
  END
`;

const TREE_ORDERING_ROOT_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    WHEN CHARINDEX('.', ${TREE_ORDERING_RAW_EXPRESSION}) > 0 THEN LEFT(${TREE_ORDERING_RAW_EXPRESSION}, CHARINDEX('.', ${TREE_ORDERING_RAW_EXPRESSION}) - 1)
    ELSE ${TREE_ORDERING_RAW_EXPRESSION}
  END
`;
const MAX_CATEGORY_DEPTH = 3;

type ProductRow = {
  ProductID: number | null;
  BrandID: number | null;
  OfferDetailID: number | null;
  ParentOfferDetailID: number | null;
  Ordering: number | null;
  TreeOrdering: string | null;
  IsPrintable: boolean | null;
  IsComment: boolean | null;
  IsCategory: boolean | null;
  IsOption: boolean | null;
  Enabled: boolean | number | null;
  CreatedOn: Date | string | null;
  CreatedBy: string | null;
  ModifiedOn: Date | string | null;
  ModifiedBy: string | null;
  BrandName: string | null;
  AVC4BrandName: string | null;
  PartNumber: string | null;
  ModelNumber: string | null;
  WebLink: string | null;
  Origin: string | null;
  Quantity: number | null;
  Description: string | null;
  Comment: string | null;
  CustomerDiscount: number | null;
  AdditionalCustomerDiscount: number | null;
  NetUnitPrice: number | null;
  TotalPrice: number | null;
  TotalNet: number | null;
  Warranty: number | null;
  TelmacoWarranty: number | null;
  Installation: number | null;
  ElInstalation: number | null;
  Commissioning: number | null;
  Delivery: string | null;
  OfferValidity: string | null;
  ListPrice: number | null;
  TelmacoDiscount: number | null;
  NetCostOtherCurrency: number | null;
  OtherCurrencyID: number | null;
  OtherCurrencyName: string | null;
  CurrencyCostModifier: number | null;
  NetCost: number | null;
  Margin: number | null;
  GrossProfit: number | null;
  TotalCost: number | null;
  PriceListID: number | null;
  PriceListItemID: number | null;
  PriceListValidFromDate: Date | string | null;
  PriceListValidToDate: Date | string | null;
  PriceListEnabled: boolean | number | null;
  RequestedItemNo: string | null;
  RequestedBrand: string | null;
  RequestedModelNo: string | null;
  RequestedPartNo: string | null;
  RequestedWebLink: string | null;
  RequestedDescription: string | null;
  RequestedDescription2: string | null;
  RequestedDescription3: string | null;
  RequestedQuantity: number | null;
  __isRequestedRow?: number | bigint | null;
  __requestedItemOrdinal?: string | null;
};

type RequestedFieldKey =
  | 'RequestedItemNo'
  | 'RequestedBrand'
  | 'RequestedModelNo'
  | 'RequestedPartNo'
  | 'RequestedWebLink'
  | 'RequestedDescription'
  | 'RequestedDescription2'
  | 'RequestedDescription3'
  | 'RequestedQuantity';

type RequestedColumns = Record<RequestedFieldKey, boolean>;

type ProductRowWithCount = ProductRow & {
  __totalCount: number | bigint | null;
  __sumTotalPrice?: number | bigint | string | null;
  __sumTotalNet?: number | bigint | string | null;
  __sumTotalCost?: number | bigint | string | null;
  __sumInstallation?: number | bigint | string | null;
  __sumElInstalation?: number | bigint | string | null;
  __sumCommissioning?: number | bigint | string | null;
  __hasRequestedItemNo?: number | bigint | null;
  __hasRequestedBrand?: number | bigint | null;
  __hasRequestedModelNo?: number | bigint | null;
  __hasRequestedPartNo?: number | bigint | null;
  __hasRequestedWebLink?: number | bigint | null;
  __hasRequestedDescription?: number | bigint | null;
  __hasRequestedDescription2?: number | bigint | null;
  __hasRequestedDescription3?: number | bigint | null;
  __hasRequestedQuantity?: number | bigint | null;
  __isRequestedRow?: number | bigint | null;
  __requestedItemOrdinal?: string | null;
};

type OfferProductTotals = {
  totalListPrice: number;
  totalNetPrice: number;
  totalCost: number;
  totalInstallation: number;
  totalElInstalation: number;
  totalCommissioning: number;
};

type TreeOrderingUpdateRequest = {
  updates?: TreeOrderingUpdateInput[];
};

type DeleteRowRequest = {
  OfferDetailIDs?: Array<number | string | null | undefined>;
};

type DetailUpdateInput = {
  ProductDescription?: string | null;
  Comment?: string | null;
  Delivery?: string | null;
  OfferDetailID?: number | string | null;
  Description?: string | null;
  Quantity?: number | string | null;
  CustomerDiscount?: number | string | null;
  AdditionalCustomerDiscount?: number | string | null;
  TelmacoDiscount?: number | string | null;
  NetUnitPrice?: number | string | null;
  NetCostOtherCurrency?: number | string | null;
  OtherCurrencyID?: number | string | null;
  CurrencyCostModifier?: number | string | null;
  NetCost?: number | string | null;
  Margin?: number | string | null;
  ListPrice?: number | string | null;
  IsCategory?: boolean | null;
  IsPrintable?: boolean | number | string | null;
  IsComment?: boolean | number | string | null;
  IsOption?: boolean | number | string | null;
  RequestedItemNo?: string | null;
  RequestedBrand?: string | null;
  RequestedModelNo?: string | null;
  RequestedPartNo?: string | null;
  RequestedWebLink?: string | null;
  RequestedDescription?: string | null;
  RequestedDescription2?: string | null;
  RequestedDescription3?: string | null;
  RequestedQuantity?: number | string | null;
  PartNumber?: string | null;
  ModelNumber?: string | null;
  Installation?: number | string | null;
  ElInstalation?: number | string | null;
  Commissioning?: number | string | null;
};

type DetailUpdateRequest = {
  updates?: DetailUpdateInput[];
};

type CreateRowType = 'category' | 'printable-comment' | 'non-printable-comment';

type CreateRowRequest = {
  action?: 'create';
  type?: CreateRowType | null;
  description?: string | null;
};

const CREATE_TYPE_LABELS: Record<CreateRowType, string> = {
  category: 'New Category',
  'printable-comment': 'New Printable Comment',
  'non-printable-comment': 'New Non Printable Comment',
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  OfferDetailID: 'od.ID',
  ParentOfferDetailID: 'od.ParentOfferDetailID',
  Ordering: 'od.Ordering',
  TreeOrdering: 'od.TreeOrdering',
  IsPrintable: 'od.IsPrintable',
  IsComment: 'od.IsComment',
  IsCategory: 'od.IsCategory',
  IsOption: 'od.IsOption',
  Enabled: 'od.Enabled',
  CreatedOn: 'od.CreatedOn',
  CreatedBy: 'od.CreatedBy',
  ModifiedOn: 'od.ModifiedOn',
  ModifiedBy: 'od.ModifiedBy',
  BrandID: 'od.BrandID',
  BrandName: 'b.Name',
  AVC4BrandName: 'b.AVC4Name',
  PartNumber: 'od.PartNumber',
  WebLink: 'p.WebLink',
  Origin: 'p.Origin',
  ModelNumber: 'od.ModelNumber',
  Quantity: 'od.Quantity',
  Description: 'od.ProductDescription',
  Comment: 'od.[Comment]',
  CustomerDiscount: 'od.CustomerDiscount',
  AdditionalCustomerDiscount: 'od.AdditionalCustomerDiscount',
  NetUnitPrice: 'od.NetUnitPrice',
  TotalPrice: 'od.TotalPrice',
  TotalNet: 'od.TotalNet',
  Warranty: 'od.Warranty',
  TelmacoWarranty: 'od.TelmacoWarranty',
  Installation: 'od.Installation',
  ElInstalation: 'od.ElInstalation',
  Commissioning: 'od.Commissioning',
  Delivery: 'od.Delivery',
  OfferValidity: 'o.OfferValidity',
  ListPrice: 'od.ListPrice',
  TelmacoDiscount: 'od.TelmacoDiscount',
  NetCostOtherCurrency: 'od.NetCostOtherCurrency',
  OtherCurrencyID: 'od.OtherCurrencyID',
  OtherCurrencyName: 'oc.Name',
  CurrencyCostModifier: 'od.CurrencyCostModifier',
  NetCost: 'od.NetCost',
  Margin: 'od.Margin',
  GrossProfit: 'od.GrossProfit',
  TotalCost: 'od.TotalCost',
  PriceListID: 'od.PriceListID',
  PriceListItemID: 'od.PriceListItemID',
  PriceListValidFromDate: 'pl.ValidFromDate',
  PriceListValidToDate: 'pl.ValidToDate',
  PriceListEnabled: 'pl.Enabled',
  RequestedItemNo: 'od.RequestedItemNo',
  RequestedBrand: 'od.RequestedBrand',
  RequestedModelNo: 'od.RequestedModelNo',
  RequestedPartNo: 'od.RequestedPartNo',
  RequestedWebLink: 'od.RequestedWebLink',
  RequestedDescription: 'od.RequestedDescription',
  RequestedDescription2: 'od.RequestedDescription2',
  RequestedDescription3: 'od.RequestedDescription3',
  RequestedQuantity: 'od.RequestedQuantity',
};
const PRODUCTS_QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));
const SELECT_FIELD_EXPRESSIONS: Record<string, string> = {
  ...COLUMN_EXPRESSIONS,
  ProductID: 'od.ProductID',
  ProductDescription: 'od.ProductDescription',
  CategoryName: `NULLIF(LTRIM(RTRIM(cat.ProductDescription)), '')`,
};

const ORDER_EXPRESSION_OVERRIDES: Record<string, string | string[]> = {
  TreeOrdering: ['TreeOrderingHierarchy', 'od.TreeOrdering'],
};

const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeRequestedTextValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeRequestedItemNoValue = normalizeRequestedTextValue;
const normalizeDeliveryValue = normalizeRequestedTextValue;

const normalizeQuantityValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
};

const normalizePercentValue = (value: unknown, { allowNegative = false }: { allowNegative?: boolean } = {}): number | null => {
  let num: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    num = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    num = Number.isFinite(parsed) ? parsed : null;
  }
  if (num == null) return null;
  if (!allowNegative && num < 0) return null;
  return num;
};

// Discount columns (CustomerDiscount, AdditionalCustomerDiscount, TelmacoDiscount)
// must lie in [-100, 100]. Returns null for non-numeric input. Out-of-range values
// are clamped rather than rejected so that paste/import flows don't drop the row.
const normalizeDiscountValue = (value: unknown): number | null => {
  const num = normalizePercentValue(value, { allowNegative: true });
  if (num == null) return null;
  if (num > 100) return 100;
  if (num < -100) return -100;
  return num;
};

const normalizeIntValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
};

const normalizeMoneyValue = (
  value: unknown,
  { allowNegative = false }: { allowNegative?: boolean } = {},
): number | null => {
  if (value == null) return null;
  const accept = (n: number) => Number.isFinite(n) && (allowNegative || n >= 0);
  if (typeof value === 'number' && accept(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return accept(parsed) ? parsed : null;
  }
  return null;
};

const normalizePositiveMoneyValue = (value: unknown): number | null => {
  const num = normalizeMoneyValue(value);
  if (num == null) return null;
  if (!(num > 0)) return null;
  return num;
};

const normalizeBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') return true;
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return false;
  }
  return null;
};

import {
  roundTo,
  resolvePricing,
  deriveWithoutListPrice,
  deriveListPrice,
  type PricingInput,
  type ResolvedPricing,
} from '../../../../../lib/pricing';

const normalizeCreateRowType = (value: unknown): CreateRowType | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'category') return 'category';
  if (normalized === 'printable-comment') return 'printable-comment';
  if (normalized === 'non-printable-comment') return 'non-printable-comment';
  return null;
};

const normalizeAggregateValue = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const normalizeAggregateFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== BigInt(0);
  if (typeof value === 'string') return value.trim() !== '' && value !== '0';
  return false;
};


const TREE_ORDERING_UPDATE_CHUNK_SIZE = 400;

const persistTreeOrderingUpdates = async (
  pool: ConnectionPool,
  offerId: number,
  audit: AuditContext,
  updates: TreeOrderingUpdateInput[],
): Promise<number> => {
  if (updates.length === 0) return 0;
  let rowsAffected = 0;
  for (let idx = 0; idx < updates.length; idx += TREE_ORDERING_UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(idx, idx + TREE_ORDERING_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const request = pool.request();
    request.input('__offerId', sql.Int, offerId);
    request.input('__modifiedBy', sql.Int, audit.userId);
    const valueClauses: string[] = [];
    chunk.forEach((entry, chunkIdx) => {
      const idParam = `odid_${chunkIdx}`;
      const orderingParam = `ordering_${chunkIdx}`;
      request.input(idParam, sql.Int, entry.OfferDetailID);
      request.input(orderingParam, sql.NVarChar(255), entry.TreeOrdering);
      valueClauses.push(`(@${idParam}, @${orderingParam})`);
    });
    const updateQuery = `
      WITH PendingUpdates (OfferDetailID, TreeOrdering) AS (
        SELECT v.OfferDetailID, v.TreeOrdering
        FROM (VALUES ${valueClauses.join(', ')}) AS v (OfferDetailID, TreeOrdering)
      )
      UPDATE od
      SET od.TreeOrdering = PendingUpdates.TreeOrdering,
          od.ModifiedOn = SYSUTCDATETIME(),
          od.ModifiedBy = @__modifiedBy
      FROM dbo.OfferDetails od
        INNER JOIN PendingUpdates ON od.ID = PendingUpdates.OfferDetailID
      WHERE od.OfferID = @__offerId;
    `;
    const result = await request.query(updateQuery);
    rowsAffected += result.rowsAffected?.[0] ?? 0;
  }
  return rowsAffected;
};

type ReorderRequest = {
  action: 'reorder';
  sourceId?: number | string | null;
  sourceIds?: Array<number | string | null>;
  position?: 'before' | 'after';
  parentPath?: Array<number | string | null>;
  beforeId?: number | string | null;
  afterId?: number | string | null;
};

const normalizeParentPath = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((segment) => {
      if (typeof segment === 'number' && Number.isFinite(segment)) return String(segment);
      if (typeof segment === 'string') {
        const trimmed = segment.trim();
        return trimmed || null;
      }
      return null;
    })
    .filter((segment): segment is string => segment != null);
};

const isDescendantOf = (candidateParent: TreeOrderingNode | null, potentialAncestor: TreeOrderingNode) => {
  let current = candidateParent;
  while (current) {
    if (current === potentialAncestor) return true;
    current = current.parent;
  }
  return false;
};

async function handleReorderRow(
  offerId: number,
  payload: ReorderRequest,
  audit: AuditContext,
  requestId?: string,
): Promise<NextResponse> {
  const rawSourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];
  const normalizedSourceIds: number[] = [];
  const seenSourceIds = new Set<number>();
  for (const rawId of rawSourceIds) {
    const nextId = normalizeOfferDetailId(rawId ?? null);
    if (nextId == null) continue;
    if (seenSourceIds.has(nextId)) continue;
    seenSourceIds.add(nextId);
    normalizedSourceIds.push(nextId);
  }
  if (normalizedSourceIds.length === 0) {
    const singleId = normalizeOfferDetailId(payload.sourceId ?? null);
    if (singleId == null) {
      return NextResponse.json({ ok: false, error: 'Missing source row identifier' }, { status: 400 });
    }
    normalizedSourceIds.push(singleId);
  }

  const position = payload.position === 'before' ? 'before' : 'after';
  const parentPath = normalizeParentPath(payload.parentPath);
  const nextDepth = parentPath.length + 1;
  const beforeId = normalizeOfferDetailId(payload.beforeId ?? null);
  const afterId = normalizeOfferDetailId(payload.afterId ?? null);

  const pool = await getPool();
  if (nextDepth > MAX_CATEGORY_DEPTH) {
    const categoryCheckRequest = pool.request();
    categoryCheckRequest.input('__offerId', sql.Int, offerId);
    const sourceIdParams: string[] = [];
    normalizedSourceIds.forEach((id, idx) => {
      const paramName = `__sourceId_${idx}`;
      categoryCheckRequest.input(paramName, sql.Int, id);
      sourceIdParams.push(`@${paramName}`);
    });
    const categoryCheckResult = await categoryCheckRequest.query<{ OfferDetailID: number }>(`
      SELECT od.ID AS OfferDetailID
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
        AND od.ID IN (${sourceIdParams.join(', ')})
        AND ISNULL(od.IsCategory, 0) = 1;
    `);
    if ((categoryCheckResult.recordset?.length ?? 0) > 0) {
      return NextResponse.json(
        { ok: false, error: 'Categories can only be created up to sub-sub category level' },
        { status: 400 },
      );
    }
  }

  const readRequest = pool.request();
  readRequest.input('__offerId', sql.Int, offerId);
  const readResult = await readRequest.query<TreeOrderingRow>(`
    SELECT od.ID AS OfferDetailID, od.TreeOrdering
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND ${TREE_ORDERING_RAW_EXPRESSION} IS NOT NULL
    ORDER BY ${TREE_ORDERING_SORT_PRIORITY_EXPRESSION}, ${TREE_ORDERING_HIERARCHY_EXPRESSION}, od.TreeOrdering;
  `);
  const rows = readResult.recordset ?? [];
  const roots = buildTreeFromRows(rows);

  const nodesById = new Map<number, TreeOrderingNode>();
  const nodesByPath = new Map<string, TreeOrderingNode>();
  const buildMaps = (node: TreeOrderingNode) => {
    nodesById.set(node.id, node);
    nodesByPath.set(formatTreeOrderingPath(node.path), node);
    node.children.forEach(buildMaps);
  };
  roots.forEach(buildMaps);

  const sourceNodes: TreeOrderingNode[] = normalizedSourceIds
    .map((id) => nodesById.get(id))
    .filter((node): node is TreeOrderingNode => Boolean(node));
  if (sourceNodes.length === 0) {
    return NextResponse.json({ ok: false, error: 'Source row not found' }, { status: 404 });
  }

  const parentKey = parentPath.length > 0 ? formatTreeOrderingPath(parentPath) : '';
  const targetParentNode = parentKey ? nodesByPath.get(parentKey) ?? null : null;
  if (targetParentNode) {
    for (const sourceNode of sourceNodes) {
      if (isDescendantOf(targetParentNode, sourceNode)) {
        return NextResponse.json({ ok: false, error: 'Cannot drop a row into itself or its descendant' }, { status: 400 });
      }
    }
  }

  const detachNode = (node: TreeOrderingNode) => {
    const collection = node.parent ? node.parent.children : roots;
    const idx = collection.indexOf(node);
    if (idx >= 0) {
      collection.splice(idx, 1);
      // Reset path segments of siblings after the removed position so
      // buildSegmentList closes the gap instead of preserving stale numbers
      for (let i = idx; i < collection.length; i++) {
        const sibling = collection[i];
        if (sibling.path.length > 0) {
          sibling.path = [...sibling.path.slice(0, -1), '0'];
        }
      }
    }
    node.parent = null;
  };
  sourceNodes.forEach(detachNode);

  const siblings = targetParentNode ? targetParentNode.children : roots;
  const indexOfSibling = (id: number | null | undefined) => {
    if (id == null) return -1;
    return siblings.findIndex((entry) => entry.id === id);
  };

  let insertIndex = siblings.length;
  if (position === 'before') {
    const afterIdx = indexOfSibling(afterId);
    if (afterIdx >= 0) {
      insertIndex = afterIdx;
    } else {
      const beforeIdx = indexOfSibling(beforeId);
      if (beforeIdx >= 0) insertIndex = beforeIdx + 1;
    }
  } else {
    const beforeIdx = indexOfSibling(beforeId);
    if (beforeIdx >= 0) {
      insertIndex = beforeIdx + 1;
    } else {
      const afterIdx = indexOfSibling(afterId);
      if (afterIdx >= 0) insertIndex = afterIdx;
    }
  }

  const boundedIndex = Math.max(0, Math.min(insertIndex, siblings.length));
  let currentIndex = boundedIndex;
  for (const node of sourceNodes) {
    siblings.splice(currentIndex, 0, node);
    node.parent = targetParentNode;
    // Clear the last path segment so buildSegmentList assigns a fresh number
    // instead of preserving the stale auto-generated one
    if (node.path.length > 0) {
      node.path = [...node.path.slice(0, -1), '0'];
    }
    currentIndex += 1;
  }

  const updates = collectResequencedUpdates(roots);
  const rowsAffected = await persistTreeOrderingUpdates(pool, offerId, audit, updates);

  // Emit realtime event for row reordering
  if (updates.length > 0) {
    realtimeEvents.emit(
      `offer:${offerId}:products`,
      'rows-reordered',
      {
        updates: updates.map(u => ({
          OfferDetailID: u.OfferDetailID,
          TreeOrdering: u.TreeOrdering ?? '',
        })),
        updatedBy: audit.userId,
      }
    );
    const changes: FieldChange[] = updates.map((u) => ({
      targetId: u.OfferDetailID,
      field: 'TreeOrdering',
      before: null,
      after: u.TreeOrdering ?? null,
    }));
    logEditAuditDetails({
      endpoint: `/api/offers/${offerId}/products`,
      method: 'POST',
      requestId,
      userId: audit.userId,
      targetEntity: 'offerProducts',
      targetIds: Array.from(new Set(changes.map((c) => c.targetId))),
      changes,
      message: `Offer rows reordered for offer ${offerId}`,
      extra: { offerId, action: 'reorder' },
    });
  }

  return NextResponse.json({ ok: true, updated: updates.length, rowsAffected });
}

async function resequenceTreeOrdering(
  offerId: number,
  audit: AuditContext,
): Promise<{ updated: number; rowsAffected: number }> {
  const pool = await getPool();
  const readRequest = pool.request();
  readRequest.input('__offerId', sql.Int, offerId);
  const readResult = await readRequest.query<TreeOrderingRow>(`
    SELECT od.ID AS OfferDetailID, od.TreeOrdering
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND ${TREE_ORDERING_RAW_EXPRESSION} IS NOT NULL
    ORDER BY ${TREE_ORDERING_SORT_PRIORITY_EXPRESSION}, ${TREE_ORDERING_HIERARCHY_EXPRESSION}, od.TreeOrdering;
  `);
  const rows = readResult.recordset ?? [];
  const roots = buildTreeFromRows(rows);
  // Force renumber: after a deletion the remaining siblings need to close
  // gaps (e.g. 1,2,3,5,6,7 → 1,2,3,4,5,6). No sentinel is set by the delete
  // flow, so the default preserve-on-no-sentinel path would leave the gap.
  const updates = collectResequencedUpdates(roots, { forceRenumber: true });
  if (updates.length === 0) {
    return { updated: 0, rowsAffected: 0 };
  }

  const rowsAffected = await persistTreeOrderingUpdates(pool, offerId, audit, updates);
  return { updated: updates.length, rowsAffected };
}

async function handleCreateRow(
  offerId: number,
  payload: CreateRowRequest | null,
  audit: AuditContext,
  requestId?: string,
) {
  const type = normalizeCreateRowType(payload?.type ?? null);
  if (!type) {
    return NextResponse.json({ ok: false, error: 'Invalid row type' }, { status: 400 });
  }
  const fallbackLabel = CREATE_TYPE_LABELS[type] ?? 'New Entry';
  const description = normalizeDescriptionValue(payload?.description ?? null) ?? fallbackLabel;
  const isComment = type === 'category' ? null : 1;
  const isPrintable = type === 'category'
    ? null
    : type === 'printable-comment'
      ? 1
      : 0;
  const isCategory = type === 'category' ? 1 : 0;
  const quantity = 0;
  const createdBy = audit.userId;

  const pool = await getPool();
  const request = pool.request();
  request.input('__offerId', sql.Int, offerId);
  request.input('__isComment', isComment);
  request.input('__isPrintable', isPrintable);
  request.input('__description', description);
  request.input('__quantity', quantity);
  request.input('__createdBy', sql.Int, createdBy);
  request.input('__modifiedBy', sql.Int, createdBy);
  request.input('__isCategory', sql.Bit, isCategory);

  const query = `
    DECLARE @lastRootValue INT =
      (
        SELECT MAX(
          TRY_CONVERT(INT,
            CASE
              WHEN CHARINDEX('.', LTRIM(RTRIM(ISNULL(od.TreeOrdering, '')))) > 0 THEN
                LEFT(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), CHARINDEX('.', LTRIM(RTRIM(ISNULL(od.TreeOrdering, '')))) - 1)
              ELSE NULLIF(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), '')
            END
          )
        )
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
      );
    DECLARE @treeOrdering NVARCHAR(255) = CONVERT(NVARCHAR(255), ISNULL(@lastRootValue, 0) + 1);
    DECLARE @nextOrdering INT =
      (
        SELECT ISNULL(MAX(ISNULL(od.Ordering, 0)), 0) + 1
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
      );

    INSERT INTO dbo.OfferDetails (
      OfferID,
      ParentOfferDetailID,
      TreeOrdering,
      Ordering,
      IsPrintable,
      IsComment,
      IsCategory,
      ProductDescription,
      Quantity,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    OUTPUT
      INSERTED.ID AS OfferDetailID,
      INSERTED.TreeOrdering,
      INSERTED.IsComment,
      INSERTED.IsPrintable,
      INSERTED.ProductDescription
    VALUES (
      @__offerId,
      NULL,
      @treeOrdering,
      @nextOrdering,
      @__isPrintable,
      @__isComment,
      @__isCategory,
      @__description,
      @__quantity,
      SYSUTCDATETIME(),
      @__createdBy,
      SYSUTCDATETIME(),
      @__modifiedBy
    );
  `;

  const result = await request.query<{
    OfferDetailID: number;
    TreeOrdering: string | null;
    IsComment: number | null;
    IsPrintable: number | null;
    ProductDescription: string | null;
  }>(query);
  const inserted = Array.isArray(result.recordset) ? result.recordset[0] ?? null : null;
  
  // Emit realtime event for new row
  if (inserted && inserted.OfferDetailID) {
    realtimeEvents.emit(
      `offer:${offerId}:products`,
      'row-added',
      {
        row: {
          OfferDetailID: inserted.OfferDetailID,
          TreeOrdering: inserted.TreeOrdering,
          Description: inserted.ProductDescription,
          IsComment: inserted.IsComment,
          IsPrintable: inserted.IsPrintable,
          // Grid will fetch full row data when it receives this event
        },
        updatedBy: createdBy,
      }
    );
    logAddAuditDetails({
      endpoint: `/api/offers/${offerId}/products`,
      method: 'POST',
      requestId,
      userId: audit.userId,
      targetEntity: 'offerProducts',
      createdRows: [
        {
          id: inserted.OfferDetailID,
          name: inserted.ProductDescription?.trim() || description,
        },
      ],
      message: `Offer row created (type: ${type})`,
      extra: { offerId, rowType: type },
    });
  }

  return NextResponse.json({
    ok: true,
    created: inserted ?? null,
  });
}

// Normalize part/model numbers by removing special characters
const normalizePartModelNumber = (value: string): string => {
  return clearPartModelNumber(value);
};

// Helper to get the cleared column name for part/model numbers
// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance.
// Strips x/X between digits at query time to avoid backfilling stored cleared values.
const partModelNumberSql = (expr: string) => {
  // OfferDetails (od) doesn't have Cleared columns — use Products (p) table instead
  if (expr.includes('.PartNumber')) {
    const cleared = expr.startsWith('od.')
      ? 'p.PartNumberCleared'
      : expr.replace('.PartNumber', '.PartNumberCleared');
    return stripXBetweenDigitsSql(`ISNULL(${cleared}, '')`);
  }
  if (expr.includes('.ModelNumber')) {
    const cleared = expr.startsWith('od.')
      ? 'p.ModelNumberCleared'
      : expr.replace('.ModelNumber', '.ModelNumberCleared');
    return stripXBetweenDigitsSql(`ISNULL(${cleared}, '')`);
  }
  return stripXBetweenDigitsSql(`ISNULL(${expr}, '')`);
};

const buildBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NULL)`;

const buildNotBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NOT NULL)`;

function buildFilterClauses(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { clauses: [] as string[], params: [] as QueryParam[] };
  }

  const clauses: string[] = [];
  const params: QueryParam[] = [];
  const typedModel = filterModel as Record<string, KnownFilterModel>;
  const isCompoundTextFilter = (filter: KnownFilterModel): filter is CompoundTextFilterModel => (
    filter.filterType === 'text'
    && 'operator' in filter
    && Array.isArray((filter as { conditions?: unknown }).conditions)
  );
  const isCompoundNumberFilter = (filter: KnownFilterModel): filter is CompoundNumberFilterModel => (
    filter.filterType === 'number'
    && 'operator' in filter
    && Array.isArray((filter as { conditions?: unknown }).conditions)
  );

  const descriptionSqlExpr = (expr: string) =>
    `UPPER(COALESCE(CAST(${expr} AS NVARCHAR(MAX)), ''))`;

  Object.entries(typedModel).forEach(([col, fm], idx) => {
    if (!fm) return;
    const paramBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    const isPartNumber = col === 'PartNumber';
    const isModelNumber = col === 'ModelNumber';
    const isDescription = col === 'Description';
    const isPartOrModel = isPartNumber || isModelNumber;
    const otherColumnExpression = isPartNumber
      ? COLUMN_EXPRESSIONS.ModelNumber
      : isModelNumber
        ? COLUMN_EXPRESSIONS.PartNumber
        : null;

    switch (fm.filterType) {
      case 'text': {
        const buildTextConditionClause = (condition: TextFilterModel, conditionParamBase: string) => {
          const type = condition.type;

          if (type === 'blank') {
            return { clause: buildBlankClause(columnExpression), params: [] as QueryParam[] };
          }
          if (type === 'notBlank') {
            return { clause: buildNotBlankClause(columnExpression), params: [] as QueryParam[] };
          }

          const value = String(condition.filter ?? '');
          if (!value) return { clause: '', params: [] as QueryParam[] };

          if (isPartOrModel) {
            const searchVal = normalizePartModelNumber(value);
            const rawVal = value.trim().toUpperCase();
            const expr = partModelNumberSql(columnExpression);

            // Cross-search: ModelNumber also searches Description (raw value)
            const descCrossExpr = isModelNumber ? COLUMN_EXPRESSIONS.Description : null;
            const descCrossParam = `${conditionParamBase}_desc`;

            // Also search LegacyPartNoCleaned
            const legacySql = stripXBetweenDigitsSql(`UPPER(ISNULL(p.LegacyPartNoCleaned, ''))`);

            if (type === 'equals') {
              if (otherColumnExpression) {
                const resultParams: QueryParam[] = [{ key: conditionParamBase, value: searchVal }];
                let clause = `(${expr} = @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} = @${conditionParamBase} OR ${legacySql} = @${conditionParamBase}`;
                if (descCrossExpr) {
                  clause += ` OR ${descriptionSqlExpr(descCrossExpr)} = @${descCrossParam}`;
                  resultParams.push({ key: descCrossParam, value: rawVal });
                }
                return { clause: `${clause})`, params: resultParams };
              }
              return {
                clause: `(${expr} = @${conditionParamBase} OR ${legacySql} = @${conditionParamBase})`,
                params: [{ key: conditionParamBase, value: searchVal }],
              };
            }
            if (type === 'notEqual') {
              return {
                clause: `${expr} <> @${conditionParamBase}`,
                params: [{ key: conditionParamBase, value: searchVal }],
              };
            }
            if (type === 'startsWith') {
              if (otherColumnExpression) {
                const resultParams: QueryParam[] = [{ key: conditionParamBase, value: `${searchVal}%` }];
                let clause = `(${expr} LIKE @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${conditionParamBase} OR ${legacySql} LIKE @${conditionParamBase}`;
                if (descCrossExpr) {
                  clause += ` OR ${descriptionSqlExpr(descCrossExpr)} LIKE @${descCrossParam}`;
                  resultParams.push({ key: descCrossParam, value: `${rawVal}%` });
                }
                return { clause: `${clause})`, params: resultParams };
              }
              return {
                clause: `(${expr} LIKE @${conditionParamBase} OR ${legacySql} LIKE @${conditionParamBase})`,
                params: [{ key: conditionParamBase, value: `${searchVal}%` }],
              };
            }
            if (type === 'endsWith') {
              if (otherColumnExpression) {
                const resultParams: QueryParam[] = [{ key: conditionParamBase, value: `%${searchVal}` }];
                let clause = `(${expr} LIKE @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${conditionParamBase} OR ${legacySql} LIKE @${conditionParamBase}`;
                if (descCrossExpr) {
                  clause += ` OR ${descriptionSqlExpr(descCrossExpr)} LIKE @${descCrossParam}`;
                  resultParams.push({ key: descCrossParam, value: `%${rawVal}` });
                }
                return { clause: `${clause})`, params: resultParams };
              }
              return {
                clause: `(${expr} LIKE @${conditionParamBase} OR ${legacySql} LIKE @${conditionParamBase})`,
                params: [{ key: conditionParamBase, value: `%${searchVal}` }],
              };
            }
            // Default: contains
            if (otherColumnExpression) {
              const resultParams: QueryParam[] = [{ key: conditionParamBase, value: `%${searchVal}%` }];
              let clause = `(${expr} LIKE @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${conditionParamBase} OR ${legacySql} LIKE @${conditionParamBase}`;
              if (descCrossExpr) {
                clause += ` OR ${descriptionSqlExpr(descCrossExpr)} LIKE @${descCrossParam}`;
                resultParams.push({ key: descCrossParam, value: `%${rawVal}%` });
              }
              return { clause: `${clause})`, params: resultParams };
            }
            return {
              clause: `(${expr} LIKE @${conditionParamBase} OR ${legacySql} LIKE @${conditionParamBase})`,
              params: [{ key: conditionParamBase, value: `%${searchVal}%` }],
            };
          }

          // Cross-search: Description also searches ModelNumber
          if (isDescription) {
            const rawVal = value.trim().toUpperCase();
            const modelExpr = COLUMN_EXPRESSIONS.ModelNumber;
            const modelParam = `${conditionParamBase}_model`;
            const descExpr = descriptionSqlExpr(columnExpression);
            const mode = type ?? 'contains';

            if (mode === 'contains') {
              return {
                clause: `(${descExpr} LIKE @${conditionParamBase} OR ${partModelNumberSql(modelExpr)} LIKE @${modelParam})`,
                params: [{ key: conditionParamBase, value: `%${rawVal}%` }, { key: modelParam, value: `%${rawVal}%` }],
              };
            }
            if (mode === 'equals') {
              return {
                clause: `(${descExpr} = @${conditionParamBase} OR ${partModelNumberSql(modelExpr)} = @${modelParam})`,
                params: [{ key: conditionParamBase, value: rawVal }, { key: modelParam, value: rawVal }],
              };
            }
            if (mode === 'startsWith') {
              return {
                clause: `(${descExpr} LIKE @${conditionParamBase} OR ${partModelNumberSql(modelExpr)} LIKE @${modelParam})`,
                params: [{ key: conditionParamBase, value: `${rawVal}%` }, { key: modelParam, value: `${rawVal}%` }],
              };
            }
            if (mode === 'endsWith') {
              return {
                clause: `(${descExpr} LIKE @${conditionParamBase} OR ${partModelNumberSql(modelExpr)} LIKE @${modelParam})`,
                params: [{ key: conditionParamBase, value: `%${rawVal}` }, { key: modelParam, value: `%${rawVal}` }],
              };
            }
            if (mode === 'notEqual') {
              return {
                clause: `${descExpr} <> @${conditionParamBase}`,
                params: [{ key: conditionParamBase, value: rawVal }],
              };
            }
          }

          const mode = (type ?? 'contains') as 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'notEqual';
          return buildTextMatchPredicate(columnExpression, value, {
            paramKey: conditionParamBase,
            mode,
            enablePhonetic: !isSensitiveColumn(col),
          });
        };

        if (isCompoundTextFilter(fm)) {
          const operator = fm.operator === 'OR' ? 'OR' : 'AND';
          const conditionResults = fm.conditions
            .map((condition, conditionIdx) => (
              buildTextConditionClause(condition, `${paramBase}_c${conditionIdx}`)
            ))
            .filter((result) => result.clause);
          if (conditionResults.length === 0) break;
          if (conditionResults.length === 1) {
            clauses.push(conditionResults[0].clause);
          } else {
            clauses.push(`(${conditionResults.map((result) => result.clause).join(` ${operator} `)})`);
          }
          conditionResults.forEach((result) => result.params.forEach((p) => params.push(p)));
          break;
        }

        const single = buildTextConditionClause(fm as TextFilterModel, paramBase);
        if (single.clause) {
          clauses.push(single.clause);
          single.params.forEach((p) => params.push(p));
        }
        break;
      }
      case 'number': {
        const buildNumberConditionClause = (condition: NumberFilterModel, conditionParamBase: string) => {
          const type = condition.type;

          if (type === 'blank') {
            return { clause: buildBlankClause(columnExpression), params: [] as QueryParam[] };
          }
          if (type === 'notBlank') {
            return { clause: buildNotBlankClause(columnExpression), params: [] as QueryParam[] };
          }

          const val = condition.filter !== undefined ? Number(condition.filter) : Number.NaN;
          const valTo = condition.filterTo !== undefined ? Number(condition.filterTo) : undefined;
          if (Number.isNaN(val)) return { clause: '', params: [] as QueryParam[] };
          const conditionParams: QueryParam[] = [{ key: conditionParamBase, value: val }];
          let clause = '';
          if (type === 'equals') clause = `${columnExpression} = @${conditionParamBase}`;
          if (type === 'notEqual') clause = `${columnExpression} <> @${conditionParamBase}`;
          if (type === 'lessThan') clause = `${columnExpression} < @${conditionParamBase}`;
          if (type === 'greaterThan') clause = `${columnExpression} > @${conditionParamBase}`;
          if (type === 'lessThanOrEqual') clause = `${columnExpression} <= @${conditionParamBase}`;
          if (type === 'greaterThanOrEqual') clause = `${columnExpression} >= @${conditionParamBase}`;
          if (type === 'inRange' && valTo !== undefined) {
            clause = `(${columnExpression} BETWEEN @${conditionParamBase} AND @${conditionParamBase}_to)`;
            conditionParams.push({ key: `${conditionParamBase}_to`, value: valTo });
          }
          return { clause, params: conditionParams };
        };

        if (isCompoundNumberFilter(fm)) {
          const operator = fm.operator === 'OR' ? 'OR' : 'AND';
          const conditionResults = fm.conditions
            .map((condition, conditionIdx) => (
              buildNumberConditionClause(condition, `${paramBase}_c${conditionIdx}`)
            ))
            .filter((result) => result.clause);
          if (conditionResults.length === 0) break;
          if (conditionResults.length === 1) {
            clauses.push(conditionResults[0].clause);
          } else {
            clauses.push(`(${conditionResults.map((result) => result.clause).join(` ${operator} `)})`);
          }
          conditionResults.forEach((result) => result.params.forEach((p) => params.push(p)));
          break;
        }

        const single = buildNumberConditionClause(fm as NumberFilterModel, paramBase);
        if (single.clause) {
          clauses.push(single.clause);
          single.params.forEach((p) => params.push(p));
        }
        break;
      }
      case 'set': {
        const rawValues = fm.values ?? [];
        if (rawValues.length === 0) break;

        const normalize = (value: string | number | boolean) => {
          if (value === true || value === 'true') return 1;
          if (value === false || value === 'false') return 0;
          return value;
        };

        const placeholders = rawValues.map((value, valueIdx) => {
          const key = `${paramBase}_${valueIdx}`;
          params.push({ key, value: normalize(value) });
          return `@${key}`;
        });

        clauses.push(`${columnExpression} IN (${placeholders.join(', ')})`);
        break;
      }
      default:
        break;
    }
  });

  return { clauses, params };
}

function buildOrder(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const resolveExpressions = (colId: string): string[] => {
    const override = ORDER_EXPRESSION_OVERRIDES[colId];
    if (override) {
      return Array.isArray(override) ? override : [override];
    }
    const expression = COLUMN_EXPRESSIONS[colId];
    return expression ? [expression] : [`[${colId}]`];
  };

  const parts = sortModel
    .filter((entry): entry is { colId: string; sort: 'asc' | 'desc' } => Boolean(entry?.colId && entry?.sort))
    .flatMap((entry) => {
      const direction = entry.sort === 'desc' ? 'DESC' : 'ASC';
      return resolveExpressions(entry.colId).map((expression) => `${expression} ${direction}`);
    });
  return parts.length ? `ORDER BY ${parts.join(', ')}, od.ID` : '';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products');
  const requestId = await getRequestId(req);
  try {
    let body: (GridRequestEnvelope & (CreateRowRequest | ReorderRequest)) | null = null;
    try {
      body = (await req.json()) as (GridRequestEnvelope & (CreateRowRequest | ReorderRequest));
    } catch {
      body = null;
    }

    const audit = buildAuditContext(req);
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();

    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: 'Missing id', rows: [], rowCount: 0 },
        { status: 400 },
      );
    }

    const idValue = Number(normalizedId);
    if (!Number.isFinite(idValue) || !Number.isInteger(idValue)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid id', rows: [], rowCount: 0 },
        { status: 400 },
      );
    }

    const requestedFieldsRaw = body && Array.isArray(body.fields) ? body.fields : [];
    const requestedFields = requestedFieldsRaw
      .filter((field): field is string => typeof field === 'string')
      .map((field) => field.trim())
      .filter((field) => field.length > 0);
    const requiredFields = [
      'OfferDetailID',
      'ParentOfferDetailID',
      'ProductID',
      'TreeOrdering',
      'IsPrintable',
      'IsComment',
      'IsCategory',
      'IsOption',
      'Description',
      'ProductDescription',
      'BrandName',
      'PartNumber',
      'ModelNumber',
      'WebLink',
      'Origin',
      'RequestedItemNo',
      'RequestedBrand',
      'RequestedModelNo',
      'RequestedPartNo',
      'RequestedWebLink',
      'RequestedDescription',
      'RequestedDescription2',
      'RequestedDescription3',
      'RequestedQuantity',
      'PriceListID',
      'PriceListEnabled',
      'PriceListValidFromDate',
      'PriceListValidToDate',
      'CreatedBy',
    ];
    // Always include OtherCurrencyName + OtherCurrencyID so the client can drive
    // auto-show of the cost-other-currency columns even when the user has hidden them.
    const extraFields: string[] = ['OtherCurrencyID', 'OtherCurrencyName', 'AdditionalCustomerDiscount'];
    const selectedFields = Array.from(new Set([...requiredFields, ...requestedFields, ...extraFields]))
      .filter((field) => Boolean(SELECT_FIELD_EXPRESSIONS[field]));

    if ((body as ReorderRequest | null)?.action === 'reorder') {
      const auth = await requirePermission(req, "editOffers");
      if (!auth.ok) return auth.response;
      return handleReorderRow(idValue, body as ReorderRequest, audit, requestId);
    }

    if ((body as CreateRowRequest | null)?.action === 'create') {
      const auth = await requirePermission(req, "editOffers");
      if (!auth.ok) return auth.response;
      return handleCreateRow(idValue, body as CreateRowRequest, audit, requestId);
    }

    const pool = await getPool();
    const gridRequest = body?.request ?? {};
    const allRows = gridRequest.allRows === true;
    const view = gridRequest.view === 'pivot' ? 'pivot' : 'grid';
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const windowSize = endRow > startRow ? endRow - startRow : 100;
    const pageSize = allRows ? ALL_ROWS_LIMIT : Math.max(1, Math.min(1000, windowSize));
    const offset = allRows ? 0 : Math.max(0, startRow);
    const { clauses, params: filterParams } = buildFilterClauses(gridRequest.filterModel);
    const viewClauses = view === 'pivot'
      ? [
          'ISNULL(od.IsCategory, 0) = 0',
          'od.ProductID IS NOT NULL',
        ]
      : [];
    const whereClauses = [`od.OfferID = @__id`, ...viewClauses, ...clauses];
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, PRODUCTS_QUICK_FILTER_COLUMNS, undefined, {
      legacyPartNoExpression: 'p.LegacyPartNoCleaned',
      partNumberClearedExpression: 'p.PartNumberCleared',
      modelNumberClearedExpression: 'p.ModelNumberCleared',
    });
    const combinedWhereSql = mergeWhereClauses(whereSql, quickFilterClause.clause);
    const combinedParams = [...filterParams, ...quickFilterClause.params];
    const orderSql = buildOrder(gridRequest.sortModel) || `ORDER BY ${TREE_ORDERING_SORT_PRIORITY_EXPRESSION}, TreeOrderingHierarchy, od.TreeOrdering, od.ID`;
    const pagingSql = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const selectedColumnSql = selectedFields
      .map((field) => `${SELECT_FIELD_EXPRESSIONS[field]} AS ${field}`)
      .join(',\n          ');
    const query = `
        SELECT
          COUNT_BIG(1) OVER () AS __totalCount,
          SUM(CASE WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0 THEN COALESCE(od.TotalPrice, 0) ELSE 0 END) OVER () AS __sumTotalPrice,
          SUM(CASE WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0 THEN COALESCE(od.TotalNet, 0) ELSE 0 END) OVER () AS __sumTotalNet,
          SUM(CASE WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0 THEN COALESCE(od.TotalCost, 0) ELSE 0 END) OVER () AS __sumTotalCost,
          SUM(CASE WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0 THEN COALESCE(od.Quantity, 0) * COALESCE(od.Installation, 0) ELSE 0 END) OVER () AS __sumInstallation,
          SUM(CASE WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0 THEN COALESCE(od.Quantity, 0) * COALESCE(od.ElInstalation, 0) ELSE 0 END) OVER () AS __sumElInstalation,
          SUM(CASE WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0 THEN COALESCE(od.Quantity, 0) * COALESCE(od.Commissioning, 0) ELSE 0 END) OVER () AS __sumCommissioning,
          ${TREE_ORDERING_HIERARCHY_EXPRESSION} AS TreeOrderingHierarchy,
          ${selectedColumnSql},
          CASE
            WHEN ISNULL(od.IsCategory, 0) = 1 THEN 0
            WHEN NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedWebLink)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedDescription)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedDescription2)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedDescription3)), '') IS NOT NULL
              OR od.RequestedQuantity IS NOT NULL
            THEN 1
            ELSE 0
          END AS __isRequestedRow,
          NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') AS __requestedItemOrdinal,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedItemNo,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedBrand,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedModelNo,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedPartNo,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedWebLink)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedWebLink,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedDescription,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription2)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedDescription2,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription3)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedDescription3,
          MAX(CASE WHEN od.RequestedQuantity IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedQuantity
        FROM dbo.OfferDetails od
          OUTER APPLY (
            SELECT TOP 1 cat_inner.ProductDescription
            FROM dbo.OfferDetails cat_inner
            WHERE cat_inner.OfferID = od.OfferID
              AND ISNULL(cat_inner.IsCategory, 0) = 1
              AND NULLIF(LTRIM(RTRIM(cat_inner.TreeOrdering)), '') = ${TREE_ORDERING_ROOT_EXPRESSION}
          ) cat
          LEFT OUTER JOIN dbo.Products p ON od.ProductID = p.ID
          LEFT OUTER JOIN dbo.Brands b ON od.BrandID = b.ID
          LEFT OUTER JOIN dbo.[Offer] o ON od.OfferID = o.ID
          LEFT OUTER JOIN dbo.PriceLists pl ON od.PriceListID = pl.ID
          LEFT OUTER JOIN dbo.Currencies oc ON od.OtherCurrencyID = oc.ID
        ${combinedWhereSql}
          ${orderSql}
          ${pagingSql}
      `;

    const sqlRequest = pool.request();
    sqlRequest.input('__id', sql.Int, idValue);
    combinedParams.forEach(param => sqlRequest.input(param.key, param.value));
    sqlRequest.input('__offset', sql.Int, offset);
    sqlRequest.input('__limit', sql.Int, pageSize);

    const result = await sqlRequest.query<ProductRowWithCount>(query);
    const recordset = result.recordset ?? [];
    const rowCount = recordset.length > 0 ? Number(recordset[0].__totalCount ?? 0) : 0;

    if (allRows && rowCount > ALL_ROWS_LIMIT) {
      return NextResponse.json(
        {
          ok: false,
          error: `Too many rows (${rowCount}) to load all at once. Please filter first, or increase ALL_ROWS_LIMIT.`,
          rows: [],
          rowCount,
        },
        { status: 413 },
      );
    }
    const totals: OfferProductTotals = recordset.length > 0
      ? {
        totalListPrice: normalizeAggregateValue(recordset[0].__sumTotalPrice ?? 0),
        totalNetPrice: normalizeAggregateValue(recordset[0].__sumTotalNet ?? 0),
        totalCost: normalizeAggregateValue(recordset[0].__sumTotalCost ?? 0),
        totalInstallation: normalizeAggregateValue(recordset[0].__sumInstallation ?? 0),
        totalElInstalation: normalizeAggregateValue(recordset[0].__sumElInstalation ?? 0),
        totalCommissioning: normalizeAggregateValue(recordset[0].__sumCommissioning ?? 0),
      }
      : { totalListPrice: 0, totalNetPrice: 0, totalCost: 0, totalInstallation: 0, totalElInstalation: 0, totalCommissioning: 0 };

    // Query requested columns separately without filters to determine visibility
    // This ensures requested columns remain visible even when filters result in no rows
    const requestedColumnsQuery = `
      SELECT
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedItemNo,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedBrand,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedModelNo,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedPartNo,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedWebLink)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedWebLink,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedDescription,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription2)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedDescription2,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription3)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedDescription3,
        MAX(CASE WHEN od.RequestedQuantity IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedQuantity
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__id
    `;
    const requestedColumnsRequest = pool.request();
    requestedColumnsRequest.input('__id', sql.Int, idValue);
    const requestedColumnsResult = await requestedColumnsRequest.query<{
      __hasRequestedItemNo?: number | bigint | null;
      __hasRequestedBrand?: number | bigint | null;
      __hasRequestedModelNo?: number | bigint | null;
      __hasRequestedPartNo?: number | bigint | null;
      __hasRequestedWebLink?: number | bigint | null;
      __hasRequestedDescription?: number | bigint | null;
      __hasRequestedDescription2?: number | bigint | null;
      __hasRequestedDescription3?: number | bigint | null;
      __hasRequestedQuantity?: number | bigint | null;
    }>(requestedColumnsQuery);
    const requestedColumnsRow = requestedColumnsResult.recordset?.[0] ?? null;

    const requestedColumns: RequestedColumns = {
      RequestedItemNo: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedItemNo ?? 0),
      RequestedBrand: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedBrand ?? 0),
      RequestedModelNo: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedModelNo ?? 0),
      RequestedPartNo: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedPartNo ?? 0),
      RequestedWebLink: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedWebLink ?? 0),
      RequestedDescription: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedDescription ?? 0),
      RequestedDescription2: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedDescription2 ?? 0),
      RequestedDescription3: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedDescription3 ?? 0),
      RequestedQuantity: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedQuantity ?? 0),
    };

    const offerCurrencyResult = await pool
      .request()
      .input('__id', sql.Int, idValue)
      .query<{ Name: string | null }>(`
        SELECT cur.Name
        FROM dbo.Offer o
        LEFT JOIN dbo.Currencies cur ON o.CurrencyID = cur.ID
        WHERE o.ID = @__id
      `);
    const offerCurrencyName = (offerCurrencyResult.recordset?.[0]?.Name ?? '').trim() || null;

    const rows: ProductRow[] = recordset.map(row => {
      const {
        __totalCount,
        __sumTotalPrice,
        __sumTotalNet,
        __sumTotalCost,
        __sumInstallation,
        __sumElInstalation,
        __sumCommissioning,
      __hasRequestedItemNo,
      __hasRequestedBrand,
      __hasRequestedModelNo,
      __hasRequestedPartNo,
      __hasRequestedWebLink,
      __hasRequestedDescription,
      __hasRequestedDescription2,
      __hasRequestedDescription3,
      __hasRequestedQuantity,
      ...rest
      } = row;
      void __totalCount;
      void __sumTotalPrice;
      void __sumTotalNet;
      void __sumTotalCost;
      void __sumInstallation;
      void __sumElInstalation;
      void __sumCommissioning;
      void __hasRequestedItemNo;
      void __hasRequestedBrand;
      void __hasRequestedModelNo;
      void __hasRequestedPartNo;
      void __hasRequestedWebLink;
      void __hasRequestedDescription;
      void __hasRequestedDescription2;
      void __hasRequestedDescription3;
      void __hasRequestedQuantity;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount, totals, requestedColumns, offerCurrencyName });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message, rows: [], rowCount: 0 }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products');
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    const audit = buildAuditContext(req);
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    let body: TreeOrderingUpdateRequest | null = null;
    try {
      body = (await req.json()) as TreeOrderingUpdateRequest;
    } catch {
      body = null;
    }
    const updates = body && Array.isArray(body.updates) ? body.updates : [];
    const normalizedUpdates = updates
      .map((update) => {
        const id = normalizeOfferDetailId(update?.OfferDetailID ?? null);
        if (id == null) return null;
        const ordering = normalizeTreeOrderingValue(update?.TreeOrdering ?? null);
        return { OfferDetailID: id, TreeOrdering: ordering };
      })
      .filter((entry): entry is { OfferDetailID: number; TreeOrdering: string | null } => Boolean(entry));

    if (normalizedUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: 'No valid updates provided' }, { status: 400 });
    }

    const pool = await getPool();
    const affected = await persistTreeOrderingUpdates(pool, offerId, audit, normalizedUpdates);

    if (affected > 0) {
      realtimeEvents.emit(
        `offer:${offerId}:products`,
        'rows-reordered',
        {
          updates: normalizedUpdates.map((u) => ({
            OfferDetailID: u.OfferDetailID,
            TreeOrdering: u.TreeOrdering ?? '',
          })),
          updatedBy: audit.userId,
        },
      );
      const changes: FieldChange[] = normalizedUpdates.map((u) => ({
        targetId: u.OfferDetailID,
        field: 'TreeOrdering',
        before: null,
        after: u.TreeOrdering ?? null,
      }));
      logEditAuditDetails({
        endpoint: `/api/offers/${offerId}/products`,
        method: 'PUT',
        requestId,
        userId: audit.userId,
        targetEntity: 'offerProducts',
        targetIds: Array.from(new Set(changes.map((c) => c.targetId))),
        changes,
        message: `Offer row tree ordering updated for offer ${offerId}`,
        extra: { offerId },
      });
    }

    return NextResponse.json({
      ok: true,
      updated: normalizedUpdates.length,
      rowsAffected: affected,
    });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products');
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    const audit = buildAuditContext(req);
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    let body: DetailUpdateRequest | null = null;
    try {
      body = (await req.json()) as DetailUpdateRequest;
    } catch {
      body = null;
    }

    const updates = body && Array.isArray(body.updates) ? body.updates : [];
    let hadInvalidQuantity = false;
    let hadInvalidPricing = false;
    const normalizedUpdates = updates
      .map((entry) => {
        const id = normalizeOfferDetailId(entry?.OfferDetailID ?? null);
        if (id == null) return null;
        const hasProductDescription = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'ProductDescription')
          : false;
        const hasComment = entry ? Object.prototype.hasOwnProperty.call(entry, 'Comment') : false;
        const hasDelivery = entry ? Object.prototype.hasOwnProperty.call(entry, 'Delivery') : false;
        const hasDescription = entry ? Object.prototype.hasOwnProperty.call(entry, 'Description') : false;
        const hasQuantity = entry ? Object.prototype.hasOwnProperty.call(entry, 'Quantity') : false;
        const hasCustomerDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'CustomerDiscount') : false;
        const hasAdditionalCustomerDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'AdditionalCustomerDiscount') : false;
        const hasTelmacoDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'TelmacoDiscount') : false;
        const hasNetUnitPrice = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetUnitPrice') : false;
        const hasNetCostOtherCurrency = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetCostOtherCurrency') : false;
        const hasOtherCurrencyID = entry ? Object.prototype.hasOwnProperty.call(entry, 'OtherCurrencyID') : false;
        const hasCurrencyCostModifier = entry ? Object.prototype.hasOwnProperty.call(entry, 'CurrencyCostModifier') : false;
        const hasNetCost = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetCost') : false;
        const hasMargin = entry ? Object.prototype.hasOwnProperty.call(entry, 'Margin') : false;
        const hasListPrice = entry ? Object.prototype.hasOwnProperty.call(entry, 'ListPrice') : false;
        const hasIsCategory = entry ? Object.prototype.hasOwnProperty.call(entry, 'IsCategory') : false;
        const hasIsPrintable = entry ? Object.prototype.hasOwnProperty.call(entry, 'IsPrintable') : false;
        const hasIsComment = entry ? Object.prototype.hasOwnProperty.call(entry, 'IsComment') : false;
        const hasIsOption = entry ? Object.prototype.hasOwnProperty.call(entry, 'IsOption') : false;
        const hasRequestedItemNo = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedItemNo')
          : false;
        const hasRequestedBrand = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedBrand')
          : false;
        const hasRequestedModelNo = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedModelNo')
          : false;
        const hasRequestedPartNo = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedPartNo')
          : false;
        const hasRequestedWebLink = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedWebLink')
          : false;
        const hasRequestedDescription = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedDescription')
          : false;
        const hasRequestedDescription2 = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedDescription2')
          : false;
        const hasRequestedDescription3 = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedDescription3')
          : false;
        const hasRequestedQuantity = entry
          ? Object.prototype.hasOwnProperty.call(entry, 'RequestedQuantity')
          : false;
        const hasPartNumber = entry ? Object.prototype.hasOwnProperty.call(entry, 'PartNumber') : false;
        const hasModelNumber = entry ? Object.prototype.hasOwnProperty.call(entry, 'ModelNumber') : false;
        const hasInstallation = entry ? Object.prototype.hasOwnProperty.call(entry, 'Installation') : false;
        const hasElInstalation = entry ? Object.prototype.hasOwnProperty.call(entry, 'ElInstalation') : false;
        const hasCommissioning = entry ? Object.prototype.hasOwnProperty.call(entry, 'Commissioning') : false;
        const hasPricingFields = hasCustomerDiscount || hasAdditionalCustomerDiscount || hasTelmacoDiscount || hasNetUnitPrice || hasNetCost || hasMargin
          || hasNetCostOtherCurrency || hasOtherCurrencyID || hasCurrencyCostModifier;
        if (
          !hasProductDescription
          && !hasComment
          && !hasDelivery
          && !hasDescription
          && !hasQuantity
          && !hasPricingFields
          && !hasListPrice
          && !hasIsCategory
          && !hasIsPrintable
          && !hasIsComment
          && !hasIsOption
          && !hasRequestedItemNo
          && !hasRequestedBrand
          && !hasRequestedModelNo
          && !hasRequestedPartNo
          && !hasRequestedWebLink
          && !hasRequestedDescription
          && !hasPartNumber
          && !hasModelNumber
          && !hasRequestedDescription2
          && !hasRequestedDescription3
          && !hasRequestedQuantity
          && !hasInstallation
          && !hasElInstalation
          && !hasCommissioning
        ) {
          return null;
        }

        const productDescription = hasProductDescription
          ? normalizeDescriptionValue(entry?.ProductDescription ?? null)
          : hasDescription
            ? normalizeDescriptionValue(entry?.Description ?? null)
            : null;
        const comment = hasComment ? normalizeDescriptionValue(entry?.Comment ?? null) : null;
        const delivery = hasDelivery ? normalizeDeliveryValue(entry?.Delivery ?? null) : null;
        let quantity: number | null = null;
        if (hasQuantity) {
          quantity = normalizeQuantityValue(entry?.Quantity ?? null);
          if (quantity == null) {
            hadInvalidQuantity = true;
            return null;
          }
        }
        const requestedBrand = hasRequestedBrand
          ? normalizeRequestedTextValue(entry?.RequestedBrand ?? null)
          : null;
        const requestedModelNo = hasRequestedModelNo
          ? normalizeRequestedTextValue(entry?.RequestedModelNo ?? null)
          : null;
        const requestedPartNo = hasRequestedPartNo
          ? normalizeRequestedTextValue(entry?.RequestedPartNo ?? null)
          : null;
        const requestedWebLink = hasRequestedWebLink
          ? normalizeRequestedTextValue(entry?.RequestedWebLink ?? null)
          : null;
        const requestedDescription = hasRequestedDescription
          ? normalizeRequestedTextValue(entry?.RequestedDescription ?? null)
          : null;
        const requestedDescription2 = hasRequestedDescription2
          ? normalizeRequestedTextValue(entry?.RequestedDescription2 ?? null)
          : null;
        const requestedDescription3 = hasRequestedDescription3
          ? normalizeRequestedTextValue(entry?.RequestedDescription3 ?? null)
          : null;
        let requestedQuantity: number | null = null;
        if (hasRequestedQuantity) {
          requestedQuantity = normalizeQuantityValue(entry?.RequestedQuantity ?? null);
          const requestedQuantityRaw = entry?.RequestedQuantity;
          const hasRequestedQuantityInput = requestedQuantityRaw != null
            && String(requestedQuantityRaw).trim().length > 0;
          if (hasRequestedQuantityInput && requestedQuantity == null) {
            hadInvalidQuantity = true;
            return null;
          }
        }

        const customerDiscount = hasCustomerDiscount
          ? normalizeDiscountValue(entry?.CustomerDiscount ?? null)
          : null;
        const additionalCustomerDiscount = hasAdditionalCustomerDiscount
          ? normalizeDiscountValue(entry?.AdditionalCustomerDiscount ?? null)
          : null;
        const telmacoDiscount = hasTelmacoDiscount
          ? normalizeDiscountValue(entry?.TelmacoDiscount ?? null)
          : null;
        const netUnitPrice = hasNetUnitPrice ? normalizeMoneyValue(entry?.NetUnitPrice ?? null, { allowNegative: true }) : null;
        const netCostOtherCurrency = hasNetCostOtherCurrency ? normalizeMoneyValue(entry?.NetCostOtherCurrency ?? null, { allowNegative: true }) : null;
        const otherCurrencyId = hasOtherCurrencyID ? normalizeIntValue(entry?.OtherCurrencyID ?? null) : null;
        const currencyCostModifier = hasCurrencyCostModifier ? normalizePositiveMoneyValue(entry?.CurrencyCostModifier ?? null) : null;
        const netCost = hasNetCost ? normalizeMoneyValue(entry?.NetCost ?? null, { allowNegative: true }) : null;
        const margin = hasMargin ? normalizePercentValue(entry?.Margin ?? null, { allowNegative: true }) : null;
        const listPrice = hasListPrice ? normalizeMoneyValue(entry?.ListPrice ?? null, { allowNegative: true }) : null;
        const isCategoryValue = hasIsCategory ? normalizeBoolean(entry?.IsCategory ?? null) : null;
        const isPrintableValue = hasIsPrintable ? normalizeBoolean(entry?.IsPrintable ?? null) : null;
        const isCommentValue = hasIsComment ? normalizeBoolean(entry?.IsComment ?? null) : null;
        const isOptionValue = hasIsOption ? normalizeBoolean(entry?.IsOption ?? null) : null;
        const partNumber = hasPartNumber ? normalizeRequestedTextValue(entry?.PartNumber ?? null) : null;
        const modelNumber = hasModelNumber ? normalizeRequestedTextValue(entry?.ModelNumber ?? null) : null;
        const installation = hasInstallation ? normalizeMoneyValue(entry?.Installation ?? null) : null;
        const elInstalation = hasElInstalation ? normalizeMoneyValue(entry?.ElInstalation ?? null) : null;
        const commissioning = hasCommissioning ? normalizeMoneyValue(entry?.Commissioning ?? null) : null;

        if (hasPricingFields) {
          const invalidPricing = (hasCustomerDiscount && customerDiscount == null)
            || (hasAdditionalCustomerDiscount && additionalCustomerDiscount == null)
            || (hasTelmacoDiscount && telmacoDiscount == null)
            || (hasNetUnitPrice && netUnitPrice == null)
            || (hasNetCostOtherCurrency && netCostOtherCurrency == null)
            || (hasOtherCurrencyID && otherCurrencyId == null)
            || (hasCurrencyCostModifier && currencyCostModifier == null)
            || (hasNetCost && netCost == null)
            || (hasMargin && (margin == null || Math.abs(margin) >= 100));
          if (invalidPricing) {
            hadInvalidPricing = true;
            return null;
          }
        }

        return {
          OfferDetailID: id,
          ProductDescription: productDescription,
          Comment: comment,
          Delivery: delivery,
          Quantity: quantity,
          // Treat both `ProductDescription` and legacy `Description` as a description update.
          hasProductDescription: hasProductDescription || hasDescription,
          hasComment,
          hasDelivery,
          hasQuantity,
          hasCustomerDiscount,
          hasAdditionalCustomerDiscount,
          hasTelmacoDiscount,
          hasNetUnitPrice,
          hasNetCostOtherCurrency,
          hasOtherCurrencyID,
          hasCurrencyCostModifier,
          hasNetCost,
          hasMargin,
          hasListPrice,
          hasIsPrintable,
          hasIsComment,
          hasRequestedItemNo,
          hasRequestedBrand,
          hasRequestedModelNo,
          hasRequestedPartNo,
          hasRequestedWebLink,
          hasRequestedDescription,
          hasRequestedDescription2,
          hasRequestedDescription3,
          hasRequestedQuantity,
          customerDiscount,
          additionalCustomerDiscount,
          telmacoDiscount,
          netUnitPrice,
          netCostOtherCurrency,
          otherCurrencyId,
          currencyCostModifier,
          netCost,
          margin,
          listPrice,
          hasIsCategory,
          IsCategory: isCategoryValue,
          IsPrintable: isPrintableValue,
          IsComment: isCommentValue,
          hasIsOption,
          IsOption: isOptionValue,
          requestedItemNo: hasRequestedItemNo
            ? normalizeRequestedItemNoValue(entry?.RequestedItemNo ?? null)
            : null,
          RequestedBrand: requestedBrand,
          RequestedModelNo: requestedModelNo,
          RequestedPartNo: requestedPartNo,
          RequestedWebLink: requestedWebLink,
          RequestedDescription: requestedDescription,
          RequestedDescription2: requestedDescription2,
          RequestedDescription3: requestedDescription3,
          RequestedQuantity: requestedQuantity,
          hasPartNumber,
          PartNumber: partNumber,
          hasModelNumber,
          ModelNumber: modelNumber,
          hasInstallation,
          Installation: installation,
          hasElInstalation,
          ElInstalation: elInstalation,
          hasCommissioning,
          Commissioning: commissioning,
        };
      })
      .filter((entry): entry is {
        OfferDetailID: number;
        ProductDescription: string | null;
        Comment: string | null;
        Delivery: string | null;
        Quantity: number | null;
        hasProductDescription: boolean;
        hasComment: boolean;
        hasDelivery: boolean;
        hasQuantity: boolean;
        hasCustomerDiscount: boolean;
        hasAdditionalCustomerDiscount: boolean;
        hasTelmacoDiscount: boolean;
        hasNetUnitPrice: boolean;
        hasNetCostOtherCurrency: boolean;
        hasOtherCurrencyID: boolean;
        hasCurrencyCostModifier: boolean;
        hasNetCost: boolean;
        hasMargin: boolean;
        hasListPrice: boolean;
        hasIsPrintable: boolean;
        hasIsComment: boolean;
        hasRequestedItemNo: boolean;
        hasRequestedBrand: boolean;
        hasRequestedModelNo: boolean;
        hasRequestedPartNo: boolean;
        hasRequestedWebLink: boolean;
        hasRequestedDescription: boolean;
        hasRequestedDescription2: boolean;
        hasRequestedDescription3: boolean;
        hasRequestedQuantity: boolean;
        customerDiscount: number | null;
        additionalCustomerDiscount: number | null;
        telmacoDiscount: number | null;
        netUnitPrice: number | null;
        netCostOtherCurrency: number | null;
        otherCurrencyId: number | null;
        currencyCostModifier: number | null;
        netCost: number | null;
        margin: number | null;
        listPrice: number | null;
        hasIsCategory: boolean;
        IsCategory: boolean | null;
        IsPrintable: boolean | null;
        IsComment: boolean | null;
        hasIsOption: boolean;
        IsOption: boolean | null;
        requestedItemNo: string | null;
        RequestedBrand: string | null;
        RequestedModelNo: string | null;
        RequestedPartNo: string | null;
        RequestedWebLink: string | null;
        RequestedDescription: string | null;
        RequestedDescription2: string | null;
        RequestedDescription3: string | null;
        RequestedQuantity: number | null;
        hasPartNumber: boolean;
        PartNumber: string | null;
        hasModelNumber: boolean;
        ModelNumber: string | null;
        hasInstallation: boolean;
        Installation: number | null;
        hasElInstalation: boolean;
        ElInstalation: number | null;
        hasCommissioning: boolean;
        Commissioning: number | null;
      } => Boolean(entry));

    if (normalizedUpdates.length === 0) {
      const errorMessage = hadInvalidPricing
        ? 'Invalid pricing values provided'
        : hadInvalidQuantity
          ? 'Invalid quantity value'
          : 'No valid updates provided';
      return NextResponse.json({ ok: false, error: errorMessage }, { status: 400 });
    }

    const pool = await getPool();
    const chunkSize = 400;
    let affected = 0;
    const resolvedRows: Array<{
      OfferDetailID: number;
      CustomerDiscount: number | null;
      AdditionalCustomerDiscount: number | null;
      TelmacoDiscount: number | null;
      NetUnitPrice: number | null;
      NetCost: number | null;
      Margin: number | null;
      ListPrice: number | null;
      NetCostOtherCurrency: number | null;
      OtherCurrencyID: number | null;
      CurrencyCostModifier: number | null;
      Quantity: number | null;
      TotalPrice: number | null;
      TotalNet: number | null;
      TotalCost: number | null;
      GrossProfit: number | null;
    }> = [];

    for (let idx = 0; idx < normalizedUpdates.length; idx += chunkSize) {
      const chunk = normalizedUpdates.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;

      const ids = chunk.map((entry) => entry.OfferDetailID);
      const baseRequest = pool.request();
      baseRequest.input('__offerId', sql.Int, offerId);
      const idParams: string[] = [];
      ids.forEach((id, idIdx) => {
        const param = `id_${idIdx}`;
        baseRequest.input(param, sql.Int, id);
        idParams.push(`@${param}`);
      });

      const currentRowsRes = await baseRequest.query<{
        OfferDetailID: number;
        ProductID: number | null;
        IsComment: number | null;
        PartNumber: string | null;
        ModelNumber: string | null;
        ProductDescription: string | null;
        Comment: string | null;
        Delivery: string | null;
        Quantity: number | null;
        ListPrice: number | null;
        CustomerDiscount: number | null;
        AdditionalCustomerDiscount: number | null;
        TelmacoDiscount: number | null;
        NetUnitPrice: number | null;
        NetCostOtherCurrency: number | null;
        OtherCurrencyID: number | null;
        CurrencyCostModifier: number | null;
        NetCost: number | null;
        Margin: number | null;
      }>(`
        SELECT
        od.ProductID,
        od.ID AS OfferDetailID,
        od.ProductID,
        od.IsComment,
        od.PartNumber,
        od.ModelNumber,
        od.ProductDescription,
          od.[Comment] AS Comment,
          od.Delivery,
          od.Quantity,
          od.ListPrice,
          od.CustomerDiscount,
          od.AdditionalCustomerDiscount,
          od.TelmacoDiscount,
          od.NetUnitPrice,
          od.NetCostOtherCurrency,
          od.OtherCurrencyID,
          od.CurrencyCostModifier,
          od.NetCost,
          od.Margin
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
          AND od.ID IN (${idParams.join(', ')})
      `);

      const currentById = new Map<number, {
        ProductID: number | null;
        IsComment: number | null;
        PartNumber: string | null;
        ModelNumber: string | null;
        ProductDescription: string | null;
        Comment: string | null;
        Delivery: string | null;
        Quantity: number | null;
        ListPrice: number | null;
        CustomerDiscount: number | null;
        AdditionalCustomerDiscount: number | null;
        TelmacoDiscount: number | null;
        NetUnitPrice: number | null;
        NetCostOtherCurrency: number | null;
        OtherCurrencyID: number | null;
        CurrencyCostModifier: number | null;
        NetCost: number | null;
        Margin: number | null;
      }>();
      (currentRowsRes.recordset ?? []).forEach((row) => {
        currentById.set(row.OfferDetailID, row);
      });

      const pendingRows: Array<{
        OfferDetailID: number;
        ProductDescription: string | null;
        Comment: string | null;
        Delivery: string | null;
        HasProductDescription: boolean;
        HasComment: boolean;
        HasDelivery: boolean;
        Quantity: number | null;
        HasQuantity: boolean;
        CustomerDiscount: number | null;
        AdditionalCustomerDiscount: number | null;
        TelmacoDiscount: number | null;
        NetUnitPrice: number | null;
        NetCostOtherCurrency: number | null;
        HasNetCostOtherCurrency: boolean;
        OtherCurrencyID: number | null;
        HasOtherCurrencyID: boolean;
        CurrencyCostModifier: number | null;
        HasCurrencyCostModifier: boolean;
        NetCost: number | null;
        Margin: number | null;
        TotalPrice: number | null;
        TotalNet: number | null;
        TotalCost: number | null;
        GrossProfit: number | null;
        ListPrice: number | null;
        HasListPrice: boolean;
        EffectiveListPrice: number | null;
        RequestedItemNo: string | null;
        HasRequestedItemNo: boolean;
        RequestedBrand: string | null;
        HasRequestedBrand: boolean;
        RequestedModelNo: string | null;
        HasRequestedModelNo: boolean;
        RequestedPartNo: string | null;
        HasRequestedPartNo: boolean;
        RequestedWebLink: string | null;
        HasRequestedWebLink: boolean;
        RequestedDescription: string | null;
        HasRequestedDescription: boolean;
        RequestedDescription2: string | null;
        HasRequestedDescription2: boolean;
        RequestedDescription3: string | null;
        HasRequestedDescription3: boolean;
        RequestedQuantity: number | null;
        HasRequestedQuantity: boolean;
        IsCategory: boolean | null;
        HasIsCategory: boolean;
        IsPrintable: boolean | null;
        HasIsPrintable: boolean;
        IsComment: boolean | null;
        HasIsComment: boolean;
        IsOption: boolean | null;
        HasIsOption: boolean;
        PartNumber: string | null;
        HasPartNumber: boolean;
        ModelNumber: string | null;
        HasModelNumber: boolean;
        Installation: number | null;
        HasInstallation: boolean;
        ElInstalation: number | null;
        HasElInstalation: boolean;
        Commissioning: number | null;
        HasCommissioning: boolean;
      }> = [];
      const errors: string[] = [];

      chunk.forEach((entry) => {
        const current = currentById.get(entry.OfferDetailID);
        if (!current) {
          errors.push('Offer detail not found for update.');
          return;
        }

        const costFieldsProvided = entry.hasNetCostOtherCurrency || entry.hasOtherCurrencyID || entry.hasCurrencyCostModifier;
        const resolvedNetCostOtherCurrency = entry.hasNetCostOtherCurrency
          ? entry.netCostOtherCurrency
          : normalizeMoneyValue(current.NetCostOtherCurrency ?? null, { allowNegative: true });
        const resolvedOtherCurrencyId = entry.hasOtherCurrencyID
          ? entry.otherCurrencyId
          : normalizeIntValue(current.OtherCurrencyID ?? null);
        const resolvedCurrencyCostModifier: number =
          entry.hasCurrencyCostModifier && entry.currencyCostModifier != null
            ? entry.currencyCostModifier
            : normalizePositiveMoneyValue(current.CurrencyCostModifier ?? null) ?? 1;
        const computedNetCostFromOther = resolvedNetCostOtherCurrency != null
          ? roundTo(resolvedNetCostOtherCurrency * resolvedCurrencyCostModifier)
          : null;

        const listPriceCandidate = entry.hasListPrice
          ? entry.listPrice
          : normalizeMoneyValue(current.ListPrice, { allowNegative: true });
        const fallbackListPrice = listPriceCandidate ?? computedNetCostFromOther ?? null;
        const quantity = entry.hasQuantity
          ? entry.Quantity
          : normalizeQuantityValue(current.Quantity ?? null);
        const safeQuantity = quantity == null ? 0 : quantity;
        const pricingProvided = entry.hasListPrice || entry.hasCustomerDiscount || entry.hasAdditionalCustomerDiscount
          || entry.hasTelmacoDiscount || entry.hasNetUnitPrice || entry.hasNetCost || entry.hasMargin
          || costFieldsProvided;
        const isCommentRow = Boolean(current.IsComment);

        let resolvedPricing: ResolvedPricing | null = null;

        if (pricingProvided) {
          const hasProductIdentifier = current.ProductID != null
            || (current.PartNumber != null && current.PartNumber.trim() !== '')
            || (current.ModelNumber != null && current.ModelNumber.trim() !== '');
          if (!hasProductIdentifier && !isCommentRow) {
            errors.push('Pricing can only be updated for product or comment rows.');
            return;
          }
          // No list price → resolvePricing returns null → fallback saves raw provided values.

          if (isCommentRow) {
            const nextNetCost = entry.hasNetCost
              ? entry.netCost
              : costFieldsProvided && computedNetCostFromOther != null
                ? computedNetCostFromOther
                : normalizeMoneyValue(current.NetCost ?? null, { allowNegative: true });
            const commentInput: PricingInput = {
              listPrice: fallbackListPrice,
              customerDiscount: entry.hasCustomerDiscount
                ? entry.customerDiscount
                : normalizeDiscountValue(current.CustomerDiscount ?? null),
              additionalCustomerDiscount: entry.hasAdditionalCustomerDiscount
                ? entry.additionalCustomerDiscount
                : normalizeDiscountValue(current.AdditionalCustomerDiscount ?? null),
              telmacoDiscount: entry.hasTelmacoDiscount
                ? entry.telmacoDiscount
                : normalizeDiscountValue(current.TelmacoDiscount ?? null),
              netUnitPrice: entry.hasNetUnitPrice
                ? entry.netUnitPrice
                : normalizeMoneyValue(current.NetUnitPrice ?? null, { allowNegative: true }),
              netCost: nextNetCost,
              margin: entry.hasMargin
                ? entry.margin
                : normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
              provided: {
                listPrice: entry.hasListPrice,
                customerDiscount: entry.hasCustomerDiscount,
                additionalCustomerDiscount: entry.hasAdditionalCustomerDiscount,
                telmacoDiscount: entry.hasTelmacoDiscount,
                netUnitPrice: entry.hasNetUnitPrice,
                netCost: entry.hasNetCost || costFieldsProvided,
                margin: entry.hasMargin,
              },
            };

            resolvedPricing = resolvePricing(commentInput);
            if (!resolvedPricing) {
              const derived = deriveWithoutListPrice(
                commentInput.netUnitPrice,
                commentInput.netCost,
                commentInput.margin,
                commentInput.provided,
              );
              resolvedPricing = {
                customerDiscount: commentInput.customerDiscount,
                additionalCustomerDiscount: commentInput.additionalCustomerDiscount ?? null,
                telmacoDiscount: commentInput.telmacoDiscount,
                netUnitPrice: derived.netUnitPrice,
                netCost: derived.netCost,
                margin: derived.margin,
              };
            }
          } else {
            const nextNetCost = entry.hasNetCost
              ? entry.netCost
              : costFieldsProvided && computedNetCostFromOther != null
                ? computedNetCostFromOther
                : normalizeMoneyValue(current.NetCost ?? null, { allowNegative: true });
            const input: PricingInput = {
              listPrice: fallbackListPrice,
              customerDiscount: entry.hasCustomerDiscount
                ? entry.customerDiscount
                : normalizeDiscountValue(current.CustomerDiscount ?? null),
              additionalCustomerDiscount: entry.hasAdditionalCustomerDiscount
                ? entry.additionalCustomerDiscount
                : normalizeDiscountValue(current.AdditionalCustomerDiscount ?? null),
              telmacoDiscount: entry.hasTelmacoDiscount
                ? entry.telmacoDiscount
                : normalizeDiscountValue(current.TelmacoDiscount ?? null),
              netUnitPrice: entry.hasNetUnitPrice
                ? entry.netUnitPrice
                : normalizeMoneyValue(current.NetUnitPrice ?? null, { allowNegative: true }),
              netCost: nextNetCost,
              margin: entry.hasMargin
                ? entry.margin
                : normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
              provided: {
                listPrice: entry.hasListPrice,
                customerDiscount: entry.hasCustomerDiscount,
                additionalCustomerDiscount: entry.hasAdditionalCustomerDiscount,
                telmacoDiscount: entry.hasTelmacoDiscount,
                netUnitPrice: entry.hasNetUnitPrice,
                netCost: entry.hasNetCost || costFieldsProvided,
                margin: entry.hasMargin,
              },
            };

            resolvedPricing = resolvePricing(input);
            if (!resolvedPricing) {
              const derived = deriveWithoutListPrice(
                input.netUnitPrice,
                input.netCost,
                input.margin,
                input.provided,
              );
              resolvedPricing = {
                customerDiscount: input.customerDiscount,
                additionalCustomerDiscount: input.additionalCustomerDiscount ?? null,
                telmacoDiscount: input.telmacoDiscount,
                netUnitPrice: derived.netUnitPrice,
                netCost: derived.netCost,
                margin: derived.margin,
              };
            }
          }
        } else {
          resolvedPricing = {
            customerDiscount: normalizeDiscountValue(current.CustomerDiscount ?? null),
            additionalCustomerDiscount: normalizeDiscountValue(current.AdditionalCustomerDiscount ?? null),
            telmacoDiscount: normalizeDiscountValue(current.TelmacoDiscount ?? null),
            netUnitPrice: normalizeMoneyValue(current.NetUnitPrice ?? null, { allowNegative: true }),
            netCost: normalizeMoneyValue(current.NetCost ?? null, { allowNegative: true }),
            margin: normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
          };
        }

        const netPrice = resolvedPricing.netUnitPrice;
        const telmacoCost = resolvedPricing.netCost;
        // If there is still no list price, try to derive it from the resolved price + its discount.
        const derivedListPrice = (listPriceCandidate == null && fallbackListPrice == null)
          ? deriveListPrice(
              resolvedPricing.netUnitPrice,
              resolvedPricing.netCost,
              resolvedPricing.customerDiscount,
              resolvedPricing.telmacoDiscount,
              resolvedPricing.additionalCustomerDiscount ?? null,
            )
          : null;
        const listPriceForTotals = listPriceCandidate ?? derivedListPrice ?? fallbackListPrice;
        const totalPrice = listPriceForTotals != null ? roundTo(listPriceForTotals * safeQuantity) : null;
        const totalNet = netPrice != null ? roundTo(netPrice * safeQuantity) : null;
        const totalCost = telmacoCost != null ? roundTo(telmacoCost * safeQuantity) : null;
        const grossProfit = netPrice != null && telmacoCost != null
          ? roundTo((netPrice - telmacoCost) * safeQuantity)
          : null;

        pendingRows.push({
          OfferDetailID: entry.OfferDetailID,
          ProductDescription: entry.hasProductDescription
            ? entry.ProductDescription
            : current.ProductDescription,
          Comment: entry.hasComment ? entry.Comment : current.Comment,
          Delivery: entry.hasDelivery ? entry.Delivery : current.Delivery,
          HasProductDescription: entry.hasProductDescription,
          HasComment: entry.hasComment,
          HasDelivery: entry.hasDelivery,
          Quantity: entry.hasQuantity ? entry.Quantity : current.Quantity ?? safeQuantity,
          HasQuantity: entry.hasQuantity,
          CustomerDiscount: resolvedPricing.customerDiscount,
          AdditionalCustomerDiscount: resolvedPricing.additionalCustomerDiscount ?? null,
          TelmacoDiscount: resolvedPricing.telmacoDiscount,
          NetUnitPrice: netPrice,
          NetCostOtherCurrency: resolvedNetCostOtherCurrency,
          HasNetCostOtherCurrency: entry.hasNetCostOtherCurrency,
          OtherCurrencyID: resolvedOtherCurrencyId,
          HasOtherCurrencyID: entry.hasOtherCurrencyID,
          CurrencyCostModifier: resolvedCurrencyCostModifier,
          HasCurrencyCostModifier: entry.hasCurrencyCostModifier,
          NetCost: telmacoCost,
          Margin: resolvedPricing.margin,
          TotalPrice: totalPrice,
          TotalNet: totalNet,
          TotalCost: totalCost,
          GrossProfit: grossProfit,
          ListPrice: entry.hasListPrice ? entry.listPrice ?? null : (derivedListPrice ?? null),
          HasListPrice: entry.hasListPrice || derivedListPrice != null,
          EffectiveListPrice: listPriceForTotals ?? null,
          RequestedItemNo: entry.requestedItemNo,
          HasRequestedItemNo: entry.hasRequestedItemNo,
          RequestedBrand: entry.RequestedBrand,
          HasRequestedBrand: entry.hasRequestedBrand,
          RequestedModelNo: entry.RequestedModelNo,
          HasRequestedModelNo: entry.hasRequestedModelNo,
          RequestedPartNo: entry.RequestedPartNo,
          HasRequestedPartNo: entry.hasRequestedPartNo,
          RequestedWebLink: entry.RequestedWebLink,
          HasRequestedWebLink: entry.hasRequestedWebLink,
          RequestedDescription: entry.RequestedDescription,
          HasRequestedDescription: entry.hasRequestedDescription,
          RequestedDescription2: entry.RequestedDescription2,
          HasRequestedDescription2: entry.hasRequestedDescription2,
          RequestedDescription3: entry.RequestedDescription3,
          HasRequestedDescription3: entry.hasRequestedDescription3,
          RequestedQuantity: entry.RequestedQuantity,
          HasRequestedQuantity: entry.hasRequestedQuantity,
          IsCategory: entry.hasIsCategory ? entry.IsCategory : null,
          HasIsCategory: entry.hasIsCategory,
          IsPrintable: entry.hasIsPrintable ? entry.IsPrintable : null,
          HasIsPrintable: entry.hasIsPrintable,
          IsComment: entry.hasIsComment ? entry.IsComment : null,
          HasIsComment: entry.hasIsComment,
          IsOption: entry.hasIsOption ? entry.IsOption : null,
          HasIsOption: entry.hasIsOption,
          PartNumber: entry.hasPartNumber ? entry.PartNumber : null,
          HasPartNumber: entry.hasPartNumber,
          ModelNumber: entry.hasModelNumber ? entry.ModelNumber : null,
          HasModelNumber: entry.hasModelNumber,
          Installation: entry.hasInstallation ? entry.Installation : null,
          HasInstallation: entry.hasInstallation,
          ElInstalation: entry.hasElInstalation ? entry.ElInstalation : null,
          HasElInstalation: entry.hasElInstalation,
          Commissioning: entry.hasCommissioning ? entry.Commissioning : null,
          HasCommissioning: entry.hasCommissioning,
        });
      });

      if (errors.length > 0) {
        return NextResponse.json({ ok: false, error: errors[0] ?? 'Invalid update payload' }, { status: 400 });
      }

      if (pendingRows.length === 0) continue;

      pendingRows.forEach((row) => {
        resolvedRows.push({
          OfferDetailID: row.OfferDetailID,
          CustomerDiscount: row.CustomerDiscount,
          AdditionalCustomerDiscount: row.AdditionalCustomerDiscount,
          TelmacoDiscount: row.TelmacoDiscount,
          NetUnitPrice: row.NetUnitPrice,
          NetCost: row.NetCost,
          Margin: row.Margin,
          ListPrice: row.EffectiveListPrice,
          NetCostOtherCurrency: row.NetCostOtherCurrency,
          OtherCurrencyID: row.OtherCurrencyID,
          CurrencyCostModifier: row.CurrencyCostModifier,
          Quantity: row.Quantity,
          TotalPrice: row.TotalPrice,
          TotalNet: row.TotalNet,
          TotalCost: row.TotalCost,
          GrossProfit: row.GrossProfit,
        });
      });

      const decimalType = getDecimalType();
      const UPDATE_PARAMS_PER_ROW = 63;
      const UPDATE_BASE_PARAMS = 2;
      const updateChunkSize = Math.max(1, Math.floor((2100 - UPDATE_BASE_PARAMS) / UPDATE_PARAMS_PER_ROW));

      for (let updateIdx = 0; updateIdx < pendingRows.length; updateIdx += updateChunkSize) {
      const updateChunk = pendingRows.slice(updateIdx, updateIdx + updateChunkSize);
      if (updateChunk.length === 0) continue;

      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      request.input('__modifiedBy', sql.Int, audit.userId);
      const valueClauses: string[] = [];

      updateChunk.forEach((row, rowIdx) => {
        const idParam = `odid_${rowIdx}`;
        const productDescriptionParam = `productDescription_${rowIdx}`;
        const hasProductDescriptionParam = `hasProductDescription_${rowIdx}`;
        const commentParam = `comment_${rowIdx}`;
        const hasCommentParam = `hasComment_${rowIdx}`;
        const deliveryParam = `delivery_${rowIdx}`;
        const hasDeliveryParam = `hasDelivery_${rowIdx}`;
        const quantityParam = `quantity_${rowIdx}`;
        const hasQuantityParam = `hasQuantity_${rowIdx}`;
        const customerDiscountParam = `customerDiscount_${rowIdx}`;
        const additionalCustomerDiscountParam = `additionalCustomerDiscount_${rowIdx}`;
        const telmacoDiscountParam = `telmacoDiscount_${rowIdx}`;
        const netUnitPriceParam = `netUnitPrice_${rowIdx}`;
        const netCostOtherCurrencyParam = `netCostOtherCurrency_${rowIdx}`;
        const hasNetCostOtherCurrencyParam = `hasNetCostOtherCurrency_${rowIdx}`;
        const otherCurrencyIdParam = `otherCurrencyId_${rowIdx}`;
        const hasOtherCurrencyIdParam = `hasOtherCurrencyId_${rowIdx}`;
        const currencyCostModifierParam = `currencyCostModifier_${rowIdx}`;
        const hasCurrencyCostModifierParam = `hasCurrencyCostModifier_${rowIdx}`;
        const netCostParam = `netCost_${rowIdx}`;
        const marginParam = `margin_${rowIdx}`;
        const totalPriceParam = `totalPrice_${rowIdx}`;
        const totalNetParam = `totalNet_${rowIdx}`;
        const totalCostParam = `totalCost_${rowIdx}`;
        const grossProfitParam = `grossProfit_${rowIdx}`;
        const listPriceParam = `listPrice_${rowIdx}`;
        const hasListPriceParam = `hasListPrice_${rowIdx}`;
        const isCategoryParam = `isCategory_${rowIdx}`;
        const hasIsCategoryParam = `hasIsCategory_${rowIdx}`;
        const isPrintableParam = `isPrintable_${rowIdx}`;
        const hasIsPrintableParam = `hasIsPrintable_${rowIdx}`;
        const isCommentParam = `isComment_${rowIdx}`;
        const hasIsCommentParam = `hasIsComment_${rowIdx}`;
        const isOptionParam = `isOption_${rowIdx}`;
        const hasIsOptionParam = `hasIsOption_${rowIdx}`;
        const requestedItemNoParam = `requestedItemNo_${rowIdx}`;
        const hasRequestedItemNoParam = `hasRequestedItemNo_${rowIdx}`;
        const requestedBrandParam = `requestedBrand_${rowIdx}`;
        const hasRequestedBrandParam = `hasRequestedBrand_${rowIdx}`;
        const requestedModelNoParam = `requestedModelNo_${rowIdx}`;
        const hasRequestedModelNoParam = `hasRequestedModelNo_${rowIdx}`;
        const requestedPartNoParam = `requestedPartNo_${rowIdx}`;
        const hasRequestedPartNoParam = `hasRequestedPartNo_${rowIdx}`;
        const requestedWebLinkParam = `requestedWebLink_${rowIdx}`;
        const hasRequestedWebLinkParam = `hasRequestedWebLink_${rowIdx}`;
        const requestedDescriptionParam = `requestedDescription_${rowIdx}`;
        const hasRequestedDescriptionParam = `hasRequestedDescription_${rowIdx}`;
        const requestedDescription2Param = `requestedDescription2_${rowIdx}`;
        const hasRequestedDescription2Param = `hasRequestedDescription2_${rowIdx}`;
        const requestedDescription3Param = `requestedDescription3_${rowIdx}`;
        const hasRequestedDescription3Param = `hasRequestedDescription3_${rowIdx}`;
        const requestedQuantityParam = `requestedQuantity_${rowIdx}`;
        const hasRequestedQuantityParam = `hasRequestedQuantity_${rowIdx}`;
        request.input(idParam, sql.Int, row.OfferDetailID);
        request.input(
          productDescriptionParam,
          sql.NVarChar(4000),
          row.HasProductDescription ? row.ProductDescription : null,
        );
        request.input(
          hasProductDescriptionParam,
          sql.Bit,
          row.HasProductDescription ? 1 : 0,
        );
        request.input(commentParam, sql.NVarChar(4000), row.HasComment ? row.Comment : null);
        request.input(hasCommentParam, sql.Bit, row.HasComment ? 1 : 0);
        request.input(deliveryParam, sql.NVarChar(4000), row.HasDelivery ? row.Delivery : null);
        request.input(hasDeliveryParam, sql.Bit, row.HasDelivery ? 1 : 0);
        request.input(quantityParam, decimalType, row.Quantity);
        request.input(hasQuantityParam, sql.Bit, row.HasQuantity ? 1 : 0);
        request.input(customerDiscountParam, decimalType, row.CustomerDiscount);
        request.input(additionalCustomerDiscountParam, decimalType, row.AdditionalCustomerDiscount);
        request.input(telmacoDiscountParam, decimalType, row.TelmacoDiscount);
        request.input(netUnitPriceParam, decimalType, row.NetUnitPrice);
        request.input(netCostOtherCurrencyParam, decimalType, row.NetCostOtherCurrency);
        request.input(hasNetCostOtherCurrencyParam, sql.Bit, row.HasNetCostOtherCurrency ? 1 : 0);
        request.input(otherCurrencyIdParam, sql.Int, row.OtherCurrencyID);
        request.input(hasOtherCurrencyIdParam, sql.Bit, row.HasOtherCurrencyID ? 1 : 0);
        request.input(currencyCostModifierParam, decimalType, row.CurrencyCostModifier);
        request.input(hasCurrencyCostModifierParam, sql.Bit, row.HasCurrencyCostModifier ? 1 : 0);
        request.input(netCostParam, decimalType, row.NetCost);
        request.input(marginParam, decimalType, row.Margin);
        request.input(totalPriceParam, decimalType, row.TotalPrice);
        request.input(totalNetParam, decimalType, row.TotalNet);
        request.input(totalCostParam, decimalType, row.TotalCost);
        request.input(grossProfitParam, decimalType, row.GrossProfit);
        request.input(listPriceParam, decimalType, row.HasListPrice ? row.ListPrice : null);
        request.input(hasListPriceParam, sql.Bit, row.HasListPrice ? 1 : 0);
        request.input(requestedItemNoParam, sql.NVarChar(400), row.HasRequestedItemNo ? row.RequestedItemNo : null);
        request.input(hasRequestedItemNoParam, sql.Bit, row.HasRequestedItemNo ? 1 : 0);
        request.input(requestedBrandParam, sql.NVarChar(400), row.HasRequestedBrand ? row.RequestedBrand : null);
        request.input(hasRequestedBrandParam, sql.Bit, row.HasRequestedBrand ? 1 : 0);
        request.input(requestedModelNoParam, sql.NVarChar(400), row.HasRequestedModelNo ? row.RequestedModelNo : null);
        request.input(hasRequestedModelNoParam, sql.Bit, row.HasRequestedModelNo ? 1 : 0);
        request.input(requestedPartNoParam, sql.NVarChar(400), row.HasRequestedPartNo ? row.RequestedPartNo : null);
        request.input(hasRequestedPartNoParam, sql.Bit, row.HasRequestedPartNo ? 1 : 0);
        request.input(requestedWebLinkParam, sql.NVarChar(4000), row.HasRequestedWebLink ? row.RequestedWebLink : null);
        request.input(hasRequestedWebLinkParam, sql.Bit, row.HasRequestedWebLink ? 1 : 0);
        request.input(requestedDescriptionParam, sql.NVarChar(4000), row.HasRequestedDescription ? row.RequestedDescription : null);
        request.input(hasRequestedDescriptionParam, sql.Bit, row.HasRequestedDescription ? 1 : 0);
        request.input(requestedDescription2Param, sql.NVarChar(4000), row.HasRequestedDescription2 ? row.RequestedDescription2 : null);
        request.input(hasRequestedDescription2Param, sql.Bit, row.HasRequestedDescription2 ? 1 : 0);
        request.input(requestedDescription3Param, sql.NVarChar(4000), row.HasRequestedDescription3 ? row.RequestedDescription3 : null);
        request.input(hasRequestedDescription3Param, sql.Bit, row.HasRequestedDescription3 ? 1 : 0);
        request.input(requestedQuantityParam, decimalType, row.RequestedQuantity);
        request.input(hasRequestedQuantityParam, sql.Bit, row.HasRequestedQuantity ? 1 : 0);
        request.input(
          isCategoryParam,
          sql.Bit,
          row.HasIsCategory ? (row.IsCategory == null ? null : (row.IsCategory ? 1 : 0)) : null,
        );
        request.input(hasIsCategoryParam, sql.Bit, row.HasIsCategory ? 1 : 0);
        request.input(
          isPrintableParam,
          sql.Bit,
          row.HasIsPrintable ? (row.IsPrintable == null ? null : (row.IsPrintable ? 1 : 0)) : null,
        );
        request.input(hasIsPrintableParam, sql.Bit, row.HasIsPrintable ? 1 : 0);
        request.input(
          isCommentParam,
          sql.Bit,
          row.HasIsComment ? (row.IsComment == null ? null : (row.IsComment ? 1 : 0)) : null,
        );
        request.input(hasIsCommentParam, sql.Bit, row.HasIsComment ? 1 : 0);
        request.input(
          isOptionParam,
          sql.Bit,
          row.HasIsOption ? (row.IsOption == null ? null : (row.IsOption ? 1 : 0)) : null,
        );
        request.input(hasIsOptionParam, sql.Bit, row.HasIsOption ? 1 : 0);
        const partNumberParam = `partNumber_${rowIdx}`;
        const hasPartNumberParam = `hasPartNumber_${rowIdx}`;
        const modelNumberParam = `modelNumber_${rowIdx}`;
        const hasModelNumberParam = `hasModelNumber_${rowIdx}`;
        request.input(partNumberParam, sql.NVarChar(400), row.HasPartNumber ? row.PartNumber : null);
        request.input(hasPartNumberParam, sql.Bit, row.HasPartNumber ? 1 : 0);
        request.input(modelNumberParam, sql.NVarChar(400), row.HasModelNumber ? row.ModelNumber : null);
        request.input(hasModelNumberParam, sql.Bit, row.HasModelNumber ? 1 : 0);
        const installationParam = `installation_${rowIdx}`;
        const hasInstallationParam = `hasInstallation_${rowIdx}`;
        const elInstalationParam = `elInstalation_${rowIdx}`;
        const hasElInstalationParam = `hasElInstalation_${rowIdx}`;
        const commissioningParam = `commissioning_${rowIdx}`;
        const hasCommissioningParam = `hasCommissioning_${rowIdx}`;
        request.input(installationParam, decimalType, row.HasInstallation ? row.Installation : null);
        request.input(hasInstallationParam, sql.Bit, row.HasInstallation ? 1 : 0);
        request.input(elInstalationParam, decimalType, row.HasElInstalation ? row.ElInstalation : null);
        request.input(hasElInstalationParam, sql.Bit, row.HasElInstalation ? 1 : 0);
        request.input(commissioningParam, decimalType, row.HasCommissioning ? row.Commissioning : null);
        request.input(hasCommissioningParam, sql.Bit, row.HasCommissioning ? 1 : 0);
        valueClauses.push(`(@${idParam}, @${productDescriptionParam}, @${hasProductDescriptionParam}, @${commentParam}, @${hasCommentParam}, @${deliveryParam}, @${hasDeliveryParam}, @${quantityParam}, @${hasQuantityParam}, @${customerDiscountParam}, @${additionalCustomerDiscountParam}, @${telmacoDiscountParam}, @${netUnitPriceParam}, @${netCostOtherCurrencyParam}, @${hasNetCostOtherCurrencyParam}, @${otherCurrencyIdParam}, @${hasOtherCurrencyIdParam}, @${currencyCostModifierParam}, @${hasCurrencyCostModifierParam}, @${netCostParam}, @${marginParam}, @${totalPriceParam}, @${totalNetParam}, @${totalCostParam}, @${grossProfitParam}, @${listPriceParam}, @${hasListPriceParam}, @${requestedItemNoParam}, @${hasRequestedItemNoParam}, @${requestedBrandParam}, @${hasRequestedBrandParam}, @${requestedModelNoParam}, @${hasRequestedModelNoParam}, @${requestedPartNoParam}, @${hasRequestedPartNoParam}, @${requestedWebLinkParam}, @${hasRequestedWebLinkParam}, @${requestedDescriptionParam}, @${hasRequestedDescriptionParam}, @${requestedDescription2Param}, @${hasRequestedDescription2Param}, @${requestedDescription3Param}, @${hasRequestedDescription3Param}, @${requestedQuantityParam}, @${hasRequestedQuantityParam}, @${isCategoryParam}, @${hasIsCategoryParam}, @${isPrintableParam}, @${hasIsPrintableParam}, @${isCommentParam}, @${hasIsCommentParam}, @${isOptionParam}, @${hasIsOptionParam}, @${partNumberParam}, @${hasPartNumberParam}, @${modelNumberParam}, @${hasModelNumberParam}, @${installationParam}, @${hasInstallationParam}, @${elInstalationParam}, @${hasElInstalationParam}, @${commissioningParam}, @${hasCommissioningParam})`);
      });

      const query = `
        WITH PendingUpdates (
          OfferDetailID,
          ProductDescription,
          HasProductDescription,
          Comment,
          HasComment,
          Delivery,
          HasDelivery,
          Quantity,
          HasQuantity,
          CustomerDiscount,
          AdditionalCustomerDiscount,
          TelmacoDiscount,
          NetUnitPrice,
          NetCostOtherCurrency,
          HasNetCostOtherCurrency,
          OtherCurrencyID,
          HasOtherCurrencyID,
          CurrencyCostModifier,
          HasCurrencyCostModifier,
          NetCost,
          Margin,
          TotalPrice,
          TotalNet,
          TotalCost,
          GrossProfit,
          ListPrice,
          HasListPrice,
          RequestedItemNo,
          HasRequestedItemNo,
          RequestedBrand,
          HasRequestedBrand,
          RequestedModelNo,
          HasRequestedModelNo,
          RequestedPartNo,
          HasRequestedPartNo,
          RequestedWebLink,
          HasRequestedWebLink,
          RequestedDescription,
          HasRequestedDescription,
          RequestedDescription2,
          HasRequestedDescription2,
          RequestedDescription3,
          HasRequestedDescription3,
          RequestedQuantity,
          HasRequestedQuantity,
          IsCategory,
          HasIsCategory,
          IsPrintable,
          HasIsPrintable,
          IsComment,
          HasIsComment,
          IsOption,
          HasIsOption,
          PartNumber,
          HasPartNumber,
          ModelNumber,
          HasModelNumber,
          Installation,
          HasInstallation,
          ElInstalation,
          HasElInstalation,
          Commissioning,
          HasCommissioning
        ) AS (
          SELECT *
          FROM (VALUES ${valueClauses.join(', ')}) AS v (
            OfferDetailID,
            ProductDescription,
            HasProductDescription,
            Comment,
            HasComment,
            Delivery,
            HasDelivery,
            Quantity,
            HasQuantity,
            CustomerDiscount,
            AdditionalCustomerDiscount,
            TelmacoDiscount,
            NetUnitPrice,
            NetCostOtherCurrency,
            HasNetCostOtherCurrency,
            OtherCurrencyID,
            HasOtherCurrencyID,
            CurrencyCostModifier,
            HasCurrencyCostModifier,
            NetCost,
            Margin,
            TotalPrice,
            TotalNet,
            TotalCost,
            GrossProfit,
            ListPrice,
            HasListPrice,
            RequestedItemNo,
            HasRequestedItemNo,
            RequestedBrand,
            HasRequestedBrand,
            RequestedModelNo,
            HasRequestedModelNo,
            RequestedPartNo,
            HasRequestedPartNo,
            RequestedWebLink,
            HasRequestedWebLink,
          RequestedDescription,
          HasRequestedDescription,
          RequestedDescription2,
          HasRequestedDescription2,
          RequestedDescription3,
          HasRequestedDescription3,
          RequestedQuantity,
            HasRequestedQuantity,
            IsCategory,
            HasIsCategory,
            IsPrintable,
            HasIsPrintable,
            IsComment,
            HasIsComment,
            IsOption,
            HasIsOption,
            PartNumber,
            HasPartNumber,
            ModelNumber,
            HasModelNumber,
            Installation,
            HasInstallation,
            ElInstalation,
            HasElInstalation,
            Commissioning,
            HasCommissioning
          )
        )
        UPDATE od
        SET od.ProductDescription = CASE WHEN PendingUpdates.HasProductDescription = 1 THEN PendingUpdates.ProductDescription ELSE od.ProductDescription END,
            od.[Comment] = CASE WHEN PendingUpdates.HasComment = 1 THEN PendingUpdates.Comment ELSE od.[Comment] END,
            od.Delivery = CASE WHEN PendingUpdates.HasDelivery = 1 THEN PendingUpdates.Delivery ELSE od.Delivery END,
            od.Quantity = CASE WHEN PendingUpdates.HasQuantity = 1 THEN PendingUpdates.Quantity ELSE od.Quantity END,
            od.CustomerDiscount = PendingUpdates.CustomerDiscount,
            od.AdditionalCustomerDiscount = PendingUpdates.AdditionalCustomerDiscount,
            od.TelmacoDiscount = PendingUpdates.TelmacoDiscount,
            od.NetUnitPrice = PendingUpdates.NetUnitPrice,
            od.NetCostOtherCurrency = CASE WHEN PendingUpdates.HasNetCostOtherCurrency = 1 THEN PendingUpdates.NetCostOtherCurrency ELSE od.NetCostOtherCurrency END,
            od.OtherCurrencyID = CASE WHEN PendingUpdates.HasOtherCurrencyID = 1 THEN PendingUpdates.OtherCurrencyID ELSE od.OtherCurrencyID END,
            od.CurrencyCostModifier = CASE WHEN PendingUpdates.HasCurrencyCostModifier = 1 THEN PendingUpdates.CurrencyCostModifier ELSE od.CurrencyCostModifier END,
            od.NetCost = PendingUpdates.NetCost,
            od.Margin = PendingUpdates.Margin,
            od.TotalPrice = PendingUpdates.TotalPrice,
            od.TotalNet = PendingUpdates.TotalNet,
            od.TotalCost = PendingUpdates.TotalCost,
            od.GrossProfit = PendingUpdates.GrossProfit,
            od.ListPrice = CASE WHEN PendingUpdates.HasListPrice = 1 THEN PendingUpdates.ListPrice ELSE od.ListPrice END,
            od.RequestedItemNo = CASE WHEN PendingUpdates.HasRequestedItemNo = 1 THEN PendingUpdates.RequestedItemNo ELSE od.RequestedItemNo END,
            od.RequestedBrand = CASE WHEN PendingUpdates.HasRequestedBrand = 1 THEN PendingUpdates.RequestedBrand ELSE od.RequestedBrand END,
            od.RequestedModelNo = CASE WHEN PendingUpdates.HasRequestedModelNo = 1 THEN PendingUpdates.RequestedModelNo ELSE od.RequestedModelNo END,
            od.RequestedPartNo = CASE WHEN PendingUpdates.HasRequestedPartNo = 1 THEN PendingUpdates.RequestedPartNo ELSE od.RequestedPartNo END,
            od.RequestedWebLink = CASE WHEN PendingUpdates.HasRequestedWebLink = 1 THEN PendingUpdates.RequestedWebLink ELSE od.RequestedWebLink END,
            od.RequestedDescription = CASE WHEN PendingUpdates.HasRequestedDescription = 1 THEN PendingUpdates.RequestedDescription ELSE od.RequestedDescription END,
            od.RequestedDescription2 = CASE WHEN PendingUpdates.HasRequestedDescription2 = 1 THEN PendingUpdates.RequestedDescription2 ELSE od.RequestedDescription2 END,
            od.RequestedDescription3 = CASE WHEN PendingUpdates.HasRequestedDescription3 = 1 THEN PendingUpdates.RequestedDescription3 ELSE od.RequestedDescription3 END,
            od.RequestedQuantity = CASE WHEN PendingUpdates.HasRequestedQuantity = 1 THEN PendingUpdates.RequestedQuantity ELSE od.RequestedQuantity END,
            od.IsCategory = CASE WHEN PendingUpdates.HasIsCategory = 1 THEN PendingUpdates.IsCategory ELSE od.IsCategory END,
            od.IsPrintable = CASE WHEN PendingUpdates.HasIsPrintable = 1 THEN PendingUpdates.IsPrintable ELSE od.IsPrintable END,
            od.IsComment = CASE WHEN PendingUpdates.HasIsComment = 1 THEN PendingUpdates.IsComment ELSE od.IsComment END,
            od.IsOption = CASE WHEN PendingUpdates.HasIsOption = 1 THEN PendingUpdates.IsOption ELSE od.IsOption END,
            od.PartNumber = CASE WHEN PendingUpdates.HasPartNumber = 1 THEN PendingUpdates.PartNumber ELSE od.PartNumber END,
            od.ModelNumber = CASE WHEN PendingUpdates.HasModelNumber = 1 THEN PendingUpdates.ModelNumber ELSE od.ModelNumber END,
            od.Installation = CASE WHEN PendingUpdates.HasInstallation = 1 THEN PendingUpdates.Installation ELSE od.Installation END,
            od.ElInstalation = CASE WHEN PendingUpdates.HasElInstalation = 1 THEN PendingUpdates.ElInstalation ELSE od.ElInstalation END,
            od.Commissioning = CASE WHEN PendingUpdates.HasCommissioning = 1 THEN PendingUpdates.Commissioning ELSE od.Commissioning END,
            od.ModifiedOn = SYSUTCDATETIME(),
            od.ModifiedBy = @__modifiedBy
        FROM dbo.OfferDetails od
          INNER JOIN PendingUpdates ON od.ID = PendingUpdates.OfferDetailID
        WHERE od.OfferID = @__offerId;
      `;

      const result = await request.query(query);
      affected += result.rowsAffected?.[0] ?? 0;
      } // end updateChunk loop
    }

    // Emit realtime events for updated rows. Use resolvedRows so derived fields
    // (NetUnitPrice, Margin, totals) recomputed server-side are broadcast too,
    // not just the raw field(s) the user edited.
    if (resolvedRows.length > 0 && affected > 0) {
      const broadcastFields = [
        'CustomerDiscount',
        'AdditionalCustomerDiscount',
        'TelmacoDiscount',
        'NetUnitPrice',
        'NetCost',
        'Margin',
        'ListPrice',
        'Quantity',
        'TotalPrice',
        'TotalNet',
        'TotalCost',
        'GrossProfit',
      ] as const;
      for (const row of resolvedRows) {
        for (const field of broadcastFields) {
          realtimeEvents.emit(
            `offer:${offerId}:products`,
            'cell-updated',
            {
              rowId: row.OfferDetailID,
              OfferDetailID: row.OfferDetailID,
              field,
              value: row[field as keyof typeof row] ?? null,
              updatedBy: audit.userId,
            },
          );
        }
      }
    }

    if (affected > 0) {
      for (const entry of normalizedUpdates) {
        const hourFields: Array<{ has: boolean; field: 'Installation' | 'ElInstalation' | 'Commissioning'; value: number | null }> = [
          { has: entry.hasInstallation, field: 'Installation', value: entry.Installation },
          { has: entry.hasElInstalation, field: 'ElInstalation', value: entry.ElInstalation },
          { has: entry.hasCommissioning, field: 'Commissioning', value: entry.Commissioning },
        ];
        for (const { has, field, value } of hourFields) {
          if (!has) continue;
          realtimeEvents.emit(
            `offer:${offerId}:products`,
            'cell-updated',
            {
              rowId: entry.OfferDetailID,
              OfferDetailID: entry.OfferDetailID,
              field,
              value,
              updatedBy: audit.userId,
            },
          );
        }
      }
    }

    if (affected > 0) {
      const changes: FieldChange[] = [];
      normalizedUpdates.forEach((entry) => {
        const addChange = (field: string, after: unknown) => {
          changes.push({ targetId: entry.OfferDetailID, field, before: null, after });
        };
        if (entry.hasProductDescription) addChange('ProductDescription', entry.ProductDescription);
        if (entry.hasComment) addChange('Comment', entry.Comment);
        if (entry.hasDelivery) addChange('Delivery', entry.Delivery);
        if (entry.hasQuantity) addChange('Quantity', entry.Quantity);
        if (entry.hasCustomerDiscount) addChange('CustomerDiscount', entry.customerDiscount);
        if (entry.hasAdditionalCustomerDiscount) addChange('AdditionalCustomerDiscount', entry.additionalCustomerDiscount);
        if (entry.hasTelmacoDiscount) addChange('TelmacoDiscount', entry.telmacoDiscount);
        if (entry.hasNetUnitPrice) addChange('NetUnitPrice', entry.netUnitPrice);
        if (entry.hasNetCostOtherCurrency) addChange('NetCostOtherCurrency', entry.netCostOtherCurrency);
        if (entry.hasOtherCurrencyID) addChange('OtherCurrencyID', entry.otherCurrencyId);
        if (entry.hasCurrencyCostModifier) addChange('CurrencyCostModifier', entry.currencyCostModifier);
        if (entry.hasNetCost) addChange('NetCost', entry.netCost);
        if (entry.hasMargin) addChange('Margin', entry.margin);
        if (entry.hasListPrice) addChange('ListPrice', entry.listPrice);
        if (entry.hasIsCategory) addChange('IsCategory', entry.IsCategory);
        if (entry.hasIsPrintable) addChange('IsPrintable', entry.IsPrintable);
        if (entry.hasIsComment) addChange('IsComment', entry.IsComment);
        if (entry.hasRequestedItemNo) addChange('RequestedItemNo', entry.requestedItemNo);
        if (entry.hasRequestedBrand) addChange('RequestedBrand', entry.RequestedBrand);
        if (entry.hasRequestedModelNo) addChange('RequestedModelNo', entry.RequestedModelNo);
        if (entry.hasRequestedPartNo) addChange('RequestedPartNo', entry.RequestedPartNo);
        if (entry.hasRequestedWebLink) addChange('RequestedWebLink', entry.RequestedWebLink);
        if (entry.hasRequestedDescription) addChange('RequestedDescription', entry.RequestedDescription);
        if (entry.hasRequestedDescription2) addChange('RequestedDescription2', entry.RequestedDescription2);
        if (entry.hasRequestedDescription3) addChange('RequestedDescription3', entry.RequestedDescription3);
        if (entry.hasRequestedQuantity) addChange('RequestedQuantity', entry.RequestedQuantity);
        if (entry.hasPartNumber) addChange('PartNumber', entry.PartNumber);
        if (entry.hasModelNumber) addChange('ModelNumber', entry.ModelNumber);
        if (entry.hasInstallation) addChange('Installation', entry.Installation);
        if (entry.hasElInstalation) addChange('ElInstalation', entry.ElInstalation);
        if (entry.hasCommissioning) addChange('Commissioning', entry.Commissioning);
      });
      if (changes.length > 0) {
        logEditAuditDetails({
          endpoint: `/api/offers/${offerId}/products`,
          method: 'PATCH',
          requestId,
          userId: audit.userId,
          targetEntity: 'offerProducts',
          targetIds: Array.from(new Set(changes.map((c) => c.targetId))),
          changes,
          message: `Offer products updated for offer ${offerId}`,
          extra: { offerId },
        });
      }
    }

    return NextResponse.json({
      ok: true,
      updated: normalizedUpdates.length,
      rowsAffected: affected,
      resolvedRows,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products');
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    const audit = buildAuditContext(req);
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    let body: DeleteRowRequest | null = null;
    try {
      body = (await req.json()) as DeleteRowRequest;
    } catch {
      body = null;
    }

    const rawIds = body && Array.isArray(body.OfferDetailIDs) ? body.OfferDetailIDs : [];
    const normalizedIds = Array.from(new Set(
      rawIds
        .map((value) => normalizeOfferDetailId(value ?? null))
        .filter((value): value is number => value != null)
    ));

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No rows selected for deletion' }, { status: 400 });
    }

    const pool = await getPool();

    // Check if the current user is the offer creator (offer-level check)
    const offerCreatorReq = pool.request();
    offerCreatorReq.input('__offerId', sql.Int, offerId);
    offerCreatorReq.input('__userId', sql.NVarChar, auth.userId);
    const offerCreatorResult = await offerCreatorReq.query<{ IsOfferCreator: number }>(`
      SELECT CASE WHEN CreatedBy = @__userId THEN 1 ELSE 0 END AS IsOfferCreator
      FROM dbo.Offer
      WHERE ID = @__offerId
    `);
    const isOfferCreator = offerCreatorResult.recordset?.[0]?.IsOfferCreator === 1;

    // Also check per-product creator as fallback
    const creatorCheckReq = pool.request();
    creatorCheckReq.input('__creatorUserId', sql.NVarChar, auth.userId);
    const creatorParamNames: string[] = [];
    normalizedIds.forEach((id, idx) => {
      const paramName = `__crDet_${idx}`;
      creatorCheckReq.input(paramName, sql.Int, id);
      creatorParamNames.push(`@${paramName}`);
    });
    const creatorResult = await creatorCheckReq.query<{ Total: number; CreatedByUser: number }>(`
      SELECT
        COUNT(1) AS Total,
        SUM(CASE WHEN CreatedBy = @__creatorUserId THEN 1 ELSE 0 END) AS CreatedByUser
      FROM dbo.OfferDetails
      WHERE ID IN (${creatorParamNames.join(', ')})
    `);
    const creatorRow = creatorResult.recordset[0];
    const isProductCreator = creatorRow != null && creatorRow.Total > 0 && creatorRow.Total === creatorRow.CreatedByUser;
    const isCreator = isOfferCreator || isProductCreator;

    const deleteCheck = checkDeletePermission(auth.roles, normalizedIds.length, 'offerProducts', null, { isCreator });
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }
    const chunkSize = 200;
    let deleted = 0;
    const allDeletedRows: Record<string, unknown>[] = [];

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;

      // Pre-fetch rows that will be deleted
      const prefetchReq = pool.request();
      prefetchReq.input('__offerId', sql.Int, offerId);
      const prefetchParamNames: string[] = [];
      chunk.forEach((id, chunkIdx) => {
        const paramName = `pf_${chunkIdx}`;
        prefetchReq.input(paramName, sql.Int, id);
        prefetchParamNames.push(`@${paramName}`);
      });
      const prefetchResult = await prefetchReq.query<Record<string, unknown>>(`
        SELECT od.*
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
          AND od.ID IN (${prefetchParamNames.join(', ')})
      `);
      allDeletedRows.push(...(prefetchResult.recordset ?? []));

      // Promote children of deleted rows before deleting the parents.
      // 1) Reassign ParentOfferDetailID so FK CASCADE doesn't delete children.
      //    This is done via a single UPDATE that joins to the parent row to get
      //    the grandparent ID — no dependency on TreeOrdering.
      // 2) Update TreeOrdering so children move up one level.
      //    resequenceTreeOrdering will clean up numbering afterwards.
      const reparentReq = pool.request();
      reparentReq.input('__offerId', sql.Int, offerId);
      reparentReq.input('__modifiedBy', sql.Int, audit.userId);
      const reparentChunkParamNames: string[] = [];
      chunk.forEach((id, chunkIdx) => {
        const paramName = `rp_${chunkIdx}`;
        reparentReq.input(paramName, sql.Int, id);
        reparentChunkParamNames.push(`@${paramName}`);
      });
      await reparentReq.query(`
        UPDATE child
        SET child.ParentOfferDetailID = parent.ParentOfferDetailID,
            child.ModifiedOn = SYSUTCDATETIME(),
            child.ModifiedBy = @__modifiedBy
        FROM dbo.OfferDetails child
        INNER JOIN dbo.OfferDetails parent ON child.ParentOfferDetailID = parent.ID
        WHERE parent.OfferID = @__offerId
          AND parent.ID IN (${reparentChunkParamNames.join(', ')})
          AND child.ID NOT IN (${reparentChunkParamNames.join(', ')})
      `);

      // Update TreeOrdering: children inherit the deleted parent's position.
      // Direct child "11.1" → "11" (takes parent's slot).
      // Grandchild "11.1.3" → "11.3" (stays nested under promoted child).
      // resequenceTreeOrdering will clean up numbering afterwards.
      for (const deletedRow of prefetchResult.recordset ?? []) {
        const rawTO = (deletedRow as Record<string, unknown>).TreeOrdering;
        if (rawTO == null) continue;
        const toStr = String(rawTO).trim();
        if (!toStr) continue;
        const parentPrefix = toStr + '.';
        const promoteReq = pool.request();
        promoteReq.input('__offerId', sql.Int, offerId);
        promoteReq.input('__parentPrefix', sql.NVarChar, parentPrefix);
        promoteReq.input('__parentPrefixLen', sql.Int, parentPrefix.length);
        promoteReq.input('__parentTO', sql.NVarChar, toStr);
        promoteReq.input('__modifiedBy', sql.Int, audit.userId);
        const excludeParamNames: string[] = [];
        chunk.forEach((id, chunkIdx) => {
          const paramName = `exc_${chunkIdx}`;
          promoteReq.input(paramName, sql.Int, id);
          excludeParamNames.push(`@${paramName}`);
        });
        await promoteReq.query(`
          UPDATE od
          SET od.TreeOrdering =
              CASE
                WHEN CHARINDEX('.', rel.val) > 0
                THEN @__parentTO + '.' + SUBSTRING(rel.val, CHARINDEX('.', rel.val) + 1, LEN(rel.val))
                ELSE @__parentTO
              END,
              od.ModifiedOn = SYSUTCDATETIME(),
              od.ModifiedBy = @__modifiedBy
          FROM dbo.OfferDetails od
          CROSS APPLY (
            SELECT SUBSTRING(LTRIM(RTRIM(od.TreeOrdering)), @__parentPrefixLen + 1, LEN(LTRIM(RTRIM(od.TreeOrdering)))) AS val
          ) rel
          WHERE od.OfferID = @__offerId
            AND LTRIM(RTRIM(od.TreeOrdering)) LIKE @__parentPrefix + '%'
            AND od.ID NOT IN (${excludeParamNames.join(', ')})
        `);
      }

      // Now perform the actual delete
      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      const paramNames: string[] = [];
      chunk.forEach((id, chunkIdx) => {
        const paramName = `odid_${chunkIdx}`;
        request.input(paramName, sql.Int, id);
        paramNames.push(`@${paramName}`);
      });
      const query = `
        DELETE od
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
          AND od.ID IN (${paramNames.join(', ')})
      `;
      const result = await request.query(query);
      deleted += result.rowsAffected?.[0] ?? 0;
    }

    // Emit realtime events for deleted rows
    if (normalizedIds.length > 0) {
      for (const id of normalizedIds) {
        realtimeEvents.emit(
          `offer:${offerId}:products`,
          'row-deleted',
          {
            OfferDetailID: id,
            rowId: id,
            updatedBy: audit.userId,
          }
        );
      }
    }

    const resequenced = deleted > 0
      ? await resequenceTreeOrdering(offerId, audit)
      : { updated: 0, rowsAffected: 0 };

    // Strip ID and audit columns from deleted rows for restore payload
    const deletedRowsForRestore = allDeletedRows.map((row) => {
      const { ID, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy, ...rest } = row;
      void ID; void CreatedOn; void CreatedBy; void ModifiedOn; void ModifiedBy;
      return rest;
    });

    const deletedRowsForAudit = allDeletedRows.map((row) => {
      const id = Number((row as Record<string, unknown>).ID);
      const name =
        (row as Record<string, unknown>).PartNumber
        ?? (row as Record<string, unknown>).ModelNumber
        ?? (row as Record<string, unknown>).ProductDescription
        ?? null;
      return {
        id: Number.isFinite(id) ? id : 0,
        name: typeof name === 'string' ? name.trim() || null : null,
      };
    });
    logDeleteAuditDetails({
      endpoint: `/api/offers/${offerId}/products`,
      requestId,
      userId: audit.userId,
      targetEntity: 'offerProducts',
      requestedIds: normalizedIds,
      deletedRows: deletedRowsForAudit,
      message: `Offer products deleted from offer ${offerId}`,
      extra: { offerId },
    });

    return NextResponse.json({
      ok: true,
      deleted,
      resequenced: resequenced.updated,
      resequencedRowsAffected: resequenced.rowsAffected,
      deletedRows: deletedRowsForRestore,
    });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
