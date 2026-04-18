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
  createdByUser: number; // e.g. 1011;
  businessUnit: 'AVS' | 'TVS';
  prjState: number; // e.g. 90
  startNetValue?: number | null; // offer net total → startnetvalue
  netOrderValue?: number | null; // offer net total → netordvalue
  costEstimate?: number | null;  // offer total cost → costestimate
  financialSituation?: string | null; // setProject.finantialsituation
  salesman?: string | null; // Approval user's NameCode → setProject.salesman
  salesRep?: string | null; // Sales Person's NameCode → setProject.salesrep
  implementManager?: string | null; // Sales Person's NameCode → setProject.implementmanager
  designEngineer?: string | null; // Sales Person's NameCode → setProject.designengineer
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
