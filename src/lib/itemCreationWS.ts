import { getSoftOneClient } from './softone';
import type { SetItemEntry } from './softone';
import type { CreateItemParams, CreatedItemInfo } from './itemCreation';
import { generateNewErpCode } from './itemCreation';
import { logger } from './logger';
import type { getPool, getErpPool } from './sql';

/**
 * Creates an item in SoftOne ERP via the setItem web service.
 *
 * Field mapping:
 *   code        = generated ERP code (from generateNewErpCode — SQL)
 *   name        = product description
 *   mtrunit     = 1  (Τεμάχια/pieces)
 *   vat         = 1410 (24%)
 *   mtracn      = 0  (Εμπόρευμα)
 *   mtrcategory = 1  (Εμπόρευμα/Merchandise)
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

  const client = getSoftOneClient();

  const item: SetItemEntry = {
    code: newCode,
    name: params.description,
    mtrunit: 1,
    vat: 1410,
    mtracn: 0,
    mtrcategory: 1,
  };

  logger.info('SoftOne WS: calling setItem', {
    productId: String(params.productId),
    code: newCode,
    name: params.description,
    businessUnit: params.businessUnit,
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
