import sql from 'mssql';
import { getErpPool } from './sql';

/**
 * Status codes returned by tlm._prjcFindProject
 */
export type ProjectFindStatus = 0 | 1 | 2 | 3;

/**
 * Status code meanings:
 * - 0 = OK (exists and code matches)
 * - 1 = NOT_FOUND (PRJC not found in COMPANY=1)
 * - 2 = CODE_MISMATCH (PRJC found but code differs)
 * - 3 = INVALID_INPUT (missing/invalid params)
 */
export const PROJECT_FIND_STATUS = {
  OK: 0 as const,
  NOT_FOUND: 1 as const,
  CODE_MISMATCH: 2 as const,
  INVALID_INPUT: 3 as const,
} as const;

export type ProjectFindResult = {
  statusCode: ProjectFindStatus;
  statusText: 'OK' | 'NOT_FOUND' | 'CODE_MISMATCH' | 'INVALID_INPUT';
  prjc: number;
  inputCode: string | null;
  actualCode: string | null;
};

/**
 * Finds and validates a project by ID and code using tlm._prjcFindProject
 * 
 * @param prjc - Project ID
 * @param code - Expected project code
 * @returns ProjectFindResult with status and details
 * @throws Error if the database call fails
 */
export async function findProject(
  prjc: number,
  code: string,
): Promise<ProjectFindResult> {
  if (!prjc || prjc <= 0) {
    return {
      statusCode: PROJECT_FIND_STATUS.INVALID_INPUT,
      statusText: 'INVALID_INPUT',
      prjc,
      inputCode: code || null,
      actualCode: null,
    };
  }

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return {
      statusCode: PROJECT_FIND_STATUS.INVALID_INPUT,
      statusText: 'INVALID_INPUT',
      prjc,
      inputCode: null,
      actualCode: null,
    };
  }

  const erpPool = await getErpPool();
  const request = erpPool.request();
  
  request.input('PRJC', sql.Int, prjc);
  request.input('CODE', sql.NVarChar(25), code.trim());

  // The procedure returns a SELECT statement with the results
  // We need to declare a variable for the OUTPUT parameter (can't use NULL directly)
  const result = await request.query<{
    StatusCode: number;
    StatusText: string;
    PRJC: number;
    InputCODE: string | null;
    ActualCODE: string | null;
  }>(`
    DECLARE @StatusCode INT;
    EXEC tlm._prjcFindProject
      @PRJC = @PRJC,
      @CODE = @CODE,
      @StatusCode = @StatusCode OUTPUT;
  `);

  // Get the result from the recordset (the procedure returns a SELECT)
  const recordsetRow = result.recordset?.[0];
  
  if (!recordsetRow) {
    // Fallback if no result returned
    return {
      statusCode: PROJECT_FIND_STATUS.INVALID_INPUT,
      statusText: 'INVALID_INPUT',
      prjc,
      inputCode: code.trim(),
      actualCode: null,
    };
  }

  const statusCode = (recordsetRow.StatusCode ?? PROJECT_FIND_STATUS.INVALID_INPUT) as ProjectFindStatus;
  
  // The procedure already returns StatusText, but we'll use our type-safe mapping
  const statusTextMap: Record<ProjectFindStatus, ProjectFindResult['statusText']> = {
    0: 'OK',
    1: 'NOT_FOUND',
    2: 'CODE_MISMATCH',
    3: 'INVALID_INPUT',
  };

  return {
    statusCode,
    statusText: statusTextMap[statusCode] || (recordsetRow.StatusText as ProjectFindResult['statusText']) || 'INVALID_INPUT',
    prjc: recordsetRow.PRJC ?? prjc,
    inputCode: recordsetRow.InputCODE ?? code.trim(),
    actualCode: recordsetRow.ActualCODE ?? null,
  };
}
