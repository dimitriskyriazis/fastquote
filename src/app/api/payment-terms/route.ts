import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { requirePermission } from "../../../lib/authz";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { indexRowsById, logEditAuditDetails, type FieldChange } from "../../../lib/mutationAudit";
import { handleApiError, createErrorResponse } from "../../../lib/errorHandler";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam } from "../../../lib/gridFilters";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";

// Renaming a term is allowed on every row, seeded ones included. Two things read a
// term by Name rather than by ID and will not follow a rename:
// scripts/sql/2026-08-27-payment-terms-assign-customers.sql joins on Name (it
// RAISERRORs on an unresolved name, so it fails loudly), and the customers grid
// row-groups by the Name string. Customers themselves are unaffected: they point at
// Customers.PaymentTermID, which a rename does not touch.

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type PaymentTermRow = {
  PaymentTermID: number | null;
  ID: number | null;
  Name: string | null;
  DescriptionGR: string | null;
  DescriptionEN: string | null;
  CustomerCount: number | null;
  Enabled: boolean | number | null;
};

type PaymentTermRowWithCount = PaymentTermRow & { __totalCount: number | bigint | null };

// CustomerCount is deliberately absent: it is a correlated subquery aliased in the
// SELECT list, and buildWhereAndParams would fall back to [CustomerCount], which
// SQL Server rejects in a WHERE clause.
const COLUMN_EXPRESSIONS: Record<string, string> = {
  PaymentTermID: "dbo.PaymentTerms.ID",
  Name: "dbo.PaymentTerms.Name",
  DescriptionGR: "dbo.PaymentTerms.DescriptionGR",
  DescriptionEN: "dbo.PaymentTerms.DescriptionEN",
  Enabled: "dbo.PaymentTerms.Enabled",
};
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression }));

const buildWhereAndParams = (filterModel: GridRequest["filterModel"]) => {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    // Whitelist only. The colId arrives as a raw JSON key and is interpolated into the
    // SQL text, so an unmapped one must be dropped, never wrapped in brackets: `[` plus
    // an attacker-chosen string closes the identifier and appends statements.
    const columnExpression = COLUMN_EXPRESSIONS[col];
    if (!columnExpression) return;

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

  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { where, params };
};

// Both halves of an ORDER BY term are interpolated into the SQL text and neither can be
// parameterized, so both are whitelisted. The GridRequest type says sort is 'asc' | 'desc'
// but that is erased at runtime: sortModel comes straight off req.json(), so anything can
// arrive in it. An unmapped colId is dropped rather than bracketed.
function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.flatMap((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId];
    if (!expression) return [];
    return [`${expression} ${s.sort === "desc" ? "DESC" : "ASC"}`];
  });
  if (parts.length === 0) return "";
  return `ORDER BY ${parts.join(", ")}`;
}

const normalizeTermId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
  }
  return false;
};

const normalizeTermText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

type PaymentTermUpdateInput = {
  PaymentTermID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedTermUpdate = {
  termId: number;
  field: 'Name' | 'DescriptionGR' | 'DescriptionEN' | 'Enabled';
  value: unknown;
};

type PaymentTermAuditRow = {
  ID: number;
  Name: string | null;
  DescriptionGR: string | null;
  DescriptionEN: string | null;
  Enabled: boolean | number | null;
};

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === "object" && "request" in payload) {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === "object") return inner;
    }
  } catch {
    /* noop */
  }
  return { startRow: 0, endRow: 100 };
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/payment-terms');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, 'managePaymentTerms');
    if (!auth.ok) return auth.response;

    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    // The seeded ids encode the business order, so ID is the default sort:
    // ORDER BY Name would list '120 DAYS' before '30 DAYS'.
    const orderClause = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.PaymentTerms.ID";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    // ID is emitted twice on purpose: PaymentTermID is what the grid columns bind to,
    // and plain ID is what AgGridAll's internal getRowId probes for. Without it the
    // grid assigns a random row id and loses selection across refreshes.
    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.PaymentTerms.ID AS PaymentTermID,
        dbo.PaymentTerms.ID AS ID,
        dbo.PaymentTerms.Name,
        dbo.PaymentTerms.DescriptionGR,
        dbo.PaymentTerms.DescriptionEN,
        (SELECT COUNT(*) FROM dbo.Customers c WHERE c.PaymentTermID = dbo.PaymentTerms.ID) AS CustomerCount,
        dbo.PaymentTerms.Enabled
      FROM dbo.PaymentTerms
      ${combinedWhere}
      ${orderClause}
      ${paging}
    `;

    const pool = await getPool();
    const request = pool.request();
    combinedParams.forEach((param) => request.input(param.key, param.value));
    request.input("__offset", sql.Int, offset);
    request.input("__limit", sql.Int, pageSize);

    const result = await request.query<PaymentTermRowWithCount>(select);
    const rowsWithCount = result.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    return handleApiError(err, { requestId, endpoint: '/api/payment-terms', method: 'POST', userId });
  }
}

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/payment-terms');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, 'managePaymentTerms');
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: PaymentTermUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: PaymentTermUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedTermUpdate[] = updates
      .map((entry) => {
        const termId = normalizeTermId(entry?.PaymentTermID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (
          termId == null ||
          !field ||
          (field !== "Name" &&
            field !== "DescriptionGR" &&
            field !== "DescriptionEN" &&
            field !== "Enabled")
        ) {
          return null;
        }
        return {
          termId,
          field,
          value: entry?.value } as NormalizedTermUpdate;
      })
      .filter((entry): entry is NormalizedTermUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();

    const beforeRequest = pool.request();
    const placeholders = Array.from(new Set(normalized.map((entry) => entry.termId))).map(
      (termId, idx) => {
        const paramName = `term_${idx}`;
        beforeRequest.input(paramName, sql.Int, termId);
        return `@${paramName}`;
      },
    );
    const beforeResult = await beforeRequest.query<PaymentTermAuditRow>(`
      SELECT ID, Name, DescriptionGR, DescriptionEN, Enabled
      FROM dbo.PaymentTerms
      WHERE ID IN (${placeholders.join(", ")})
    `);
    const beforeById = indexRowsById(beforeResult.recordset ?? [], (row) => row.ID);

    // Validate the whole batch before writing any of it. These messages have to reach
    // the grid verbatim, and handleApiError replaces a thrown message with
    // 'An internal error occurred' in production. The normalized value is written back
    // onto the entry so the UPDATE and the audit after-image agree.
    for (const entry of normalized) {
      if (entry.field === "Name") {
        const name = normalizeTermText(entry.value);
        if (!name) {
          return NextResponse.json(
            { ok: false, error: "Payment term name is required." },
            { status: 400 },
          );
        }
        if (name.length > 512) {
          return NextResponse.json(
            { ok: false, error: "Payment term name cannot exceed 512 characters." },
            { status: 400 },
          );
        }
        entry.value = name;
      } else if (entry.field === "Enabled") {
        entry.value = normalizeBooleanInput(entry.value);
      } else {
        // DescriptionGR / DescriptionEN are NVARCHAR(500) NOT NULL with no default, so a
        // blank is a written 400 and never a null bind (which would raise SQL 515).
        const description = normalizeTermText(entry.value);
        if (!description) {
          return NextResponse.json(
            {
              ok: false,
              error:
                entry.field === "DescriptionGR"
                  ? "Greek description is required."
                  : "English description is required.",
            },
            { status: 400 },
          );
        }
        entry.value = description.length > 500 ? description.slice(0, 500) : description;
      }
    }

    for (const entry of normalized) {
      const request = pool.request();
      request.input("termId", sql.Int, entry.termId);
      request.input("userId", sql.NVarChar(450), userId ?? null);
      if (entry.field === "Name") {
        request.input("value", sql.NVarChar(512), entry.value as string);
        await request.query(`
          UPDATE dbo.PaymentTerms
          SET Name = @value,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
          WHERE ID = @termId
        `);
      } else if (entry.field === "DescriptionGR") {
        request.input("value", sql.NVarChar(500), entry.value as string);
        await request.query(`
          UPDATE dbo.PaymentTerms
          SET DescriptionGR = @value,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
          WHERE ID = @termId
        `);
      } else if (entry.field === "DescriptionEN") {
        request.input("value", sql.NVarChar(500), entry.value as string);
        await request.query(`
          UPDATE dbo.PaymentTerms
          SET DescriptionEN = @value,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
          WHERE ID = @termId
        `);
      } else {
        request.input("value", sql.Bit, entry.value ? 1 : 0);
        await request.query(`
          UPDATE dbo.PaymentTerms
          SET Enabled = @value,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
          WHERE ID = @termId
        `);
      }
    }

    const changes: FieldChange[] = normalized.map((entry) => ({
      targetId: entry.termId,
      targetName: beforeById.get(entry.termId)?.Name ?? null,
      field: entry.field,
      before: beforeById.get(entry.termId)?.[entry.field] ?? null,
      after: entry.value,
    }));
    logEditAuditDetails({
      endpoint: '/api/payment-terms',
      method: 'PATCH',
      requestId,
      userId,
      targetEntity: 'paymentTerms',
      targetIds: normalized.map((e) => e.termId),
      changes,
      message: 'Payment term fields updated',
    });

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    // UQ_PaymentTerms_Name. This branch runs before handleApiError, which would
    // replace the message with 'An internal error occurred' in production.
    const sqlNumber = (err as { number?: number } | null)?.number;
    if (sqlNumber === 2627 || sqlNumber === 2601) {
      return await createErrorResponse('A payment term with this name already exists.', 409,
        { requestId, endpoint: '/api/payment-terms', method: 'PATCH', userId });
    }
    return handleApiError(err, { requestId, endpoint: '/api/payment-terms', method: 'PATCH', userId });
  }
}
