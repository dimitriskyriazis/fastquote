import sql from 'mssql';
import { getSoftOneClient } from './softone';
import type { SetItemEntry } from './softone';
import type { CreateItemParams, CreatedItemInfo } from './itemCreation';
import { generateNewErpCode } from './itemCreation';
import { logger } from './logger';
import type { getPool, getErpPool } from './sql';

/**
 * Maps FastQuote businessUnit string to the SoftOne WS Business Unit code.
 * From the V5 WS documentation (setItem Business Units table).
 */
function mapBusinessUnit(bu: 'AVS' | 'TVS'): string {
  return bu === 'AVS' ? '10' : '20';
}

/**
 * Resolves the ERP MTRMANFCTR numeric ID from the brand name.
 * Returns the ID as a string, or undefined if not found.
 */
async function resolveErpManufacturerId(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  brandName: string,
): Promise<string | undefined> {
  const request = erpPool.request();
  request.input('brandName', sql.NVarChar(128), brandName.trim());
  const result = await request.query<{ MTRMANFCTR: number }>(`
    SELECT TOP (1) MTRMANFCTR
    FROM dbo.MTRMANFCTR
    WHERE UPPER(LTRIM(RTRIM(NAME))) = UPPER(LTRIM(RTRIM(@brandName)))
    ORDER BY MTRMANFCTR
  `);
  const id = result.recordset?.[0]?.MTRMANFCTR;
  return id != null ? String(id) : undefined;
}

/**
 * Creates a manufacturer (brand) in the ERP via stored procedure.
 * Returns the new MTRMANFCTR ID and CODE.
 */
export async function createManufacturerInErp(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  brandName: string,
): Promise<{ mtrmanfctrId: number; mtrmanfctrCode: string }> {
  const request = erpPool.request();
  request.input('Name', sql.VarChar(50), brandName.trim());

  const result = await request.query<{ MTRMANFCTR_ID: number; MTRMANFCTR_CODE: string }>(`
    DECLARE @NewId INT, @NewCode VARCHAR(10);
    EXEC [tlm].[mtrmanfctr_CreateFromIntegration]
      @Name = @Name,
      @NewId = @NewId OUTPUT,
      @NewCode = @NewCode OUTPUT;
    SELECT @NewId AS MTRMANFCTR_ID, @NewCode AS MTRMANFCTR_CODE;
  `);

  const row = result.recordset?.[0];
  if (!row?.MTRMANFCTR_ID || !row?.MTRMANFCTR_CODE) {
    throw new Error(`Failed to create manufacturer for brand: ${brandName}`);
  }

  logger.info('Created manufacturer in ERP', {
    brandName,
    mtrmanfctrId: row.MTRMANFCTR_ID,
    mtrmanfctrCode: row.MTRMANFCTR_CODE,
  });

  return { mtrmanfctrId: row.MTRMANFCTR_ID, mtrmanfctrCode: row.MTRMANFCTR_CODE };
}

const MAX_ITEM_NAME_LENGTH = 120;

/**
 * Shortens a product description using AI so that the full item name
 * (model number + separator + description) fits within the character limit.
 */
async function shortenDescriptionWithAI(
  description: string,
  maxDescriptionLength: number,
): Promise<string> {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    logger.warn('OpenAI API key not configured, truncating description instead of using AI');
    return description.slice(0, maxDescriptionLength);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that shortens product descriptions. Return ONLY the shortened description, nothing else. Keep the most important technical details and product identity. Do not add quotes around the result.',
          },
          {
            role: 'user',
            content: `Shorten this product description to at most ${maxDescriptionLength} characters while preserving key information:\n\n${description}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error while shortening description', { status: response.status });
      return description.slice(0, maxDescriptionLength);
    }

    const data = await response.json();
    const shortened = (data.choices?.[0]?.message?.content?.trim() || '').replace(/^["']|["']$/g, '');

    if (!shortened || shortened.length > maxDescriptionLength) {
      logger.warn('AI-shortened description still too long or empty, truncating', {
        originalLength: description.length,
        shortenedLength: shortened.length,
        maxDescriptionLength,
      });
      return (shortened || description).slice(0, maxDescriptionLength);
    }

    logger.info('Description shortened by AI', {
      originalLength: description.length,
      shortenedLength: shortened.length,
      maxDescriptionLength,
    });

    return shortened;
  } catch (err) {
    logger.error('Failed to shorten description with AI', {}, err instanceof Error ? err : undefined);
    return description.slice(0, maxDescriptionLength);
  }
}

/**
 * Resolves the Soft1 Code for a category, subcategory, or type from the
 * FastQuote database.  Returns the Code string, or undefined if not found.
 */
async function resolveLookupCode(
  pool: Awaited<ReturnType<typeof getPool>>,
  table: 'ProductCategories' | 'ProductSubCategories' | 'ProductTypes',
  id: number,
): Promise<string | undefined> {
  const request = pool.request();
  request.input('id', sql.Int, id);
  const result = await request.query<{ Code: string | null }>(
    `SELECT Code FROM dbo.${table} WHERE ID = @id`,
  );
  return result.recordset?.[0]?.Code ?? undefined;
}

/**
 * Creates an item in SoftOne ERP via the setItem web service.
 *
 * Field mapping (V5 doc):
 *   code        = generated ERP code (from generateNewErpCode — SQL)
 *   code1       = model number (CODE1)
 *   code2       = part number (CODE2)
 *   name        = product description
 *   mtrunit     = 1  (Τεμάχια/pieces)
 *   vat         = 1410 (24%)
 *   mtracn      = 0  (Εμπόρευμα)
 *   mtrcategory = 1  (Εμπόρευμα/Merchandise)
 *   mtrmanfctr  = ERP manufacturer ID (from MTRMANFCTR table)
 *   busunits    = Business Unit code (10=AVS, 20=TVS)
 *   category    = Soft1 code (from ProductCategories.Code)
 *   subcateg    = Soft1 code (from ProductSubCategories.Code)
 *   type        = Soft1 code (from ProductTypes.Code)
 */
export async function createItemViaWebService(
  pool: Awaited<ReturnType<typeof getPool>>,
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  params: CreateItemParams,
): Promise<CreatedItemInfo> {
  // Code generation still uses SQL (depends on ERP sequence counters)
  const newCode = await generateNewErpCode(pool, erpPool, {
    SubCategoryID: params.subCategoryId,
    TypeID: params.typeId,
    BrandID: params.brandId,
    BrandName: params.brandName,
  });

  // Resolve ERP manufacturer ID from brand name
  const mtrmanfctr = await resolveErpManufacturerId(erpPool, params.brandName);

  // Resolve Soft1 codes for category, subcategory, and type (in parallel)
  const [categoryCode, subCategoryCode, typeCode] = await Promise.all([
    resolveLookupCode(pool, 'ProductCategories', params.categoryId),
    resolveLookupCode(pool, 'ProductSubCategories', params.subCategoryId),
    resolveLookupCode(pool, 'ProductTypes', params.typeId),
  ]);

  if (!categoryCode) {
    throw new Error(`Soft1 Code not found in ProductCategories for ID=${params.categoryId}`);
  }
  if (!subCategoryCode) {
    throw new Error(`Soft1 Code not found in ProductSubCategories for ID=${params.subCategoryId}`);
  }
  if (!typeCode) {
    throw new Error(`Soft1 Code not found in ProductTypes for ID=${params.typeId}`);
  }

  const client = getSoftOneClient();

  // Format name as "{ModelNumber} - {Description}" or just "{Description}" if no model number
  const separator = ' - ';
  const modelPrefix = params.modelNumber ? params.modelNumber + separator : '';
  let description = params.description;

  if ((modelPrefix + description).length > MAX_ITEM_NAME_LENGTH) {
    const maxDescriptionLength = MAX_ITEM_NAME_LENGTH - modelPrefix.length;
    logger.info('Item name exceeds limit, shortening description with AI', {
      originalLength: (modelPrefix + description).length,
      modelPrefixLength: modelPrefix.length,
      maxDescriptionLength,
    });
    description = await shortenDescriptionWithAI(description, maxDescriptionLength);
  }

  const itemName = modelPrefix + description;

  const item: SetItemEntry = {
    code: newCode,
    code2: params.partNumber ?? undefined,
    name: itemName,
    mtrunit: 1,
    vat: 1410,
    mtracn: 0,
    mtrcategory: 1,
    mtrmanfctr,
    busunits: mapBusinessUnit(params.businessUnit),
    category: categoryCode,
    subcateg: subCategoryCode,
    type: typeCode,
  };

  logger.info('SoftOne WS: calling setItem', {
    productId: String(params.productId),
    code: newCode,
    code2: params.partNumber ?? null,
    name: itemName,
    businessUnit: params.businessUnit,
    mtrmanfctr: mtrmanfctr ?? null,
    categoryCode: categoryCode ?? null,
    subCategoryCode: subCategoryCode ?? null,
    typeCode: typeCode ?? null,
  });

  const result = await client.setItem({ items: [item] });

  logger.info('SoftOne WS: setItem result', {
    success: result.success,
    id: String(result.id),
    itemCount: String(result.Items?.length ?? 0),
  });

  if (!result.Items || result.Items.length === 0) {
    throw new Error(
      `setItem did not return any Items. Response: ${JSON.stringify(result)}`,
    );
  }

  const created = result.Items[0];

  return {
    mtrl: created.Item_id,
    code: created.Item_code,
  };
}
