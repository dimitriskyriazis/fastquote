import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const isGreek = (name: string | null | undefined): boolean => {
  if (!name) return false;
  return /[\u0370-\u03FF]/.test(name);
};

type ContactRow = {
  CustomerName: string | null;
  Title: string | null;
  LastName: string | null;
  FirstName: string | null;
  Email: string | null;
  Fax: string | null;
};

function buildExcelBuffer(rows: ContactRow[], sheetName: string): ArrayBuffer {
  const wsData: unknown[][] = [
    ["Customer", "Title", "Last Name", "First Name", "Email", "Fax"],
  ];
  for (const row of rows) {
    wsData.push([
      row.CustomerName ?? "",
      row.Title ?? "",
      row.LastName ?? "",
      row.FirstName ?? "",
      row.Email ?? "",
      row.Fax ?? "",
    ]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [
    { wch: 30 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 35 }, { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function buildEmailText(rows: ContactRow[]): string {
  const emails = rows
    .map((r) => r.Email?.trim())
    .filter((e): e is string => !!e && e.length > 0);
  if (emails.length === 0) return "";
  return ";" + emails.join(";");
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/mails/export');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { mailId?: number | string } | null;
    const mailId = Number(body?.mailId);
    if (!Number.isFinite(mailId)) {
      return NextResponse.json({ ok: false, error: "Invalid mail ID" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("mailId", sql.Int, mailId);
    const result = await request.query<ContactRow>(`
      WITH ContactPool AS (
        SELECT mc.ContactID
        FROM dbo.MailContacts mc
        WHERE mc.MailID = @mailId
        UNION
        SELECT cgl.ContactID
        FROM dbo.MailContactGroups mcg
        INNER JOIN dbo.ContactsGroupLists cgl ON cgl.ContactGroupID = mcg.ContactGroupID
        WHERE mcg.MailID = @mailId
          AND (
            mcg.MinimumImportance IS NULL
            OR LTRIM(RTRIM(mcg.MinimumImportance)) = ''
            OR CASE cgl.Importance WHEN 'High' THEN 1 WHEN 'Med' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END
               <=
               CASE mcg.MinimumImportance WHEN 'High' THEN 1 WHEN 'Med' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END
          )
      )
      SELECT
        cust.Name AS CustomerName,
        t.Name AS Title,
        c.LastName,
        c.FirstName,
        c.Email,
        c.Fax
      FROM ContactPool cp
      INNER JOIN dbo.Contacts c ON c.ID = cp.ContactID
      LEFT JOIN dbo.Titles t ON t.ID = c.TitleID
      LEFT JOIN dbo.Customers cust ON cust.ID = c.CustomerID
      ORDER BY c.LastName, c.FirstName
    `);

    const allRows: ContactRow[] = (result.recordset ?? []) as ContactRow[];
    const greekRows = allRows.filter((r) => isGreek(r.LastName) || isGreek(r.FirstName));
    const englishRows = allRows.filter((r) => !isGreek(r.LastName) && !isGreek(r.FirstName));

    const zip = new JSZip();
    zip.file("MailCustomerEmailList.xlsx", buildExcelBuffer(allRows, "All Contacts"));
    zip.file("MailCustomerEmailList_en.xlsx", buildExcelBuffer(englishRows, "English Contacts"));
    zip.file("MailCustomerEmailList_en.txt", buildEmailText(englishRows));
    zip.file("MailCustomerEmailList_gr.xlsx", buildExcelBuffer(greekRows, "Greek Contacts"));
    zip.file("MailCustomerEmailList_gr.txt", buildEmailText(greekRows));

    const zipBuffer = await zip.generateAsync({ type: "uint8array" });

    return new NextResponse(Buffer.from(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="MailCustomerEmailList_${mailId}.zip"`,
      },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
