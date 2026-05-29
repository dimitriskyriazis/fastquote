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
 * Looks up a brand in Soft1 via tlm._mtrlFindBrand. Returns FoundCount and the
 * resolved BrandId / BrandCode (null when not found). The proc throws on
 * ambiguous matches (53101) and on empty input (53100).
 */
export async function findBrandInErp(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  brandName: string,
): Promise<{ found: number; brandId: number | null; brandCode: string | null }> {
  const trimmed = brandName.trim();
  if (!trimmed) return { found: 0, brandId: null, brandCode: null };
  const request = erpPool.request();
  request.input('BrandName', sql.VarChar(50), trimmed);
  const result = await request.query<{ FoundCount: number; BrandId: number | null; BrandCode: string | null }>(`
    DECLARE @BrandId INT, @BrandCode VARCHAR(10), @FoundCount INT;
    EXEC [tlm].[_mtrlFindBrand]
      @BrandName = @BrandName,
      @BrandId = @BrandId OUTPUT,
      @BrandCode = @BrandCode OUTPUT,
      @FoundCount = @FoundCount OUTPUT;
  `);
  const row = result.recordset?.[0];
  return {
    found: row?.FoundCount ?? 0,
    brandId: row?.BrandId ?? null,
    brandCode: row?.BrandCode ?? null,
  };
}

async function resolveErpManufacturerId(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  brandName: string,
): Promise<string | undefined> {
  const { brandId } = await findBrandInErp(erpPool, brandName);
  return brandId != null ? String(brandId) : undefined;
}

/**
 * Resolves a brand directly by its MTRMANFCTR id. Used when the user has
 * explicitly selected which ERP manufacturer to use, so we never re-match by
 * name (which is ambiguous when the same brand name appears more than once).
 */
export async function findBrandById(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  mtrmanfctr: number,
): Promise<{ brandId: number | null; brandCode: string | null }> {
  const request = erpPool.request();
  request.input('Mtrmanfctr', sql.Int, mtrmanfctr);
  const result = await request.query<{ MTRMANFCTR: number; CODE: string | null }>(`
    SELECT TOP (1) MTRMANFCTR, CODE FROM dbo.MTRMANFCTR WHERE MTRMANFCTR = @Mtrmanfctr
  `);
  const row = result.recordset?.[0];
  return { brandId: row?.MTRMANFCTR ?? null, brandCode: row?.CODE ?? null };
}

/**
 * Creates a manufacturer (brand) in the ERP via stored procedure.
 * Returns the new MTRMANFCTR ID and CODE.
 *
 * The proc sets the department (ACNMSK = 'AVS'/'TVS') — which is filled by
 * hand when opening a manufacturer manually — from the @AcnMsk parameter,
 * derived from the offer's business unit (i.e. its sales division).
 */
export async function createManufacturerInErp(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  brandName: string,
  businessUnit: 'AVS' | 'TVS',
): Promise<{ mtrmanfctrId: number; mtrmanfctrCode: string }> {
  const request = erpPool.request();
  request.input('Name', sql.VarChar(50), brandName.trim());
  request.input('AcnMsk', sql.VarChar(10), businessUnit);

  const result = await request.query<{ MTRMANFCTR_ID: number; MTRMANFCTR_CODE: string }>(`
    DECLARE @NewId INT, @NewCode VARCHAR(10);
    EXEC [tlm].[mtrmanfctr_CreateFromIntegration]
      @Name = @Name,
      @AcnMsk = @AcnMsk,
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
    businessUnit,
    mtrmanfctrId: row.MTRMANFCTR_ID,
    mtrmanfctrCode: row.MTRMANFCTR_CODE,
  });

  return { mtrmanfctrId: row.MTRMANFCTR_ID, mtrmanfctrCode: row.MTRMANFCTR_CODE };
}

const MAX_ITEM_NAME_LENGTH = 128;

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
 *   category    = Soft1 CCCCLCATEG numeric ID (same as ProductCategories.ID)
 *   subcateg    = Soft1 CCCCLSUBCATEG numeric ID (same as ProductSubCategories.ID)
 *   type        = Soft1 CCCCLTYPE numeric ID (same as ProductTypes.ID)
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
    Mtrmanfctr: params.mtrmanfctr ?? null,
  });

  // Resolve the ERP manufacturer id. When the caller passed an explicit
  // MTRMANFCTR (user-selected in the wizard), use it directly so a duplicated
  // brand name can't make the name lookup ambiguous. Otherwise resolve by name.
  // Throw if unresolved so we never create an item without a manufacturer —
  // earlier silent fall-through produced items with empty MTRMANFCTR that had
  // to be fixed by hand.
  let mtrmanfctr: string | undefined;
  if (params.mtrmanfctr != null) {
    const byId = await findBrandById(erpPool, params.mtrmanfctr);
    mtrmanfctr = byId.brandId != null ? String(byId.brandId) : undefined;
    if (!mtrmanfctr) {
      throw new Error(
        `Selected ERP manufacturer MTRMANFCTR=${params.mtrmanfctr} not found in MTRMANFCTR.`,
      );
    }
  } else {
    mtrmanfctr = await resolveErpManufacturerId(erpPool, params.brandName);
    if (!mtrmanfctr) {
      throw new Error(
        `Cannot resolve ERP manufacturer for brand "${params.brandName}". ` +
        `Ensure the brand exists in MTRMANFCTR with a non-empty CODE.`,
      );
    }
  }

  // SoftOne's CCCCLCATEG / CCCCLSUBCATEG / CCCCLTYPE fields expect numeric IDs,
  // not CODE strings. FastQuote ProductCategories / ProductSubCategories /
  // ProductTypes IDs are aligned with the SoftOne lookup IDs.
  const categoryValue = String(params.categoryId);
  const subCategoryValue = String(params.subCategoryId);
  const typeValue = String(params.typeId);

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
    name: itemName,  // Ονομασία (Description 1)
    name1: itemName, // Περιγραφή 2 — per V9 WS spec, name1 = Description 2
    mtrunit: 1,
    vat: 1410,
    mtracn: '0',
    mtrcategory: 1,
    mtrmanfctr,
    busunits: mapBusinessUnit(params.businessUnit),
    category: categoryValue,
    subcateg: subCategoryValue,
    type: typeValue,
  };

  logger.info('SoftOne WS: calling setItem', {
    productId: String(params.productId),
    code: newCode,
    code2: params.partNumber ?? null,
    name: itemName,
    name1: itemName,
    businessUnit: params.businessUnit,
    mtrmanfctr,
    categoryValue,
    subCategoryValue,
    typeValue,
  });

  let result;
  try {
    result = await client.setItem({ items: [item] });
  } catch (err) {
    logger.error('SoftOne WS: setItem failed', {
      productId: String(params.productId),
      code: newCode,
      name: itemName,
      nameLength: itemName.length,
      modelNumber: params.modelNumber ?? null,
      partNumber: params.partNumber ?? null,
      error: err instanceof Error ? err.message : String(err),
    }, err instanceof Error ? err : undefined);
    throw err;
  }

  const returnedCode = result.Items?.[0]?.Item_code ?? null;
  logger.info('SoftOne WS: setItem result', {
    success: result.success,
    id: String(result.id),
    itemCount: String(result.Items?.length ?? 0),
    nameLength: itemName.length,
    sentCode: newCode,
    returnedCode,
    codeMismatch: returnedCode != null && returnedCode !== newCode,
    returnedName: result.Items?.[0]?.Item_name ?? null,
  });

  if (returnedCode != null && returnedCode !== newCode) {
    logger.warn('SoftOne WS: setItem returned different code than sent — likely matched existing MTRL row', {
      productId: String(params.productId),
      sentCode: newCode,
      returnedCode,
      partNumber: params.partNumber ?? null,
      modelNumber: params.modelNumber ?? null,
    });
  }

  if (!result.Items || result.Items.length === 0) {
    throw new Error(
      `setItem did not return any Items. Response: ${JSON.stringify(result)}`,
    );
  }

  const created = result.Items[0];

  // Verify the MTRL row actually exists in the ERP. Soft1 has been observed to
  // return a synthetic Item_id from setItem even when the underlying insert was
  // rolled back by a trigger, leaving FastQuote with a phantom ERPID/ERPCode
  // that points to nothing. Fail loud so dbo.Products is not corrupted.
  const verifyReq = erpPool.request();
  verifyReq.input('Mtrl', sql.Int, created.Item_id);
  const verifyRes = await verifyReq.query<{ MTRL: number; CODE: string | null }>(
    'SELECT MTRL, CODE FROM MTRL WHERE MTRL = @Mtrl',
  );
  const verifiedRow = verifyRes.recordset?.[0];
  if (!verifiedRow) {
    logger.error('SoftOne WS: setItem returned MTRL that does not exist in ERP — likely rolled back by a trigger', {
      productId: String(params.productId),
      returnedMtrl: String(created.Item_id),
      returnedCode: created.Item_code,
      sentCode: newCode,
      name: itemName,
    });
    throw new Error(
      `Soft1 setItem returned MTRL ${created.Item_id} (code ${created.Item_code}) but no such row exists in the ERP. ` +
      `The insert was likely rolled back by a Soft1 trigger. Investigate the item payload before retrying.`,
    );
  }

  return {
    mtrl: created.Item_id,
    code: verifiedRow.CODE ?? created.Item_code,
  };
}
