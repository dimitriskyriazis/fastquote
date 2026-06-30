import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
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

// Marketing list exports are written into a per-list folder on the shared drive,
// so everyone works from the same canonical copy instead of scattered downloads.
const requireMailsExportRoot = (): string => {
  const raw = process.env.MAILS_EXPORT_ROOT;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(
      "Missing MAILS_EXPORT_ROOT. Set it in your environment (e.g. .env.local) to the marketing list export folder.",
    );
  }
  return value;
};

// Characters that are illegal in Windows file/folder names: < > : " / \ | ? *
const ILLEGAL_FOLDER_CHARS = /[<>:"/\\|?*]/g;
// ASCII control characters (U+0000–U+001F), built via fromCharCode to keep the source ASCII.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`, "g");

// Strip characters illegal in Windows folder names, collapse whitespace, and drop
// trailing dots/spaces (also illegal on Windows).
const sanitizeFolderSegment = (value: string): string =>
  value
    .replace(ILLEGAL_FOLDER_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");

// Folder name: "<MailID> - <Description>" (or just "<MailID>" when there is no usable description).
const buildMailFolderName = (mailId: number, description: string | null | undefined): string => {
  const cleaned = sanitizeFolderSegment(description ?? "");
  const namePart = (cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned).replace(/[. ]+$/, "");
  return namePart ? `${mailId} - ${namePart}` : `${mailId}`;
};

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
        c.Email,
        c.Fax
      FROM ContactPool cp
      INNER JOIN dbo.Contacts c ON c.ID = cp.ContactID
      LEFT JOIN dbo.Titles t ON t.ID = c.TitleID
      LEFT JOIN dbo.Customers cust ON cust.ID = c.CustomerID
      -- Exclude contacts that have opted out / have a bad address: they must never be mailed.
      WHERE c.EmailStatusID IS NULL
         OR c.EmailStatusID NOT IN (
              SELECT ID FROM dbo.EmailStatuses WHERE Name IN ('Email Unsubscribed', 'Wrong Email')
            )
      ORDER BY c.LastName, c.FirstName
    `);

    const allRows: ContactRow[] = (result.recordset ?? []) as ContactRow[];
    const greekRows = allRows.filter((r) => isGreek(r.LastName) || isGreek(r.FirstName));
    const englishRows = allRows.filter((r) => !isGreek(r.LastName) && !isGreek(r.FirstName));

    const folderName = buildMailFolderName(mailId, mailRow.Description);
    // The export root is a runtime env var (an external network share), not a build-time
    // path. Without these turbopackIgnore hints, NFT tries to statically resolve the
    // unknown base and ends up globbing the whole project into the route's file trace.
    const folderPath = path.join(/*turbopackIgnore: true*/ requireMailsExportRoot(), folderName);

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
