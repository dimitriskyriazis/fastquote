import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import type { Request as SqlRequest } from 'mssql';
import { getPool } from '../../../lib/sql';
import { resolveAuditUserId } from '../../../lib/auditTrail';
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
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type GridRequestPayload = {
  request: GridRequest;
  includeAllVersions: boolean;
  expandedVersionGroupIds: number[];
};

type DeleteRequest = {
  OfferIDs?: Array<number | string | null | undefined>;
};

type OfferRow = {
  Description: string | null;
  Title: string | null;
  Comments: string | null;
  CustomerName: string | null;
  PricingPolicyName: string | null;
  SalesMarket: string | null;
  SalesDivision: string | null;
  SalesPerson: string | null;
  SalesCreationPerson: string | null;
  OfferStatus: string | null;
  ERPProjectID: number | null;
  ERPFWCProjectID: number | null;
  ERPFWCProjectShortName: string | null;
  offerId: number | null;
  ParentOfferID: number | null;
  VersionGroupId: number | null;
  IsLatestVersion: number | null;
  HasOtherVersions: number | null;
  CustomerRef: string | null;
  ProtocolNo: number | null;
  OfferContact: string | null;
  OfferVersion: number | null;
  Enabled: boolean | number | null;
  OfferDate: string | null;
  ModifiedOn: string | null;
};

type OfferRowWithCount = OfferRow & { __totalCount: number | bigint | null };

const LATEST_MODIFIED_EXPRESSION = `
  CASE
    WHEN offerDetailsStats.DetailsModifiedOn IS NULL THEN
      CASE
        WHEN dbo.Offer.ModifiedBy = @__auditUserId THEN dbo.Offer.ModifiedOn
        ELSE NULL
      END
    WHEN dbo.Offer.ModifiedOn IS NULL THEN offerDetailsStats.DetailsModifiedOn
    WHEN dbo.Offer.ModifiedBy <> @__auditUserId THEN offerDetailsStats.DetailsModifiedOn
    WHEN offerDetailsStats.DetailsModifiedOn > dbo.Offer.ModifiedOn THEN offerDetailsStats.DetailsModifiedOn
    ELSE dbo.Offer.ModifiedOn
  END
`.trim();

const COLUMN_EXPRESSIONS: Record<string, string> = {
  Description: 'dbo.Offer.Description',
  Title: 'dbo.Offer.Title',
  Comments: 'dbo.Offer.Comments',
  CustomerName: 'dbo.Customers.Name',
  PricingPolicyName: 'dbo.PricingPolicies.Name',
  SalesMarket: 'dbo.Markets.Name',
  SalesDivision: 'dbo.SalesDivision.Name',
  SalesPerson: 'sales.FullName',
  SalesCreationPerson: 'created.FullName',
  OfferStatus: 'dbo.OfferStatus.Name',
  ERPProjectID: 'dbo.Offer.ERPProjectID',
  ERPFWCProjectID: 'dbo.Offer.ERPFWCProjectID',
  ERPFWCProjectShortName: 'fwc.ShortName',
  offerId: 'dbo.Offer.ID',
  CustomerRef: 'dbo.Offer.CustomerRef',
  ProtocolNo: 'dbo.Offer.ProtocolNo',
  OfferContact: 'dbo.Offer.OfferContact',
  OfferVersion: 'dbo.Offer.OfferVersion',
  Enabled: 'dbo.Offer.Enabled',
  OfferDate: 'dbo.Offer.OfferDate',
  ModifiedOn: LATEST_MODIFIED_EXPRESSION,
};
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

const ALLOWED_ROW_GROUP_FIELDS = new Set([
  'CustomerName',
  'PricingPolicyName',
  'SalesMarket',
  'SalesDivision',
  'SalesPerson',
  'OfferStatus',
]);

type GroupField = {
  field: string;
  expression: string;
};

const combineWhereClauses = (...clauses: Array<string | undefined>) => {
  const cleaned = clauses
    .map((clause) => clause?.trim())
    .filter((clause): clause is string => typeof clause === 'string' && clause.length > 0)
    .map((clause) => clause.replace(/^\s*WHERE\s+/i, '').trim())
    .filter((clause) => clause.length > 0);
  if (cleaned.length === 0) return '';
  return `WHERE ${cleaned.join(' AND ')}`;
};

const resolveGroupingFields = (rowGroupCols?: GridRequest['rowGroupCols']): GroupField[] => {
  if (!Array.isArray(rowGroupCols) || rowGroupCols.length === 0) return [];
  const resolved: GroupField[] = [];
  for (const col of rowGroupCols) {
    const candidate = typeof col.field === 'string' && col.field.length > 0
      ? col.field
      : typeof col.colId === 'string' && col.colId.length > 0
        ? col.colId
        : null;
    if (!candidate || !ALLOWED_ROW_GROUP_FIELDS.has(candidate)) {
      return [];
    }
    const expression = COLUMN_EXPRESSIONS[candidate] ?? `[${candidate}]`;
    resolved.push({ field: candidate, expression });
  }
  return resolved;
};

const buildGroupKeyFilter = (fields: GroupField[], keys: Array<string | null>) => {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  for (let idx = 0; idx < keys.length && idx < fields.length; idx += 1) {
    const key = keys[idx];
    const expression = fields[idx].expression;
    if (key === null) {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    const paramName = `__group_key_${idx}`;
    clauses.push(`${expression} = @${paramName}`);
    params.push({ key: paramName, value: key });
  }
  if (clauses.length === 0) {
    return { clause: '', params };
  }
  return { clause: `WHERE ${clauses.join(' AND ')}`, params };
};

// Map a basic AG Grid filter model to SQL WHERE snippets (parameterized)
function buildWhereAndParams(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: '', params: [] as QueryParam[] };

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;

    // Use centralized filter processor
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
  const parts = sortModel.map(s => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    return `${expression} ${s.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(', ')}`;
}

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
          .map((value) => normalizeOfferId(value))
          .filter((value): value is number => value != null)
        : [];
      if (inner && typeof inner === 'object') {
        return { request: inner, includeAllVersions, expandedVersionGroupIds };
      }
      return { request: { startRow: 0, endRow: 100 }, includeAllVersions, expandedVersionGroupIds };
    }
  } catch {
    /* no-op, will fall back to defaults */
  }
  return { request: { startRow: 0, endRow: 100 }, includeAllVersions: false, expandedVersionGroupIds: [] };
}

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const {
      request: gridRequest,
      includeAllVersions,
      expandedVersionGroupIds,
    } = await readGridRequest(req);
    const auditUserId = resolveAuditUserId(req);
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
	        dbo.Offer.ID AS OfferPK,
	        dbo.Offer.Description,
	        dbo.Offer.Title,
	        dbo.Offer.Comments,
	        dbo.Offer.CustomerID,
	        dbo.Customers.Name AS CustomerName,
	        dbo.PricingPolicies.Name AS PricingPolicyName,
	        dbo.Markets.Name AS SalesMarket,
	        dbo.SalesDivision.Name AS SalesDivision,
	        sales.FullName AS SalesPerson,
	        created.FullName AS SalesCreationPerson,
	        dbo.OfferStatus.Name AS OfferStatus,
	        dbo.Offer.ERPProjectID AS ERPProjectID,
	        dbo.Offer.ERPFWCProjectID AS ERPFWCProjectID,
	        fwc.ShortName AS ERPFWCProjectShortName,
	        dbo.Offer.ID AS offerId,
	        dbo.Offer.ParentOfferID,
        COALESCE(versionTree.RootOfferID, dbo.Offer.ID) AS VersionGroupId,
        CASE
          WHEN EXISTS (SELECT 1 FROM dbo.Offer child WHERE child.ParentOfferID = dbo.Offer.ID) THEN 0
          ELSE 1
        END AS IsLatestVersion,
        CASE
          WHEN versionStats.VersionCount > 1 THEN 1
          ELSE 0
        END AS HasOtherVersions,
        dbo.Offer.CustomerRef,
        dbo.Offer.ProtocolNo,
        dbo.Offer.OfferContact,
        dbo.Offer.OfferVersion,
        dbo.Offer.Enabled,
        dbo.Offer.OfferDate,
        ${LATEST_MODIFIED_EXPRESSION} AS ModifiedOn
    `;

    const from = `
      FROM
        dbo.Offer
        LEFT JOIN VersionTree versionTree ON versionTree.ID = dbo.Offer.ID
        LEFT JOIN dbo.Offer rootOffer ON rootOffer.ID = COALESCE(versionTree.RootOfferID, dbo.Offer.ID)
        LEFT JOIN (
          SELECT RootOfferID, COUNT(1) AS VersionCount
          FROM VersionTree
          GROUP BY RootOfferID
        ) AS versionStats ON versionStats.RootOfferID = versionTree.RootOfferID
	        INNER JOIN dbo.Customers ON dbo.Offer.CustomerID = dbo.Customers.ID
	        INNER JOIN dbo.PricingPolicies ON dbo.Offer.PricingPolicyID = dbo.PricingPolicies.ID
	        INNER JOIN dbo.Markets ON dbo.Offer.MarketID = dbo.Markets.ID
	        INNER JOIN dbo.SalesDivision ON dbo.Offer.SalesDivitionID = dbo.SalesDivision.ID
	        INNER JOIN dbo.AspNetUsers AS sales ON dbo.Offer.SalesPersonId = sales.Id
	        LEFT JOIN dbo.AspNetUsers AS created ON dbo.Offer.CreatedBy = created.Id
	        INNER JOIN dbo.OfferStatus ON dbo.Offer.StatusID = dbo.OfferStatus.ID
	        LEFT JOIN dbo.FWCs AS fwc ON fwc.ID = dbo.Offer.ERPFWCProjectID
	        OUTER APPLY (
	          SELECT MAX(od.ModifiedOn) AS DetailsModifiedOn
	          FROM dbo.OfferDetails od
	          WHERE od.OfferID = dbo.Offer.ID
            AND od.ModifiedBy = @__auditUserId
        ) AS offerDetailsStats
    `;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
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
    const combinedWhereWithVersions = mergeWhereClauses(combinedWhere, versionVisibilityClause);
    const combinedParams = [...whereParams, ...quickFilterClause.params, ...expandedParams];
    const defaultOrder = `
      ORDER BY
        COALESCE(rootOffer.Description, dbo.Offer.Description),
        IsLatestVersion DESC,
        dbo.Offer.OfferVersion DESC,
        dbo.Offer.ID DESC
    `.trim();
    const orderClause = buildOrder(gridRequest.sortModel) || defaultOrder;
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const groupingFields = resolveGroupingFields(gridRequest.rowGroupCols);
    const rawGroupKeys = Array.isArray(gridRequest.groupKeys) ? gridRequest.groupKeys : [];
    const groupKeys = rawGroupKeys.slice(0, groupingFields.length);
    const parentFilter = groupingFields.length > 0
      ? buildGroupKeyFilter(groupingFields, groupKeys)
      : { clause: '', params: [] };
    const groupLevel = Math.min(groupKeys.length, groupingFields.length);

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      request.input('__auditUserId', sql.NVarChar(450), auditUserId ?? null);
      return request;
    };

    if (groupingFields.length > 0 && groupLevel < groupingFields.length) {
      const groupWhere = combineWhereClauses(combinedWhereWithVersions, parentFilter.clause);
      const countReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${groupingFields[groupLevel].expression}) AS __groupCount
        ${from}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(`${versionTreeCte} ${countSql}`);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      groupReq.input('__offset', sql.Int, offset);
      groupReq.input('__limit', sql.Int, pageSize);
      const groupSql = `
        SELECT DISTINCT ${groupingFields[groupLevel].expression} AS GroupValue
        ${from}
        ${groupWhere}
        ORDER BY ${groupingFields[groupLevel].expression}
        ${paging}
      `;
      const groupRes = await groupReq.query<{ GroupValue: string | null }>(`${versionTreeCte} ${groupSql}`);
      const rows = (groupRes.recordset ?? []).map((row) => {
        const value = row.GroupValue ?? null;
        return {
          group: true,
          key: value === null ? null : String(value),
          field: groupingFields[groupLevel].field,
          [groupingFields[groupLevel].field]: value,
        };
      });

      return NextResponse.json({ ok: true, rows, rowCount: totalGroupCount });
    }

    const appliedWhere = groupingFields.length > 0
      ? combineWhereClauses(combinedWhereWithVersions, parentFilter.clause)
      : combinedWhereWithVersions;
    const appliedParams = [...combinedParams, ...parentFilter.params];

    const dataSql = `${versionTreeCte} ${select} ${from} ${appliedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), appliedParams);
    dataReq.input('__offset', sql.Int, offset);
    dataReq.input('__limit', sql.Int, pageSize);
    const dataRes = await dataReq.query<OfferRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0
      ? Number(rowsWithCount[0].__totalCount ?? 0)
      : 0;
    const rows = rowsWithCount.map((row: OfferRowWithCount) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "editOffers");
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
          .map((value) => normalizeOfferId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No offers selected for deletion' }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, normalizedIds.length, 'offers', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const chunkSize = 200;
    let deleted = 0;

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;
      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      try {
        const paramNames: string[] = [];
        chunk.forEach((offerId, chunkIdx) => {
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
          WHERE OfferID IN (${idsSql});
        `);

        await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.OfferStatusHistory
          WHERE OfferID IN (${idsSql});
        `);

        const deleteOffersResult = await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.Offer
          WHERE ID IN (${idsSql});
        `);

        await transaction.commit();
        deleted += deleteOffersResult.rowsAffected?.[0] ?? 0;
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
