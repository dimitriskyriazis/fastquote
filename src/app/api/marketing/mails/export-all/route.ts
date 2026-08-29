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
  SecondEmail: string | null;
  Fax: string | null;
};

function buildExcelBuffer(rows: ContactRow[], sheetName: string): ArrayBuffer {
  const wsData: unknown[][] = [
    ["Customer", "Title", "Last Name", "First Name", "Email", "Second Email", "Fax"],
  ];
  for (const row of rows) {
    wsData.push([
      row.CustomerName ?? "",
      row.Title ?? "",
      row.LastName ?? "",
      row.FirstName ?? "",
      row.Email ?? "",
      row.SecondEmail ?? "",
      row.Fax ?? "",
    ]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [
    { wch: 30 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 35 }, { wch: 35 }, { wch: 20 },
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
        -- Suppression is per-address: blank out only the one that opted out / bounced.
        CASE WHEN es1.ID IS NULL THEN c.Email ELSE NULL END AS Email,
        CASE WHEN es2.ID IS NULL THEN c.SecondEmail ELSE NULL END AS SecondEmail,
        c.Fax
      FROM dbo.Contacts c
      LEFT JOIN dbo.Titles t ON t.ID = c.TitleID
      LEFT JOIN dbo.Customers cust ON cust.ID = c.CustomerID
      -- These join ONLY the suppressed statuses, so a matched row means "never mail this address".
      LEFT JOIN dbo.EmailStatuses es1
        ON es1.ID = c.EmailStatusID
       AND es1.Name IN ('Email Unsubscribed', 'Wrong Email')
      LEFT JOIN dbo.EmailStatuses es2
        ON es2.ID = c.SecondEmailStatusID
       AND es2.Name IN ('Email Unsubscribed', 'Wrong Email')
      -- Disabled contacts are inactive records: they must never be mailed.
      WHERE ISNULL(c.Enabled, 0) = 1
        -- ...and neither may a live contact of a RETIRED customer. Disabling a
        -- customer used to leave its contacts fully mailable, because this join
        -- was only ever here to print the name: 42 addresses were still going
        -- out under disabled customers. A contact with no customer at all is a
        -- different case and is left in, exactly as before.
        AND (cust.ID IS NULL OR cust.Enabled = 1)
        -- This export is address-only, so a contact needs at least one mailable address left.
        AND (
          (NULLIF(LTRIM(RTRIM(c.Email)), '') IS NOT NULL AND es1.ID IS NULL)
          OR (NULLIF(LTRIM(RTRIM(c.SecondEmail)), '') IS NOT NULL AND es2.ID IS NULL)
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
