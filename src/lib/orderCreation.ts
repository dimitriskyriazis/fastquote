import sql from 'mssql';
import { getErpPool } from './sql';

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
 * Assumes a stored procedure like tlm.findoc_CreateFromIntegration exists that:
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
  request.input('PRJC', sql.Int, params.prjcId);
  request.input('BusinessUnit', sql.VarChar(20), params.businessUnit);
  request.input('TRDR', sql.Int, params.trdr);
  request.input('Series', sql.Int, params.series);
  request.input('CreatedByUser', sql.Int, params.createdByUser);

  const result = await request.query<{
    FINDOC_ID: number;
    FINCODE: string;
    SERIESNUM: number;
  }>(`
    EXEC tlm.findoc_CreateFromIntegration
      @IntegrationKey = @IntegrationKey,
      @PRJC           = @PRJC,
      @BusinessUnit   = @BusinessUnit,
      @TRDR           = @TRDR,
      @Series         = @Series,
      @CreatedByUser  = @CreatedByUser;
  `);

  const row = result.recordset?.[0];
  if (!row || row.FINDOC_ID == null || !row.FINCODE || row.SERIESNUM == null) {
    throw new Error('findoc_CreateFromIntegration did not return FINDOC_ID/FINCODE/SERIESNUM');
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

