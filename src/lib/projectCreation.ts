import sql from 'mssql';
import { getErpPool } from './sql';

export type CreateProjectFromIntegrationParams = {
  integrationKey: string; // e.g. 'FASTQUOTE_CREATE_PRJC'
  codePrefix: string; // e.g. 'COV'
  name: string;
  prjcParent: number | null;
  trdr: number | null;
  prjCategory: number | null;
  sourceSystem: string; // e.g. 'FQ'
  createdByUser: number; // e.g. 1011
  businessUnit: 'AVS' | 'TVS';
  prjState: number; // e.g. 90
};

export type CreatedProjectInfo = {
  prjcId: number;
  prjcCode: string;
};

/**
 * Calls tlm.prjc_CreateFromIntegration to create a new project in ERP.
 *
 * This procedure:
 * - Enforces the IntegrationConfig kill switch
 * - Generates a unique project CODE using the configured counters
 * - Inserts into dbo.PRJC (and related tables)
 * - Returns the new PRJC ID and CODE
 */
export async function createProjectFromIntegration(
  params: CreateProjectFromIntegrationParams,
): Promise<CreatedProjectInfo> {
  const erpPool = await getErpPool();
  const request = erpPool.request();

  request.input('IntegrationKey', sql.NVarChar(100), params.integrationKey);
  request.input('CodePrefix', sql.Char(3), params.codePrefix);
  request.input('Name', sql.NVarChar(200), params.name);
  request.input('PrjcParent', sql.Int, params.prjcParent);
  request.input('Trdr', sql.Int, params.trdr);
  request.input('PrjCategory', sql.Int, params.prjCategory);
  request.input('SourceSystem', sql.NVarChar(50), params.sourceSystem);
  request.input('CreatedByUser', sql.Int, params.createdByUser);
  request.input('BusinessUnit', sql.VarChar(20), params.businessUnit);
  request.input('PrjState', sql.SmallInt, params.prjState);

  const result = await request.query<{
    PRJC_ID: number;
    PRJC_CODE: string;
  }>(`
    EXEC tlm.prjc_CreateFromIntegration
      @IntegrationKey = @IntegrationKey,
      @CodePrefix     = @CodePrefix,
      @Name           = @Name,
      @PrjcParent     = @PrjcParent,
      @Trdr           = @Trdr,
      @PrjCategory    = @PrjCategory,
      @SourceSystem   = @SourceSystem,
      @CreatedByUser  = @CreatedByUser,
      @BusinessUnit   = @BusinessUnit,
      @PrjState       = @PrjState;
  `);

  const row = result.recordset?.[0];
  if (!row || row.PRJC_ID == null || !row.PRJC_CODE) {
    throw new Error('prjc_CreateFromIntegration did not return PRJC_ID/PRJC_CODE');
  }

  return {
    prjcId: row.PRJC_ID,
    prjcCode: row.PRJC_CODE,
  };
}

