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
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
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

function buildOrder(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    return `${expression} ${s.sort.toUpperCase()}`;
  });
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
        COUNT_BIG(1) OVER () AS __totalCount,
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
      LEFT JOIN (
        SELECT RootOfferID, COUNT(1) AS VersionCount
        FROM VersionTree
        GROUP BY RootOfferID
      ) AS versionStats ON versionStats.RootOfferID = versionTree.RootOfferID
    `;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedWhereWithStandardPackages = mergeWhereClauses(
      combinedWhere,
      'AND ISNULL(dbo.Offer.IsStandardPackage, 0) = 1',
    );

    const expandedParams: QueryParam[] = [];
    let versionVisibilityClause = '';
    if (!includeAllVersions) {
      if (expandedVersionGroupIds.length > 0) {
        const placeholders = expandedVersionGroupIds.map((groupId, idx) => {
          const key = `__expanded_group_${idx}`;
          expandedParams.push({ key, value: groupId });
          return `@${key}`;
        });
        versionVisibilityClause = `
          AND (
            NOT EXISTS (SELECT 1 FROM dbo.Offer child WHERE child.ParentOfferID = dbo.Offer.ID)
            OR COALESCE(versionTree.RootOfferID, dbo.Offer.ID) IN (${placeholders.join(', ')})
          )
        `;
      } else {
        versionVisibilityClause = 'AND NOT EXISTS (SELECT 1 FROM dbo.Offer child WHERE child.ParentOfferID = dbo.Offer.ID)';
      }
    }

    const combinedWhereWithVersions = mergeWhereClauses(combinedWhereWithStandardPackages, versionVisibilityClause);
    const combinedParams = [...whereParams, ...quickFilterClause.params, ...expandedParams];
    const orderClause = buildOrder(gridRequest.sortModel) || `
      ORDER BY
        dbo.Offer.Description,
        IsLatestVersion DESC,
        dbo.Offer.OfferVersion DESC,
        dbo.Offer.ID DESC
    `;
    const paging = 'OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY';

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    const dataSql = `${versionTreeCte} ${select} ${from} ${combinedWhereWithVersions} ${orderClause} ${paging}`;
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
      return rest;
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
