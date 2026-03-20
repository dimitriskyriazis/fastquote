import { getSoftOneClient } from './softone';
import type { SetProjectParams } from './softone';
import type { CreateProjectFromIntegrationParams, CreatedProjectInfo } from './projectCreation';
import { logger } from './logger';

/**
 * Maps the FastQuote businessUnit string to the SoftOne WS Business Unit code.
 *
 * From the WS documentation:
 *   10 = AVS
 *   20 = TVS
 */
function mapBusinessUnit(bu: 'AVS' | 'TVS'): string {
  return bu === 'AVS' ? '10' : '20';
}

/**
 * Creates a project in SoftOne ERP via the setProject web service,
 * matching the same contract as createProjectFromIntegration.
 *
 * Field mapping from CreateProjectFromIntegrationParams → setProject WS:
 *   name           → name, shortdesc
 *   businessUnit   → businessunit (numeric code)
 *   trdr           → custcode (customer code string)
 *   prjState       → prjstatus (string)
 *   codePrefix     → code (prefix — SoftOne may auto-complete the sequence)
 */
export async function createProjectViaWebService(
  params: CreateProjectFromIntegrationParams,
): Promise<CreatedProjectInfo> {
  const client = getSoftOneClient();

  const wsParams: SetProjectParams = {
    name: params.name,
    shortdesc: params.name,
    businessunit: mapBusinessUnit(params.businessUnit),
    prjstatus: String(params.prjState),
  };

  // Map customer CODE if provided (alphanumeric CODE from TRDR.CODE, e.g. 'ΔΙ.3505')
  if (params.customerCode) {
    wsParams.custcode = params.customerCode;
  }

  // Map parent project if provided
  if (params.prjcParent != null) {
    wsParams.prjparent = String(params.prjcParent);
  }

  // Pass code prefix if provided (SoftOne may auto-generate the full code)
  if (params.codePrefix) {
    wsParams.code = params.codePrefix;
  }

  logger.info('SoftOne WS: calling setProject', {
    name: params.name,
    businessUnit: params.businessUnit,
    prjState: params.prjState,
    trdr: params.trdr ?? null,
    codePrefix: params.codePrefix,
  });

  const result = await client.setProject(wsParams);

  logger.info('SoftOne WS: setProject result', {
    success: result.success,
    id: result.id,
    code: result.code,
    message: result.message ?? null,
  });

  if (!result.id || !result.code) {
    throw new Error(
      `setProject did not return expected id/code. Response: ${JSON.stringify(result)}`,
    );
  }

  return {
    prjcId: result.id,
    prjcCode: result.code,
  };
}
