import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
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

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/mails/export-all');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const pool = await getPool();
    const result = await pool.request().query<ContactRow>(`
      SELECT
        cust.Name AS CustomerName,
        t.Name AS Title,
        c.LastName,
        c.FirstName,
        c.Email,
        c.Fax
      FROM dbo.Contacts c
      LEFT JOIN dbo.Titles t ON t.ID = c.TitleID
      LEFT JOIN dbo.Customers cust ON cust.ID = c.CustomerID
      WHERE c.Email IS NOT NULL AND c.Email <> ''
        -- Exclude contacts that have opted out / have a bad address: they must never be mailed.
        AND (
          c.EmailStatusID IS NULL
          OR c.EmailStatusID NOT IN (
               SELECT ID FROM dbo.EmailStatuses WHERE Name IN ('Email Unsubscribed', 'Wrong Email')
             )
        )
      ORDER BY c.LastName, c.FirstName
    `);

    const allRows: ContactRow[] = (result.recordset ?? []) as ContactRow[];
    const greekRows = allRows.filter((r) => isGreek(r.LastName) || isGreek(r.FirstName));
    const englishRows = allRows.filter((r) => !isGreek(r.LastName) && !isGreek(r.FirstName));

    const zip = new JSZip();
    zip.file("AllEmailContacts.xlsx", buildExcelBuffer(allRows, "All Contacts"));
    zip.file("AllEmailContacts_en.xlsx", buildExcelBuffer(englishRows, "English Contacts"));
    zip.file("AllEmailContacts_gr.xlsx", buildExcelBuffer(greekRows, "Greek Contacts"));

    const zipBuffer = await zip.generateAsync({ type: "uint8array" });

    return new NextResponse(Buffer.from(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="AllEmailContacts.zip"`,
      },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
