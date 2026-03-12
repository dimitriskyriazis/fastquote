import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { clearPartModelNumberUpper } from '../../../../../../lib/partModelNumber';
import OpenAI from 'openai';

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

export type SuggestInput = {
  requestedBrand?: string | null;
  requestedModelNumber?: string | null;
  requestedPartNumber?: string | null;
  requestedDescription?: string | null;
  requestedDescription2?: string | null;
  requestedDescription3?: string | null;
};

export type CandidateRow = {
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

export async function suggestProducts(input: SuggestInput): Promise<CandidateRow[]> {
  const brand = trim(input.requestedBrand);
  const modelNumber = trim(input.requestedModelNumber);
  const partNumber = trim(input.requestedPartNumber);
  const desc1 = trim(input.requestedDescription);
  const desc2 = trim(input.requestedDescription2);
  const desc3 = trim(input.requestedDescription3);

  const hasAnyInput = brand || modelNumber || partNumber || desc1 || desc2 || desc3;
  if (!hasAnyInput) return [];

  // --- Phase 1: SQL candidate search ---
  const pool = await getPool();
  const request = pool.request();

  const conditions: string[] = [];
  let paramIdx = 0;

  const brandKey = normalizeBrandKey(brand);
  if (brandKey) {
    const p = `brand_${paramIdx++}`;
    request.input(p, sql.NVarChar(255), brandKey);
    conditions.push(`${brandKeySql('b.Name')} = @${p}`);
  }

  if (partNumber) {
    const cleared = clearPartModelNumberUpper(partNumber);
    if (cleared) {
      const p = `pn_${paramIdx++}`;
      request.input(p, sql.NVarChar(255), cleared);
      conditions.push(
        `(UPPER(ISNULL(p.PartNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.ModelNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.LegacyPartNoCleaned, '')) = @${p})`,
      );
    }
  }

  if (modelNumber) {
    const cleared = clearPartModelNumberUpper(modelNumber);
    if (cleared) {
      const p = `mn_${paramIdx++}`;
      request.input(p, sql.NVarChar(255), cleared);
      conditions.push(
        `(UPPER(ISNULL(p.PartNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.ModelNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.LegacyPartNoCleaned, '')) = @${p})`,
      );
    }
  }

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

  if (conditions.length === 0) return [];

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

  const result = await request.query<CandidateRow & { MatchScore: number }>(query);
  const candidates = result.recordset ?? [];

  if (candidates.length === 0) return [];

  if (candidates.length <= 8) {
    return candidates.map(({ MatchScore, ...rest }) => {
      void MatchScore;
      return rest;
    });
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

  let selectedIds: number[] = [];
  try {
    const completion = await getOpenAI().chat.completions.create({
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
    const parsed = JSON.parse(aiResponse) as { ids?: unknown };
    if (Array.isArray(parsed.ids)) {
      selectedIds = parsed.ids
        .filter((v: unknown) => typeof v === 'number' && Number.isFinite(v))
        .map((v: unknown) => Math.trunc(v as number))
        .slice(0, 8);
    }
  } catch {
    // Fallback: return top 8 by SQL score
    return candidates.slice(0, 8).map(({ MatchScore, ...rest }) => {
      void MatchScore;
      return rest;
    });
  }

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

  if (orderedProducts.length < 8) {
    for (const candidate of candidates) {
      if (orderedProducts.length >= 8) break;
      if (usedIds.has(candidate.ProductID)) continue;
      const { MatchScore, ...rest } = candidate;
      void MatchScore;
      orderedProducts.push(rest);
    }
  }

  return orderedProducts.slice(0, 8);
}
