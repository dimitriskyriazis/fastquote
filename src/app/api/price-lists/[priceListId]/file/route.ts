import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import path from "node:path";
import fs from "node:fs/promises";
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

const requirePriceListUploadRoot = (): string => {
  const raw = process.env.PRICELIST_UPLOAD_ROOT;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(
      "Missing PRICELIST_UPLOAD_ROOT. Set it in your environment (e.g. .env.local) to an absolute directory path.",
    );
  }
  return value;
};

/** Resolve the stored FilePath to an absolute path on disk.
 *  If the stored value is already absolute (drive letter or UNC), use it directly.
 *  Otherwise, treat it as a filename and join with PRICELIST_UPLOAD_ROOT.
 */
const resolveAbsoluteFilePath = (filePath: string): string => {
  // Windows absolute paths: C:\... or \\server\...
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath;
  }
  // Treat as bare filename (or relative) — join with upload root
  const uploadRoot = requirePriceListUploadRoot();
  return path.join(uploadRoot, path.basename(filePath));
};

const CONTENT_TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/file');

  const auth = await requirePermission(req, "managePriceLists");
  if (!auth.ok) return auth.response;

  const { priceListId: priceListIdParam } = await params;
  const priceListId = Number.parseInt(priceListIdParam, 10);
  if (!Number.isInteger(priceListId) || priceListId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid price list ID" }, { status: 400 });
  }

  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("priceListId", sql.Int, priceListId);
    const result = await request.query<{ FilePath: string | null; Name: string | null }>(`
      SELECT TOP 1 FilePath, Name FROM dbo.PriceLists WHERE ID = @priceListId
    `);

    const row = result.recordset?.[0];
    if (!row) {
      return NextResponse.json({ ok: false, error: "Price list not found" }, { status: 404 });
    }

    if (!row.FilePath || !row.FilePath.trim()) {
      return NextResponse.json({ ok: false, error: "No file is attached to this price list" }, { status: 404 });
    }

    const absolutePath = resolveAbsoluteFilePath(row.FilePath.trim());

    let rawFile: Buffer;
    try {
      rawFile = await fs.readFile(absolutePath);
    } catch {
      return NextResponse.json(
        { ok: false, error: "The file could not be found on the server. It may have been moved or deleted." },
        { status: 404 },
      );
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const fileName = path.basename(absolutePath);

    return new NextResponse(new Blob([rawFile.buffer as ArrayBuffer], { type: contentType }), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Length": String(rawFile.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Failed to serve price list file", err);
    return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
}
