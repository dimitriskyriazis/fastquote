import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { buildAuditContext } from '../../../../../../lib/auditTrail';

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

type KnownFilterModel = TextFilterModel | NumberFilterModel;

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
};

type GridRequestEnvelope = {
  request?: GridRequest;
  action?: string | null;
};

type QueryParam = { key: string; value: string | number | boolean };

const TREE_ORDERING_RAW_EXPRESSION = 'NULLIF(LTRIM(RTRIM(od.TreeOrdering)), \'\')';
const TREE_ORDERING_HIERARCHY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    ELSE TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/'))
  END
`;

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

async function readBody(req: NextRequest): Promise<GridRequestEnvelope & Record<string, unknown>> {
  try {
    const payload = (await req.json()) as GridRequestEnvelope & Record<string, unknown>;
    if (payload && typeof payload === 'object') return payload;
  } catch {
    /* noop */
  }
  return {};
}

function readGridRequest(body: GridRequestEnvelope): GridRequest {
  if (body && typeof body === 'object' && body.request && typeof body.request === 'object') {
    return body.request;
  }
  return { startRow: 0, endRow: 100 };
}

const buildWhereClauses = (filterModel: GridRequest['filterModel'], columnExpressions: Record<string, string>) => {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { clauses: [] as string[], params: [] as QueryParam[] };
  }
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  const typedModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedModel).forEach(([col, fm], idx) => {
    if (!fm) return;
    const paramBase = `${col}_${idx}`;
    const columnExpression = columnExpressions[col] ?? `[${col}]`;

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
      default:
        break;
    }
  });

  return { clauses, params };
};

const buildOrderSql = (sortModel: GridRequest['sortModel'], columnExpressions: Record<string, string>, defaultOrder: string) => {
  if (!sortModel || sortModel.length === 0) return defaultOrder;
  const parts = sortModel
    .filter((entry): entry is { colId: string; sort: 'asc' | 'desc' } => Boolean(entry?.colId && entry?.sort))
    .map((entry) => {
      const expression = columnExpressions[entry.colId] ?? `[${entry.colId}]`;
      const direction = entry.sort === 'desc' ? 'DESC' : 'ASC';
      return `${expression} ${direction}`;
    });
  return parts.length ? `ORDER BY ${parts.join(', ')}` : defaultOrder;
};

type CategoryGridRow = {
  __totalCount: number | bigint | null;
  OfferDetailID: number;
  TreeOrdering: string | null;
  Description: string | null;
  ModifiedOn: Date | string | null;
  ModifiedBy: string | null;
  TreeOrderingHierarchy?: unknown;
};

async function handleCategoryGrid(
  offerId: number,
  body: GridRequestEnvelope,
) {
  const gridRequest = readGridRequest(body);
  const startRow = gridRequest.startRow ?? 0;
  const endRow = gridRequest.endRow ?? startRow + 100;
  const windowSize = endRow > startRow ? endRow - startRow : 100;
  const pageSize = Math.max(1, Math.min(400, windowSize));
  const offset = Math.max(0, startRow);

  const columnExpressions: Record<string, string> = {
    TreeOrdering: 'od.TreeOrdering',
    Description: 'od.ProductDescription',
    ModifiedOn: 'od.ModifiedOn',
    ModifiedBy: 'od.ModifiedBy',
  };

  const { clauses, params } = buildWhereClauses(gridRequest.filterModel, columnExpressions);
  const whereSql = clauses.length
    ? `AND ${clauses.join(' AND ')}`
    : '';

  const orderSql = buildOrderSql(
    gridRequest.sortModel,
    columnExpressions,
    'ORDER BY TreeOrderingHierarchy, od.TreeOrdering',
  );

  const pool = await getPool();
  const request = pool.request();
  request.input('__offerId', sql.Int, offerId);
  request.input('__offset', sql.Int, offset);
  request.input('__limit', sql.Int, pageSize);
  params.forEach((param) => request.input(param.key, param.value));

  const query = `
    SELECT
      COUNT_BIG(1) OVER () AS __totalCount,
      od.ID AS OfferDetailID,
      od.TreeOrdering,
      od.ProductDescription AS Description,
      od.ModifiedOn,
      od.ModifiedBy,
      ${TREE_ORDERING_HIERARCHY_EXPRESSION} AS TreeOrderingHierarchy
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND ISNULL(od.IsCategory, 0) = 1
      ${whereSql}
    ${orderSql}
    OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY;
  `;

  const result = await request.query<CategoryGridRow>(query);
  const rows = result.recordset ?? [];
  const rowCount = rows.length > 0 ? Number(rows[0].__totalCount ?? 0) : 0;
  const mappedRows = rows.map((row) => {
    const { __totalCount, TreeOrderingHierarchy, ...rest } = row;
    void __totalCount;
    void TreeOrderingHierarchy;
    return rest;
  });

  return NextResponse.json({ ok: true, rows: mappedRows, rowCount });
}

type ProductGridRow = {
  __totalCount: number | bigint | null;
  ProductID: number;
  PartNumber: string | null;
  Description: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  PriceListItemID: number | null;
  PriceListID: number | null;
  PriceListName: string | null;
  ListPrice: number | null;
  UnitPrice: number | null;
  PriceListValidFromDate: Date | string | null;
  PriceListValidToDate: Date | string | null;
  PriceListEnabled: boolean | number | null;
};

async function handleProductGrid(
  offerId: number,
  body: GridRequestEnvelope,
) {
  void offerId; // offer context may be used later (pricing policies), keep signature
  const gridRequest = readGridRequest(body);
  const startRow = gridRequest.startRow ?? 0;
  const endRow = gridRequest.endRow ?? startRow + 100;
  const windowSize = endRow > startRow ? endRow - startRow : 100;
  const pageSize = Math.max(1, Math.min(400, windowSize));
  const offset = Math.max(0, startRow);

  const columnExpressions: Record<string, string> = {
    PartNumber: 'bp.PartNumber',
    Description: 'bp.Description',
    ModelNumber: 'bp.ModelNumber',
    BrandName: 'bp.BrandName',
    PriceListName: 'price.PriceListName',
    ListPrice: 'price.ListPrice',
    UnitPrice: 'price.ListPrice',
  };

  const { clauses, params } = buildWhereClauses(gridRequest.filterModel, columnExpressions);
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderSql = buildOrderSql(
    gridRequest.sortModel,
    columnExpressions,
    'ORDER BY bp.PartNumber ASC',
  );

  const pool = await getPool();
  const request = pool.request();
  request.input('__offset', sql.Int, offset);
  request.input('__limit', sql.Int, pageSize);
  params.forEach((param) => request.input(param.key, param.value));

  const query = `
    WITH BaseProducts AS (
      SELECT
        p.ID AS ProductID,
        p.PartNumber,
        p.Description,
        p.ModelNumber,
        b.Name AS BrandName
      FROM dbo.Products p
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
    )
    SELECT
      COUNT_BIG(1) OVER () AS __totalCount,
      bp.ProductID,
      bp.PartNumber,
      bp.Description,
      bp.ModelNumber,
      bp.BrandName,
      price.PriceListItemID,
      price.PriceListID,
      price.PriceListName,
      price.ListPrice,
      price.ListPrice AS UnitPrice,
      price.PriceListValidFromDate,
      price.PriceListValidToDate,
      price.PriceListEnabled
    FROM BaseProducts bp
      CROSS APPLY (
        SELECT TOP (1)
          pli.ID AS PriceListItemID,
          pli.PriceListID,
          pl.Name AS PriceListName,
          pli.ListPrice,
          pl.ValidFromDate AS PriceListValidFromDate,
          pl.ValidToDate AS PriceListValidToDate,
          pl.Enabled AS PriceListEnabled
        FROM dbo.PriceListItems pli
          INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        WHERE pli.ProductID = bp.ProductID
          AND pl.Enabled = 1
        ORDER BY
          CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
          pl.ValidToDate,
          pl.ValidFromDate DESC,
          pli.ID DESC
      ) price
    ${whereSql}
    ${orderSql}
    OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY;
  `;

  const result = await request.query<ProductGridRow>(query);
  const rows = result.recordset ?? [];
  const rowCount = rows.length > 0 ? Number(rows[0].__totalCount ?? 0) : 0;
  const mappedRows = rows.map((row) => {
    const { __totalCount, ...rest } = row;
    void __totalCount;
    return rest;
  });

  return NextResponse.json({ ok: true, rows: mappedRows, rowCount });
}

type ProductSelection = { productId: number; sequence: number };

const normalizeSelectionPayload = (raw: unknown): ProductSelection[] => {
  if (!Array.isArray(raw)) return [];
  const mapped = raw
    .map((entry, idx) => {
      if (entry == null) return null;
      if (typeof entry === 'number' || typeof entry === 'string') {
        const productId = normalizeProductId(entry);
        if (productId == null) return null;
        return { productId, sequence: idx + 1 };
      }
      if (typeof entry === 'object') {
        const obj = entry as { productId?: unknown; ProductID?: unknown; sequence?: unknown; Sequence?: unknown };
        const productId = normalizeProductId(obj.productId ?? obj.ProductID ?? null);
        if (productId == null) return null;
        const seqRaw = obj.sequence ?? obj.Sequence;
        const seq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : idx + 1;
        return { productId, sequence: seq };
      }
      return null;
    })
    .filter((entry): entry is ProductSelection => Boolean(entry));

  const seen = new Set<number>();
  const deduped: ProductSelection[] = [];
  mapped.forEach((entry) => {
    if (seen.has(entry.productId)) return;
    seen.add(entry.productId);
    deduped.push(entry);
  });
  return deduped;
};

async function handleAddProducts(
  offerId: number,
  body: Record<string, unknown>,
  auditUserId: string | number | null,
) {
  const categoryId = normalizeOfferDetailId(
    body?.categoryId ?? (body as { CategoryID?: unknown })?.CategoryID ?? null,
);
  const selections = normalizeSelectionPayload((body as { products?: unknown })?.products ?? null);
  if (selections.length === 0) {
    return NextResponse.json({ ok: false, error: 'No products selected' }, { status: 400 });
  }

  const pool = await getPool();

  let parentTreeOrdering: string | null = null;

  if (categoryId != null) {
    const lookup = pool.request();
    lookup.input('__offerId', sql.Int, offerId);
    lookup.input('__categoryId', sql.Int, categoryId);
    const categoryResult = await lookup.query<{
      TreeOrdering: string | null;
    }>(`
      SELECT TOP (1)
        NULLIF(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), '') AS TreeOrdering
      FROM dbo.OfferDetails od
      WHERE od.ID = @__categoryId
        AND od.OfferID = @__offerId
        AND ISNULL(od.IsComment, 0) = 0
        AND ISNULL(od.ProductID, 0) = 0
    `);

    parentTreeOrdering = categoryResult.recordset?.[0]?.TreeOrdering ?? null;
    if (!parentTreeOrdering) {
      return NextResponse.json({ ok: false, error: 'Invalid category selection' }, { status: 400 });
    }
  }

  const request = pool.request();
  request.input('__offerId', sql.Int, offerId);
  request.input('__categoryId', sql.Int, categoryId);
  request.input('__parentTree', sql.NVarChar(255), parentTreeOrdering);
  request.input('__createdBy', sql.Int, auditUserId);
  request.input('__modifiedBy', sql.Int, auditUserId);

  const valueClauses: string[] = [];
  selections.forEach((entry, idx) => {
    const pidParam = `pid_${idx}`;
    const seqParam = `seq_${idx}`;
    request.input(pidParam, sql.Int, entry.productId);
    request.input(seqParam, sql.Int, entry.sequence);
    valueClauses.push(`(@${pidParam}, @${seqParam})`);
  });

  const query = `
  DECLARE @parentTree NVARCHAR(255) = NULLIF(LTRIM(RTRIM(@__parentTree)), '');
  DECLARE @prefix NVARCHAR(260);
  DECLARE @targetSegments INT;
  DECLARE @maxChild INT;

  IF @parentTree IS NULL
  BEGIN
    -- No category selected: find max top-level TreeOrdering
    SELECT @maxChild =
      MAX(
        TRY_CONVERT(
          INT,
          NULLIF(LTRIM(RTRIM(od.TreeOrdering)), '')
        )
      )
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId;

    SET @maxChild = ISNULL(@maxChild, 0);
  END
  ELSE
  BEGIN
    SET @prefix = CONCAT(@parentTree, '.');
    SET @targetSegments = (LEN(@parentTree) - LEN(REPLACE(@parentTree, '.', '')) + 2);

    SELECT @maxChild =
      MAX(
        TRY_CONVERT(INT, RIGHT(t.TreeOrderingTrimmed, CHARINDEX('.', REVERSE(t.TreeOrderingTrimmed) + '.') - 1))
      )
    FROM (
      SELECT LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))) AS TreeOrderingTrimmed
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
    ) AS t
    WHERE t.TreeOrderingTrimmed <> ''
      AND t.TreeOrderingTrimmed LIKE CONCAT(@prefix, '%')
      AND (LEN(t.TreeOrderingTrimmed) - LEN(REPLACE(t.TreeOrderingTrimmed, '.', '')) + 1) = @targetSegments;

    SET @maxChild = ISNULL(@maxChild, 0);
  END;

  DECLARE @nextOrdering INT =
    (
      SELECT ISNULL(MAX(ISNULL(od.Ordering, 0)), 0) + 1
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
    );


    WITH OfferContext AS (
      SELECT
        o.ID AS OfferID,
        o.PricingPolicyID
      FROM dbo.Offer o
      WHERE o.ID = @__offerId
    ),
    ProvidedProducts AS (
      SELECT DISTINCT v.ProductID, v.Seq
      FROM (VALUES ${valueClauses.join(', ')}) AS v (ProductID, Seq)
    ),
    ProductData AS (
      SELECT
        p.ProductID,
        p.Seq,
        pr.Description,
        pr.BrandID,
        pr.PartNumber,
        pr.ModelNumber,
        0 AS WarrantyValue,
        price.PriceListID,
        price.PriceListItemID,
        price.ListPrice
      FROM ProvidedProducts p
        INNER JOIN dbo.Products pr ON pr.ID = p.ProductID
        CROSS APPLY (
          SELECT TOP (1)
            pli.ID AS PriceListItemID,
            pli.PriceListID,
            pli.ListPrice
          FROM dbo.PriceListItems pli
            INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
          WHERE pli.ProductID = p.ProductID
            AND pl.Enabled = 1
          ORDER BY
            CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
            pl.ValidToDate,
            pl.ValidFromDate DESC,
            pli.ID DESC
        ) price
    )
    INSERT INTO dbo.OfferDetails (
      OfferID,
      ParentOfferDetailID,
      TreeOrdering,
      Ordering,
      IsPrintable,
      IsComment,
      IsCategory,
      ProductID,
      BrandID,
      PartNumber,
      ModelNumber,
      ProductDescription,
      Warranty,
      Quantity,
      ListPrice,
      NetUnitPrice,
      TotalPrice,
      TotalNet,
      TelmacoDiscount,
      CustomerDiscount,
      NetCost,
      Margin,
      GrossProfit,
      TotalCost,
      PriceListID,
      PriceListItemID,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    OUTPUT INSERTED.ID AS OfferDetailID, INSERTED.TreeOrdering
    SELECT
      @__offerId,
      CASE WHEN @parentTree IS NULL THEN NULL ELSE @__categoryId END,
      CASE
        WHEN @parentTree IS NULL THEN CONVERT(NVARCHAR(255), @maxChild + ROW_NUMBER() OVER (ORDER BY p.Seq))
        ELSE CONCAT(@parentTree, '.', @maxChild + ROW_NUMBER() OVER (ORDER BY p.Seq))
      END,
      @nextOrdering + ROW_NUMBER() OVER (ORDER BY p.Seq) - 1,

      NULL,
      0,
      0,
      p.ProductID,
      p.BrandID,
      p.PartNumber,
      p.ModelNumber,
      p.Description,
      p.WarrantyValue,
      1,
      p.ListPrice,
      p.ListPrice,
      CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice END,
      CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice END,
      COALESCE(discounts.TelmacoDiscountPercentage, 0),
      COALESCE(discounts.CustomerDiscountPercentage, 0),
      CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice END,
      0,
      0,
      CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice END,
      p.PriceListID,
      p.PriceListItemID,
      SYSUTCDATETIME(),
      @__createdBy,
      SYSUTCDATETIME(),
      @__modifiedBy
    FROM ProductData p
    CROSS JOIN OfferContext oc
    OUTER APPLY (
      SELECT TOP (1)
        ppr.TelmacoDiscountPercentage,
        ppr.CustomerDiscountPercentage
      FROM dbo.PricingPolicyRules ppr
      WHERE ppr.PricingPolicyID = oc.PricingPolicyID
        AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
      ORDER BY CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END, ppr.ID DESC
    ) AS discounts
    ORDER BY p.Seq;
  `;

  const result = await request.query(query);
  const inserted = result.rowsAffected?.[0] ?? 0;
  return NextResponse.json({ ok: true, inserted });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    const offerId = normalizeOfferId(normalizedId);
    if (offerId == null) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id' }, { status: 400 });
    }

    const body = await readBody(req);
    const actionRaw = typeof body.action === 'string' ? body.action.trim().toLowerCase() : null;

    if (actionRaw === 'categories') {
      return handleCategoryGrid(offerId, body);
    }
    if (actionRaw === 'add') {
      const audit = buildAuditContext(req);
      return handleAddProducts(offerId, body, audit.userId);
    }

    return handleProductGrid(offerId, body);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message, rows: [], rowCount: 0 }, { status: 500 });
  }
}
