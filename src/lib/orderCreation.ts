import { createOrderViaWebService } from './orderCreationWS';

export type OrderLineForCreation = {
  erpId: number;
  erpCode: string;
  qty: number;
  price: number;
  netCost: number | null;
};

export type CreateOrderWithLinesParams = {
  offerId: number;
  description: string;
  customerCode: string;  // alphanumeric CODE from dbo.TRDR.CODE
  prjcId: number;
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
