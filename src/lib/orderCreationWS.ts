import { getSoftOneClient } from './softone';
import type { SetDocsLineItem } from './softone';
import type { CreateOrderWithLinesParams, CreatedOrderWithLinesInfo } from './orderCreation';
import { logger } from './logger';

/**
 * Creates an order with lines in SoftOne ERP via the setDocs web service.
 *
 * setDocs creates the document header and all lines atomically in one call.
 *
 * Field mapping:
 *   custcode  = customer CODE string (from dbo.TRDR.CODE, NOT numeric TRDR)
 *   date      = today (YYYY-MM-DD)
 *   status    = '10' (Εκκρεμούν Παραγγελίες σε Προμηθευτή)
 *   comments  = offer description
 *   comments1 = "FastQuote Offer #<offerId>"
 *   items[].productcode = product ERPCode
 *   items[].qty1        = quantity
 *   items[].price       = list price
 *   items[].lineval     = qty * price
 */
export async function createOrderViaWebService(
  params: CreateOrderWithLinesParams,
): Promise<CreatedOrderWithLinesInfo> {
  const client = getSoftOneClient();

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // SoftOne parses numeric strings using Greek locale where '.' is the thousands
  // separator and ',' is the decimal separator. Sending "191.4" gets stripped to
  // 1914. Always emit decimals with a comma and a fixed scale.
  const toErpDecimal = (n: number, scale = 2) => n.toFixed(scale).replace('.', ',');

  const items: SetDocsLineItem[] = params.lines.map((line) => {
    const item: SetDocsLineItem = {
      productcode: line.erpCode,
      qty1: toErpDecimal(line.qty),
      price: toErpDecimal(line.price),
      lineval: toErpDecimal(line.qty * line.price),
    };
    if (line.netCost != null) item.cost = toErpDecimal(line.netCost);
    if (line.warrantyMonths != null) item.warrantymonths = String(line.warrantyMonths);
    return item;
  });

  logger.info('SoftOne WS: calling setDocs', {
    offerId: String(params.offerId),
    custcode: params.customerCode,
    lineCount: String(items.length),
  });

  const result = await client.setDocs({
    custcode: params.customerCode,
    projectcode: params.projectCode ?? undefined,
    date: today,
    status: '10',
    comments: params.description,
    comments1: `FastQuote Offer #${params.offerId}`,
    items,
  });

  logger.info('SoftOne WS: setDocs result', {
    success: result.success,
    id: String(result.id),
    code: result.code,
    message: result.message ?? null,
  });

  if (!result.id || !result.code) {
    throw new Error(
      `setDocs did not return expected id/code. Response: ${JSON.stringify(result)}`,
    );
  }

  return {
    findocId: result.id,
    finCode: result.code,
  };
}
