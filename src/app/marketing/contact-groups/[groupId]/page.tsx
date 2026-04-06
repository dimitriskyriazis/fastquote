import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import ContactGroupDetailClient from "./ContactGroupDetailClient";

async function fetchGroupDescription(groupId: string): Promise<string | null> {
  try {
    const id = Number.parseInt(groupId, 10);
    if (!Number.isFinite(id)) return null;
    const pool = await getPool();
    const request = pool.request();
    request.input("id", sql.Int, id);
    const result = await request.query<{ Description: string | null }>(
      "SELECT Description FROM dbo.ContactGroups WHERE ID = @id"
    );
    return result.recordset?.[0]?.Description ?? null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const description = await fetchGroupDescription(groupId);
  return <ContactGroupDetailClient groupId={groupId} description={description} />;
}
