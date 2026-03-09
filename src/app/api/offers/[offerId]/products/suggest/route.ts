import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { clearPartModelNumberUpper } from '../../../../../../lib/partModelNumber';
import { requirePermission } from '../../../../../../lib/authz';
import OpenAI from 'openai';

export const runtime = 'nodejs';

const openai = new OpenAI();

type RequestBody = {
  requestedBrand?: string | null;
  requestedModelNumber?: string | null;
  requestedPartNumber?: string | null;
  requestedDescription?: string | null;
  requestedDescription2?: string | null;
  requestedDescription3?: string | null;
};

type CandidateRow = {
  ProductID: number;
  PartNumber: string | null;
  Description: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  PriceListName: string | null;
  ListPrice: number | null;
  UnitPrice: number | null;
};

const trim = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const normalizeBrandKey = (value: string | null): string | null => {
  if (!value) return null;
  return value.replace(/\u00A0/g, ' ').replace(/\s+/g, '').toLowerCase() || null;
};

const brandKeySql = (expr: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(LTRIM(RTRIM(ISNULL(${expr}, N'')))), NCHAR(160), N''), NCHAR(9), N''), NCHAR(10), N''), NCHAR(13), N''), N' ', N'')`;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/suggest');

  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  try {
    const { offerId: offerIdRaw } = await params;
    const offerId = Number.parseInt(offerIdRaw, 10);
    if (!Number.isFinite(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid offerId' }, { status: 400 });
    }

    const body = (await req.json()) as RequestBody;
    const brand = trim(body.requestedBrand);
    const modelNumber = trim(body.requestedModelNumber);
    const partNumber = trim(body.requestedPartNumber);
    const desc1 = trim(body.requestedDescription);
    const desc2 = trim(body.requestedDescription2);
    const desc3 = trim(body.requestedDescription3);

    const hasAnyInput = brand || modelNumber || partNumber || desc1 || desc2 || desc3;
    if (!hasAnyInput) {
      return NextResponse.json({ ok: false, error: 'No requested product info provided' }, { status: 400 });
    }

    // --- Phase 1: SQL candidate search ---
    const pool = await getPool();
    const request = pool.request();

    const conditions: string[] = [];
    let paramIdx = 0;

    // Brand key match
    const brandKey = normalizeBrandKey(brand);
    if (brandKey) {
      const p = `brand_${paramIdx++}`;
      request.input(p, sql.NVarChar(255), brandKey);
      conditions.push(`${brandKeySql('b.Name')} = @${p}`);
    }

    // Part number match (cleared, cross-searches both columns)
    if (partNumber) {
      const cleared = clearPartModelNumberUpper(partNumber);
      if (cleared) {
        const p = `pn_${paramIdx++}`;
        request.input(p, sql.NVarChar(255), cleared);
        conditions.push(
          `(UPPER(ISNULL(p.PartNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.ModelNumberCleared, '')) = @${p})`,
        );
      }
    }

    // Model number match (cleared, cross-searches both columns)
    if (modelNumber) {
      const cleared = clearPartModelNumberUpper(modelNumber);
      if (cleared) {
        const p = `mn_${paramIdx++}`;
        request.input(p, sql.NVarChar(255), cleared);
        conditions.push(
          `(UPPER(ISNULL(p.PartNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.ModelNumberCleared, '')) = @${p})`,
        );
      }
    }

    // Description keyword search — extract meaningful words (3+ chars)
    const fullDesc = [desc1, desc2, desc3].filter(Boolean).join(' ');
    const descWords = fullDesc
      .replace(/[^a-zA-Z0-9\u00C0-\u024F]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 8);

    for (const word of descWords) {
      const p = `dw_${paramIdx++}`;
      request.input(p, sql.NVarChar(255), `%${word}%`);
      conditions.push(`p.Description LIKE @${p}`);
    }

    if (conditions.length === 0) {
      return NextResponse.json({ ok: true, products: [] });
    }

    // Use OR-based matching with relevance scoring
    const scoreParts = conditions.map((_, i) => `CASE WHEN ${conditions[i]} THEN 1 ELSE 0 END`);
    const scoreExpr = scoreParts.join(' + ');

    const query = `
      SELECT TOP (50)
        p.ID AS ProductID,
        p.PartNumber,
        p.Description,
        p.ModelNumber,
        b.Name AS BrandName,
        price.PriceListName,
        price.ListPrice,
        price.ListPrice AS UnitPrice,
        (${scoreExpr}) AS MatchScore
      FROM dbo.Products p
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
        OUTER APPLY (
          SELECT TOP (1)
            pl.Name AS PriceListName,
            pli.ListPrice
          FROM dbo.PriceListItems pli
            INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
          WHERE pli.ProductID = p.ID
            AND pl.Enabled = 1
          ORDER BY
            CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
            pl.ValidToDate,
            pl.ValidFromDate DESC,
            pli.ID DESC
        ) price
      WHERE (${conditions.join(' OR ')})
      ORDER BY (${scoreExpr}) DESC, p.ID DESC
    `;

    console.log('[suggest] SQL conditions:', conditions.length, '| query params:', paramIdx);
    const result = await request.query<CandidateRow & { MatchScore: number }>(query);
    const candidates = result.recordset ?? [];
    console.log('[suggest] SQL returned', candidates.length, 'candidates');

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, products: [] });
    }

    // If we have 8 or fewer candidates, return them directly (no AI needed)
    if (candidates.length <= 8) {
      const products = candidates.map(({ MatchScore, ...rest }) => {
        void MatchScore;
        return rest;
      });
      return NextResponse.json({ ok: true, products });
    }

    // --- Phase 2: AI ranking ---
    const requestedInfo = [
      brand && `Brand: ${brand}`,
      modelNumber && `Model Number: ${modelNumber}`,
      partNumber && `Part Number: ${partNumber}`,
      desc1 && `Description: ${desc1}`,
      desc2 && `Description 2: ${desc2}`,
      desc3 && `Description 3: ${desc3}`,
    ].filter(Boolean).join('\n');

    const candidateList = candidates.map((c) => ({
      id: c.ProductID,
      partNumber: c.PartNumber,
      modelNumber: c.ModelNumber,
      brand: c.BrandName,
      description: c.Description,
    }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a product matching assistant for a B2B AV equipment catalog. Given a requested product and a list of candidate catalog products, select up to 8 that best match the requested product. Rank them by relevance (best match first).

Return a JSON object: { "ids": [id1, id2, ...] } with up to 8 product IDs.

Consider:
- Exact or close part/model number matches are the strongest signal
- Brand match is important
- Description similarity matters when numbers don't match
- Prefer products that match multiple criteria`,
        },
        {
          role: 'user',
          content: `Requested product:\n${requestedInfo}\n\nCandidate products:\n${JSON.stringify(candidateList)}`,
        },
      ],
    });

    const aiResponse = completion.choices[0]?.message?.content ?? '{}';
    let selectedIds: number[] = [];
    try {
      const parsed = JSON.parse(aiResponse) as { ids?: unknown };
      if (Array.isArray(parsed.ids)) {
        selectedIds = parsed.ids
          .filter((v: unknown) => typeof v === 'number' && Number.isFinite(v))
          .map((v: unknown) => Math.trunc(v as number))
          .slice(0, 8);
      }
    } catch {
      // Fallback: return top 8 by SQL score
      const products = candidates.slice(0, 8).map(({ MatchScore, ...rest }) => {
        void MatchScore;
        return rest;
      });
      return NextResponse.json({ ok: true, products });
    }

    // Build result in AI-ranked order, falling back to SQL order for any missing
    const candidateMap = new Map(candidates.map((c) => [c.ProductID, c]));
    const orderedProducts: CandidateRow[] = [];
    const usedIds = new Set<number>();

    for (const id of selectedIds) {
      const candidate = candidateMap.get(id);
      if (candidate) {
        const { MatchScore, ...rest } = candidate;
        void MatchScore;
        orderedProducts.push(rest);
        usedIds.add(id);
      }
    }

    // Fill remaining slots from SQL-ranked candidates
    if (orderedProducts.length < 8) {
      for (const candidate of candidates) {
        if (orderedProducts.length >= 8) break;
        if (usedIds.has(candidate.ProductID)) continue;
        const { MatchScore, ...rest } = candidate;
        void MatchScore;
        orderedProducts.push(rest);
      }
    }

    return NextResponse.json({ ok: true, products: orderedProducts.slice(0, 8) });
  } catch (err) {
    console.error('Failed to suggest products', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
