import { NextRequest, NextResponse } from "next/server";
import type { Request as SqlRequest } from "mssql";
import { getPool, sql } from "../../../../lib/sql";
import { buildQuickFilterClause, mergeWhereClauses, QueryParam } from "../../../../lib/gridFilters";

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type KnownFilterModel = TextFilterModel;

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
};

type MatrixRequestBody = {
  request?: GridRequest | null;
};

type BrandRow = {
  __totalCount: number | bigint | null;
  BrandID: number | null;
  BrandName: string | null;
};

type RuleAggRow = {
  BrandID: number | null;
  PricingPolicyID: number | null;
  MinTelmaco: number | null;
  MinCustomer: number | null;
};

type GrandAggRow = {
  PricingPolicyID: number | null;
  MinTelmaco: number | null;
  MinCustomer: number | null;
};

const BRAND_COLUMN_EXPRESSIONS: Record<string, string> = {
  BrandName: "dbo.Brands.Name",
};

const QUICK_FILTER_COLUMNS = ["dbo.Brands.Name", "dbo.Brands.ID"];

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = (await req.json().catch(() => null)) as MatrixRequestBody | null;
    const inner = payload?.request;
    if (inner && typeof inner === "object") return inner;
  } catch {
    /* noop */
  }
  return { startRow: 0, endRow: 100 };
}

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typed = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typed).forEach(([col, fm], idx) => {
    if (!fm || fm.filterType !== "text") return;
    if (col !== "BrandName") return;
    const val = String((fm as TextFilterModel).filter ?? "").trim();
    if (!val) return;
    const pBase = `${col}_${idx}`;
    const expr = BRAND_COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    const type = (fm as TextFilterModel).type;
    if (type === "equals") {
      parts.push(`${expr} = @${pBase}`);
      params.push({ key: pBase, value: val });
      return;
    }
    if (type === "startsWith") {
      parts.push(`${expr} LIKE @${pBase}`);
      params.push({ key: pBase, value: `${val}%` });
      return;
    }
    if (type === "endsWith") {
      parts.push(`${expr} LIKE @${pBase}`);
      params.push({ key: pBase, value: `%${val}` });
      return;
    }
    parts.push(`${expr} LIKE @${pBase}`);
    params.push({ key: pBase, value: `%${val}%` });
  });

  return {
    where: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

const normalizeNumeric = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilter = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilter.clause);
    const combinedParams = [...whereParams, ...quickFilter.params];

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;
    const brandSql = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Brands.ID AS BrandID,
        dbo.Brands.Name AS BrandName
      FROM dbo.Brands
      INNER JOIN (
        SELECT DISTINCT BrandID
        FROM dbo.PricingPolicyRules
        WHERE BrandID IS NOT NULL
      ) AS linked ON dbo.Brands.ID = linked.BrandID
      ${combinedWhere}
      ORDER BY dbo.Brands.Name
      ${paging}
    `;
    const brandReq = bindParams(pool.request(), combinedParams);
    brandReq.input("__offset", sql.Int, offset);
    brandReq.input("__limit", sql.Int, pageSize);
    const brandRes = await brandReq.query<BrandRow>(brandSql);
    const brandRows = brandRes.recordset ?? [];
    const rowCount = brandRows.length > 0 ? Number(brandRows[0].__totalCount ?? 0) : 0;

    const brandIds = brandRows
      .map((row) => row.BrandID)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    let ruleAggRows: RuleAggRow[] = [];
    if (brandIds.length > 0) {
      const inParams = brandIds.map((_, idx) => `@__brand_${idx}`).join(", ");
      const rulesReq = pool.request();
      brandIds.forEach((id, idx) => rulesReq.input(`__brand_${idx}`, sql.Int, id));
      const rulesSql = `
        SELECT
          ppr.BrandID,
          ppr.PricingPolicyID,
          MIN(ppr.TelmacoDiscountPercentage) AS MinTelmaco,
          MIN(ppr.CustomerDiscountPercentage) AS MinCustomer
        FROM dbo.PricingPolicyRules ppr
        WHERE ppr.BrandID IS NOT NULL
          AND ppr.BrandID IN (${inParams})
        GROUP BY ppr.BrandID, ppr.PricingPolicyID
      `;
      const rulesRes = await rulesReq.query<RuleAggRow>(rulesSql);
      ruleAggRows = rulesRes.recordset ?? [];
    }

    const grandReq = pool.request();
    const grandRes = await grandReq.query<GrandAggRow>(`
      SELECT
        ppr.PricingPolicyID,
        MIN(ppr.TelmacoDiscountPercentage) AS MinTelmaco,
        MIN(ppr.CustomerDiscountPercentage) AS MinCustomer
      FROM dbo.PricingPolicyRules ppr
      WHERE ppr.BrandID IS NOT NULL
      GROUP BY ppr.PricingPolicyID
    `);
    const grandAggRows = grandRes.recordset ?? [];

    const policiesByBrand = new Map<number, Record<string, { minTelmaco: number | null; minCustomer: number | null }>>();
    ruleAggRows.forEach((row) => {
      const brandId = row.BrandID;
      const policyId = row.PricingPolicyID;
      if (brandId == null || policyId == null) return;
      const key = String(policyId);
      const map = policiesByBrand.get(brandId) ?? {};
      map[key] = {
        minTelmaco: normalizeNumeric(row.MinTelmaco),
        minCustomer: normalizeNumeric(row.MinCustomer),
      };
      policiesByBrand.set(brandId, map);
    });

    const rows = brandRows.map((brand) => {
      const brandId = brand.BrandID;
      const policies = typeof brandId === "number" ? (policiesByBrand.get(brandId) ?? {}) : {};
      const telmacoValues = Object.values(policies)
        .map((cell) => cell?.minTelmaco ?? null)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const customerValues = Object.values(policies)
        .map((cell) => cell?.minCustomer ?? null)
        .filter((value): value is number => value != null && Number.isFinite(value));

      return {
        BrandID: brand.BrandID,
        BrandName: brand.BrandName,
        policies,
        totalMinTelmaco: telmacoValues.length > 0 ? Math.min(...telmacoValues) : null,
        totalMinCustomer: customerValues.length > 0 ? Math.min(...customerValues) : null,
      };
    });

    const grandPolicies: Record<string, { minTelmaco: number | null; minCustomer: number | null }> = {};
    const grandTelmacoValues: number[] = [];
    const grandCustomerValues: number[] = [];
    grandAggRows.forEach((row) => {
      const policyId = row.PricingPolicyID;
      if (policyId == null) return;
      const cell = {
        minTelmaco: normalizeNumeric(row.MinTelmaco),
        minCustomer: normalizeNumeric(row.MinCustomer),
      };
      grandPolicies[String(policyId)] = cell;
      if (cell.minTelmaco != null && Number.isFinite(cell.minTelmaco)) grandTelmacoValues.push(cell.minTelmaco);
      if (cell.minCustomer != null && Number.isFinite(cell.minCustomer)) grandCustomerValues.push(cell.minCustomer);
    });

    const grandTotalRow = {
      BrandID: null,
      BrandName: "Grand Total",
      policies: grandPolicies,
      totalMinTelmaco: grandTelmacoValues.length > 0 ? Math.min(...grandTelmacoValues) : null,
      totalMinCustomer: grandCustomerValues.length > 0 ? Math.min(...grandCustomerValues) : null,
    };

    return NextResponse.json({ ok: true, rows, rowCount, grandTotal: grandTotalRow });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

