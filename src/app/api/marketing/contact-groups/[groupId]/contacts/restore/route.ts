import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../../lib/sql";
import { requirePermission } from "../../../../../../../lib/authz";
import { resolveAuditUserId } from "../../../../../../../lib/auditTrail";
import { getRequestId } from "../../../../../../../lib/requestId";
import { logAddAuditDetails } from "../../../../../../../lib/mutationAudit";

// Undo target for the members DELETE: takes the `deletedRows` that route
// returned and re-creates the memberships, Importance/Note included.
type RestoreRow = {
  ContactID?: number | string | null;
  ContactGroupID?: number | string | null;
  Importance?: string | null;
  Note?: string | null;
};

const toInt = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  logRequest(req, '/api/marketing/contact-groups/[groupId]/contacts/restore');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageMarketing");
    if (!auth.ok) return auth.response;

    const { groupId: rawId } = await params;
    const groupId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(groupId)) {
      return NextResponse.json({ ok: false, error: "Invalid group ID" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows to restore" }, { status: 400 });
    }

    const pool = await getPool();
    const restoredContactIds: number[] = [];
    const seen = new Set<number>();

    for (const row of rows) {
      const contactId = toInt(row.ContactID);
      if (contactId == null || seen.has(contactId)) continue;
      seen.add(contactId);
      // Rows remember the group they were removed from; never re-attach them
      // to a different group than the one in the URL.
      const rowGroupId = toInt(row.ContactGroupID);
      if (rowGroupId != null && rowGroupId !== groupId) continue;

      const request = pool.request();
      request.input("groupId", sql.Int, groupId);
      request.input("contactId", sql.Int, contactId);
      request.input("importance", sql.NVarChar(50), row.Importance != null ? String(row.Importance).trim() : null);
      request.input("note", sql.NVarChar(sql.MAX), row.Note != null ? String(row.Note) : null);

      // Idempotent on purpose: the toast Undo and Ctrl+Z share one undo entry,
      // but a retried restore must not create a duplicate membership, and a
      // contact or group deleted in the meantime must not resurrect a dangling row.
      const result = await request.query<{ ID: number }>(`
        INSERT INTO dbo.ContactsGroupLists (ContactID, ContactGroupID, Importance, Note)
        OUTPUT INSERTED.ID
        SELECT @contactId, @groupId, @importance, @note
        WHERE EXISTS (SELECT 1 FROM dbo.Contacts WHERE ID = @contactId)
          AND EXISTS (SELECT 1 FROM dbo.ContactGroups WHERE ID = @groupId)
          AND NOT EXISTS (
            SELECT 1 FROM dbo.ContactsGroupLists
            WHERE ContactGroupID = @groupId AND ContactID = @contactId
          )
      `);
      if ((result.recordset?.length ?? 0) > 0) restoredContactIds.push(contactId);
    }

    if (restoredContactIds.length > 0) {
      logAddAuditDetails({
        endpoint: '/api/marketing/contact-groups/[groupId]/contacts/restore',
        method: 'POST',
        requestId,
        userId: auditUserId,
        targetEntity: 'contactGroupMembers',
        createdRows: restoredContactIds.map((contactId) => ({
          id: contactId,
          name: null,
          groupId,
        })),
        message: `Contacts restored to contact group ID ${groupId}`,
      });
    }

    return NextResponse.json({ ok: true, restored: restoredContactIds.length });
  } catch (err) {
    console.error("Failed to restore contact group members", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
