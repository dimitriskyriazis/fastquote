import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';

type OfferSummaryRow = {
  ID: number;
  Title: string | null;
  Description: string | null;
  CustomerName: string | null;
  IsStandardPackage: boolean | number | null;
};

type OfferSummary = {
  title: string | null;
  description: string | null;
  customerName: string | null;
  isStandardPackage: boolean;
};

const MAX_IDS = 50;

export async function POST(request: NextRequest) {
  logRequest(request, '/api/offers/batch-summary');
  try {
    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
    const rawIds = Array.isArray(body?.ids) ? body.ids : [];

    const numericIds: number[] = [];
    for (const raw of rawIds) {
      const id = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (Number.isInteger(id) && id > 0 && !numericIds.includes(id)) {
        numericIds.push(id);
      }
      if (numericIds.length >= MAX_IDS) break;
    }

    if (numericIds.length === 0) {
      return NextResponse.json({ ok: true, offers: {} });
    }

    const pool = await getPool();
    const req = pool.request();
    const placeholders = numericIds.map((id, i) => {
      req.input(`id${i}`, sql.Int, id);
      return `@id${i}`;
    });

    const result = await req.query<OfferSummaryRow>(`
      SELECT
        o.ID,
        o.Title,
        o.Description,
        c.Name AS CustomerName,
        ISNULL(o.IsStandardPackage, 0) AS IsStandardPackage
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON o.CustomerID = c.ID
      WHERE o.ID IN (${placeholders.join(', ')})
    `);

    const offers: Record<string, OfferSummary> = {};
    for (const row of result.recordset ?? []) {
      offers[String(row.ID)] = {
        title: row.Title?.trim() ?? null,
        description: row.Description?.trim() ?? null,
        customerName: row.CustomerName?.trim() ?? null,
        isStandardPackage: row.IsStandardPackage === true || row.IsStandardPackage === 1,
      };
    }

    return NextResponse.json({ ok: true, offers });
  } catch (error) {
    console.error('Failed to load batch offer summaries', error);
    return NextResponse.json(
      { ok: false, error: 'Unable to fetch offer summaries' },
      { status: 500 },
    );
  }
}
