import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../lib/sql";
import { requirePermission } from "../../../../../../lib/authz";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  logRequest(req, '/api/marketing/contact-groups/[groupId]/copy');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { groupId: rawId } = await params;
    const groupId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(groupId)) {
      return NextResponse.json({ ok: false, error: "Invalid group ID" }, { status: 400 });
    }

    const pool = await getPool();

    // Get original group
    const origReq = pool.request();
    origReq.input("groupId", sql.Int, groupId);
    const origResult = await origReq.query(`
      SELECT Description, SalesDivisionID, SalespersonID, GroupImportance, Note, Enabled
      FROM dbo.ContactGroups WHERE ID = @groupId
    `);
    if (!origResult.recordset || origResult.recordset.length === 0) {
      return NextResponse.json({ ok: false, error: "Group not found" }, { status: 404 });
    }

    const orig = origResult.recordset[0] as Record<string, unknown>;

    // Create new group with "(Copy)" suffix
    const createReq = pool.request();
    createReq.input("description", sql.NVarChar(sql.MAX), `${(orig.Description as string) ?? ''} (Copy)`);
    createReq.input("salesDivisionId", sql.Int, orig.SalesDivisionID as number | null);
    createReq.input("salespersonId", sql.NVarChar(450), orig.SalespersonID as string | null);
    createReq.input("groupImportance", sql.NVarChar(255), orig.GroupImportance as string | null);
    createReq.input("note", sql.NVarChar(sql.MAX), orig.Note as string | null);
    createReq.input("enabled", sql.Bit, orig.Enabled ? 1 : 0);
    createReq.input("totalCount", sql.Int, 0);
    const createResult = await createReq.query<{ ID: number }>(`
      INSERT INTO dbo.ContactGroups (Description, SalesDivisionID, SalespersonID, GroupImportance, Note, Enabled, TotalCount)
      OUTPUT INSERTED.ID
      VALUES (@description, @salesDivisionId, @salespersonId, @groupImportance, @note, @enabled, @totalCount)
    `);

    const newGroupId = createResult.recordset?.[0]?.ID;
    if (newGroupId == null) {
      return NextResponse.json({ ok: false, error: "Failed to create copy" }, { status: 500 });
    }

    // Copy members
    const copyReq = pool.request();
    copyReq.input("origGroupId", sql.Int, groupId);
    copyReq.input("newGroupId", sql.Int, newGroupId);
    await copyReq.query(`
      INSERT INTO dbo.ContactsGroupLists (ContactID, ContactGroupID, Importance, Note)
      SELECT ContactID, @newGroupId, Importance, Note
      FROM dbo.ContactsGroupLists
      WHERE ContactGroupID = @origGroupId
    `);

    return NextResponse.json({ ok: true, newGroupId });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
