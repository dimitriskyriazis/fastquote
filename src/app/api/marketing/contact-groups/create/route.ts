import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
import { logAddAuditDetails } from "../../../../../lib/mutationAudit";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";

type CreateGroupBody = {
  description?: string | null;
  salesDivisionId?: number | string | null;
  salespersonId?: string | null;
  groupImportance?: string | null;
  note?: string | null;
  enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/contact-groups/create');
  try {
    const auth = await requirePermission(req, "manageMarketing");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as CreateGroupBody | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    }

    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!description) {
      return NextResponse.json({ ok: false, error: "Description is required" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("description", sql.NVarChar(255), description);
    request.input("salesDivisionId", sql.Int, body.salesDivisionId != null ? Number(body.salesDivisionId) || null : null);
    request.input("salespersonId", sql.NVarChar(450), body.salespersonId || null);
    request.input("groupImportance", sql.NVarChar(255), body.groupImportance || null);
    request.input("note", sql.NVarChar(sql.MAX), body.note || null);
    const enabled = body.enabled === true || body.enabled === 1;
    request.input("enabled", sql.Bit, enabled ? 1 : 0);

    const result = await request.query<{ ID: number }>(`
      INSERT INTO dbo.ContactGroups (Description, SalesDivisionID, SalespersonID, GroupImportance, Note, Enabled, TotalCount)
      OUTPUT INSERTED.ID
      VALUES (@description, @salesDivisionId, @salespersonId, @groupImportance, @note, @enabled, 0)
    `);

    const groupId = result.recordset?.[0]?.ID;
    if (groupId == null) {
      return NextResponse.json({ ok: false, error: "Failed to create contact group" }, { status: 500 });
    }

    const auditUserId = resolveAuditUserId(req);
    logAddAuditDetails({
      endpoint: "/api/marketing/contact-groups/create",
      userId: auditUserId,
      targetEntity: "contactGroups",
      createdRows: [{ id: groupId, name: description }],
      message: "Contact group created",
    });

    return NextResponse.json({ ok: true, contactGroupId: groupId });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
