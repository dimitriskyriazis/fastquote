import sql from 'mssql';
import { getPool, getErpPool } from './sql';
import { createItemViaWebService } from './itemCreationWS';
import { logger } from './logger';

// ── Types ──────────────────────────────────────────────────────────────────

export type CreateItemParams = {
  productId: number;
  description: string;
  modelNumber: string | null;
  partNumber: string | null;
  brandId: number;
  brandName: string;
  subCategoryId: number;
  typeId: number;
  businessUnit: 'AVS' | 'TVS';
};

export type CreatedItemInfo = {
  mtrl: number;
  code: string;
};

// ── Feature flag ───────────────────────────────────────────────────────────

const USE_WS_ITEM_CREATION = process.env.SOFTONE_WS_ITEM_CREATION === 'true';

// ── Code generation (always SQL — depends on ERP sequence counters) ───────

/**
 * Generates a structured ERP CODE: [SubCategoryCode][TypeFirstLetter].[BrandCode].[3DigitSequence]
 * Example: SPRM.BIA.180
 */
export async function generateNewErpCode(
  pool: Awaited<ReturnType<typeof getPool>>,
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  product: {
    SubCategoryID: number;
    TypeID: number;
    BrandID: number;
    BrandName: string;
  },
): Promise<string> {
  // 1. Get SubCategory Code (first 3 chars) from FASTQUOTE
  const subCategoryRequest = pool.request();
  subCategoryRequest.input('subCategoryId', sql.Int, product.SubCategoryID);
  const subCategoryResult = await subCategoryRequest.query<{ Code: string | null }>(`
    SELECT Code
    FROM dbo.ProductSubCategories
    WHERE ID = @subCategoryId
  `);
  const subCategoryCode = subCategoryResult.recordset?.[0]?.Code;
  if (!subCategoryCode || subCategoryCode.length < 3) {
    throw new Error(
      `SubCategory Code not found or too short for product SubCategoryID=${product.SubCategoryID}`,
    );
  }
  const subCategoryCode3 = subCategoryCode.substring(0, 3).toUpperCase();

  // 2. Get Type first letter (4th char) from FASTQUOTE
  const typeRequest = pool.request();
  typeRequest.input('typeId', sql.Int, product.TypeID);
  const typeResult = await typeRequest.query<{ Name: string | null }>(`
    SELECT Name
    FROM dbo.ProductTypes
    WHERE ID = @typeId
  `);
  const typeName = typeResult.recordset?.[0]?.Name;
  if (!typeName || typeName.length === 0) {
    throw new Error(`Type Name not found for product TypeID=${product.TypeID}`);
  }
  const typeFirstLetter = typeName.trim().charAt(0).toUpperCase();

  // 3. Match Brand Name with ERP MTRMANFCTR.NAME (case-insensitive) and get CODE
  const brandRequest = erpPool.request();
  brandRequest.input('brandName', sql.NVarChar(128), product.BrandName.trim());
  const brandResult = await brandRequest.query<{ CODE: string | null }>(`
    SELECT TOP (1) CODE
    FROM dbo.MTRMANFCTR
    WHERE UPPER(LTRIM(RTRIM(NAME))) = UPPER(LTRIM(RTRIM(@brandName)))
    ORDER BY MTRMANFCTR
  `);
  const brandCode = brandResult.recordset?.[0]?.CODE;
  if (!brandCode) {
    throw new Error(`Brand Code not found in ERP for brand name: ${product.BrandName}`);
  }

  // 4. Build prefix: SubCategoryCode + TypeFirstLetter + "." + BrandCode
  const prefix = `${subCategoryCode3}${typeFirstLetter}.${brandCode}`;

  // 5. Call tlm._mtrlNextCode3Digit to get the full CODE
  const nextCodeRequest = erpPool.request();
  nextCodeRequest.input('Prefix', sql.NVarChar(20), prefix);
  nextCodeRequest.input('Company', sql.Int, 1);
  const nextCodeResult = await nextCodeRequest.query<{
    NextCode: string | null;
    NextNo: number | null;
  }>(`
    DECLARE @NextCode VARCHAR(25);
    DECLARE @NextNo INT;
    EXEC tlm._mtrlNextCode3Digit
      @Prefix = @Prefix,
      @Company = @Company,
      @NextCode = @NextCode OUTPUT,
      @NextNo = @NextNo OUTPUT;
    SELECT @NextCode AS NextCode, @NextNo AS NextNo;
  `);

  const nextCode = nextCodeResult.recordset?.[0]?.NextCode;
  if (!nextCode) {
    throw new Error(`Failed to get next CODE from tlm._mtrlNextCode3Digit for prefix: ${prefix}`);
  }

  return nextCode;
}

// ── SQL-based item creation ───────────────────────────────────────────────

function isRequestErrorWithNumber(error: unknown): error is { number: number } {
  return typeof error === 'object' && error !== null && 'number' in error && typeof (error as { number: unknown }).number === 'number';
}

async function createItemViaSql(
  pool: Awaited<ReturnType<typeof getPool>>,
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  params: CreateItemParams,
): Promise<CreatedItemInfo> {
  let retryCount = 0;
  const MAX_RETRIES = 3;
  let createdMTRL: number | null = null;
  let createdCode: string | null = null;

  while (retryCount <= MAX_RETRIES && !createdMTRL) {
    try {
      const newCode = await generateNewErpCode(pool, erpPool, {
        SubCategoryID: params.subCategoryId,
        TypeID: params.typeId,
        BrandID: params.brandId,
        BrandName: params.brandName,
      });

      const createRequest = erpPool.request();
      createRequest.input('CODE', sql.NVarChar(25), newCode);
      createRequest.input('CODE1', sql.NVarChar(25), params.modelNumber);
      createRequest.input('CODE2', sql.NVarChar(50), params.partNumber);
      createRequest.input('Description', sql.NVarChar(128), params.description);
      createRequest.input('BrandId', sql.Int, params.brandId);
      createRequest.input('BusinessUnit', sql.NVarChar(20), params.businessUnit);

      const createResult = await createRequest.query(`
        DECLARE @CreatedMTRL INT;
        EXEC [tlm].[_mtrlCreateProduct]
          @CODE = @CODE,
          @CODE1 = @CODE1,
          @CODE2 = @CODE2,
          @Description = @Description,
          @BrandId = @BrandId,
          @BusinessUnit = @BusinessUnit,
          @CreatedMTRL = @CreatedMTRL OUTPUT;
        SELECT @CreatedMTRL AS CreatedMTRL;
      `) as { recordset: Array<{ CreatedMTRL: number }>; recordsets?: Array<Array<{ MTRL: number; CODE: string | null }>> };

      createdMTRL = createResult.recordset?.[0]?.CreatedMTRL ?? createResult.recordsets?.[0]?.[0]?.MTRL ?? null;
      createdCode = createResult.recordsets?.[0]?.[0]?.CODE ?? newCode;
    } catch (retryErr) {
      const isDuplicateKey = isRequestErrorWithNumber(retryErr) && retryErr.number === 2627;
      if (isDuplicateKey && retryCount < MAX_RETRIES) {
        retryCount++;
        logger.warn(`Duplicate CODE detected for product ${params.productId}, retrying`, {
          attempt: String(retryCount),
          maxRetries: String(MAX_RETRIES),
        });
        continue;
      }
      throw retryErr;
    }
  }

  if (!createdMTRL || !createdCode) {
    throw new Error('Failed to create product after retries - could not get CreatedMTRL from tlm._mtrlCreateProduct');
  }

  return { mtrl: createdMTRL, code: createdCode };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Creates an item in ERP.
 *
 * When SOFTONE_WS_ITEM_CREATION=true, uses the SoftOne setItem web service.
 * Otherwise falls back to the SQL stored procedure tlm._mtrlCreateProduct.
 */
export async function createItemInErp(
  pool: Awaited<ReturnType<typeof getPool>>,
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  params: CreateItemParams,
): Promise<CreatedItemInfo> {
  if (USE_WS_ITEM_CREATION) {
    return createItemViaWebService(pool, erpPool, params);
  }

  return createItemViaSql(pool, erpPool, params);
}
