import { NextRequest, NextResponse } from 'next/server';
import sql, { ConnectionPool } from 'mssql';
import { buildAuditContext, type AuditContext } from '../../../../../lib/auditTrail';
import { getPool } from '../../../../../lib/sql';
import { buildQuickFilterClause, mergeWhereClauses, QueryParam } from '../../../../../lib/gridFilters';
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

type TextFilterModel = {
  filterType: 'text';
  type?: 'contains' | 'equals' | 'notEqual' | 'startsWith' | 'endsWith';
  filter?: string;
};

type NumberFilterModel = {
  filterType: 'number';
  type?:
    | 'equals'
    | 'notEqual'
    | 'lessThan'
    | 'greaterThan'
    | 'lessThanOrEqual'
    | 'greaterThanOrEqual'
    | 'inRange';
  filter?: number;
  filterTo?: number;
};

type SetFilterModel = {
  filterType: 'set';
  values?: Array<string | number | boolean>;
};

type KnownFilterModel = TextFilterModel | NumberFilterModel | SetFilterModel;

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

const TREE_ORDERING_ROOT_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    WHEN CHARINDEX('.', ${TREE_ORDERING_RAW_EXPRESSION}) > 0 THEN LEFT(${TREE_ORDERING_RAW_EXPRESSION}, CHARINDEX('.', ${TREE_ORDERING_RAW_EXPRESSION}) - 1)
    ELSE ${TREE_ORDERING_RAW_EXPRESSION}
  END
`;

const ALL_ROWS_LIMIT = 20000;

type ProductRow = {
  ProductID: number | null;
  OfferDetailID: number | null;
  ParentOfferDetailID: number | null;
  TreeOrdering: string | null;
  IsPrintable: boolean | null;
  IsComment: boolean | null;
  IsCategory: boolean | null;
  BrandName: string | null;
  PartNumber: string | null;
  ModelNumber: string | null;
  WebLink: string | null;
  Quantity: number | null;
  Description: string | null;
  CustomerDiscount: number | null;
  NetUnitPrice: number | null;
  TotalPrice: number | null;
  TotalNet: number | null;
  Warranty: string | number | null;
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
  __hasRequestedItemNo?: number | bigint | null;
  __hasRequestedBrand?: number | bigint | null;
  __hasRequestedModelNo?: number | bigint | null;
  __hasRequestedPartNo?: number | bigint | null;
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
};

type TreeOrderingUpdateRequest = {
  updates?: TreeOrderingUpdateInput[];
};

type DeleteRowRequest = {
  OfferDetailIDs?: Array<number | string | null | undefined>;
};

type DetailUpdateInput = {
  ProductDescription?: string | null;
  OfferDetailID?: number | string | null;
  Description?: string | null;
  Quantity?: number | string | null;
  CustomerDiscount?: number | string | null;
  TelmacoDiscount?: number | string | null;
  NetUnitPrice?: number | string | null;
  NetCostOtherCurrency?: number | string | null;
  OtherCurrencyID?: number | string | null;
  CurrencyCostModifier?: number | string | null;
  NetCost?: number | string | null;
  Margin?: number | string | null;
  ListPrice?: number | string | null;
  IsCategory?: boolean | null;
  RequestedItemNo?: string | null;
  RequestedBrand?: string | null;
  RequestedModelNo?: string | null;
  RequestedPartNo?: string | null;
  RequestedDescription?: string | null;
  RequestedDescription2?: string | null;
  RequestedDescription3?: string | null;
  RequestedQuantity?: number | string | null;
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
  TreeOrdering: 'od.TreeOrdering',
  IsPrintable: 'od.IsPrintable',
  IsComment: 'od.IsComment',
  IsCategory: 'od.IsCategory',
  BrandName: 'b.Name',
  PartNumber: 'p.PartNumber',
  WebLink: 'p.WebLink',
  ModelNumber: 'p.ModelNumber',
  Quantity: 'od.Quantity',
  Description: 'od.ProductDescription',
  CustomerDiscount: 'od.CustomerDiscount',
  NetUnitPrice: 'od.NetUnitPrice',
  TotalPrice: 'od.TotalPrice',
  TotalNet: 'od.TotalNet',
  Warranty: 'od.Warranty',
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
  RequestedDescription: 'od.RequestedDescription',
  RequestedDescription2: 'od.RequestedDescription2',
  RequestedDescription3: 'od.RequestedDescription3',
  RequestedQuantity: 'od.RequestedQuantity',
};
const PRODUCTS_QUICK_FILTER_COLUMNS = Object.values(COLUMN_EXPRESSIONS);
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
  const num = normalizeQuantityValue(value);
  if (num == null) return null;
  if (!allowNegative && num < 0) return null;
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

const normalizeMoneyValue = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

const roundTo = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

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

type PricingSnapshot = {
  listPrice: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netUnitPrice: number | null;
  netCost: number | null;
  margin: number | null;
};

type PricingInput = PricingSnapshot & {
  provided: {
    customerDiscount: boolean;
    telmacoDiscount: boolean;
    netUnitPrice: boolean;
    netCost: boolean;
    margin: boolean;
  };
};

type ResolvedPricing = {
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netUnitPrice: number | null;
  netCost: number | null;
  margin: number | null;
};

const percentageToFactor = (value: number) => value / 100;

const deriveMarginPercent = (netPrice: number | null, telmacoCost: number | null): number | null => {
  if (netPrice == null || telmacoCost == null) return null;
  if (Object.is(netPrice, 0)) return null;
  return roundTo((1 - (telmacoCost / netPrice)) * 100);
};

const computeScenario = (
  scenario: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H',
  lp: number,
  cd: number | null,
  td: number | null,
  np: number | null,
  tc: number | null,
  m: number | null,
): ResolvedPricing | null => {
  // All percentages are stored as percent units (e.g., 12 = 12%).
  switch (scenario) {
    case 'A': {
      if (cd == null || td == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd)));
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginPct = deriveMarginPercent(netPrice, telmacoCost);
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: netPrice, netCost: telmacoCost, margin: marginPct };
    }
    case 'B': {
      if (td == null || m == null) return null;
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginFactor = 1 - percentageToFactor(m);
      if (Object.is(marginFactor, 0)) return null;
      const netPrice = roundTo(telmacoCost / marginFactor);
      const customerDiscount = roundTo((1 - (netPrice / lp)) * 100);
      return { customerDiscount, telmacoDiscount: td, netUnitPrice: netPrice, netCost: telmacoCost, margin: m };
    }
    case 'C': {
      if (np == null || tc == null) return null;
      const customerDiscount = roundTo((1 - (np / lp)) * 100);
      const telmacoDiscount = roundTo((1 - (tc / lp)) * 100);
      const marginPct = deriveMarginPercent(np, tc);
      return { customerDiscount, telmacoDiscount, netUnitPrice: np, netCost: tc, margin: marginPct };
    }
    case 'D': {
      if (cd == null || m == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd)));
      const telmacoCost = roundTo(netPrice * (1 - percentageToFactor(m)));
      const telmacoDiscount = roundTo((1 - (telmacoCost / lp)) * 100);
      return { customerDiscount: cd, telmacoDiscount, netUnitPrice: netPrice, netCost: telmacoCost, margin: m };
    }
    case 'E': {
      if (cd == null || tc == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd)));
      const telmacoDiscount = roundTo((1 - (tc / lp)) * 100);
      const marginPct = deriveMarginPercent(netPrice, tc);
      return { customerDiscount: cd, telmacoDiscount, netUnitPrice: netPrice, netCost: tc, margin: marginPct };
    }
    case 'F': {
      if (td == null || np == null) return null;
      const customerDiscount = roundTo((1 - (np / lp)) * 100);
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginPct = deriveMarginPercent(np, telmacoCost);
      return { customerDiscount, telmacoDiscount: td, netUnitPrice: np, netCost: telmacoCost, margin: marginPct };
    }
    case 'G': {
      if (np == null || m == null) return null;
      const telmacoCost = roundTo(np * (1 - percentageToFactor(m)));
      const customerDiscount = roundTo((1 - (np / lp)) * 100);
      const telmacoDiscount = roundTo((1 - (telmacoCost / lp)) * 100);
      return { customerDiscount, telmacoDiscount, netUnitPrice: np, netCost: telmacoCost, margin: m };
    }
    case 'H': {
      if (tc == null || m == null) return null;
      const marginFactor = 1 - percentageToFactor(m);
      if (Object.is(marginFactor, 0)) return null;
      const netPrice = roundTo(tc / marginFactor);
      const customerDiscount = roundTo((1 - (netPrice / lp)) * 100);
      const telmacoDiscount = roundTo((1 - (tc / lp)) * 100);
      return { customerDiscount, telmacoDiscount, netUnitPrice: netPrice, netCost: tc, margin: m };
    }
    default:
      return null;
  }
};

const resolvePricing = (input: PricingInput): ResolvedPricing | null => {
  const lp = input.listPrice;
  if (lp == null || !Number.isFinite(lp) || Object.is(lp, 0)) return null;

  const cd = input.customerDiscount;
  const td = input.telmacoDiscount;
  const np = input.netUnitPrice;
  const tc = input.netCost;
  const m = input.margin;

  type PricingRequiredKey = keyof PricingInput['provided'];

  const scenarios: Array<{
    key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
    required: PricingRequiredKey[];
  }> = [
    { key: 'A', required: ['customerDiscount', 'telmacoDiscount'] },
    { key: 'B', required: ['telmacoDiscount', 'margin'] },
    { key: 'C', required: ['netUnitPrice', 'netCost'] },
    { key: 'D', required: ['customerDiscount', 'margin'] },
    { key: 'E', required: ['customerDiscount', 'netCost'] },
    { key: 'F', required: ['telmacoDiscount', 'netUnitPrice'] },
    { key: 'G', required: ['netUnitPrice', 'margin'] },
    { key: 'H', required: ['netCost', 'margin'] },
  ];

  const values: PricingSnapshot = { listPrice: lp, customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: m };
  const providedMap = input.provided;

  for (const scenario of scenarios) {
    const missingRequired = scenario.required.some((field) => values[field] == null);
    const hasUserInput = scenario.required.some((field) => providedMap[field]);
    if (missingRequired || !hasUserInput) continue;
    const resolved = computeScenario(
      scenario.key,
      lp,
      values.customerDiscount,
      values.telmacoDiscount,
      values.netUnitPrice,
      values.netCost,
      values.margin,
);
    if (resolved) return resolved;
  }

  return null;
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

const normalizeParentPath = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((segment) => {
      if (typeof segment === 'number' && Number.isFinite(segment)) return segment;
      if (typeof segment === 'string') {
        const trimmed = segment.trim();
        if (!trimmed) return null;
        const parsed = Number.parseInt(trimmed, 10);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((segment): segment is number => segment != null);
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
  const beforeId = normalizeOfferDetailId(payload.beforeId ?? null);
  const afterId = normalizeOfferDetailId(payload.afterId ?? null);

  const pool = await getPool();
  const readRequest = pool.request();
  readRequest.input('__offerId', sql.Int, offerId);
  const readResult = await readRequest.query<TreeOrderingRow>(`
    SELECT od.ID AS OfferDetailID, od.TreeOrdering
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND ${TREE_ORDERING_RAW_EXPRESSION} IS NOT NULL
    ORDER BY ${TREE_ORDERING_HIERARCHY_EXPRESSION}, od.TreeOrdering;
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
    if (idx >= 0) collection.splice(idx, 1);
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
    currentIndex += 1;
  }

  const updates = collectResequencedUpdates(roots);
  const rowsAffected = await persistTreeOrderingUpdates(pool, offerId, audit, updates);
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
    ORDER BY ${TREE_ORDERING_HIERARCHY_EXPRESSION}, od.TreeOrdering;
  `);
  const rows = readResult.recordset ?? [];
  const roots = buildTreeFromRows(rows);
  const updates = collectResequencedUpdates(roots);
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

  const result = await request.query(query);
  const inserted = Array.isArray(result.recordset) ? result.recordset[0] ?? null : null;
  return NextResponse.json({
    ok: true,
    created: inserted ?? null,
  });
}

function buildFilterClauses(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { clauses: [] as string[], params: [] as QueryParam[] };
  }

  const clauses: string[] = [];
  const params: QueryParam[] = [];
  const typedModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedModel).forEach(([col, fm], idx) => {
    if (!fm) return;
    const paramBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;

    switch (fm.filterType) {
      case 'text': {
        const type = fm.type;
        const value = String(fm.filter ?? '');
        if (!value) break;
        if (type === 'equals') {
          clauses.push(`${columnExpression} = @${paramBase}`);
          params.push({ key: paramBase, value });
        } else if (type === 'notEqual') {
          clauses.push(`${columnExpression} <> @${paramBase}`);
          params.push({ key: paramBase, value });
        } else if (type === 'startsWith') {
          clauses.push(`${columnExpression} LIKE @${paramBase}`);
          params.push({ key: paramBase, value: `${value}%` });
        } else if (type === 'endsWith') {
          clauses.push(`${columnExpression} LIKE @${paramBase}`);
          params.push({ key: paramBase, value: `%${value}` });
        } else {
          clauses.push(`${columnExpression} LIKE @${paramBase}`);
          params.push({ key: paramBase, value: `%${value}%` });
        }
        break;
      }
      case 'number': {
        const type = fm.type;
        const val = fm.filter !== undefined ? Number(fm.filter) : Number.NaN;
        const valTo = fm.filterTo !== undefined ? Number(fm.filterTo) : undefined;
        if (Number.isNaN(val)) break;
        if (type === 'equals') clauses.push(`${columnExpression} = @${paramBase}`);
        if (type === 'notEqual') clauses.push(`${columnExpression} <> @${paramBase}`);
        if (type === 'lessThan') clauses.push(`${columnExpression} < @${paramBase}`);
        if (type === 'greaterThan') clauses.push(`${columnExpression} > @${paramBase}`);
        if (type === 'lessThanOrEqual') clauses.push(`${columnExpression} <= @${paramBase}`);
        if (type === 'greaterThanOrEqual') clauses.push(`${columnExpression} >= @${paramBase}`);
        if (type === 'inRange' && valTo !== undefined) {
          clauses.push(`(${columnExpression} BETWEEN @${paramBase} AND @${paramBase}_to)`);
          params.push({ key: `${paramBase}_to`, value: valTo });
        }
        params.push({ key: paramBase, value: val });
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
      'Description',
      'ProductDescription',
      'BrandName',
      'PartNumber',
      'ModelNumber',
      'RequestedItemNo',
      'RequestedBrand',
      'RequestedModelNo',
      'RequestedPartNo',
      'RequestedDescription',
      'RequestedDescription2',
      'RequestedDescription3',
      'RequestedQuantity',
      'PriceListID',
      'PriceListEnabled',
      'PriceListValidFromDate',
      'PriceListValidToDate',
    ];
    const selectedFields = Array.from(new Set([...requiredFields, ...requestedFields]))
      .filter((field) => Boolean(SELECT_FIELD_EXPRESSIONS[field]));

    if ((body as ReorderRequest | null)?.action === 'reorder') {
      return handleReorderRow(idValue, body as ReorderRequest, audit);
    }

    if ((body as CreateRowRequest | null)?.action === 'create') {
      return handleCreateRow(idValue, body as CreateRowRequest, audit);
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
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, PRODUCTS_QUICK_FILTER_COLUMNS);
    const combinedWhereSql = mergeWhereClauses(whereSql, quickFilterClause.clause);
    const combinedParams = [...filterParams, ...quickFilterClause.params];
    const orderSql = buildOrder(gridRequest.sortModel) || 'ORDER BY TreeOrderingHierarchy, od.TreeOrdering, od.ID';
    const pagingSql = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const selectedColumnSql = selectedFields
      .map((field) => `${SELECT_FIELD_EXPRESSIONS[field]} AS ${field}`)
      .join(',\n          ');
    const query = `
        SELECT
          COUNT_BIG(1) OVER () AS __totalCount,
          SUM(CASE WHEN od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1 THEN COALESCE(od.TotalPrice, 0) ELSE 0 END) OVER () AS __sumTotalPrice,
          SUM(CASE WHEN od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1 THEN COALESCE(od.TotalNet, 0) ELSE 0 END) OVER () AS __sumTotalNet,
          SUM(CASE WHEN od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1 THEN COALESCE(od.TotalCost, 0) ELSE 0 END) OVER () AS __sumTotalCost,
          ${TREE_ORDERING_HIERARCHY_EXPRESSION} AS TreeOrderingHierarchy,
          ${selectedColumnSql},
          CASE
            WHEN ISNULL(od.IsCategory, 0) = 1 THEN 0
            WHEN NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL
              OR NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL
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
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedDescription,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription2)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedDescription2,
          MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedDescription3)), '') IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedDescription3,
          MAX(CASE WHEN od.RequestedQuantity IS NOT NULL THEN 1 ELSE 0 END) OVER () AS __hasRequestedQuantity
        FROM dbo.OfferDetails od
          LEFT OUTER JOIN dbo.OfferDetails cat
            ON cat.OfferID = od.OfferID
            AND ISNULL(cat.IsCategory, 0) = 1
            AND NULLIF(LTRIM(RTRIM(cat.TreeOrdering)), '') = ${TREE_ORDERING_ROOT_EXPRESSION}
          LEFT OUTER JOIN dbo.Products p ON od.ProductID = p.ID
          LEFT OUTER JOIN dbo.Brands b ON p.BrandID = b.ID
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
      }
      : { totalListPrice: 0, totalNetPrice: 0, totalCost: 0 };

    // Query requested columns separately without filters to determine visibility
    // This ensures requested columns remain visible even when filters result in no rows
    const requestedColumnsQuery = `
      SELECT
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedItemNo,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedBrand,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedModelNo,
        MAX(CASE WHEN NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL THEN 1 ELSE 0 END) AS __hasRequestedPartNo,
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
      RequestedDescription: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedDescription ?? 0),
      RequestedDescription2: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedDescription2 ?? 0),
      RequestedDescription3: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedDescription3 ?? 0),
      RequestedQuantity: normalizeAggregateFlag(requestedColumnsRow?.__hasRequestedQuantity ?? 0),
    };

    const rows: ProductRow[] = recordset.map(row => {
      const {
        __totalCount,
        __sumTotalPrice,
        __sumTotalNet,
        __sumTotalCost,
      __hasRequestedItemNo,
      __hasRequestedBrand,
      __hasRequestedModelNo,
      __hasRequestedPartNo,
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
      void __hasRequestedItemNo;
      void __hasRequestedBrand;
      void __hasRequestedModelNo;
      void __hasRequestedPartNo;
      void __hasRequestedDescription;
      void __hasRequestedDescription2;
      void __hasRequestedDescription3;
      void __hasRequestedQuantity;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount, totals, requestedColumns });
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
  try {
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
  try {
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
        const hasDescription = entry ? Object.prototype.hasOwnProperty.call(entry, 'Description') : false;
        const hasQuantity = entry ? Object.prototype.hasOwnProperty.call(entry, 'Quantity') : false;
        const hasCustomerDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'CustomerDiscount') : false;
        const hasTelmacoDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'TelmacoDiscount') : false;
        const hasNetUnitPrice = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetUnitPrice') : false;
        const hasNetCostOtherCurrency = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetCostOtherCurrency') : false;
        const hasOtherCurrencyID = entry ? Object.prototype.hasOwnProperty.call(entry, 'OtherCurrencyID') : false;
        const hasCurrencyCostModifier = entry ? Object.prototype.hasOwnProperty.call(entry, 'CurrencyCostModifier') : false;
        const hasNetCost = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetCost') : false;
        const hasMargin = entry ? Object.prototype.hasOwnProperty.call(entry, 'Margin') : false;
        const hasListPrice = entry ? Object.prototype.hasOwnProperty.call(entry, 'ListPrice') : false;
        const hasIsCategory = entry ? Object.prototype.hasOwnProperty.call(entry, 'IsCategory') : false;
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
        const hasPricingFields = hasCustomerDiscount || hasTelmacoDiscount || hasNetUnitPrice || hasNetCost || hasMargin
          || hasNetCostOtherCurrency || hasOtherCurrencyID || hasCurrencyCostModifier;
        if (
          !hasProductDescription
          && !hasDescription
          && !hasQuantity
          && !hasPricingFields
          && !hasListPrice
          && !hasIsCategory
          && !hasRequestedItemNo
          && !hasRequestedBrand
          && !hasRequestedModelNo
          && !hasRequestedPartNo
          && !hasRequestedDescription
          && !hasRequestedDescription2
          && !hasRequestedDescription3
          && !hasRequestedQuantity
        ) {
          return null;
        }

        const productDescription = hasProductDescription
          ? normalizeDescriptionValue(entry?.ProductDescription ?? null)
          : hasDescription
            ? normalizeDescriptionValue(entry?.Description ?? null)
            : null;
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

        const customerDiscount = hasCustomerDiscount ? normalizePercentValue(entry?.CustomerDiscount ?? null) : null;
        const telmacoDiscount = hasTelmacoDiscount ? normalizePercentValue(entry?.TelmacoDiscount ?? null) : null;
        const netUnitPrice = hasNetUnitPrice ? normalizeMoneyValue(entry?.NetUnitPrice ?? null) : null;
        const netCostOtherCurrency = hasNetCostOtherCurrency ? normalizeMoneyValue(entry?.NetCostOtherCurrency ?? null) : null;
        const otherCurrencyId = hasOtherCurrencyID ? normalizeIntValue(entry?.OtherCurrencyID ?? null) : null;
        const currencyCostModifier = hasCurrencyCostModifier ? normalizePositiveMoneyValue(entry?.CurrencyCostModifier ?? null) : null;
        const netCost = hasNetCost ? normalizeMoneyValue(entry?.NetCost ?? null) : null;
        const margin = hasMargin ? normalizePercentValue(entry?.Margin ?? null, { allowNegative: true }) : null;
        const listPrice = hasListPrice ? normalizeMoneyValue(entry?.ListPrice ?? null) : null;
        const isCategoryValue = hasIsCategory ? normalizeBoolean(entry?.IsCategory ?? null) : null;

        if (hasPricingFields) {
          const invalidPricing = (hasCustomerDiscount && customerDiscount == null)
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
          Quantity: quantity,
          hasQuantity,
          hasCustomerDiscount,
          hasTelmacoDiscount,
          hasNetUnitPrice,
          hasNetCostOtherCurrency,
          hasOtherCurrencyID,
          hasCurrencyCostModifier,
          hasNetCost,
          hasMargin,
          hasListPrice,
          hasRequestedItemNo,
          hasRequestedBrand,
          hasRequestedModelNo,
          hasRequestedPartNo,
          hasRequestedDescription,
          hasRequestedDescription2,
          hasRequestedQuantity,
          customerDiscount,
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
          requestedItemNo: hasRequestedItemNo
            ? normalizeRequestedItemNoValue(entry?.RequestedItemNo ?? null)
            : null,
          RequestedBrand: requestedBrand,
          RequestedModelNo: requestedModelNo,
          RequestedPartNo: requestedPartNo,
          RequestedDescription: requestedDescription,
          RequestedDescription2: requestedDescription2,
          RequestedDescription3: requestedDescription3,
          RequestedQuantity: requestedQuantity,
        };
      })
      .filter((entry): entry is {
        OfferDetailID: number;
        ProductDescription: string | null;
        Quantity: number | null;
        hasProductDescription: boolean;
        hasQuantity: boolean;
        hasCustomerDiscount: boolean;
        hasTelmacoDiscount: boolean;
        hasNetUnitPrice: boolean;
        hasNetCostOtherCurrency: boolean;
        hasOtherCurrencyID: boolean;
        hasCurrencyCostModifier: boolean;
        hasNetCost: boolean;
        hasMargin: boolean;
        hasListPrice: boolean;
        hasRequestedItemNo: boolean;
        hasRequestedBrand: boolean;
        hasRequestedModelNo: boolean;
        hasRequestedPartNo: boolean;
        hasRequestedDescription: boolean;
        hasRequestedDescription2: boolean;
        hasRequestedDescription3: boolean;
        hasRequestedQuantity: boolean;
        customerDiscount: number | null;
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
        requestedItemNo: string | null;
        RequestedBrand: string | null;
        RequestedModelNo: string | null;
        RequestedPartNo: string | null;
        RequestedDescription: string | null;
        RequestedDescription2: string | null;
        RequestedDescription3: string | null;
        RequestedQuantity: number | null;
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
        ProductDescription: string | null;
        Quantity: number | null;
        ListPrice: number | null;
        CustomerDiscount: number | null;
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
        od.ProductDescription,
          od.Quantity,
          od.ListPrice,
          od.CustomerDiscount,
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
        ProductDescription: string | null;
        Quantity: number | null;
        ListPrice: number | null;
        CustomerDiscount: number | null;
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
        HasProductDescription: boolean;
        Quantity: number | null;
        HasQuantity: boolean;
        CustomerDiscount: number | null;
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
        RequestedItemNo: string | null;
        HasRequestedItemNo: boolean;
        RequestedBrand: string | null;
        HasRequestedBrand: boolean;
        RequestedModelNo: string | null;
        HasRequestedModelNo: boolean;
        RequestedPartNo: string | null;
        HasRequestedPartNo: boolean;
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
          : normalizeMoneyValue(current.NetCostOtherCurrency ?? null);
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
          : normalizeMoneyValue(current.ListPrice);
        const fallbackListPrice = listPriceCandidate ?? entry.netUnitPrice ?? entry.netCost ?? computedNetCostFromOther ?? null;
        const quantity = entry.hasQuantity
          ? entry.Quantity
          : normalizeQuantityValue(current.Quantity ?? null);
        const safeQuantity = quantity == null ? 0 : quantity;
        const pricingProvided = entry.hasCustomerDiscount || entry.hasTelmacoDiscount
          || entry.hasNetUnitPrice || entry.hasNetCost || entry.hasMargin || costFieldsProvided;
        const isCommentRow = Boolean(current.IsComment);

        let resolvedPricing: ResolvedPricing | null = null;

        if (pricingProvided) {
          if (current.ProductID == null && !isCommentRow) {
            errors.push('Pricing can only be updated for product or comment rows.');
            return;
          }
          if (fallbackListPrice == null || Object.is(fallbackListPrice, 0)) {
            errors.push('Missing list price for pricing update.');
            return;
          }

          if (isCommentRow) {
            const nextNetCost = entry.hasNetCost
              ? entry.netCost
              : costFieldsProvided && computedNetCostFromOther != null
                ? computedNetCostFromOther
                : normalizeMoneyValue(current.NetCost ?? null);
            resolvedPricing = {
              customerDiscount: entry.hasCustomerDiscount
                ? entry.customerDiscount
                : normalizePercentValue(current.CustomerDiscount ?? null),
              telmacoDiscount: entry.hasTelmacoDiscount
                ? entry.telmacoDiscount
                : normalizePercentValue(current.TelmacoDiscount ?? null),
              netUnitPrice: entry.hasNetUnitPrice
                ? entry.netUnitPrice
                : normalizeMoneyValue(current.NetUnitPrice ?? null),
              netCost: nextNetCost,
              margin: entry.hasMargin
                ? entry.margin
                : normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
            };
          } else {
            const nextNetCost = entry.hasNetCost
              ? entry.netCost
              : costFieldsProvided && computedNetCostFromOther != null
                ? computedNetCostFromOther
                : normalizeMoneyValue(current.NetCost ?? null);
            const input: PricingInput = {
              listPrice: fallbackListPrice,
              customerDiscount: entry.hasCustomerDiscount
                ? entry.customerDiscount
                : normalizePercentValue(current.CustomerDiscount ?? null),
              telmacoDiscount: entry.hasTelmacoDiscount
                ? entry.telmacoDiscount
                : normalizePercentValue(current.TelmacoDiscount ?? null),
              netUnitPrice: entry.hasNetUnitPrice
                ? entry.netUnitPrice
                : normalizeMoneyValue(current.NetUnitPrice ?? null),
              netCost: nextNetCost,
              margin: entry.hasMargin
                ? entry.margin
                : normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
              provided: {
                customerDiscount: entry.hasCustomerDiscount,
                telmacoDiscount: entry.hasTelmacoDiscount,
                netUnitPrice: entry.hasNetUnitPrice,
                netCost: entry.hasNetCost || costFieldsProvided,
                margin: entry.hasMargin,
              },
            };

            resolvedPricing = resolvePricing(input);
            if (!resolvedPricing) {
              errors.push('Unable to resolve pricing from inputs.');
              return;
            }
          }
        } else {
          resolvedPricing = {
            customerDiscount: normalizePercentValue(current.CustomerDiscount ?? null),
            telmacoDiscount: normalizePercentValue(current.TelmacoDiscount ?? null),
            netUnitPrice: normalizeMoneyValue(current.NetUnitPrice ?? null),
            netCost: normalizeMoneyValue(current.NetCost ?? null),
            margin: normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
          };
        }

        const netPrice = resolvedPricing.netUnitPrice;
        const telmacoCost = resolvedPricing.netCost;
        const listPriceForTotals = listPriceCandidate ?? fallbackListPrice;
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
          HasProductDescription: entry.hasProductDescription,
          Quantity: entry.hasQuantity ? entry.Quantity : current.Quantity ?? safeQuantity,
          HasQuantity: entry.hasQuantity,
          CustomerDiscount: resolvedPricing.customerDiscount,
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
          ListPrice: entry.hasListPrice ? entry.listPrice ?? null : null,
          HasListPrice: entry.hasListPrice,
          RequestedItemNo: entry.requestedItemNo,
          HasRequestedItemNo: entry.hasRequestedItemNo,
          RequestedBrand: entry.RequestedBrand,
          HasRequestedBrand: entry.hasRequestedBrand,
          RequestedModelNo: entry.RequestedModelNo,
          HasRequestedModelNo: entry.hasRequestedModelNo,
          RequestedPartNo: entry.RequestedPartNo,
          HasRequestedPartNo: entry.hasRequestedPartNo,
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
        });
      });

      if (errors.length > 0) {
        return NextResponse.json({ ok: false, error: errors[0] ?? 'Invalid update payload' }, { status: 400 });
      }

      if (pendingRows.length === 0) continue;

      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      request.input('__modifiedBy', sql.Int, audit.userId);
      const decimalType = getDecimalType();
      const valueClauses: string[] = [];

      pendingRows.forEach((row, rowIdx) => {
        const idParam = `odid_${rowIdx}`;
        const productDescriptionParam = `productDescription_${rowIdx}`;
        const hasProductDescriptionParam = `hasProductDescription_${rowIdx}`;
        const quantityParam = `quantity_${rowIdx}`;
        const hasQuantityParam = `hasQuantity_${rowIdx}`;
        const customerDiscountParam = `customerDiscount_${rowIdx}`;
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
        const requestedItemNoParam = `requestedItemNo_${rowIdx}`;
        const hasRequestedItemNoParam = `hasRequestedItemNo_${rowIdx}`;
        const requestedBrandParam = `requestedBrand_${rowIdx}`;
        const hasRequestedBrandParam = `hasRequestedBrand_${rowIdx}`;
        const requestedModelNoParam = `requestedModelNo_${rowIdx}`;
        const hasRequestedModelNoParam = `hasRequestedModelNo_${rowIdx}`;
        const requestedPartNoParam = `requestedPartNo_${rowIdx}`;
        const hasRequestedPartNoParam = `hasRequestedPartNo_${rowIdx}`;
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
        request.input(quantityParam, decimalType, row.Quantity);
        request.input(hasQuantityParam, sql.Bit, row.HasQuantity ? 1 : 0);
        request.input(customerDiscountParam, decimalType, row.CustomerDiscount);
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
        request.input(requestedDescriptionParam, sql.NVarChar(4000), row.HasRequestedDescription ? row.RequestedDescription : null);
        request.input(hasRequestedDescriptionParam, sql.Bit, row.HasRequestedDescription ? 1 : 0);
        request.input(requestedDescription2Param, sql.NVarChar(4000), row.HasRequestedDescription2 ? row.RequestedDescription2 : null);
        request.input(hasRequestedDescription2Param, sql.Bit, row.HasRequestedDescription2 ? 1 : 0);
        request.input(requestedDescription3Param, sql.NVarChar(4000), row.HasRequestedDescription3 ? row.RequestedDescription3 : null);
        request.input(hasRequestedDescription3Param, sql.Bit, row.HasRequestedDescription3 ? 1 : 0);
        request.input(requestedQuantityParam, decimalType, row.RequestedQuantity);
        request.input(hasRequestedQuantityParam, sql.Bit, row.HasRequestedQuantity ? 1 : 0);
        request.input(isCategoryParam, sql.Bit, row.HasIsCategory ? (row.IsCategory ? 1 : 0) : null);
        request.input(hasIsCategoryParam, sql.Bit, row.HasIsCategory ? 1 : 0);
        valueClauses.push(`(@${idParam}, @${productDescriptionParam}, @${hasProductDescriptionParam}, @${quantityParam}, @${hasQuantityParam}, @${customerDiscountParam}, @${telmacoDiscountParam}, @${netUnitPriceParam}, @${netCostOtherCurrencyParam}, @${hasNetCostOtherCurrencyParam}, @${otherCurrencyIdParam}, @${hasOtherCurrencyIdParam}, @${currencyCostModifierParam}, @${hasCurrencyCostModifierParam}, @${netCostParam}, @${marginParam}, @${totalPriceParam}, @${totalNetParam}, @${totalCostParam}, @${grossProfitParam}, @${listPriceParam}, @${hasListPriceParam}, @${requestedItemNoParam}, @${hasRequestedItemNoParam}, @${requestedBrandParam}, @${hasRequestedBrandParam}, @${requestedModelNoParam}, @${hasRequestedModelNoParam}, @${requestedPartNoParam}, @${hasRequestedPartNoParam}, @${requestedDescriptionParam}, @${hasRequestedDescriptionParam}, @${requestedDescription2Param}, @${hasRequestedDescription2Param}, @${requestedDescription3Param}, @${hasRequestedDescription3Param}, @${requestedQuantityParam}, @${hasRequestedQuantityParam}, @${isCategoryParam}, @${hasIsCategoryParam})`);
      });

      const query = `
        WITH PendingUpdates (
          OfferDetailID,
          ProductDescription,
          HasProductDescription,
          Quantity,
          HasQuantity,
          CustomerDiscount,
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
          RequestedDescription,
          HasRequestedDescription,
          RequestedDescription2,
          HasRequestedDescription2,
          RequestedDescription3,
          HasRequestedDescription3,
          RequestedQuantity,
          HasRequestedQuantity,
          IsCategory,
          HasIsCategory
        ) AS (
          SELECT *
          FROM (VALUES ${valueClauses.join(', ')}) AS v (
            OfferDetailID,
            ProductDescription,
            HasProductDescription,
            Quantity,
            HasQuantity,
            CustomerDiscount,
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
          RequestedDescription,
          HasRequestedDescription,
          RequestedDescription2,
          HasRequestedDescription2,
          RequestedDescription3,
          HasRequestedDescription3,
          RequestedQuantity,
            HasRequestedQuantity,
            IsCategory,
            HasIsCategory
          )
        )
        UPDATE od
        SET od.ProductDescription = CASE WHEN PendingUpdates.HasProductDescription = 1 THEN PendingUpdates.ProductDescription ELSE od.ProductDescription END,
            od.Quantity = CASE WHEN PendingUpdates.HasQuantity = 1 THEN PendingUpdates.Quantity ELSE od.Quantity END,
            od.CustomerDiscount = PendingUpdates.CustomerDiscount,
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
            od.RequestedDescription = CASE WHEN PendingUpdates.HasRequestedDescription = 1 THEN PendingUpdates.RequestedDescription ELSE od.RequestedDescription END,
            od.RequestedDescription2 = CASE WHEN PendingUpdates.HasRequestedDescription2 = 1 THEN PendingUpdates.RequestedDescription2 ELSE od.RequestedDescription2 END,
            od.RequestedDescription3 = CASE WHEN PendingUpdates.HasRequestedDescription3 = 1 THEN PendingUpdates.RequestedDescription3 ELSE od.RequestedDescription3 END,
            od.RequestedQuantity = CASE WHEN PendingUpdates.HasRequestedQuantity = 1 THEN PendingUpdates.RequestedQuantity ELSE od.RequestedQuantity END,
            od.IsCategory = CASE WHEN PendingUpdates.HasIsCategory = 1 THEN PendingUpdates.IsCategory ELSE od.IsCategory END,
            od.ModifiedOn = SYSUTCDATETIME(),
            od.ModifiedBy = @__modifiedBy
        FROM dbo.OfferDetails od
          INNER JOIN PendingUpdates ON od.ID = PendingUpdates.OfferDetailID
        WHERE od.OfferID = @__offerId;
      `;

      const result = await request.query(query);
      affected += result.rowsAffected?.[0] ?? 0;
    }

    return NextResponse.json({
      ok: true,
      updated: normalizedUpdates.length,
      rowsAffected: affected,
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
  try {
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
    const chunkSize = 200;
    let deleted = 0;

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;
      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      const paramNames: string[] = [];
      chunk.forEach((id, chunkIdx) => {
        const paramName = `odid_${chunkIdx}`;
        request.input(paramName, sql.Int, id);
        paramNames.push(`@${paramName}`);
      });
      const query = `
        WITH PendingDeletes AS (
          SELECT od.ID AS OfferDetailID,
                 ${TREE_ORDERING_RAW_EXPRESSION} AS TreeOrderingTrimmed
          FROM dbo.OfferDetails od
          WHERE od.OfferID = @__offerId
            AND od.ID IN (${paramNames.join(', ')})
        ),
        RowsToDelete AS (
          SELECT od.ID
          FROM dbo.OfferDetails od
          WHERE od.OfferID = @__offerId
            AND (
              od.ID IN (SELECT OfferDetailID FROM PendingDeletes)
              OR EXISTS (
                SELECT 1
                FROM PendingDeletes pd
                WHERE pd.TreeOrderingTrimmed IS NOT NULL
                  AND ${TREE_ORDERING_RAW_EXPRESSION} IS NOT NULL
                  AND (
                    ${TREE_ORDERING_RAW_EXPRESSION} = pd.TreeOrderingTrimmed
                    OR ${TREE_ORDERING_RAW_EXPRESSION} LIKE pd.TreeOrderingTrimmed + '.%'
                  )
              )
            )
        )
        DELETE od
        FROM dbo.OfferDetails od
          INNER JOIN RowsToDelete rtd ON od.ID = rtd.ID
      `;
      const result = await request.query(query);
      deleted += result.rowsAffected?.[0] ?? 0;
    }

    const resequenced = deleted > 0
      ? await resequenceTreeOrdering(offerId, audit)
      : { updated: 0, rowsAffected: 0 };

    return NextResponse.json({
      ok: true,
      deleted,
      resequenced: resequenced.updated,
      resequencedRowsAffected: resequenced.rowsAffected,
    });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
