import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
import { buildMailFolderPath } from "../../../../../lib/mailsExportFolder";
import * as XLSX from "xlsx";

export const runtime = "nodejs";

// Greek & Coptic Unicode block (U+0370–U+03FF). Built via fromCharCode to keep the source ASCII.
const GREEK_BLOCK = new RegExp(`[${String.fromCharCode(0x0370)}-${String.fromCharCode(0x03ff)}]`);

const isGreek = (name: string | null | undefined): boolean => {
  if (!name) return false;
  return GREEK_BLOCK.test(name);
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

// Both addresses are mailable channels, so both go in the paste-into-your-mail-client list.
// The query has already blanked whichever one carries a suppressed status.
function buildEmailText(rows: ContactRow[]): string {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const row of rows) {
    for (const raw of [row.Email, row.SecondEmail]) {
      const email = raw?.trim();
      if (!email) continue;
      // A second email can duplicate someone else's primary; don't mail the same address twice.
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push(email);
    }
  }
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

    // Look up the list itself so we can name the destination folder after it.
    const mailReq = pool.request();
    mailReq.input("mailId", sql.Int, mailId);
    const mailRes = await mailReq.query<{ Description: string | null }>(
      `SELECT Description FROM dbo.Mails WHERE ID = @mailId`,
    );
    const mailRow = mailRes.recordset?.[0];
    if (!mailRow) {
      return NextResponse.json({ ok: false, error: "Mail not found" }, { status: 404 });
    }

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
        -- Suppression is per-address: blank out only the one that opted out / bounced.
        CASE WHEN es1.ID IS NULL THEN c.Email ELSE NULL END AS Email,
        CASE WHEN es2.ID IS NULL THEN c.SecondEmail ELSE NULL END AS SecondEmail,
        c.Fax
      FROM ContactPool cp
      INNER JOIN dbo.Contacts c ON c.ID = cp.ContactID
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
        -- Drop the contact only when every address is suppressed. A bad primary no longer
        -- loses someone who still has a good second address. Contacts with no email at all
        -- stay in, as before -- this sheet doubles as the fax list.
        AND (
          es1.ID IS NULL
          OR (NULLIF(LTRIM(RTRIM(c.SecondEmail)), '') IS NOT NULL AND es2.ID IS NULL)
        )
      ORDER BY c.LastName, c.FirstName
    `);

    const allRows: ContactRow[] = (result.recordset ?? []) as ContactRow[];
    const greekRows = allRows.filter((r) => isGreek(r.LastName) || isGreek(r.FirstName));
    const englishRows = allRows.filter((r) => !isGreek(r.LastName) && !isGreek(r.FirstName));

    const folderPath = buildMailFolderPath(mailId, mailRow.Description);

    const filesToWrite: Array<{ name: string; data: Buffer | string }> = [
      { name: "MailCustomerEmailList.xlsx", data: Buffer.from(buildExcelBuffer(allRows, "All Contacts")) },
      { name: "MailCustomerEmailList_en.xlsx", data: Buffer.from(buildExcelBuffer(englishRows, "English Contacts")) },
      { name: "MailCustomerEmailList_en.txt", data: buildEmailText(englishRows) },
      { name: "MailCustomerEmailList_gr.xlsx", data: Buffer.from(buildExcelBuffer(greekRows, "Greek Contacts")) },
      { name: "MailCustomerEmailList_gr.txt", data: buildEmailText(greekRows) },
    ];

    try {
      await fs.mkdir(folderPath, { recursive: true });
      await Promise.all(
        filesToWrite.map(({ name, data }) =>
          typeof data === "string"
            ? fs.writeFile(path.join(/*turbopackIgnore: true*/ folderPath, name), data, "utf8")
            : fs.writeFile(path.join(/*turbopackIgnore: true*/ folderPath, name), data),
        ),
      );
    } catch (writeErr) {
      const reason = writeErr instanceof Error ? writeErr.message : String(writeErr);
      console.error("Failed to write mail export to share", folderPath, writeErr);
      return NextResponse.json(
        { ok: false, error: `Could not save to "${folderPath}": ${reason}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      folder: folderPath,
      fileCount: filesToWrite.length,
      contacts: { total: allRows.length, english: englishRows.length, greek: greekRows.length },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
