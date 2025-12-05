import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import type { DropdownOption } from "../../../lib/dropdownOptions";

type CreateCountryBody = {
  name?: string;
};

export async function POST(req: NextRequest) {
  try {
    let payload: CreateCountryBody | null = null;
    try {
      payload = (await req.json()) as CreateCountryBody;
    } catch {
      payload = null;
    }

    const rawName = payload?.name ?? "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      return NextResponse.json({ ok: false, error: "Country name is required" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("__name", sql.NVarChar(512), name);
    const auditUserId = resolveAuditUserId(req);
    request.input("__userId", sql.NVarChar(450), auditUserId ?? null);

    const result = await request.query<{ ID: number; Name: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, Name NVARCHAR(512));
      INSERT INTO dbo.Countries ([Name], [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy], [Enabled])
      OUTPUT INSERTED.ID, INSERTED.Name INTO @Inserted
      VALUES (@__name, SYSUTCDATETIME(), @__userId, SYSUTCDATETIME(), @__userId, 1);
      SELECT TOP 1 ID, Name FROM @Inserted;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error("Unable to create country");
    }

    const option: DropdownOption = {
      value: String(inserted.ID),
      label: inserted.Name?.trim() || name,
    };

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
