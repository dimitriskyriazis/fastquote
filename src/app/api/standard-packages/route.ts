import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import sql from 'mssql';
import type { Request as SqlRequest } from 'mssql';
import { getPool } from '../../../lib/sql';
import { resolveAuditUserId } from '../../../lib/auditTrail';
import { getRequestId } from '../../../lib/requestId';
import { logDeleteAuditDetails } from '../../../lib/mutationAudit';
import { normalizeId } from '../../../lib/normalize';
import { BATCH_DELETE_SIZE } from '../../../lib/constants';
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from '../../../lib/gridFilters';
import { requirePermission } from '../../../lib/authz';
import { checkDeletePermission } from '../../../lib/deletePermissions';
import { KnownFilterModel } from '../../../lib/filterTypes';
import { processFilter } from '../../../lib/filterProcessing';
import { sqlBracketId, sqlSortDirection } from '../../../lib/sqlIdentifier';

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
};

type GridRequestPayload = {
  request: GridRequest;
  includeAllVersions: boolean;
  expandedVersionGroupIds: number[];
};

type DeleteRequest = {
  OfferIDs?: Array<number | string | null | undefined>;
};

type StandardPackageUpdateField = 'Description' | 'Comments' | 'Enabled';

type StandardPackageUpdateInput = {
  OfferID?: number | string | null;
  field?: StandardPackageUpdateField;
  value?: unknown;
};

type StandardPackagePatchRequest = {
  updates?: StandardPackageUpdateInput[];
};

type StandardPackageRow = {
  ID: number | null;
  offerId: number | null;
  Description: string | null;
  CreatedOn: string | null;
  CreatedBy: string | null;
  CreatedByUserId: string | null;
  ModifiedOn: string | null;
  ModifiedBy: string | null;
  Comments: string | null;
  Enabled: boolean | number | null;
  OfferVersion: number | null;
  ParentOfferID: number | null;
  IsStandardPackage: boolean | number | null;
  VersionGroupId: number | null;
  IsLatestVersion: number | null;
  HasOtherVersions: number | null;
};

type StandardPackageRowWithCount = StandardPackageRow & { __totalCount: number | bigint | null };

const MODIFIED_BY_DISPLAY_EXPRESSION = `
  COALESCE(
    NULLIF(LTRIM(RTRIM(CAST(modified.FullName AS NVARCHAR(450)))), ''),
    NULLIF(LTRIM(RTRIM(CAST(modified.UserName AS NVARCHAR(450)))), ''),
    CAST(dbo.Offer.ModifiedBy AS NVARCHAR(450))
  )
`.trim();

const CREATED_BY_DISPLAY_EXPRESSION = `
  COALESCE(
    NULLIF(LTRIM(RTRIM(CAST(created.FullName AS NVARCHAR(450)))), ''),
    NULLIF(LTRIM(RTRIM(CAST(created.UserName AS NVARCHAR(450)))), ''),
    CAST(dbo.Offer.CreatedBy AS NVARCHAR(450))
  )
`.trim();

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ID: 'dbo.Offer.ID',
  offerId: 'dbo.Offer.ID',
  Description: 'dbo.Offer.Description',
  CreatedOn: 'dbo.Offer.CreatedOn',
  CreatedBy: CREATED_BY_DISPLAY_EXPRESSION,
  CreatedByUserId: 'dbo.Offer.CreatedBy',
  ModifiedOn: 'dbo.Offer.ModifiedOn',
  ModifiedBy: MODIFIED_BY_DISPLAY_EXPRESSION,
  Comments: 'dbo.Offer.Comments',
  Enabled: 'dbo.Offer.Enabled',
  OfferVersion: 'dbo.Offer.OfferVersion',
  ParentOfferID: 'dbo.Offer.ParentOfferID',
  IsStandardPackage: 'dbo.Offer.IsStandardPackage',
};

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

function buildWhereAndParams(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: '', params: [] as QueryParam[] };

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? sqlBracketId(col);
    const result = processFilter(fm, {
      columnExpression,
      columnId: col,
      paramBase: pBase,
    });

    if (result.clause) {
      parts.push(result.clause);
      params.push(...result.params);
    }
  });

  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  return { where, params };
}

const VERSION_GROUP_EXPRESSION = 'COALESCE(versionTree.RootOfferID, dbo.Offer.ID)';

// User-sort columns are applied at the GROUP level via a FIRST_VALUE-of-latest alias so every
// version of a package stays contiguous (the data query wraps the projection in outer layers, so
// these are referenced as projected aliases). Mirrors the offers list.
function buildVersionGroupedSortColumns(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const columns = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? sqlBracketId(s.colId);
    const alias = `__sort_${s.colId}`;
    return `FIRST_VALUE(${expression}) OVER (
          PARTITION BY ${VERSION_GROUP_EXPRESSION}
          ORDER BY dbo.Offer.OfferVersion DESC
        ) AS ${sqlBracketId(alias)}`;
  });
  return ', ' + columns.join(', ');
}

function buildVersionGroupedOrder(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  // FIRST_VALUE-of-latest per column keeps a package's versions together; VersionGroupId breaks
  // ties between distinct groups whose latest versions share the sort value; the per-row keys
  // order versions within a group (anchor first, newest→oldest); ID keeps paging deterministic.
  const parts = sortModel.map((s) => `${sqlBracketId(`__sort_${s.colId}`)} ${sqlSortDirection(s.sort)}`);
  parts.push(
    'VersionGroupId',
    'IsLatestVersion DESC',
    'OfferVersion DESC',
    'ID DESC',
  );
  return `ORDER BY ${parts.join(', ')}`;
}

const normalizeNullableText = (value: unknown, maxLength = 2000): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeEnabled = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  }
  return null;
};

async function readGridRequest(req: NextRequest): Promise<GridRequestPayload> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === 'object') {
      const inner = (payload as { request?: GridRequest }).request;
      const includeAllVersions = Boolean(
        (payload as { includeAllVersions?: unknown }).includeAllVersions,
      );
      const rawExpanded = (payload as { expandedVersionGroupIds?: unknown }).expandedVersionGroupIds;
      const expandedVersionGroupIds = Array.isArray(rawExpanded)
        ? rawExpanded
          .map((value) => normalizeId(value))
          .filter((value): value is number => value != null)
        : [];
      if (inner && typeof inner === 'object') {
        return { request: inner, includeAllVersions, expandedVersionGroupIds };
      }
      return { request: { startRow: 0, endRow: 100 }, includeAllVersions, expandedVersionGroupIds };
    }
  } catch {
    /* no-op */
  }
  return { request: { startRow: 0, endRow: 100 }, includeAllVersions: false, expandedVersionGroupIds: [] };
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/standard-packages');
  try {
    const {
      request: gridRequest,
      includeAllVersions,
      expandedVersionGroupIds,
    } = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = Math.max(0, startRow);

    const versionTreeCte = `
      WITH VersionTree AS (
        SELECT ID, ParentOfferID, ID AS RootOfferID
        FROM dbo.Offer
        WHERE ParentOfferID IS NULL
        UNION ALL
        SELECT o.ID, o.ParentOfferID, vt.RootOfferID
        FROM dbo.Offer o
        INNER JOIN VersionTree vt ON o.ParentOfferID = vt.ID
      )
    `;

    const select = `
      SELECT
        dbo.Offer.ID AS ID,
        dbo.Offer.ID AS offerId,
        dbo.Offer.Description,
        dbo.Offer.CreatedOn,
        ${CREATED_BY_DISPLAY_EXPRESSION} AS CreatedBy,
        dbo.Offer.CreatedBy AS CreatedByUserId,
        dbo.Offer.ModifiedOn,
        ${MODIFIED_BY_DISPLAY_EXPRESSION} AS ModifiedBy,
        dbo.Offer.Comments,
        dbo.Offer.Enabled,
        dbo.Offer.OfferVersion,
        dbo.Offer.ParentOfferID,
        dbo.Offer.IsStandardPackage,
        COALESCE(versionTree.RootOfferID, dbo.Offer.ID) AS VersionGroupId,
        CASE
          WHEN EXISTS (SELECT 1 FROM dbo.Offer child WHERE child.ParentOfferID = dbo.Offer.ID) THEN 0
          ELSE 1
        END AS IsLatestVersion,
        CASE
          WHEN versionStats.VersionCount > 1 THEN 1
          ELSE 0
        END AS HasOtherVersions
    `;

    const from = `
      FROM dbo.Offer
      LEFT JOIN dbo.AspNetUsers AS created ON dbo.Offer.CreatedBy = created.Id
      LEFT JOIN dbo.AspNetUsers AS modified ON dbo.Offer.ModifiedBy = modified.Id
      LEFT JOIN VersionTree versionTree ON versionTree.ID = dbo.Offer.ID
      LEFT JOIN dbo.Offer rootOffer ON rootOffer.ID = COALESCE(versionTree.RootOfferID, dbo.Offer.ID)
      LEFT JOIN (
        SELECT RootOfferID, COUNT(1) AS VersionCount
        FROM VersionTree
        GROUP BY RootOfferID
      ) AS versionStats ON versionStats.RootOfferID = versionTree.RootOfferID
    `;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);

    // The grid filter (including the default Enabled=true) is no longer a hard WHERE; it becomes a
    // per-row match flag so a version group surfaces whenever ANY version matches — even when the
    // latest version does not. This fixes the same "filter only matches an old version → the
    // package disappears unless you pre-expand it" bug as the offers list. See
    // src/app/api/offers/route.ts for the detailed rationale.
    const filterCondition = combinedWhere.trim().replace(/^\s*WHERE\s+/i, '').trim();
    const filterExpr = filterCondition.length > 0 ? `(${filterCondition})` : '1=1';

    // Groups the user explicitly expanded (clicked the ▸ toggle) show every version.
    const expandedParams: QueryParam[] = [];
    let expandedExpr = '1 = 0';
    if (expandedVersionGroupIds.length > 0) {
      const placeholders = expandedVersionGroupIds.map((groupId, idx) => {
        const key = `__expanded_group_${idx}`;
        expandedParams.push({ key, value: groupId });
        return `@${key}`;
      });
      expandedExpr = `${VERSION_GROUP_EXPRESSION} IN (${placeholders.join(', ')})`;
    }

    // Innermost annotations. IsLatestVersion (a "no children" leaf check) is already projected by
    // `select`; here we add the per-row match flag and the expand/order helpers. The per-group
    // window aggregates are computed in a SEPARATE layer below — the leaf check is a subquery and
    // SQL Server forbids a subquery inside an aggregate function's argument, so __matchesFilter /
    // IsLatestVersion must be plain columns before they can be fed to MAX(...) OVER (...).
    const matchColumns = `,
        CASE WHEN ${filterExpr} THEN 1 ELSE 0 END AS __matchesFilter,
        CASE WHEN ${expandedExpr} THEN 1 ELSE 0 END AS __inExpandedGroup,
        COALESCE(rootOffer.Description, dbo.Offer.Description) AS __rootDescription`;

    // Visibility predicate (see offers route): the latest version of any matching group (anchor),
    // plus a matching historical version only when the latest itself does NOT match (so the default
    // Enabled=true view stays collapsed), plus everything in an explicitly expanded group.
    const visibilityWhere = includeAllVersions
      ? 'WHERE __matchesFilter = 1'
      : `WHERE (
          (IsLatestVersion = 1 AND __groupHasMatch = 1)
          OR (IsLatestVersion = 0 AND __matchesFilter = 1 AND __latestMatches = 0)
          OR __inExpandedGroup = 1
        )`;

    const combinedParams = [...whereParams, ...quickFilterClause.params, ...expandedParams];
    const defaultOrder = `
      ORDER BY
        __rootDescription,
        VersionGroupId,
        IsLatestVersion DESC,
        OfferVersion DESC,
        ID DESC
    `.trim();
    // Group-level ordering applies whenever the user sorts (not only when a group is expanded), so a
    // rescued historical row stays adjacent to its anchor instead of scattering by the flat sort.
    const hasUserSort = Array.isArray(gridRequest.sortModel) && gridRequest.sortModel.length > 0;
    const versionSortColumns = hasUserSort
      ? buildVersionGroupedSortColumns(gridRequest.sortModel)
      : '';
    const orderClause = hasUserSort
      ? buildVersionGroupedOrder(gridRequest.sortModel)
      : defaultOrder;
    const paging = 'OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY';

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    // Three layers: (A) base rows + leaf/match flags, (B) per-group window aggregates, (C) the
    // version-visibility filter + total count + ordering/paging. The aggregates get their own layer
    // so the leaf-check subquery is never nested inside an aggregate function's argument.
    const flagged = `${select}${versionSortColumns}${matchColumns} ${from} WHERE ISNULL(dbo.Offer.IsStandardPackage, 0) = 1`;
    const grouped = `
      SELECT flagged.*,
        MAX(flagged.__matchesFilter) OVER (PARTITION BY flagged.VersionGroupId) AS __groupHasMatch,
        MAX(CASE WHEN flagged.IsLatestVersion = 1 THEN flagged.__matchesFilter ELSE 0 END)
          OVER (PARTITION BY flagged.VersionGroupId) AS __latestMatches
      FROM (${flagged}) AS flagged
    `;
    const dataSql = `${versionTreeCte}
      SELECT visible.*, COUNT_BIG(1) OVER () AS __totalCount
      FROM (${grouped}) AS visible
      ${visibilityWhere}
      ${orderClause}
      ${paging}`;
    const dataReq = bindParams(pool.request(), combinedParams);
    dataReq.input('__offset', sql.Int, offset);
    dataReq.input('__limit', sql.Int, pageSize);
    const dataRes = await dataReq.query<StandardPackageRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0
      ? Number(rowsWithCount[0].__totalCount ?? 0)
      : 0;
    const rows = rowsWithCount.map((row: StandardPackageRowWithCount) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      const cleaned = rest as Record<string, unknown>;
      // Drop internal helper columns (__matchesFilter, __groupHasMatch, __sort_*, __rootDescription, …)
      for (const key of Object.keys(cleaned)) {
        if (key.startsWith('__')) {
          delete cleaned[key];
        }
      }
      return cleaned;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/standard-packages');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    let body: StandardPackagePatchRequest | null = null;
    try {
      body = (await req.json()) as StandardPackagePatchRequest;
    } catch {
      body = null;
    }

    const rawUpdates = Array.isArray(body?.updates) ? body.updates : [];
    if (rawUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: 'No updates provided' }, { status: 400 });
    }

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);
    let updated = 0;

    for (const update of rawUpdates) {
      if (!update || !update.field) continue;
      const offerId = normalizeId(update.OfferID);
      if (offerId == null) continue;

      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      if (auditUserId) {
        request.input('__modifiedBy', sql.NVarChar(450), auditUserId);
      }

      let updateClause = '';
      if (update.field === 'Description') {
        const normalized = normalizeNullableText(update.value, 2000);
        if (!normalized) {
          return NextResponse.json({ ok: false, error: 'Description is required.' }, { status: 400 });
        }
        request.input('__value', sql.NVarChar(2000), normalized);
        updateClause = 'Description = @__value';
      } else if (update.field === 'Comments') {
        const normalized = normalizeNullableText(update.value, 2000);
        request.input('__value', sql.NVarChar(2000), normalized);
        updateClause = 'Comments = @__value';
      } else if (update.field === 'Enabled') {
        const normalized = normalizeEnabled(update.value);
        if (normalized == null) {
          return NextResponse.json({ ok: false, error: 'Enabled must be Yes/No.' }, { status: 400 });
        }
        request.input('__value', sql.Bit, normalized);
        updateClause = 'Enabled = @__value';
      } else {
        continue;
      }

      const result = await request.query(`
        UPDATE dbo.Offer
        SET
          ${updateClause},
          ModifiedOn = SYSUTCDATETIME()
          ${auditUserId ? ', ModifiedBy = @__modifiedBy' : ''}
        WHERE ID = @__offerId
          AND ISNULL(IsStandardPackage, 0) = 1;
      `);
      updated += result.rowsAffected?.[0] ?? 0;
    }

    if (updated <= 0) {
      return NextResponse.json({ ok: false, error: 'No valid updates were applied' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, updated });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/standard-packages');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    let body: DeleteRequest | null = null;
    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      body = null;
    }

    const rawIds = body != null && Array.isArray(body.OfferIDs) ? body.OfferIDs : [];
    const normalizedIds = Array.from(
      new Set(
        rawIds
          .map((value) => normalizeId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No standard packages selected for deletion' }, { status: 400 });
    }

    const pool = await getPool();

    // Check if the current user created all the standard packages being deleted
    const creatorCheckReq = pool.request();
    creatorCheckReq.input('__creatorUserId', sql.NVarChar, auth.userId);
    const creatorParamNames: string[] = [];
    normalizedIds.forEach((id, idx) => {
      const paramName = `__crOffer_${idx}`;
      creatorCheckReq.input(paramName, sql.Int, id);
      creatorParamNames.push(`@${paramName}`);
    });
    const creatorResult = await creatorCheckReq.query<{ Total: number; CreatedByUser: number }>(`
      SELECT
        COUNT(1) AS Total,
        SUM(CASE WHEN CreatedBy = @__creatorUserId THEN 1 ELSE 0 END) AS CreatedByUser
      FROM dbo.Offer
      WHERE ID IN (${creatorParamNames.join(', ')})
    `);
    const creatorRow = creatorResult.recordset[0];
    const isCreator = creatorRow != null && creatorRow.Total > 0 && creatorRow.Total === creatorRow.CreatedByUser;

    const deleteCheck = checkDeletePermission(auth.roles, normalizedIds.length, 'standardPackages', null, { isCreator });
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }
    const chunkSize = BATCH_DELETE_SIZE;
    let deleted = 0;
    const deletedRows: Array<{ id: number; name: string | null }> = [];

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;
      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      try {
        const paramNames: string[] = [];
        chunk.forEach((_, chunkIdx) => {
          const paramName = `offer_${chunkIdx}`;
          paramNames.push(`@${paramName}`);
        });
        const idsSql = paramNames.join(', ');

        const bindParams = (request: SqlRequest) => {
          chunk.forEach((offerId, chunkIdx) => {
            request.input(`offer_${chunkIdx}`, sql.Int, offerId);
          });
          return request;
        };

        await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.OfferDetails
          WHERE OfferID IN (
            SELECT ID
            FROM dbo.Offer
            WHERE ID IN (${idsSql})
              AND ISNULL(IsStandardPackage, 0) = 1
          );
        `);

        await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.OfferStatusHistory
          WHERE OfferID IN (
            SELECT ID
            FROM dbo.Offer
            WHERE ID IN (${idsSql})
              AND ISNULL(IsStandardPackage, 0) = 1
          );
        `);

        const deleteOffersResult = await bindParams(new sql.Request(transaction)).query<{
          OfferID: number;
          Description: string | null;
        }>(`
          DELETE FROM dbo.Offer
          OUTPUT DELETED.ID AS OfferID, DELETED.Description
          WHERE ID IN (${idsSql})
            AND ISNULL(IsStandardPackage, 0) = 1;
        `);

        await transaction.commit();
        deleted += deleteOffersResult.rowsAffected?.[0] ?? 0;
        (deleteOffersResult.recordset ?? []).forEach((row) => {
          deletedRows.push({ id: row.OfferID, name: row.Description?.trim() || null });
        });
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    logDeleteAuditDetails({
      endpoint: '/api/standard-packages',
      requestId,
      userId,
      targetEntity: 'standardPackages',
      requestedIds: normalizedIds,
      deletedRows,
      message: 'Standard packages deleted',
    });

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
