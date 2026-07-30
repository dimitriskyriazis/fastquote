import { getSoftOneClient } from './softone';
import type { SetDocsLineItem } from './softone';
import type { CreateOrderWithLinesParams, CreatedOrderWithLinesInfo } from './orderCreation';
import { logger } from './logger';

/**
 * Creates an order with lines in SoftOne ERP via the setDocs web service.
 *
 * setDocs creates the document header and all lines atomically in one call.
 *
 * Field mapping (per Web_Services_Documentation_Telmaco §4.1.4):
 *   custcode    = customer CODE string (from dbo.TRDR.CODE, NOT numeric TRDR)
 *   series      = document series CODE (8999 = customer pre-order). REQUIRED — without it
 *                 SoftOne cannot resolve the numbering and rejects the save.
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
 *   discval     = document-level discount in EUR, sent only when the offer's
 *                 additional discount is allocated to the document instead of
 *                 being baked into the line prices (WS V11, 29/07/2026)
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
      mtracn: '0',
    };
    if (line.netCost != null) item.cost = toErpDecimal(line.netCost);
    if (line.warrantyMonths != null) item.warranty = String(line.warrantyMonths);
    if (line.position != null) item.position = String(line.position);
    if (line.comment != null && line.comment.trim() !== '') item.comments = line.comment;
    return item;
  });

  // Only send discval when there is a real document discount — an explicit "0"
  // is a value SoftOne would still process, and we never want to touch the field
  // on the (normal) no-discount path.
  const documentDiscount =
    params.documentDiscount != null &&
    Number.isFinite(params.documentDiscount) &&
    params.documentDiscount > 0
      ? params.documentDiscount
      : null;

  logger.info('SoftOne WS: calling setDocs', {
    offerId: String(params.offerId),
    custcode: params.customerCode,
    lineCount: String(items.length),
    documentDiscount: documentDiscount != null ? String(documentDiscount) : null,
  });

  const result = await client.setDocs({
    custcode: params.customerCode,
    series: String(params.series),
    salesmancode: params.salesmanCode ?? undefined,
    shipkind: '1',
    projectcode: params.projectCode ?? undefined,
    date: today,
    status: '10',
    comments: params.description,
    comments1: `FastQuote Offer #${params.offerId}`,
    ...(documentDiscount != null ? { discval: toErpDecimal(documentDiscount) } : {}),
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
