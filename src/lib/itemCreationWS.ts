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

  const client = getSoftOneClient();

  // Format name as "{ModelNumber} - {Description}" or just "{Description}" if no model number
  const nameParts: string[] = [];
  if (params.modelNumber) nameParts.push(params.modelNumber);
  nameParts.push(params.description);
  const itemName = nameParts.join(' - ');

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
  };

  logger.info('SoftOne WS: calling setItem', {
    productId: String(params.productId),
    code: newCode,
    code2: params.partNumber ?? null,
    name: itemName,
    businessUnit: params.businessUnit,
    mtrmanfctr: mtrmanfctr ?? null,
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
