import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { buildAuditContext, type AuditContext } from '../../../../../lib/auditTrail';
import { getPool } from '../../../../../lib/sql';

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

type DescriptionUpdateInput = {
  OfferDetailID?: number | string | null;
  Description?: string | null;
};

type DescriptionUpdateRequest = {
  updates?: DescriptionUpdateInput[];
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
        SUM(CASE WHEN od.ProductID IS NOT NULL THEN COALESCE(od.TotalPrice, 0) ELSE 0 END) OVER () AS __sumTotalPrice,
        SUM(CASE WHEN od.ProductID IS NOT NULL THEN COALESCE(od.TotalNet, 0) ELSE 0 END) OVER () AS __sumTotalNet,
        SUM(CASE WHEN od.ProductID IS NOT NULL THEN COALESCE(od.TotalCost, 0) ELSE 0 END) OVER () AS __sumTotalCost,
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

    let body: DescriptionUpdateRequest | null = null;
    try {
      body = (await req.json()) as DescriptionUpdateRequest;
    } catch {
      body = null;
    }

    const updates = Array.isArray(body?.updates) ? body?.updates : [];
    const normalizedUpdates = updates
      .map((entry) => {
        const id = normalizeOfferDetailId(entry?.OfferDetailID ?? null);
        if (id == null) return null;
        const hasDescription = entry ? Object.prototype.hasOwnProperty.call(entry, 'Description') : false;
        if (!hasDescription) return null;
        const description = normalizeDescriptionValue(entry?.Description ?? null);
        return { OfferDetailID: id, Description: description };
      })
      .filter((entry): entry is { OfferDetailID: number; Description: string | null } => Boolean(entry));

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
        const descriptionParam = `description_${chunkIdx}`;
        request.input(idParam, sql.Int, entry.OfferDetailID);
        request.input(descriptionParam, sql.NVarChar(4000), entry.Description);
        valueClauses.push(`(@${idParam}, @${descriptionParam})`);
      });
      const query = `
        WITH PendingDescriptionUpdates (OfferDetailID, Description) AS (
          SELECT v.OfferDetailID, v.Description
          FROM (VALUES ${valueClauses.join(', ')}) AS v (OfferDetailID, Description)
        )
        UPDATE od
        SET od.ProductDescription = PendingDescriptionUpdates.Description,
            od.ModifiedOn = SYSUTCDATETIME(),
            od.ModifiedBy = @__modifiedBy
        FROM dbo.OfferDetails od
          INNER JOIN PendingDescriptionUpdates ON od.ID = PendingDescriptionUpdates.OfferDetailID
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
        DELETE od
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
          AND od.ID IN (${paramNames.join(', ')})
      `;
      const result = await request.query(query);
      deleted += result.rowsAffected?.[0] ?? 0;
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
