import { createOrderViaWebService } from './orderCreationWS';

export type OrderLineForCreation = {
  erpId: number;
  erpCode: string;
  qty: number;
  price: number;
  netCost: number | null;
  warrantyMonths: number | null;
  position: number | null; // our itemno (OfferDetails.TreeOrdering)
  comment: string | null; // OfferDetails.Comment — sent as line comments
};

export type CreateOrderWithLinesParams = {
  offerId: number;
  description: string;
  customerCode: string;  // alphanumeric CODE from dbo.TRDR.CODE
  projectCode: string | null; // alphanumeric CODE from dbo.PRJC.CODE (e.g. 'COV.0239')
  prjcId: number;
  salesmanCode: string | null; // Πωλητής (AspNetUsers.NameCode of the offer Approver)
  businessUnit: 'AVS' | 'TVS';
  trdr: number;
  integrationKey: string;
  series: number;
  createdByUser: number;
  lines: OrderLineForCreation[];
};

export type CreatedOrderWithLinesInfo = {
  findocId: number;
  finCode: string;
};

/**
 * Creates an order with lines in ERP via the SoftOne setDocs web service.
 * Creates header + all lines atomically in one call.
 */
export async function createOrderWithLines(
  params: CreateOrderWithLinesParams,
): Promise<CreatedOrderWithLinesInfo> {
  return createOrderViaWebService(params);
}
