import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { buildAuditContext, type AuditContext } from '../../../../../lib/auditTrail';
import { getPool } from '../../../../../lib/sql';

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
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
};

type GridRequestEnvelope = {
  request?: GridRequest;
};

type QueryParam = { key: string; value: string | number | boolean };

const TREE_ORDERING_RAW_EXPRESSION = 'NULLIF(LTRIM(RTRIM(od.TreeOrdering)), \'\')';
const TREE_ORDERING_HIERARCHY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    ELSE TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/'))
  END
`;

type ProductRow = {
  OfferDetailID: number | null;
  ParentOfferDetailID: number | null;
  TreeOrdering: string | null;
  IsPrintable: boolean | null;
  IsComment: boolean | null;
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
  NetCost: number | null;
  Margin: number | null;
  GrossProfit: number | null;
  TotalCost: number | null;
  PriceListID: number | null;
  PriceListItemID: number | null;
  PriceListValidFromDate: Date | string | null;
  PriceListValidToDate: Date | string | null;
  PriceListEnabled: boolean | number | null;
};

type ProductRowWithCount = ProductRow & {
  __totalCount: number | bigint | null;
  __sumTotalPrice?: number | bigint | string | null;
  __sumTotalNet?: number | bigint | string | null;
  __sumTotalCost?: number | bigint | string | null;
};

type OfferProductTotals = {
  totalListPrice: number;
  totalNetPrice: number;
  totalCost: number;
};

type TreeOrderingUpdateInput = {
  OfferDetailID: number | string | null;
  TreeOrdering?: string | null;
};

type TreeOrderingUpdateRequest = {
  updates?: TreeOrderingUpdateInput[];
};

type DeleteRowRequest = {
  OfferDetailIDs?: Array<number | string | null | undefined>;
};

type DetailUpdateInput = {
  OfferDetailID?: number | string | null;
  Description?: string | null;
  Quantity?: number | string | null;
  CustomerDiscount?: number | string | null;
  TelmacoDiscount?: number | string | null;
  NetUnitPrice?: number | string | null;
  NetCost?: number | string | null;
  Margin?: number | string | null;
  ListPrice?: number | string | null;
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
  NetCost: 'od.NetCost',
  Margin: 'od.Margin',
  GrossProfit: 'od.GrossProfit',
  TotalCost: 'od.TotalCost',
  PriceListID: 'od.PriceListID',
  PriceListItemID: 'od.PriceListItemID',
  PriceListValidFromDate: 'pl.ValidFromDate',
  PriceListValidToDate: 'pl.ValidToDate',
  PriceListEnabled: 'pl.Enabled',
};

const ORDER_EXPRESSION_OVERRIDES: Record<string, string> = {
  TreeOrdering: 'TreeOrderingHierarchy',
};

const normalizeTreeOrderingValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

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

type TreeOrderingRow = {
  OfferDetailID: number;
  TreeOrdering: string | null;
};

type TreeOrderingNode = {
  id: number;
  path: number[];
  children: TreeOrderingNode[];
};

const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

const formatTreeOrderingPath = (path: number[]): string => path.join('.');

const comparePaths = (a: number[], b: number[]) => {
  const max = Math.max(a.length, b.length);
  for (let idx = 0; idx < max; idx += 1) {
    const hasA = idx < a.length;
    const hasB = idx < b.length;
    if (!hasA && !hasB) return 0;
    if (!hasA) return -1;
    if (!hasB) return 1;
    const diff = a[idx] - b[idx];
    if (diff !== 0) return diff;
  }
  return 0;
};

const pathsEqual = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx] !== b[idx]) return false;
  }
  return true;
};

const buildTreeFromRows = (rows: TreeOrderingRow[]): TreeOrderingNode[] => {
  const nodes: TreeOrderingNode[] = rows
    .map((row) => ({
      id: row.OfferDetailID,
      path: parseTreeOrderingPath(normalizeTreeOrderingValue(row.TreeOrdering)),
      children: [] as TreeOrderingNode[],
    }))
    .filter((node) => Number.isInteger(node.id) && node.path.length > 0);

  const byPath = new Map<string, TreeOrderingNode>();
  nodes.forEach((node) => {
    const key = formatTreeOrderingPath(node.path);
    if (!byPath.has(key)) {
      byPath.set(key, node);
    }
  });

  const roots: TreeOrderingNode[] = [];
  nodes.forEach((node) => {
    const parentPath = node.path.slice(0, -1);
    if (parentPath.length === 0) {
      roots.push(node);
      return;
    }
    const parentKey = formatTreeOrderingPath(parentPath);
    const parent = byPath.get(parentKey);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortTree = (entries: TreeOrderingNode[]) => {
    entries.sort((a, b) => comparePaths(a.path, b.path));
    entries.forEach((entry) => sortTree(entry.children));
  };
  sortTree(roots);

  return roots;
};

const collectResequencedUpdates = (roots: TreeOrderingNode[]): TreeOrderingUpdateInput[] => {
  const updates: TreeOrderingUpdateInput[] = [];
  const assign = (nodes: TreeOrderingNode[], parentPath: number[]) => {
    nodes.forEach((node, idx) => {
      const nextPath = [...parentPath, idx + 1];
      if (!pathsEqual(node.path, nextPath)) {
        updates.push({ OfferDetailID: node.id, TreeOrdering: formatTreeOrderingPath(nextPath) });
      }
      if (node.children.length > 0) {
        assign(node.children, nextPath);
      }
    });
  };
  assign(roots, []);
  return updates;
};

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

  const chunkSize = 400;
  let rowsAffected = 0;

  for (let idx = 0; idx < updates.length; idx += chunkSize) {
    const chunk = updates.slice(idx, idx + chunkSize);
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
    const updateResult = await request.query(updateQuery);
    rowsAffected += updateResult.rowsAffected?.[0] ?? 0;
  }

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
  const parts = sortModel
    .filter((entry): entry is { colId: string; sort: 'asc' | 'desc' } => Boolean(entry?.colId && entry?.sort))
    .map(entry => {
      const expression = ORDER_EXPRESSION_OVERRIDES[entry.colId]
        ?? COLUMN_EXPRESSIONS[entry.colId]
        ?? `[${entry.colId}]`;
      const direction = entry.sort === 'desc' ? 'DESC' : 'ASC';
      return `${expression} ${direction}`;
    });
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ oID: string }> },
) {
  try {
    let body: (GridRequestEnvelope & CreateRowRequest) | null = null;
    try {
      body = (await req.json()) as (GridRequestEnvelope & CreateRowRequest);
    } catch {
      body = null;
    }

    const audit = buildAuditContext(req);
    const { oID } = await params;
    const normalizedId = decodeURIComponent(String(oID ?? '')).trim();

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

    if ((body as CreateRowRequest | null)?.action === 'create') {
      return handleCreateRow(idValue, body as CreateRowRequest, audit);
    }

    const pool = await getPool();
    const gridRequest = body?.request ?? {};
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const windowSize = endRow > startRow ? endRow - startRow : 100;
    const pageSize = Math.max(1, Math.min(1000, windowSize));
    const offset = Math.max(0, startRow);
    const { clauses, params: filterParams } = buildFilterClauses(gridRequest.filterModel);
    const whereClauses = [`od.OfferID = @__id`, ...clauses];
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const orderSql =
      buildOrder(gridRequest.sortModel) ||
      'ORDER BY TreeOrderingHierarchy, od.TreeOrdering';
    const pagingSql = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const query = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        SUM(CASE WHEN od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1 THEN COALESCE(od.TotalPrice, 0) ELSE 0 END) OVER () AS __sumTotalPrice,
        SUM(CASE WHEN od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1 THEN COALESCE(od.TotalNet, 0) ELSE 0 END) OVER () AS __sumTotalNet,
        SUM(CASE WHEN od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1 THEN COALESCE(od.TotalCost, 0) ELSE 0 END) OVER () AS __sumTotalCost,
        od.ID AS OfferDetailID,
        od.ParentOfferDetailID,
        od.TreeOrdering AS TreeOrdering,
        od.IsPrintable,
        od.IsComment,
        ${TREE_ORDERING_HIERARCHY_EXPRESSION} AS TreeOrderingHierarchy,
        b.Name AS BrandName,
        p.PartNumber,
        p.WebLink,
        p.ModelNumber,
        od.Quantity,
        od.ProductDescription AS Description,
        od.CustomerDiscount,
        od.NetUnitPrice,
        od.TotalPrice,
        od.TotalNet,
        od.Warranty,
        od.ListPrice,
        od.TelmacoDiscount,
        od.NetCost,
        od.Margin,
        od.GrossProfit,
        od.TotalCost,
        od.PriceListID,
        od.PriceListItemID,
        pl.ValidFromDate AS PriceListValidFromDate,
        pl.ValidToDate AS PriceListValidToDate,
        pl.Enabled AS PriceListEnabled
      FROM dbo.OfferDetails od
        LEFT OUTER JOIN dbo.Products p ON od.ProductID = p.ID
        LEFT OUTER JOIN dbo.Brands b ON p.BrandID = b.ID
        LEFT OUTER JOIN dbo.PriceLists pl ON od.PriceListID = pl.ID
      ${whereSql}
        ${orderSql}
        ${pagingSql}
    `;

    const sqlRequest = pool.request();
    sqlRequest.input('__id', sql.Int, idValue);
    filterParams.forEach(param => sqlRequest.input(param.key, param.value));
    sqlRequest.input('__offset', sql.Int, offset);
    sqlRequest.input('__limit', sql.Int, pageSize);

    const result = await sqlRequest.query<ProductRowWithCount>(query);
    const recordset = result.recordset ?? [];
    const rowCount = recordset.length > 0 ? Number(recordset[0].__totalCount ?? 0) : 0;
    const totals: OfferProductTotals = recordset.length > 0
      ? {
        totalListPrice: normalizeAggregateValue(recordset[0].__sumTotalPrice ?? 0),
        totalNetPrice: normalizeAggregateValue(recordset[0].__sumTotalNet ?? 0),
        totalCost: normalizeAggregateValue(recordset[0].__sumTotalCost ?? 0),
      }
      : { totalListPrice: 0, totalNetPrice: 0, totalCost: 0 };

    const rows: ProductRow[] = recordset.map(row => {
      const { __totalCount, __sumTotalPrice, __sumTotalNet, __sumTotalCost, ...rest } = row;
      void __totalCount;
      void __sumTotalPrice;
      void __sumTotalNet;
      void __sumTotalCost;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount, totals });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message, rows: [], rowCount: 0 }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ oID: string }> },
) {
  try {
    const audit = buildAuditContext(req);
    const { oID } = await params;
    const normalizedId = decodeURIComponent(String(oID ?? '')).trim();
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
    const updates = Array.isArray(body?.updates) ? body?.updates : [];
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
    const chunkSize = 400;
    let affected = 0;

    for (let idx = 0; idx < normalizedUpdates.length; idx += chunkSize) {
      const chunk = normalizedUpdates.slice(idx, idx + chunkSize);
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

      const query = `
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
      const result = await request.query(query);
      affected += result.rowsAffected?.[0] ?? 0;
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
  { params }: { params: Promise<{ oID: string }> },
) {
  try {
    const audit = buildAuditContext(req);
    const { oID } = await params;
    const normalizedId = decodeURIComponent(String(oID ?? '')).trim();
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

    const updates = Array.isArray(body?.updates) ? body?.updates : [];
    let hadInvalidQuantity = false;
    let hadInvalidPricing = false;
    const normalizedUpdates = updates
      .map((entry) => {
        const id = normalizeOfferDetailId(entry?.OfferDetailID ?? null);
        if (id == null) return null;
        const hasDescription = entry ? Object.prototype.hasOwnProperty.call(entry, 'Description') : false;
        const hasQuantity = entry ? Object.prototype.hasOwnProperty.call(entry, 'Quantity') : false;
        const hasCustomerDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'CustomerDiscount') : false;
        const hasTelmacoDiscount = entry ? Object.prototype.hasOwnProperty.call(entry, 'TelmacoDiscount') : false;
        const hasNetUnitPrice = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetUnitPrice') : false;
        const hasNetCost = entry ? Object.prototype.hasOwnProperty.call(entry, 'NetCost') : false;
        const hasMargin = entry ? Object.prototype.hasOwnProperty.call(entry, 'Margin') : false;
        const hasListPrice = entry ? Object.prototype.hasOwnProperty.call(entry, 'ListPrice') : false;
        const hasPricingFields = hasCustomerDiscount || hasTelmacoDiscount || hasNetUnitPrice || hasNetCost || hasMargin;
        if (!hasDescription && !hasQuantity && !hasPricingFields && !hasListPrice) return null;

        const description = hasDescription ? normalizeDescriptionValue(entry?.Description ?? null) : null;
        let quantity: number | null = null;
        if (hasQuantity) {
          quantity = normalizeQuantityValue(entry?.Quantity ?? null);
          if (quantity == null) {
            hadInvalidQuantity = true;
            return null;
          }
        }

        const customerDiscount = hasCustomerDiscount ? normalizePercentValue(entry?.CustomerDiscount ?? null) : null;
        const telmacoDiscount = hasTelmacoDiscount ? normalizePercentValue(entry?.TelmacoDiscount ?? null) : null;
        const netUnitPrice = hasNetUnitPrice ? normalizeMoneyValue(entry?.NetUnitPrice ?? null) : null;
        const netCost = hasNetCost ? normalizeMoneyValue(entry?.NetCost ?? null) : null;
        const margin = hasMargin ? normalizePercentValue(entry?.Margin ?? null, { allowNegative: true }) : null;
        const listPrice = hasListPrice ? normalizeMoneyValue(entry?.ListPrice ?? null) : null;

        if (hasPricingFields) {
          const invalidPricing = (hasCustomerDiscount && customerDiscount == null)
            || (hasTelmacoDiscount && telmacoDiscount == null)
            || (hasNetUnitPrice && netUnitPrice == null)
            || (hasNetCost && netCost == null)
            || (hasMargin && (margin == null || Math.abs(margin) >= 100));
          if (invalidPricing) {
            hadInvalidPricing = true;
            return null;
          }
        }

        return {
          OfferDetailID: id,
          Description: description,
          Quantity: quantity,
          hasDescription,
          hasQuantity,
          hasCustomerDiscount,
          hasTelmacoDiscount,
          hasNetUnitPrice,
          hasNetCost,
          hasMargin,
          hasListPrice,
          customerDiscount,
          telmacoDiscount,
          netUnitPrice,
          netCost,
          margin,
          listPrice,
        };
      })
      .filter((entry): entry is {
        OfferDetailID: number;
        Description: string | null;
        Quantity: number | null;
        hasDescription: boolean;
        hasQuantity: boolean;
        hasCustomerDiscount: boolean;
        hasTelmacoDiscount: boolean;
        hasNetUnitPrice: boolean;
        hasNetCost: boolean;
        hasMargin: boolean;
        hasListPrice: boolean;
        customerDiscount: number | null;
        telmacoDiscount: number | null;
        netUnitPrice: number | null;
        netCost: number | null;
        margin: number | null;
        listPrice: number | null;
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
        NetCost: number | null;
        Margin: number | null;
      }>(`
        SELECT
        od.ID AS OfferDetailID,
        od.ProductID,
        od.IsComment,
        od.ProductDescription,
          od.Quantity,
          od.ListPrice,
          od.CustomerDiscount,
          od.TelmacoDiscount,
          od.NetUnitPrice,
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
        NetCost: number | null;
        Margin: number | null;
      }>();
      (currentRowsRes.recordset ?? []).forEach((row) => {
        currentById.set(row.OfferDetailID, row);
      });

      const pendingRows: Array<{
        OfferDetailID: number;
        Description: string | null;
        HasDescription: boolean;
        Quantity: number | null;
        HasQuantity: boolean;
        CustomerDiscount: number | null;
        TelmacoDiscount: number | null;
        NetUnitPrice: number | null;
        NetCost: number | null;
        Margin: number | null;
        TotalPrice: number | null;
        TotalNet: number | null;
        TotalCost: number | null;
        GrossProfit: number | null;
        ListPrice: number | null;
        HasListPrice: boolean;
      }> = [];
      const errors: string[] = [];

      chunk.forEach((entry) => {
        const current = currentById.get(entry.OfferDetailID);
        if (!current) {
          errors.push('Offer detail not found for update.');
          return;
        }

        const listPriceCandidate = entry.hasListPrice
          ? entry.listPrice
          : normalizeMoneyValue(current.ListPrice);
        const fallbackListPrice = listPriceCandidate ?? entry.netUnitPrice ?? entry.netCost ?? null;
        const quantity = entry.hasQuantity
          ? entry.Quantity
          : normalizeQuantityValue(current.Quantity ?? null);
        const safeQuantity = quantity == null ? 0 : quantity;
        const pricingProvided = entry.hasCustomerDiscount || entry.hasTelmacoDiscount
          || entry.hasNetUnitPrice || entry.hasNetCost || entry.hasMargin;
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
              netCost: entry.hasNetCost
                ? entry.netCost
                : normalizeMoneyValue(current.NetCost ?? null),
              margin: entry.hasMargin
                ? entry.margin
                : normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
            };
          } else {
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
              netCost: entry.hasNetCost
                ? entry.netCost
                : normalizeMoneyValue(current.NetCost ?? null),
              margin: entry.hasMargin
                ? entry.margin
                : normalizePercentValue(current.Margin ?? null, { allowNegative: true }),
              provided: {
                customerDiscount: entry.hasCustomerDiscount,
                telmacoDiscount: entry.hasTelmacoDiscount,
                netUnitPrice: entry.hasNetUnitPrice,
                netCost: entry.hasNetCost,
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
          Description: entry.hasDescription ? entry.Description : current.ProductDescription,
          HasDescription: entry.hasDescription,
          Quantity: entry.hasQuantity ? entry.Quantity : current.Quantity ?? safeQuantity,
          HasQuantity: entry.hasQuantity,
          CustomerDiscount: resolvedPricing.customerDiscount,
          TelmacoDiscount: resolvedPricing.telmacoDiscount,
          NetUnitPrice: netPrice,
          NetCost: telmacoCost,
          Margin: resolvedPricing.margin,
          TotalPrice: totalPrice,
          TotalNet: totalNet,
          TotalCost: totalCost,
          GrossProfit: grossProfit,
          ListPrice: entry.hasListPrice ? entry.listPrice ?? null : null,
          HasListPrice: entry.hasListPrice,
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
        const descriptionParam = `description_${rowIdx}`;
        const hasDescriptionParam = `hasDescription_${rowIdx}`;
        const quantityParam = `quantity_${rowIdx}`;
        const hasQuantityParam = `hasQuantity_${rowIdx}`;
        const customerDiscountParam = `customerDiscount_${rowIdx}`;
        const telmacoDiscountParam = `telmacoDiscount_${rowIdx}`;
        const netUnitPriceParam = `netUnitPrice_${rowIdx}`;
        const netCostParam = `netCost_${rowIdx}`;
        const marginParam = `margin_${rowIdx}`;
        const totalPriceParam = `totalPrice_${rowIdx}`;
        const totalNetParam = `totalNet_${rowIdx}`;
        const totalCostParam = `totalCost_${rowIdx}`;
        const grossProfitParam = `grossProfit_${rowIdx}`;
        const listPriceParam = `listPrice_${rowIdx}`;
        const hasListPriceParam = `hasListPrice_${rowIdx}`;

        request.input(idParam, sql.Int, row.OfferDetailID);
        request.input(descriptionParam, sql.NVarChar(4000), row.HasDescription ? row.Description : null);
        request.input(hasDescriptionParam, sql.Bit, row.HasDescription ? 1 : 0);
        request.input(quantityParam, decimalType, row.Quantity);
        request.input(hasQuantityParam, sql.Bit, row.HasQuantity ? 1 : 0);
        request.input(customerDiscountParam, decimalType, row.CustomerDiscount);
        request.input(telmacoDiscountParam, decimalType, row.TelmacoDiscount);
        request.input(netUnitPriceParam, decimalType, row.NetUnitPrice);
        request.input(netCostParam, decimalType, row.NetCost);
        request.input(marginParam, decimalType, row.Margin);
        request.input(totalPriceParam, decimalType, row.TotalPrice);
        request.input(totalNetParam, decimalType, row.TotalNet);
        request.input(totalCostParam, decimalType, row.TotalCost);
        request.input(grossProfitParam, decimalType, row.GrossProfit);
        request.input(listPriceParam, decimalType, row.HasListPrice ? row.ListPrice : null);
        request.input(hasListPriceParam, sql.Bit, row.HasListPrice ? 1 : 0);

        valueClauses.push(`(@${idParam}, @${descriptionParam}, @${hasDescriptionParam}, @${quantityParam}, @${hasQuantityParam}, @${customerDiscountParam}, @${telmacoDiscountParam}, @${netUnitPriceParam}, @${netCostParam}, @${marginParam}, @${totalPriceParam}, @${totalNetParam}, @${totalCostParam}, @${grossProfitParam}, @${listPriceParam}, @${hasListPriceParam})`);
      });

      const query = `
        WITH PendingUpdates (
          OfferDetailID,
          Description,
          HasDescription,
          Quantity,
          HasQuantity,
          CustomerDiscount,
          TelmacoDiscount,
          NetUnitPrice,
          NetCost,
          Margin,
          TotalPrice,
          TotalNet,
          TotalCost,
          GrossProfit,
          ListPrice,
          HasListPrice
        ) AS (
          SELECT *
          FROM (VALUES ${valueClauses.join(', ')}) AS v (
            OfferDetailID,
            Description,
            HasDescription,
            Quantity,
            HasQuantity,
            CustomerDiscount,
            TelmacoDiscount,
            NetUnitPrice,
            NetCost,
            Margin,
            TotalPrice,
            TotalNet,
            TotalCost,
            GrossProfit,
            ListPrice,
            HasListPrice
          )
        )
        UPDATE od
        SET od.ProductDescription = CASE WHEN PendingUpdates.HasDescription = 1 THEN PendingUpdates.Description ELSE od.ProductDescription END,
            od.Quantity = CASE WHEN PendingUpdates.HasQuantity = 1 THEN PendingUpdates.Quantity ELSE od.Quantity END,
            od.CustomerDiscount = PendingUpdates.CustomerDiscount,
            od.TelmacoDiscount = PendingUpdates.TelmacoDiscount,
            od.NetUnitPrice = PendingUpdates.NetUnitPrice,
            od.NetCost = PendingUpdates.NetCost,
            od.Margin = PendingUpdates.Margin,
            od.TotalPrice = PendingUpdates.TotalPrice,
            od.TotalNet = PendingUpdates.TotalNet,
            od.TotalCost = PendingUpdates.TotalCost,
            od.GrossProfit = PendingUpdates.GrossProfit,
            od.ListPrice = CASE WHEN PendingUpdates.HasListPrice = 1 THEN PendingUpdates.ListPrice ELSE od.ListPrice END,
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
  { params }: { params: Promise<{ oID: string }> },
) {
  try {
    const audit = buildAuditContext(req);
    const { oID } = await params;
    const normalizedId = decodeURIComponent(String(oID ?? '')).trim();
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

    const rawIds = Array.isArray(body?.OfferDetailIDs) ? body?.OfferDetailIDs : [];
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
