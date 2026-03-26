import { createProjectViaWebService } from './projectCreationWS';

export type CreateProjectFromIntegrationParams = {
  integrationKey: string; // e.g. 'FASTQUOTE_CREATE_PRJC'
  codePrefix: string; // e.g. 'COV'
  name: string;
  prjcParent: number | null;
  trdr: number | null;
  customerCode: string | null; // alphanumeric CODE from TRDR.CODE (e.g. 'ΔΙ.3505')
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
 * Creates a new project in ERP via the SoftOne setProject web service.
 */
export async function createProjectFromIntegration(
  params: CreateProjectFromIntegrationParams,
): Promise<CreatedProjectInfo> {
  return createProjectViaWebService(params);
}
