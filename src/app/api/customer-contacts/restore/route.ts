import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { requirePermission } from "../../../../lib/authz";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logEditAuditDetails, type FieldChange } from "../../../../lib/mutationAudit";

type RestoreRow = {
  ContactID?: number | null;
  CustomerID?: number | null;
  TitleID?: number | null;
  FirstName?: string | null;
  LastName?: string | null;
  Position?: string | null;
  Importance?: string | null;
  Enabled?: boolean | number | null;
  Phone?: string | null;
  Mobile?: string | null;
  Email?: string | null;
  EmailStatusID?: number | null;
  SecondEmail?: string | null;
  SecondEmailStatusID?: number | null;
  Notes?: string | null;
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows to restore" }, { status: 400 });
    }

    const pool = await getPool();
    let restored = 0;
    const restoredRows: Array<{ id: number; name: string | null }> = [];

    for (const row of rows) {
      const request = pool.request();
      request.input("CustomerID", sql.Int, row.CustomerID ?? null);
      request.input("TitleID", sql.Int, row.TitleID ?? null);
      request.input("FirstName", sql.NVarChar(120), row.FirstName ?? null);
      request.input("LastName", sql.NVarChar(120), row.LastName ?? null);
      request.input("Position", sql.NVarChar(255), row.Position ?? null);
      request.input("Importance", sql.NVarChar(50), row.Importance ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);
      request.input("Phone", sql.NVarChar(120), row.Phone ?? null);
      request.input("Mobile", sql.NVarChar(120), row.Mobile ?? null);
      request.input("Email", sql.NVarChar(320), row.Email ?? null);
      request.input("EmailStatusID", sql.Int, row.EmailStatusID ?? null);
      request.input("SecondEmail", sql.NVarChar(320), row.SecondEmail ?? null);
      request.input("SecondEmailStatusID", sql.Int, row.SecondEmailStatusID ?? null);
      request.input("Notes", sql.NVarChar(2000), row.Notes ?? null);

      const result = await request.query<{ ID: number; FirstName: string | null; LastName: string | null }>(`
        INSERT INTO dbo.Contacts (
          CustomerID, TitleID, FirstName, LastName, Position,
          Importance, Enabled, Phone, Mobile, Email, EmailStatusID,
          SecondEmail, SecondEmailStatusID, Notes,
          CreatedOn, ModifiedOn
        )
        OUTPUT inserted.ID, inserted.FirstName, inserted.LastName
        VALUES (
          @CustomerID, @TitleID, @FirstName, @LastName, @Position,
          @Importance, @Enabled, @Phone, @Mobile, @Email, @EmailStatusID,
          @SecondEmail, @SecondEmailStatusID, @Notes,
          SYSUTCDATETIME(), SYSUTCDATETIME()
        )
      `);
      const inserted = result.recordset?.[0];
      if (inserted?.ID != null) {
        const fullName = [inserted.FirstName, inserted.LastName]
          .map((value) => value?.trim())
          .filter(Boolean)
          .join(' ');
        restoredRows.push({ id: inserted.ID, name: fullName || null });
      }
      restored++;
    }

    if (restoredRows.length > 0) {
      const changes: FieldChange[] = restoredRows.map((row) => ({
        targetId: row.id,
        targetName: row.name,
        field: 'Deleted',
        before: true,
        after: false,
      }));
      logEditAuditDetails({
        endpoint: '/api/customer-contacts/restore',
        method: 'POST',
        requestId,
        userId,
        targetEntity: 'contacts',
        targetIds: restoredRows.map((row) => row.id),
        changes,
        message: 'Contact restored',
      });
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore contacts", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
