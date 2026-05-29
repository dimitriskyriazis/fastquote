import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import { normalizeId, normalizeProbability } from '../../../lib/normalize';
import { BATCH_DELETE_SIZE } from '../../../lib/constants';
import sql from 'mssql';
import type { Request as SqlRequest } from 'mssql';
import { getPool } from '../../../lib/sql';
import { resolveAuditUserId } from '../../../lib/auditTrail';
import { getRequestId } from '../../../lib/requestId';
import {
  logDeleteAuditDetails,
  logEditAuditDetails,
  type FieldChange,
} from '../../../lib/mutationAudit';
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

type OfferUpdateField = 'Probability';

type OfferUpdateInput = {
  OfferID?: number | string | null;
  field?: OfferUpdateField;
  value?: unknown;
};

type OfferPatchRequest = {
  updates?: OfferUpdateInput[];
};

type OfferRow = {
  Description: string | null;
  Title: string | null;
  Comments: string | null;
  CustomerName: string | null;
  CustomerGroup: string | null;
  PricingPolicyName: string | null;
  SalesMarket: string | null;
  SalesDivision: string | null;
  SalesPerson: string | null;
  SalesCreationPerson: string | null;
  CreatedByUserId: string | null;
  OfferStatus: string | null;
  ERPProjectCode: string | null;
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
  ModifiedOnAny: string | null;
  CreatedOn: string | null;
  Probability: number | null;
  PaymentTerms: string | null;
  InstallationSchedule: string | null;
  OfferNotesClosing: string | null;
  OfferValidity: string | null;
  DeliveryTime: string | null;
  OfferNotesIntroduction: string | null;
  ContactFullName: string | null;
  ApprovalUserName: string | null;
  DraftRequestDate: string | null;
  DraftOfferDate: string | null;
  RequestDate: string | null;
  OfferDeadlineDate: string | null;
  OrderSignedDate: string | null;
  DeliveryDueDate: string | null;
  PossibleOrderDate: string | null;
  TotalNet: number | null;
  OfferCurrencySymbol: string | null;
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

const LATEST_MODIFIED_ANY_EXPRESSION = `
  CASE
    WHEN allOfferDetailsStats.DetailsModifiedOn IS NULL THEN dbo.Offer.ModifiedOn
    WHEN dbo.Offer.ModifiedOn IS NULL THEN allOfferDetailsStats.DetailsModifiedOn
    WHEN allOfferDetailsStats.DetailsModifiedOn > dbo.Offer.ModifiedOn THEN allOfferDetailsStats.DetailsModifiedOn
    ELSE dbo.Offer.ModifiedOn
  END
`.trim();

const COLUMN_EXPRESSIONS: Record<string, string> = {
  Description: 'dbo.Offer.Description',
  Title: 'dbo.Offer.Title',
  Comments: 'dbo.Offer.Comments',
  CustomerID: 'dbo.Offer.CustomerID',
  CustomerName: 'dbo.Customers.Name',
  CustomerGroup: 'offerCustomerGroup.Name',
  PricingPolicyName: 'dbo.PricingPolicies.Name',
  SalesMarket: 'dbo.Markets.Name',
  SalesDivision: 'dbo.SalesDivision.Name',
  SalesPerson: 'sales.FullName',
  SalesCreationPerson: 'created.FullName',
  CreatedByUserId: 'dbo.Offer.CreatedBy',
  OfferStatus: 'dbo.OfferStatus.Name',
  ERPProjectCode: 'dbo.Offer.ERPProjectCode',
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
  ModifiedOnAny: LATEST_MODIFIED_ANY_EXPRESSION,
  CreatedOn: 'dbo.Offer.CreatedOn',
  Probability: 'dbo.Offer.Probability',
  PaymentTerms: 'dbo.Offer.PaymentTerms',
  InstallationSchedule: 'dbo.Offer.InstallationSchedule',
  OfferNotesClosing: 'dbo.Offer.OfferNotesClosing',
  OfferValidity: 'dbo.Offer.OfferValidity',
  DeliveryTime: 'dbo.Offer.DeliveryTime',
  OfferNotesIntroduction: 'dbo.Offer.OfferNotesIntroduction',
  ContactFullName: `TRIM(CONCAT(ISNULL(contact.FirstName, ''), ' ', ISNULL(contact.LastName, '')))`,
  ApprovalUserName: 'approval.FullName',
  DraftRequestDate: 'dbo.Offer.DraftRequestDate',
  DraftOfferDate: 'dbo.Offer.DraftOfferDate',
  RequestDate: 'dbo.Offer.RequestDate',
  OfferDeadlineDate: 'dbo.Offer.OfferDeadlineDate',
  OrderSignedDate: 'dbo.Offer.OrderSignedDate',
  DeliveryDueDate: 'dbo.Offer.DeliveryDueDate',
  PossibleOrderDate: 'dbo.Offer.PossibleOrderDate',
  TotalNet: 'offerTotals.TotalNet',
};
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

const ALLOWED_ROW_GROUP_FIELDS = new Set([
  'CustomerName',
  'CustomerGroup',
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

function buildVersionGroupedOrder(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const parts = sortModel.map(s => {
    const alias = `__sort_${s.colId}`;
    return `[${alias}] ${s.sort.toUpperCase()}`;
  });
  parts.push(
    'IsLatestVersion DESC',
    'dbo.Offer.OfferVersion DESC',
    'dbo.Offer.ID DESC',
  );
  return `ORDER BY ${parts.join(', ')}`;
}

function buildVersionGroupedSortColumns(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const columns = sortModel.map(s => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    const alias = `__sort_${s.colId}`;
    return `FIRST_VALUE(${expression}) OVER (
          PARTITION BY COALESCE(versionTree.RootOfferID, dbo.Offer.ID)
          ORDER BY dbo.Offer.OfferVersion DESC
        ) AS [${alias}]`;
  });
  return ', ' + columns.join(', ');
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
          .map((value) => normalizeId(value))
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


export async function POST(req: NextRequest) {
  logRequest(req, '/api/offers');
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
	        offerCustomerGroup.Name AS CustomerGroup,
	        dbo.PricingPolicies.Name AS PricingPolicyName,
	        dbo.Markets.Name AS SalesMarket,
	        dbo.SalesDivision.Name AS SalesDivision,
	        sales.FullName AS SalesPerson,
	        created.FullName AS SalesCreationPerson,
	        dbo.Offer.CreatedBy AS CreatedByUserId,
	        dbo.OfferStatus.Name AS OfferStatus,
	        dbo.Offer.ERPProjectCode AS ERPProjectCode,
	        dbo.Offer.ERPFWCProjectID AS ERPFWCProjectID,
	        fwc.ShortName AS ERPFWCProjectShortName,
	        dbo.Offer.ID AS offerId,
	        dbo.Offer.ParentOfferID,
        COALESCE(versionTree.RootOfferID, dbo.Offer.ID) AS VersionGroupId,
        CASE
          WHEN dbo.Offer.OfferVersion = COALESCE(versionStats.MaxOfferVersion, dbo.Offer.OfferVersion) THEN 1
          ELSE 0
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
        dbo.Offer.Probability,
        dbo.Offer.CreatedOn AS CreatedOn,
        ${LATEST_MODIFIED_EXPRESSION} AS ModifiedOn,
        ${LATEST_MODIFIED_ANY_EXPRESSION} AS ModifiedOnAny,
        dbo.Offer.PaymentTerms,
        dbo.Offer.InstallationSchedule,
        dbo.Offer.OfferNotesClosing,
        dbo.Offer.OfferValidity,
        dbo.Offer.DeliveryTime,
        dbo.Offer.OfferNotesIntroduction,
        TRIM(CONCAT(ISNULL(contact.FirstName, ''), ' ', ISNULL(contact.LastName, ''))) AS ContactFullName,
        approval.FullName AS ApprovalUserName,
        dbo.Offer.DraftRequestDate,
        dbo.Offer.DraftOfferDate,
        dbo.Offer.RequestDate,
        dbo.Offer.OfferDeadlineDate,
        dbo.Offer.OrderSignedDate,
        dbo.Offer.DeliveryDueDate,
        dbo.Offer.PossibleOrderDate,
        offerTotals.TotalNet AS TotalNet,
        offerCurrency.Name AS OfferCurrencySymbol
    `;

    const from = `
      FROM
        dbo.Offer
        LEFT JOIN VersionTree versionTree ON versionTree.ID = dbo.Offer.ID
        LEFT JOIN dbo.Offer rootOffer ON rootOffer.ID = COALESCE(versionTree.RootOfferID, dbo.Offer.ID)
        LEFT JOIN (
          SELECT vt.RootOfferID, COUNT(1) AS VersionCount, MAX(o.OfferVersion) AS MaxOfferVersion
          FROM VersionTree vt
          INNER JOIN dbo.Offer o ON o.ID = vt.ID
          GROUP BY vt.RootOfferID
        ) AS versionStats ON versionStats.RootOfferID = versionTree.RootOfferID
	        INNER JOIN dbo.Customers ON dbo.Offer.CustomerID = dbo.Customers.ID
	        LEFT JOIN dbo.CustomerGroups AS offerCustomerGroup ON dbo.Customers.CustomerGroupID = offerCustomerGroup.ID
	        INNER JOIN dbo.PricingPolicies ON dbo.Offer.PricingPolicyID = dbo.PricingPolicies.ID
	        INNER JOIN dbo.Markets ON dbo.Offer.MarketID = dbo.Markets.ID
	        INNER JOIN dbo.SalesDivision ON dbo.Offer.SalesDivisionID = dbo.SalesDivision.ID
	        INNER JOIN dbo.AspNetUsers AS sales ON dbo.Offer.SalesPersonId = sales.Id
	        LEFT JOIN dbo.AspNetUsers AS created ON dbo.Offer.CreatedBy = created.Id
	        INNER JOIN dbo.OfferStatus ON dbo.Offer.StatusID = dbo.OfferStatus.ID
	        LEFT JOIN dbo.FWCs AS fwc ON fwc.ID = dbo.Offer.ERPFWCProjectID
	        LEFT JOIN dbo.Contacts AS contact ON dbo.Offer.ContactID = contact.ID
	        LEFT JOIN dbo.AspNetUsers AS approval ON dbo.Offer.ApprovalUserId = approval.Id
	        LEFT JOIN dbo.Currencies AS offerCurrency ON offerCurrency.ID = dbo.Offer.CurrencyID
	        OUTER APPLY (
	          SELECT MAX(od.ModifiedOn) AS DetailsModifiedOn
	          FROM dbo.OfferDetails od
	          WHERE od.OfferID = dbo.Offer.ID
            AND od.ModifiedBy = @__auditUserId
        ) AS offerDetailsStats
	        OUTER APPLY (
	          SELECT MAX(od.ModifiedOn) AS DetailsModifiedOn
	          FROM dbo.OfferDetails od
	          WHERE od.OfferID = dbo.Offer.ID
        ) AS allOfferDetailsStats
        OUTER APPLY (
          SELECT SUM(
            CASE
              WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0
                THEN COALESCE(od.TotalNet, 0)
              ELSE 0
            END
          ) AS TotalNet
          FROM dbo.OfferDetails od
          WHERE od.OfferID = dbo.Offer.ID
        ) AS offerTotals
    `;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedWhereWithStandardOffersOnly = mergeWhereClauses(
      combinedWhere,
      'AND ISNULL(dbo.Offer.IsStandardPackage, 0) = 0',
    );
    const expandedParams: QueryParam[] = [];
    let combinedWhereWithVersions: string;
    if (!includeAllVersions) {
      if (expandedVersionGroupIds.length > 0) {
        const placeholders = expandedVersionGroupIds.map((groupId, idx) => {
          const key = `__expanded_group_${idx}`;
          expandedParams.push({ key, value: groupId });
          return `@${key}`;
        });
        const expandedInList = placeholders.join(', ');
        // When version groups are expanded, historical versions must bypass grid filters
        // (e.g. Enabled=true) so ALL versions in the group are shown.
        // Structure: IsStandardPackage=0 AND ((grid_filters AND is_latest_or_in_expanded) OR is_historical_in_expanded)
        const isLatest = 'dbo.Offer.OfferVersion = COALESCE(versionStats.MaxOfferVersion, dbo.Offer.OfferVersion)';
        const inExpandedGroup = `COALESCE(versionTree.RootOfferID, dbo.Offer.ID) IN (${expandedInList})`;
        const isHistorical = 'dbo.Offer.OfferVersion < COALESCE(versionStats.MaxOfferVersion, dbo.Offer.OfferVersion)';

        // Strip leading WHERE from the filter clause so we can wrap it in parens
        const filterClause = combinedWhere.trim();
        const filterCondition = filterClause.replace(/^\s*WHERE\s+/i, '').trim();

        const standardPackageFilter = 'ISNULL(dbo.Offer.IsStandardPackage, 0) = 0';

        if (filterCondition.length > 0) {
          combinedWhereWithVersions = `WHERE ${standardPackageFilter} AND (
            (${filterCondition} AND (${isLatest} OR ${inExpandedGroup}))
            OR (${isHistorical} AND ${inExpandedGroup})
          )`;
        } else {
          combinedWhereWithVersions = `WHERE ${standardPackageFilter} AND (
            ${isLatest} OR ${inExpandedGroup}
          )`;
        }
      } else {
        const versionVisibilityClause = 'AND dbo.Offer.OfferVersion = COALESCE(versionStats.MaxOfferVersion, dbo.Offer.OfferVersion)';
        combinedWhereWithVersions = mergeWhereClauses(combinedWhereWithStandardOffersOnly, versionVisibilityClause);
      }
    } else {
      combinedWhereWithVersions = combinedWhereWithStandardOffersOnly;
    }
    const combinedParams = [...whereParams, ...quickFilterClause.params, ...expandedParams];
    const defaultOrder = `
      ORDER BY
        COALESCE(rootOffer.Description, dbo.Offer.Description),
        IsLatestVersion DESC,
        dbo.Offer.OfferVersion DESC,
        dbo.Offer.ID DESC
    `.trim();
    const hasExpandedGroups = expandedVersionGroupIds.length > 0;
    const hasUserSort = Array.isArray(gridRequest.sortModel) && gridRequest.sortModel.length > 0;
    const useVersionGroupedSort = hasExpandedGroups && hasUserSort;
    const versionSortColumns = useVersionGroupedSort
      ? buildVersionGroupedSortColumns(gridRequest.sortModel)
      : '';
    const orderClause = useVersionGroupedSort
      ? buildVersionGroupedOrder(gridRequest.sortModel)
      : (buildOrder(gridRequest.sortModel) || defaultOrder);
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

    const dataSql = `${versionTreeCte} ${select}${versionSortColumns} ${from} ${appliedWhere} ${orderClause} ${paging}`;
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
      const cleaned = rest as Record<string, unknown>;
      for (const key of Object.keys(cleaned)) {
        if (key.startsWith('__sort_')) {
          delete cleaned[key];
        }
      }
      return cleaned;
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

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/offers');
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    let body: OfferPatchRequest | null = null;
    try {
      body = (await req.json()) as OfferPatchRequest;
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
    const auditChanges: FieldChange[] = [];

    for (const update of rawUpdates) {
      if (!update || update.field !== 'Probability') continue;
      const offerId = normalizeId(update.OfferID);
      if (offerId == null) continue;
      const probability = normalizeProbability(update.value);
      if (probability == null) {
        return NextResponse.json(
          { ok: false, error: 'Probability must be an integer value.' },
          { status: 400 },
        );
      }

      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      request.input('__probability', sql.Int, probability);
      if (auditUserId) {
        request.input('__modifiedBy', sql.NVarChar(450), auditUserId);
      }

      const result = await request.query(`
        UPDATE dbo.Offer
        SET
          Probability = @__probability,
          ModifiedOn = SYSUTCDATETIME()
          ${auditUserId ? ', ModifiedBy = @__modifiedBy' : ''}
        WHERE ID = @__offerId
          AND ISNULL(IsStandardPackage, 0) = 0;
      `);

      const affected = result.rowsAffected?.[0] ?? 0;
      if (affected > 0) {
        auditChanges.push({
          targetId: offerId,
          field: 'Probability',
          before: null,
          after: probability,
        });
      }
      updated += affected;
    }

    if (updated <= 0) {
      return NextResponse.json({ ok: false, error: 'No valid updates were applied' }, { status: 400 });
    }

    if (auditChanges.length > 0) {
      logEditAuditDetails({
        endpoint: '/api/offers',
        method: 'PATCH',
        requestId,
        userId: auditUserId,
        targetEntity: 'offers',
        targetIds: Array.from(new Set(auditChanges.map((change) => change.targetId))),
        changes: auditChanges,
        message: 'Offer fields updated',
      });
    }

    return NextResponse.json({ ok: true, updated });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/offers');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
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
          .map((value) => normalizeId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No offers selected for deletion' }, { status: 400 });
    }

    const pool = await getPool();

    // Check if the current user created all the offers being deleted
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

    const deleteCheck = checkDeletePermission(auth.roles, normalizedIds.length, 'offers', null, { isCreator });
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

        // Renumber remaining versions in affected groups before deletion.
        // Uses the original (still-intact) parent chain to find version groups,
        // then assigns sequential OfferVersion numbers to the versions that will remain.
        await bindParams(new sql.Request(transaction)).query(`
          ;WITH VersionTree AS (
            SELECT ID, ParentOfferID, ID AS RootOfferID
            FROM dbo.Offer
            WHERE ParentOfferID IS NULL
            UNION ALL
            SELECT o.ID, o.ParentOfferID, vt.RootOfferID
            FROM dbo.Offer o
            INNER JOIN VersionTree vt ON o.ParentOfferID = vt.ID
          ),
          AffectedGroups AS (
            SELECT DISTINCT vt.RootOfferID
            FROM VersionTree vt
            WHERE vt.ID IN (${idsSql})
          ),
          RemainingVersions AS (
            SELECT vt.ID,
              ROW_NUMBER() OVER (PARTITION BY vt.RootOfferID ORDER BY o.OfferVersion) AS NewVersion
            FROM VersionTree vt
            INNER JOIN dbo.Offer o ON o.ID = vt.ID
            WHERE vt.RootOfferID IN (SELECT RootOfferID FROM AffectedGroups)
              AND vt.ID NOT IN (${idsSql})
          )
          UPDATE dbo.Offer
          SET OfferVersion = rv.NewVersion
          FROM dbo.Offer
          INNER JOIN RemainingVersions rv ON rv.ID = dbo.Offer.ID
          WHERE dbo.Offer.OfferVersion <> rv.NewVersion;
        `);

        // Re-parent children of deleted offers to prevent orphaned version chains.
        // Each child's ParentOfferID is set to its deleted parent's ParentOfferID.
        // Loop handles cases where multiple versions in the same chain are deleted
        // (e.g. deleting v1 and v2: first pass re-parents v3 to v1, second pass to NULL).
        await bindParams(new sql.Request(transaction)).query(`
          DECLARE @reparented INT = 1;
          WHILE @reparented > 0
          BEGIN
            UPDATE child
            SET child.ParentOfferID = parent.ParentOfferID
            FROM dbo.Offer child
            INNER JOIN dbo.Offer parent ON child.ParentOfferID = parent.ID
            WHERE parent.ID IN (${idsSql})
              AND child.ID NOT IN (${idsSql});
            SET @reparented = @@ROWCOUNT;
          END
        `);

        await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.OfferDetails
          WHERE OfferID IN (
            SELECT ID
            FROM dbo.Offer
            WHERE ID IN (${idsSql})
              AND ISNULL(IsStandardPackage, 0) = 0
          );
        `);

        await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.OfferStatusHistory
          WHERE OfferID IN (
            SELECT ID
            FROM dbo.Offer
            WHERE ID IN (${idsSql})
              AND ISNULL(IsStandardPackage, 0) = 0
          );
        `);

        const deleteOffersResult = await bindParams(new sql.Request(transaction)).query<{ OfferID: number; Title: string | null }>(`
          DELETE FROM dbo.Offer
          OUTPUT DELETED.ID AS OfferID, DELETED.Title
          WHERE ID IN (${idsSql})
            AND ISNULL(IsStandardPackage, 0) = 0;
        `);

        await transaction.commit();
        deleted += deleteOffersResult.rowsAffected?.[0] ?? 0;
        (deleteOffersResult.recordset ?? []).forEach((row) => {
          deletedRows.push({ id: row.OfferID, name: row.Title?.trim() || null });
        });
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    logDeleteAuditDetails({
      endpoint: '/api/offers',
      requestId,
      userId,
      targetEntity: 'offers',
      requestedIds: normalizedIds,
      deletedRows,
      message: 'Offers deleted',
    });

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
