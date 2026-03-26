import sql from 'mssql';
import { getPool, getErpPool } from './sql';
import { createItemViaWebService } from './itemCreationWS';

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

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Creates an item in ERP via the SoftOne setItem web service.
 */
export async function createItemInErp(
  pool: Awaited<ReturnType<typeof getPool>>,
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  params: CreateItemParams,
): Promise<CreatedItemInfo> {
  return createItemViaWebService(pool, erpPool, params);
}
