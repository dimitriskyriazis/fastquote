import { NextRequest, NextResponse } from 'next/server';
import sql, { type ConnectionPool } from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { buildAuditContext } from '../../../../../../lib/auditTrail';

const getDecimalType = () => {
  const decimalFactory = (sql as unknown as { Decimal: (precision: number, scale: number) => unknown }).Decimal;
  return decimalFactory(18, 4);
};

type RequestedRowInput = {
  itemNo?: unknown;
  brand?: unknown;
  modelNumber?: unknown;
  partNumber?: unknown;
  description?: unknown;
  description2?: unknown;
  description3?: unknown;
  quantity?: unknown;
};

type ImportBody = {
  rows?: RequestedRowInput[];
};

type NormalizedRow = {
  itemNo: string | null;
  treeOrdering: string | null;
  brand: string | null;
  modelNumber: string | null;
  partNumber: string | null;
  description: string | null;
  description2: string | null;
  description3: string | null;
  quantity: number | null;
};

type RowForInsert = NormalizedRow & {
  resolvedTreeOrdering: string;
  parentTreeOrdering: string | null;
  isCategory: boolean;
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

type ColumnLengthKey = RequestedFieldKey | 'ProductDescription';
type ColumnLengthMap = Record<ColumnLengthKey, number | null>;

const REQUESTED_COLUMN_METADATA: Array<{ key: ColumnLengthKey; column: string }> = [
  { key: 'RequestedItemNo', column: 'RequestedItemNo' },
  { key: 'RequestedBrand', column: 'RequestedBrand' },
  { key: 'RequestedModelNo', column: 'RequestedModelNo' },
  { key: 'RequestedPartNo', column: 'RequestedPartNo' },
  { key: 'RequestedDescription', column: 'RequestedDescription' },
  { key: 'RequestedDescription2', column: 'RequestedDescription2' },
  { key: 'RequestedDescription3', column: 'RequestedDescription3' },
  { key: 'RequestedQuantity', column: 'RequestedQuantity' },
  { key: 'ProductDescription', column: 'ProductDescription' },
];

const normalizeString = (value: unknown, maxLength = 255): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = typeof value === 'number' ? String(value) : value;
  const trimmed = str.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeDescription = (value: unknown): string | null => normalizeString(value, 2000);

const normalizeQuantity = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeTreeOrdering = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  return trimmed;
};

const resolveParentOrdering = (treeOrdering: string | null): string | null => {
  if (!treeOrdering) return null;
  const lastDot = treeOrdering.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const parent = treeOrdering.slice(0, lastDot).trim();
  return parent || null;
};

const normalizeRows = (rows: RequestedRowInput[] | undefined): NormalizedRow[] => {
  if (!Array.isArray(rows)) return [];
  const normalized: NormalizedRow[] = [];
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const itemNoRaw = row.itemNo ?? (row as Record<string, unknown>).ItemNo ?? null;
    const itemNo = normalizeString(itemNoRaw ?? null);
    const treeOrdering = normalizeTreeOrdering(itemNoRaw);
    const brand = normalizeString(row.brand ?? (row as Record<string, unknown>).Brand);
    const modelNumber = normalizeString(
      row.modelNumber ?? (row as Record<string, unknown>).ModelNo ?? (row as Record<string, unknown>).ModelNumber,
    );
    const partNumber = normalizeString(
      row.partNumber ?? (row as Record<string, unknown>).PartNo ?? (row as Record<string, unknown>).PartNumber,
    );
    const description = normalizeDescription(row.description ?? (row as Record<string, unknown>).Description);
    const description2 = normalizeDescription(row.description2 ?? (row as Record<string, unknown>).Description2);
    const description3 = normalizeDescription(row.description3 ?? (row as Record<string, unknown>).Description3);
    const quantity = normalizeQuantity(row.quantity ?? (row as Record<string, unknown>).Quantity);
    if (!itemNo && !brand && !modelNumber && !partNumber && !description && !description2 && quantity == null) {
      return;
    }
    normalized.push({
      itemNo,
      treeOrdering,
      brand,
      modelNumber,
      partNumber,
      description,
      description2,
      description3,
      quantity,
    });
  });
  return normalized;
};

const dedupeRowsByTree = (rows: NormalizedRow[]): NormalizedRow[] => {
  const seen = new Map<string, NormalizedRow>();
  rows.forEach((row) => {
    if (!row.treeOrdering) return;
    seen.set(row.treeOrdering, row);
  });
  return Array.from(seen.values());
};

const parseRootSegment = (treeOrdering: string | null): number | null => {
  if (!treeOrdering) return null;
  const firstSegment = treeOrdering.split('.')[0];
  const parsed = Number.parseInt(firstSegment, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const isCategoryCandidate = (row: NormalizedRow) => {
  if (!row) return false;
  const hasDescription = Boolean(row.description || row.description2 || row.description3);
  const hasQuantity = row.quantity != null && !Object.is(row.quantity, 0);
  const hasLookup = Boolean(row.partNumber || row.modelNumber || row.brand);
  return hasDescription && !hasQuantity && !hasLookup;
};

const assignSequentialOrdering = (
  rows: NormalizedRow[],
  lastRootValue: number,
): { rows: RowForInsert[]; nextRoot: number } => {
  let nextRoot = lastRootValue;
  const resolved: RowForInsert[] = [];
  let currentCategoryRoot: string | null = null;
  const childCounters = new Map<string, number>();

  rows.forEach((row) => {
    if (!row) return;
    const isCategory = isCategoryCandidate(row);
    let resolvedTreeOrdering = row.treeOrdering;
    let parentTreeOrdering: string | null = null;

    if (isCategory) {
      if (!resolvedTreeOrdering) {
        nextRoot += 1;
        resolvedTreeOrdering = String(nextRoot);
      } else {
        const rootSegment = parseRootSegment(resolvedTreeOrdering);
        if (rootSegment != null && rootSegment > nextRoot) {
          nextRoot = rootSegment;
        }
      }
      parentTreeOrdering = null;
      currentCategoryRoot = resolvedTreeOrdering;
      childCounters.set(resolvedTreeOrdering, 0);
    } else {
      if (!resolvedTreeOrdering) {
        if (currentCategoryRoot) {
          const nextChildIndex = (childCounters.get(currentCategoryRoot) ?? 0) + 1;
          childCounters.set(currentCategoryRoot, nextChildIndex);
          resolvedTreeOrdering = `${currentCategoryRoot}.${nextChildIndex}`;
          parentTreeOrdering = currentCategoryRoot;
        } else {
          nextRoot += 1;
          resolvedTreeOrdering = String(nextRoot);
        }
      }
      if (!parentTreeOrdering && resolvedTreeOrdering) {
        parentTreeOrdering = resolveParentOrdering(resolvedTreeOrdering);
      }
    }

    resolved.push({
      ...row,
      resolvedTreeOrdering: resolvedTreeOrdering ?? String(nextRoot),
      parentTreeOrdering: parentTreeOrdering,
      isCategory,
    });
  });
  return { rows: resolved, nextRoot };
};

const truncateStringValue = (value: string | null, length: number | null | undefined) => {
  if (value == null) return null;
  if (length == null || length <= 0) return value;
  return value.length > length ? value.slice(0, length) : value;
};

const minPositiveLength = (left: number | null | undefined, right: number | null | undefined) => {
  const normalize = (input: number | null | undefined) =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : null;
  const a = normalize(left);
  const b = normalize(right);
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
};

const applyColumnLengthsToRow = (row: NormalizedRow, lengths: ColumnLengthMap): NormalizedRow => {
  const requestedDescriptionLength = lengths.RequestedDescription;
  const productDescriptionLength = lengths.ProductDescription;
  const combinedDescriptionLength = minPositiveLength(requestedDescriptionLength, productDescriptionLength);
  return {
    ...row,
    itemNo: truncateStringValue(row.itemNo, lengths.RequestedItemNo),
    brand: truncateStringValue(row.brand, lengths.RequestedBrand),
    modelNumber: truncateStringValue(row.modelNumber, lengths.RequestedModelNo),
    partNumber: truncateStringValue(row.partNumber, lengths.RequestedPartNo),
    description: truncateStringValue(row.description, combinedDescriptionLength ?? requestedDescriptionLength),
    description2: truncateStringValue(row.description2, lengths.RequestedDescription2),
    description3: truncateStringValue(row.description3, lengths.RequestedDescription3),
  };
};

const readRequestedColumnLengths = async (pool: ConnectionPool): Promise<ColumnLengthMap> => {
  const defaults: ColumnLengthMap = {
    RequestedItemNo: null,
    RequestedBrand: null,
    RequestedModelNo: null,
    RequestedPartNo: null,
    RequestedDescription: null,
    RequestedDescription2: null,
    RequestedDescription3: null,
    RequestedQuantity: null,
    ProductDescription: null,
  };
  const columnList = REQUESTED_COLUMN_METADATA.map((entry) => `'${entry.column}'`).join(', ');
  const request = pool.request();
  const result = await request.query<{ COLUMN_NAME: string; CHARACTER_MAXIMUM_LENGTH: number | null }>(`
    SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'OfferDetails'
      AND COLUMN_NAME IN (${columnList})
  `);
  result.recordset?.forEach((row) => {
    const meta = REQUESTED_COLUMN_METADATA.find((entry) => entry.column === row.COLUMN_NAME);
    if (!meta) return;
    defaults[meta.key] = row.CHARACTER_MAXIMUM_LENGTH ?? null;
  });
  return defaults;
};

export async function POST(
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

    let body: ImportBody | null = null;
    try {
      body = (await req.json()) as ImportBody;
    } catch {
      body = null;
    }

    const normalizedRowsRaw = normalizeRows(body?.rows);
    if (!normalizedRowsRaw.length) {
      return NextResponse.json({ ok: false, error: 'No valid rows provided' }, { status: 400 });
    }

    const pool = await getPool();
    const columnLengths = await readRequestedColumnLengths(pool);
    const normalizedRows = normalizedRowsRaw.map((row) => applyColumnLengthsToRow(row, columnLengths));

    const rowsWithTree = dedupeRowsByTree(normalizedRows.filter((row) => row.treeOrdering));
    const rowsWithoutTree = normalizedRows.filter((row) => !row.treeOrdering);
    let updatedCount = 0;
    let insertedCount = 0;
    const rowsNeedingInsert: NormalizedRow[] = [...rowsWithoutTree];

    if (rowsWithTree.length) {
      const chunkSize = 200;
      for (let idx = 0; idx < rowsWithTree.length; idx += chunkSize) {
        const chunk = rowsWithTree.slice(idx, idx + chunkSize);
        if (!chunk.length) continue;
        const request = pool.request();
        request.input('__offerId', sql.Int, offerId);
        request.input('__modifiedBy', sql.Int, audit.userId ?? null);
        chunk.forEach((row, chunkIdx) => {
          request.input(`tree_${chunkIdx}`, sql.NVarChar(255), row.treeOrdering);
          request.input(`item_${chunkIdx}`, sql.NVarChar(255), row.itemNo ?? row.treeOrdering);
          request.input(`brand_${chunkIdx}`, sql.NVarChar(255), row.brand);
          request.input(`model_${chunkIdx}`, sql.NVarChar(255), row.modelNumber);
          request.input(`part_${chunkIdx}`, sql.NVarChar(255), row.partNumber);
          request.input(`desc_${chunkIdx}`, sql.NVarChar(sql.MAX), row.description);
          request.input(`desc2_${chunkIdx}`, sql.NVarChar(sql.MAX), row.description2);
          request.input(`desc3_${chunkIdx}`, sql.NVarChar(sql.MAX), row.description3);
          request.input(`qty_${chunkIdx}`, getDecimalType(), row.quantity);
        });
        const values = chunk
          .map((_, chunkIdx) =>
            `(@tree_${chunkIdx}, @item_${chunkIdx}, @brand_${chunkIdx}, @model_${chunkIdx}, @part_${chunkIdx}, @desc_${chunkIdx}, @desc2_${chunkIdx}, @qty_${chunkIdx})`,
          )
          .join(', ');
        const query = `
          DECLARE @payload TABLE (
            TreeOrdering NVARCHAR(255) NOT NULL,
            RequestedItemNo NVARCHAR(255) NULL,
            RequestedBrand NVARCHAR(255) NULL,
            RequestedModelNo NVARCHAR(255) NULL,
            RequestedPartNo NVARCHAR(255) NULL,
            RequestedDescription NVARCHAR(MAX) NULL,
            RequestedDescription2 NVARCHAR(MAX) NULL,
            RequestedDescription3 NVARCHAR(MAX) NULL,
            RequestedQuantity DECIMAL(18, 4) NULL
          );

          INSERT INTO @payload (TreeOrdering, RequestedItemNo, RequestedBrand, RequestedModelNo, RequestedPartNo, RequestedDescription, RequestedDescription2, RequestedDescription3, RequestedQuantity)
          VALUES ${values};

          DECLARE @updated TABLE (TreeOrdering NVARCHAR(255) NOT NULL);

          UPDATE od
          SET
            RequestedItemNo = payload.RequestedItemNo,
            RequestedBrand = payload.RequestedBrand,
            RequestedModelNo = payload.RequestedModelNo,
            RequestedPartNo = payload.RequestedPartNo,
            RequestedDescription = payload.RequestedDescription,
            RequestedDescription2 = payload.RequestedDescription2,
            RequestedDescription3 = payload.RequestedDescription3,
            RequestedQuantity = payload.RequestedQuantity,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @__modifiedBy
          OUTPUT INSERTED.TreeOrdering INTO @updated(TreeOrdering)
          FROM dbo.OfferDetails od
            INNER JOIN @payload payload ON payload.TreeOrdering = od.TreeOrdering
          WHERE od.OfferID = @__offerId;

          SELECT payload.TreeOrdering,
                 payload.RequestedItemNo,
                 payload.RequestedBrand,
                 payload.RequestedModelNo,
                 payload.RequestedPartNo,
                 payload.RequestedDescription,
                 payload.RequestedDescription2,
                 payload.RequestedDescription3,
                 payload.RequestedQuantity
          FROM @payload payload
          WHERE NOT EXISTS (
            SELECT 1 FROM @updated updated WHERE updated.TreeOrdering = payload.TreeOrdering
          );
        `;
        const result = await request.query<{
          TreeOrdering: string | null;
          RequestedItemNo: string | null;
          RequestedBrand: string | null;
          RequestedModelNo: string | null;
          RequestedPartNo: string | null;
          RequestedDescription: string | null;
          RequestedDescription2: string | null;
          RequestedDescription3: string | null;
          RequestedQuantity: number | null;
        }>(query);
        const unmatched = result.recordset ?? [];
        updatedCount += chunk.length - unmatched.length;
        if (unmatched.length) {
          rowsNeedingInsert.push(
            ...unmatched.map((row) => applyColumnLengthsToRow({
              itemNo: row.RequestedItemNo ?? row.TreeOrdering ?? null,
              treeOrdering: row.TreeOrdering ?? null,
              brand: row.RequestedBrand ?? null,
              modelNumber: row.RequestedModelNo ?? null,
              partNumber: row.RequestedPartNo ?? null,
              description: row.RequestedDescription ?? null,
              description2: row.RequestedDescription2 ?? null,
              description3: row.RequestedDescription3 ?? null,
              quantity: row.RequestedQuantity ?? null,
            }, columnLengths)),
          );
        }
      }
    }

    if (!rowsNeedingInsert.length) {
      return NextResponse.json({ ok: true, updated: updatedCount, inserted: 0, total: normalizedRows.length });
    }

    const metaRequest = pool.request();
    metaRequest.input('__offerId', sql.Int, offerId);
    const metaResult = await metaRequest.query<{ LastRootValue: number | null; LastOrdering: number | null }>(`
      SELECT
        MAX(
          TRY_CONVERT(INT,
            CASE
              WHEN CHARINDEX('.', LTRIM(RTRIM(ISNULL(TreeOrdering, '')))) > 0 THEN
                LEFT(LTRIM(RTRIM(ISNULL(TreeOrdering, ''))), CHARINDEX('.', LTRIM(RTRIM(ISNULL(TreeOrdering, '')))) - 1)
              ELSE NULLIF(LTRIM(RTRIM(ISNULL(TreeOrdering, ''))), '')
            END
          )
        ) AS LastRootValue,
        MAX(ISNULL(Ordering, 0)) AS LastOrdering
      FROM dbo.OfferDetails
      WHERE OfferID = @__offerId;
    `);
    const metaRow = metaResult.recordset?.[0] ?? { LastRootValue: 0, LastOrdering: 0 };
    let nextRootValue = Number(metaRow.LastRootValue ?? 0);
    let nextOrderingValue = Number(metaRow.LastOrdering ?? 0) + 1;

    const { rows: rowsToInsert, nextRoot } = assignSequentialOrdering(rowsNeedingInsert, nextRootValue);
    nextRootValue = nextRoot;

    const chunkSize = 200;
    for (let idx = 0; idx < rowsToInsert.length; idx += chunkSize) {
      const chunk = rowsToInsert.slice(idx, idx + chunkSize);
      if (!chunk.length) continue;
      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      request.input('__userId', sql.Int, audit.userId ?? null);
      request.input('__orderingBase', sql.Int, nextOrderingValue);
      chunk.forEach((row, chunkIdx) => {
        request.input(`tree_${chunkIdx}`, sql.NVarChar(255), row.resolvedTreeOrdering);
        request.input(`parent_${chunkIdx}`, sql.NVarChar(255), row.parentTreeOrdering);
        request.input(`item_${chunkIdx}`, sql.NVarChar(255), row.itemNo ?? row.resolvedTreeOrdering);
        request.input(`brand_${chunkIdx}`, sql.NVarChar(255), row.brand);
        request.input(`model_${chunkIdx}`, sql.NVarChar(255), row.modelNumber);
        request.input(`part_${chunkIdx}`, sql.NVarChar(255), row.partNumber);
        request.input(`desc_${chunkIdx}`, sql.NVarChar(sql.MAX), row.description);
        request.input(`desc2_${chunkIdx}`, sql.NVarChar(sql.MAX), row.description2);
        request.input(`desc3_${chunkIdx}`, sql.NVarChar(sql.MAX), row.description3);
        request.input(`rqty_${chunkIdx}`, getDecimalType(), row.quantity);
        request.input(`isCategory_${chunkIdx}`, sql.Bit, row.isCategory ? 1 : 0);
      });
        const values = chunk
          .map((_, chunkIdx) =>
            `(@tree_${chunkIdx}, @parent_${chunkIdx}, @item_${chunkIdx}, @brand_${chunkIdx}, @model_${chunkIdx}, @part_${chunkIdx}, @desc_${chunkIdx}, @desc2_${chunkIdx}, @desc3_${chunkIdx}, @rqty_${chunkIdx}, @isCategory_${chunkIdx})`,
          )
          .join(', ');
        const query = `
        DECLARE @payload TABLE (
          RowNumber INT IDENTITY(1,1) NOT NULL,
          TreeOrdering NVARCHAR(255) NOT NULL,
          ParentTreeOrdering NVARCHAR(255) NULL,
          RequestedItemNo NVARCHAR(255) NULL,
          RequestedBrand NVARCHAR(255) NULL,
          RequestedModelNo NVARCHAR(255) NULL,
          RequestedPartNo NVARCHAR(255) NULL,
          RequestedDescription NVARCHAR(MAX) NULL,
          RequestedDescription2 NVARCHAR(MAX) NULL,
          RequestedDescription3 NVARCHAR(MAX) NULL,
          RequestedQuantity DECIMAL(18, 4) NULL,
          IsCategory BIT NOT NULL
        );

        INSERT INTO @payload (
          TreeOrdering,
          ParentTreeOrdering,
          RequestedItemNo,
          RequestedBrand,
          RequestedModelNo,
          RequestedPartNo,
          RequestedDescription,
          RequestedDescription2,
          RequestedDescription3,
          RequestedQuantity,
          IsCategory
        )
        VALUES ${values};

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
          RequestedItemNo,
          RequestedBrand,
          RequestedModelNo,
          RequestedPartNo,
          RequestedDescription,
          RequestedDescription2,
          RequestedDescription3,
          RequestedQuantity,
          CreatedOn,
          CreatedBy,
          ModifiedOn,
          ModifiedBy
        )
        SELECT
          @__offerId,
          parent.ID,
          payload.TreeOrdering,
          ROW_NUMBER() OVER (ORDER BY payload.RowNumber) + @__orderingBase - 1,
          1,
          0,
          payload.IsCategory,
          NULL,
          0,
          payload.RequestedItemNo,
          payload.RequestedBrand,
          payload.RequestedModelNo,
          payload.RequestedPartNo,
          payload.RequestedDescription,
          payload.RequestedDescription2,
          payload.RequestedDescription3,
          payload.RequestedQuantity,
          SYSUTCDATETIME(),
          @__userId,
          SYSUTCDATETIME(),
          @__userId
        FROM @payload payload
          LEFT JOIN dbo.OfferDetails parent
            ON parent.OfferID = @__offerId AND payload.ParentTreeOrdering IS NOT NULL AND parent.TreeOrdering = payload.ParentTreeOrdering;
      `;
      await request.query(query);
      insertedCount += chunk.length;
      nextOrderingValue += chunk.length;
    }

    return NextResponse.json({ ok: true, updated: updatedCount, inserted: insertedCount, total: normalizedRows.length });
  } catch (err) {
    console.error('Failed to import requested products', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
