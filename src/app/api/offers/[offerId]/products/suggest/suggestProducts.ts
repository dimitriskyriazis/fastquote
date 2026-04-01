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
  CostPrice: number | null;
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
  const weights: number[] = [];
  let paramIdx = 0;

  const brandKey = normalizeBrandKey(brand);
  if (brandKey) {
    const p = `brand_${paramIdx++}`;
    request.input(p, sql.NVarChar(255), brandKey);
    const bk = brandKeySql('b.Name');
    // Bi-directional starts-with: "d&b" matches "d&b audiotechnik" and vice versa
    conditions.push(`(CHARINDEX(@${p}, ${bk}) = 1 OR (LEN(${bk}) > 0 AND CHARINDEX(${bk}, @${p}) = 1))`);
    weights.push(3);
  }

  const addPartModelCondition = (value: string, prefix: string, weight: number) => {
    const cleared = clearPartModelNumberUpper(value);
    if (!cleared) return;
    const p = `${prefix}_${paramIdx++}`;
    request.input(p, sql.NVarChar(255), cleared);
    conditions.push(
      `(UPPER(ISNULL(p.PartNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.ModelNumberCleared, '')) = @${p} OR UPPER(ISNULL(p.LegacyPartNoCleaned, '')) = @${p})`,
    );
    weights.push(weight);
  };

  // Prefix match: e.g. requested "Z5803" matches DB "Z5803000" (from "Z5803.000")
  const addPartModelPrefixCondition = (value: string, prefix: string, weight: number) => {
    const cleared = clearPartModelNumberUpper(value);
    if (!cleared) return;
    const p = `${prefix}_${paramIdx++}`;
    request.input(p, sql.NVarChar(255), cleared);
    conditions.push(
      `(UPPER(ISNULL(p.PartNumberCleared, '')) LIKE @${p} + N'%' OR UPPER(ISNULL(p.ModelNumberCleared, '')) LIKE @${p} + N'%' OR UPPER(ISNULL(p.LegacyPartNoCleaned, '')) LIKE @${p} + N'%')`,
    );
    weights.push(weight);
  };

  if (partNumber) {
    // Full value match (highest weight)
    addPartModelCondition(partNumber, 'pn', 10);
    // Prefix match for part numbers with sub-variants (e.g. "Z5803" → "Z5803.000")
    addPartModelPrefixCondition(partNumber, 'pnpfx', 7);
    // Also try individual tokens for multi-part values like "TEL152 71.04.0154"
    const tokens = partNumber.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length > 1) {
      for (const token of tokens) {
        addPartModelCondition(token, 'pnt', 5);
      }
    }
  }

  if (modelNumber) {
    addPartModelCondition(modelNumber, 'mn', 10);
    // Prefix match for model numbers with sub-variants
    addPartModelPrefixCondition(modelNumber, 'mnpfx', 7);
    const tokens = modelNumber.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length > 1) {
      for (const token of tokens) {
        addPartModelCondition(token, 'mnt', 5);
      }
    }
  }

  // Extract model-like tokens from descriptions (e.g. "CX-30", "TDC-7100", "C-10")
  // These are alphanumeric+dash/dot patterns that look like model identifiers
  const allDescText = [desc1, desc2, desc3].filter(Boolean).join(' ');
  const modelLikeTokens = allDescText
    .match(/\b[A-Za-z]+[-.]?\d[\w.-]*\b|\b\d[\w.-]*[-.]?[A-Za-z]+\b/g)
    ?.filter((t) => t.length >= 3) ?? [];
  // Also consider the brand name might appear in description - skip it as a model token
  const brandUpper = brand?.toUpperCase();
  const uniqueModelTokens = [...new Set(modelLikeTokens.map((t) => t.toUpperCase()))]
    .filter((t) => t !== brandUpper)
    .slice(0, 4);

  for (const token of uniqueModelTokens) {
    if (!partNumber && !modelNumber) {
      // No explicit part/model number provided, so try matching these tokens as part/model
      addPartModelCondition(token, 'dmt', 8);
    }
  }

  const fullDesc = [desc1, desc2, desc3, partNumber, modelNumber].filter(Boolean).join(' ');
  const descWords = fullDesc
    .replace(/[^a-zA-Z0-9\u00C0-\u024F]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6);

  for (const word of descWords) {
    const p = `dw_${paramIdx++}`;
    request.input(p, sql.NVarChar(255), `%${word}%`);
    conditions.push(`p.Description LIKE @${p}`);
    weights.push(1);
  }

  if (conditions.length === 0) return [];

  const scoreParts = conditions.map((cond, i) => `CASE WHEN ${cond} THEN ${weights[i]} ELSE 0 END`);
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
      price.CostPrice,
      (${scoreExpr}) AS MatchScore
    FROM dbo.Products p
      LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      OUTER APPLY (
        SELECT TOP (1)
          pl.Name AS PriceListName,
          pli.ListPrice,
          pli.CostPrice
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
    ORDER BY (${scoreExpr}) DESC, CASE WHEN price.ListPrice IS NOT NULL THEN 0 ELSE 1 END, p.ID DESC
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
  // Only rank the top candidates to reduce prompt size and AI latency.
  const aiCandidates = candidates.slice(0, 20);

  const requestedInfo = [
    brand && `Brand: ${brand}`,
    modelNumber && `Model Number: ${modelNumber}`,
    partNumber && `Part Number: ${partNumber}`,
    desc1 && `Description: ${desc1}`,
    desc2 && `Description 2: ${desc2}`,
    desc3 && `Description 3: ${desc3}`,
  ].filter(Boolean).join('\n');

  const candidateList = aiCandidates.map((c) => ({
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
          content: `You are a product matching assistant for a B2B AV equipment catalog. Given a requested product and a list of candidate catalog products, select ONLY the products that are genuinely a match for the requested product. Be selective — do NOT pad the results. If only 1 or 2 products match well, return only those.

Return a JSON object: { "ids": [id1, id2, ...] } with the matching product IDs (max 8), ranked by relevance (best match first).

Matching rules:
- Exact or close part/model number matches are the strongest signal — a product with a different model number (e.g. CX-30 vs CX-20 vs C-10) is NOT a match
- The model identifier in descriptions (e.g. "CX-30" in "Clickshare CX-30") is critical — only match products with the same model identifier
- Brand match is important but not sufficient alone
- Different variants of the same model (e.g. with 1 button vs 2 buttons) ARE valid matches
- Do NOT include products from the same product family but with different model numbers`,
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

  return orderedProducts.slice(0, 8);
}
