import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';

type SearchResult = {
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
};

type SearchResponse = {
  ok: true;
  results: {
    offers: SearchResult[];
    customers: SearchResult[];
    products: SearchResult[];
  };
};

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 5, 10);

  if (query.length < 2) {
    return NextResponse.json({
      ok: true,
      results: { offers: [], customers: [], products: [] },
    } satisfies SearchResponse);
  }

  try {
    const pool = await getPool();
    const searchPattern = `%${query}%`;

    const [offersResult, customersResult, productsResult] = await Promise.all([
      pool
        .request()
        .input('pattern', sql.NVarChar, searchPattern)
        .input('limit', sql.Int, limit)
        .query<{ ID: number; Title: string | null; CustomerName: string | null }>(`
          SELECT TOP (@limit) o.ID, o.Title, c.Name AS CustomerName
          FROM dbo.Offer AS o
          LEFT JOIN dbo.Customers AS c ON c.ID = o.CustomerID
          WHERE o.Title LIKE @pattern
             OR o.Description LIKE @pattern
             OR c.Name LIKE @pattern
             OR CAST(o.ID AS NVARCHAR(20)) LIKE @pattern
          ORDER BY o.ModifiedOn DESC
        `),
      pool
        .request()
        .input('pattern', sql.NVarChar, searchPattern)
        .input('limit', sql.Int, limit)
        .query<{ ID: number; Name: string | null }>(`
          SELECT TOP (@limit) ID, Name
          FROM dbo.Customers
          WHERE Name LIKE @pattern
             OR CAST(ID AS NVARCHAR(20)) LIKE @pattern
          ORDER BY Name
        `),
      pool
        .request()
        .input('pattern', sql.NVarChar, searchPattern)
        .input('limit', sql.Int, limit)
        .query<{ ID: number; Description: string | null; PartNumber: string | null; ModelNumber: string | null }>(`
          SELECT TOP (@limit) ID, Description,
            NULLIF(LTRIM(RTRIM(PartNumber)), '') AS PartNumber,
            NULLIF(LTRIM(RTRIM(ModelNumber)), '') AS ModelNumber
          FROM dbo.Products
          WHERE Description LIKE @pattern
             OR PartNumber LIKE @pattern
             OR ModelNumber LIKE @pattern
          ORDER BY Description
        `),
    ]);

    const offers: SearchResult[] = (offersResult.recordset ?? []).map((row) => ({
      id: String(row.ID),
      label: row.Title?.trim() || `Offer ${row.ID}`,
      sublabel: row.CustomerName?.trim() || null,
      href: `/offers/${row.ID}/basicdata`,
    }));

    const customers: SearchResult[] = (customersResult.recordset ?? []).map((row) => ({
      id: String(row.ID),
      label: row.Name?.trim() || `Customer ${row.ID}`,
      sublabel: null,
      href: `/customers/${row.ID}/basicdata`,
    }));

    const products: SearchResult[] = (productsResult.recordset ?? []).map((row) => {
      const parts = [row.PartNumber, row.ModelNumber].filter(Boolean);
      return {
        id: String(row.ID),
        label: row.Description?.trim() || `Product ${row.ID}`,
        sublabel: parts.length > 0 ? parts.join(' / ') : null,
        href: `/products/${row.ID}/history`,
      };
    });

    return NextResponse.json({
      ok: true,
      results: { offers, customers, products },
    } satisfies SearchResponse);
  } catch (err) {
    console.error('Search failed', err);
    return NextResponse.json(
      { ok: false, error: 'Search failed' },
      { status: 500 },
    );
  }
}
