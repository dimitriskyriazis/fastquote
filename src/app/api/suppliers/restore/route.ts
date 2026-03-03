import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";

type RestoreRow = {
  Name?: string | null;
  TaxID?: string | null;
  Address?: string | null;
  City?: string | null;
  CountryID?: number | null;
  PostalCode?: string | null;
  Phone?: string | null;
  WebSite?: string | null;
  Comments?: string | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows to restore" }, { status: 400 });
    }

    const pool = await getPool();
    const userId = resolveAuditUserId(req);
    let restored = 0;

    for (const row of rows) {
      const request = pool.request();
      request.input("Name", sql.NVarChar(255), row.Name ?? null);
      request.input("TaxID", sql.NVarChar(128), row.TaxID ?? null);
      request.input("Address", sql.NVarChar(500), row.Address ?? null);
      request.input("City", sql.NVarChar(256), row.City ?? null);
      request.input("CountryID", sql.Int, row.CountryID ?? null);
      request.input("PostalCode", sql.NVarChar(20), row.PostalCode ?? null);
      request.input("Phone", sql.NVarChar(50), row.Phone ?? null);
      request.input("WebSite", sql.NVarChar(255), row.WebSite ?? null);
      request.input("Comments", sql.NVarChar(2000), row.Comments ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);
      request.input("UserId", sql.NVarChar(450), userId ?? null);

      await request.query(`
        INSERT INTO dbo.Suppliers (
          [Name], [TaxID], [Address], [City], [CountryID], [PostalCode],
          [Phone], [WebSite], [Comments], [Enabled],
          [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy]
        ) VALUES (
          @Name, @TaxID, @Address, @City, @CountryID, @PostalCode,
          @Phone, @WebSite, @Comments, @Enabled,
          SYSUTCDATETIME(), @UserId, SYSUTCDATETIME(), @UserId
        )
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore suppliers", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
