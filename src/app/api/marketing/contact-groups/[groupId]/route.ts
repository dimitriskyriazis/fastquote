import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  logRequest(req, '/api/marketing/contact-groups/[groupId]');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { groupId: rawId } = await params;
    const groupId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(groupId)) {
      return NextResponse.json({ ok: false, error: "Invalid group ID" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("groupId", sql.Int, groupId);
    const result = await request.query(`
      SELECT
        cg.ID AS ContactGroupID,
        cg.Description,
        sd.Name AS Division,
        cg.GroupImportance,
        cg.SalespersonID,
        cg.Note,
        cg.Enabled,
        (SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID) AS TotalCount
      FROM dbo.ContactGroups cg
      LEFT JOIN dbo.SalesDivision sd ON sd.ID = cg.SalesDivisionID
      WHERE cg.ID = @groupId
    `);

    if (!result.recordset || result.recordset.length === 0) {
      return NextResponse.json({ ok: false, error: "Contact group not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, group: result.recordset[0] });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  logRequest(req, '/api/marketing/contact-groups/[groupId]');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { groupId: rawId } = await params;
    const groupId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(groupId)) {
      return NextResponse.json({ ok: false, error: "Invalid group ID" }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
    }

    const pool = await getPool();
    const { field, value } = body as { field?: string; value?: unknown };
    if (!field) {
      return NextResponse.json({ ok: false, error: "Missing field" }, { status: 400 });
    }

    const request = pool.request();
    request.input("groupId", sql.Int, groupId);

    if (field === "Description" || field === "Note") {
      request.input("value", sql.NVarChar(sql.MAX), value != null ? String(value).trim() : null);
      await request.query(`UPDATE dbo.ContactGroups SET [${field}] = @value WHERE ID = @groupId`);
    } else if (field === "GroupImportance") {
      request.input("value", sql.NVarChar(255), value != null ? String(value).trim() : null);
      await request.query(`UPDATE dbo.ContactGroups SET GroupImportance = @value WHERE ID = @groupId`);
    } else if (field === "Enabled") {
      const boolVal = value === true || value === 1 || value === "true" || value === "Yes";
      request.input("value", sql.Bit, boolVal ? 1 : 0);
      await request.query(`UPDATE dbo.ContactGroups SET Enabled = @value WHERE ID = @groupId`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
