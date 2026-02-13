import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import type { ConnectionPool } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";

export const runtime = "nodejs";

type DescriptionMismatch = {
  productId: number;
  newDescription: string;
};

type TransactionLike = {
  begin: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const mismatches: DescriptionMismatch[] = body?.mismatches;
    if (!Array.isArray(mismatches) || mismatches.length === 0) {
      return NextResponse.json({ ok: false, error: "No mismatches provided." }, { status: 400 });
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();

    const TransactionCtor = (sql as unknown as {
      Transaction: new (pool: ConnectionPool) => TransactionLike;
    }).Transaction;
    const transaction = new TransactionCtor(pool);
    await transaction.begin();

    try {
      let updatedCount = 0;
      for (const item of mismatches) {
        if (!item.productId || !item.newDescription) continue;

        const RequestCtor = sql.Request as unknown as new (o: TransactionLike) => InstanceType<typeof sql.Request>;
        const request = new RequestCtor(transaction);
        request.input("ProductID", sql.Int, item.productId);
        request.input("Description", sql.NVarChar(2000), item.newDescription.slice(0, 2000));
        request.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await request.query(`
          UPDATE dbo.Products
          SET Description = @Description,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @ProductID
        `);
        updatedCount += 1;
      }

      await transaction.commit();
      return NextResponse.json({ ok: true, updatedCount });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    console.error("Failed to update product descriptions", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
