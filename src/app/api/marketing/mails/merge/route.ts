import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

type MergeBody = {
  sourceMailId?: number | string;
  targetMailId?: number | string;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/mails/merge');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as MergeBody | null;
    const sourceMailId = Number(body?.sourceMailId);
    const targetMailId = Number(body?.targetMailId);

    if (!Number.isFinite(sourceMailId) || !Number.isFinite(targetMailId)) {
      return NextResponse.json({ ok: false, error: "Invalid mail IDs" }, { status: 400 });
    }

    if (sourceMailId === targetMailId) {
      return NextResponse.json({ ok: false, error: "Cannot merge a mail with itself" }, { status: 400 });
    }

    const pool = await getPool();

    // Move contacts from source to target (skip duplicates)
    const moveContactsReq = pool.request();
    moveContactsReq.input("sourceId", sql.Int, sourceMailId);
    moveContactsReq.input("targetId", sql.Int, targetMailId);
    await moveContactsReq.query(`
      INSERT INTO dbo.MailContacts (ContactID, MailID, Importance, Note)
      SELECT mc.ContactID, @targetId, mc.Importance, mc.Note
      FROM dbo.MailContacts mc
      WHERE mc.MailID = @sourceId
        AND mc.ContactID NOT IN (
          SELECT ContactID FROM dbo.MailContacts WHERE MailID = @targetId
        )
    `);

    // Move contact groups from source to target (skip duplicates)
    const moveGroupsReq = pool.request();
    moveGroupsReq.input("sourceId", sql.Int, sourceMailId);
    moveGroupsReq.input("targetId", sql.Int, targetMailId);
    await moveGroupsReq.query(`
      INSERT INTO dbo.MailContactGroups (ContactGroupID, MailID, MinimumImportance, Note)
      SELECT mcg.ContactGroupID, @targetId, mcg.MinimumImportance, mcg.Note
      FROM dbo.MailContactGroups mcg
      WHERE mcg.MailID = @sourceId
        AND mcg.ContactGroupID NOT IN (
          SELECT ContactGroupID FROM dbo.MailContactGroups WHERE MailID = @targetId
        )
    `);

    // Delete source mail's associations
    const delContacts = pool.request();
    delContacts.input("sourceId", sql.Int, sourceMailId);
    await delContacts.query(`DELETE FROM dbo.MailContacts WHERE MailID = @sourceId`);

    const delGroups = pool.request();
    delGroups.input("sourceId", sql.Int, sourceMailId);
    await delGroups.query(`DELETE FROM dbo.MailContactGroups WHERE MailID = @sourceId`);

    // Delete source mail
    const delMail = pool.request();
    delMail.input("sourceId", sql.Int, sourceMailId);
    await delMail.query(`DELETE FROM dbo.Mails WHERE ID = @sourceId`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
