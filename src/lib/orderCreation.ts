import sql from 'mssql';
import { getErpPool } from './sql';
import { createOrderViaWebService } from './orderCreationWS';
import { logger } from './logger';

export type CreateCustomerOrderParams = {
  prjcId: number;
  businessUnit: 'AVS' | 'TVS';
  trdr: number;
  integrationKey: string; // e.g. 'FASTQUOTE_CREATE_FINDOC'
  series: number; // e.g. 9001
  createdByUser: number; // e.g. 1011
};

export type CreatedCustomerOrderInfo = {
  findocId: number;
  finCode: string;
  seriesNum: number;
};

export type OrderLineInput = {
  findocId: number;
  cccPosNo: string;
  mtrl: number;
  qty: number;
  price: number;
  num01: number | null;
  createdByUser: number;
};

/**
 * Creates a customer order (FINDOC) in ERP using the integration procedure.
 *
 * Calls tlm._findocCreateCustomerOrder which:
 * - Enforces the IntegrationConfig kill switch
 * - Reserves the next SERIESNUM via tlm.FINDOC_SeriesCounter
 * - Inserts into dbo.FINDOC
 * - Returns FINDOC_ID, FINCODE, SERIESNUM via a SELECT
 */
export async function createCustomerOrder(
  params: CreateCustomerOrderParams,
): Promise<CreatedCustomerOrderInfo> {
  const erpPool = await getErpPool();
  const request = erpPool.request();

  request.input('IntegrationKey', sql.NVarChar(100), params.integrationKey);
  request.input('Prjc', sql.Int, params.prjcId);
  request.input('Trdr', sql.Int, params.trdr);
  request.input('BusinessUnit', sql.VarChar(20), params.businessUnit);
  request.input('Series', sql.Int, params.series);
  request.input('CreatedByUser', sql.Int, params.createdByUser);

  const result = await request.query<{
    FINDOC_ID: number;
    FINCODE: string;
    SERIESNUM: number;
  }>(`
    EXEC tlm._findocCreateCustomerOrder
      @IntegrationKey = @IntegrationKey,
      @Prjc           = @Prjc,
      @Trdr           = @Trdr,
      @BusinessUnit   = @BusinessUnit,
      @Series         = @Series,
      @CreatedByUser  = @CreatedByUser;
  `);

  const row = result.recordset?.[0];
  if (!row || row.FINDOC_ID == null || !row.FINCODE || row.SERIESNUM == null) {
    throw new Error('_findocCreateCustomerOrder did not return FINDOC_ID/FINCODE/SERIESNUM');
  }

  return {
    findocId: row.FINDOC_ID,
    finCode: row.FINCODE,
    seriesNum: row.SERIESNUM,
  };
}

/**
 * Adds a material line to an existing order using tlm._mtrlinesAddLine.
 *
 * This procedure:
 * - Inherits PRJC, BUSUNITS, TRDR, etc. from the FINDOC header
 * - Computes the next LINENUM per document under lock
 * - Inserts into dbo.MTRLINES and recomputes header totals
 */
export async function addOrderLine(input: OrderLineInput): Promise<void> {
  const erpPool = await getErpPool();
  const request = erpPool.request();

  request.input('Findoc', sql.Int, input.findocId);
  request.input('CCCPosNo', sql.NVarChar(50), input.cccPosNo);
  request.input('MTRL', sql.Int, input.mtrl);
  request.input('QTY', sql.Decimal(18, 4), input.qty);
  request.input('PRICE', sql.Decimal(18, 4), input.price);
  request.input('NUM01', sql.Decimal(18, 4), input.num01);
  request.input('CreatedByUser', sql.Int, input.createdByUser);

  await request.query(`
    EXEC tlm._mtrlinesAddLine
      @Findoc        = @Findoc,
      @CCCPosNo      = @CCCPosNo,
      @MTRL          = @MTRL,
      @QTY           = @QTY,
      @PRICE         = @PRICE,
      @NUM01         = @NUM01,
      @CreatedByUser = @CreatedByUser;
  `);
}

// ── Order + Lines dispatch (WS vs SQL) ────────────────────────────────────

const USE_WS_ORDER_CREATION = process.env.SOFTONE_WS_ORDER_CREATION === 'true';

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
 * Creates an order with lines in ERP.
 *
 * When SOFTONE_WS_ORDER_CREATION=true, uses the SoftOne setDocs web service
 * (creates header + all lines atomically in one call).
 * Otherwise falls back to SQL SPs: createCustomerOrder + addOrderLine per line.
 */
export async function createOrderWithLines(
  params: CreateOrderWithLinesParams,
): Promise<CreatedOrderWithLinesInfo> {
  if (USE_WS_ORDER_CREATION) {
    return createOrderViaWebService(params);
  }

  // SQL path: create header, then add lines one by one
  const orderInfo = await createCustomerOrder({
    prjcId: params.prjcId,
    businessUnit: params.businessUnit,
    trdr: params.trdr,
    integrationKey: params.integrationKey,
    series: params.series,
    createdByUser: params.createdByUser,
  });

  let lineIndex = 0;
  for (const line of params.lines) {
    lineIndex += 1;
    const cccPosNo = String(lineIndex);

    try {
      await addOrderLine({
        findocId: orderInfo.findocId,
        cccPosNo,
        mtrl: line.erpId,
        qty: line.qty,
        price: line.price,
        num01: line.netCost,
        createdByUser: params.createdByUser,
      });
    } catch (lineErr) {
      logger.error(
        'Failed to add order line',
        {
          offerId: String(params.offerId),
          findocId: String(orderInfo.findocId),
          erpId: String(line.erpId),
          cccPosNo,
        },
        lineErr instanceof Error ? lineErr : undefined,
      );
    }
  }

  return {
    findocId: orderInfo.findocId,
    finCode: orderInfo.finCode,
  };
}

