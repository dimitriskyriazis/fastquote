import { getSoftOneClient } from './softone';
import type { SetDocsLineItem } from './softone';
import type { CreateOrderWithLinesParams, CreatedOrderWithLinesInfo } from './orderCreation';
import { logger } from './logger';

/**
 * Creates an order with lines in SoftOne ERP via the setDocs web service.
 *
 * setDocs creates the document header and all lines atomically in one call.
 *
 * Field mapping (per Web_Services_Documentation_Telmaco_V6):
 *   custcode    = customer CODE string (from dbo.TRDR.CODE, NOT numeric TRDR)
 *   projectcode = PRJC CODE (e.g. COV.0239)
 *   date        = today (YYYY-MM-DD)
 *   status      = '10' (Εκκρεμούν Παραγγελίες σε Προμηθευτή)
 *   comments    = offer description
 *   comments1   = "FastQuote Offer #<offerId>"
 *   items[].productcode = product ERPCode
 *   items[].qty1        = quantity
 *   items[].price       = net unit price (list)
 *   items[].lineval     = qty * price
 *   items[].cost        = net unit cost (when available)
 *   items[].warranty    = warranty in months (when available)
 *   items[].position    = our itemno (OfferDetails.TreeOrdering)
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
    if (line.warrantyMonths != null) item.warranty = String(line.warrantyMonths);
    if (line.position != null) item.position = String(line.position);
    if (line.comment != null && line.comment.trim() !== '') item.comments = line.comment;
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
