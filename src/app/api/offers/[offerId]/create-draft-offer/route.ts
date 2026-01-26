import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool, getErpPool } from '../../../../../lib/sql';

type ProductMatch = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  partNumberActual: string | null;
  modelNumberActual: string | null;
  matches: Array<{
    MTRL: number;
    CODE: string | null;
    CODE1: string | null;
    CODE2: string | null;
    NAME1: string | null;
  }>;
};

type ProductSelection = {
  productId: number;
  MTRL: number;
  CODE: string | null;
};

type CreateDraftOfferRequestBody = {
  selections?: ProductSelection[];
};

function normalizeOfferId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Type guard to check if error is a RequestError with a number property
function isRequestErrorWithNumber(error: unknown): error is { number: number } {
  return typeof error === 'object' && error !== null && 'number' in error && typeof (error as { number: unknown }).number === 'number';
}

// Generate a new CODE by finding the max numeric CODE in ERP MTRL table and incrementing
// Example: if max is 146000, returns 146001
// Retries if the generated CODE already exists (handles race conditions)
async function generateNewErpCode(erpPool: Awaited<ReturnType<typeof getErpPool>>, retryCount = 0): Promise<string> {
  const MAX_RETRIES = 5;
  try {
    const codeRequest = erpPool.request();
    const codeResult = await codeRequest.query<{
      MaxCode: number | null;
    }>(`
      SELECT MAX(CAST(CODE AS BIGINT)) AS MaxCode
      FROM dbo.MTRL
      WHERE COMPANY = 1
        AND ISACTIVE = 1
        AND CODE IS NOT NULL
        AND CODE <> ''
        AND TRY_CAST(CODE AS BIGINT) IS NOT NULL
    `);
    
    const maxCode = codeResult.recordset?.[0]?.MaxCode;
    let nextCode: number;
    if (maxCode != null && Number.isFinite(maxCode) && maxCode > 0) {
      // Increment by 1 + retry count to handle race conditions
      nextCode = Number(maxCode) + 1 + retryCount;
    } else {
      // If no numeric codes found, start from 1 + retry count
      nextCode = 1 + retryCount;
    }
    
    const codeString = nextCode.toString();
    
    // Verify the CODE doesn't already exist (check for duplicates)
    const checkRequest = erpPool.request();
    checkRequest.input('code', sql.NVarChar(25), codeString);
    const checkResult = await checkRequest.query<{
      Exists: number;
    }>(`
      SELECT COUNT(*) AS Exists
      FROM dbo.MTRL
      WHERE COMPANY = 1
        AND CODE = @code
    `);
    
    const exists = checkResult.recordset?.[0]?.Exists ?? 0;
    if (exists > 0 && retryCount < MAX_RETRIES) {
      // CODE exists, retry with incremented value
      return generateNewErpCode(erpPool, retryCount + 1);
    }
    
    return codeString;
  } catch (err) {
    console.error('Failed to generate new ERP CODE:', err);
    if (retryCount < MAX_RETRIES) {
      // Retry on error
      return generateNewErpCode(erpPool, retryCount + 1);
    }
    // Fallback: use timestamp-based code
    return Date.now().toString().slice(-10);
  }
}

// First call: Find matches for all products
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const { offerId: offerIdParam } = await params;
    const normalizedId = normalizeOfferId(
      typeof offerIdParam === 'string' ? decodeURIComponent(offerIdParam) : null,
    );
    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid offer id' },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => null)) as CreateDraftOfferRequestBody | null;
    const selections = body?.selections ?? [];

    const pool = await getPool();
    const erpPool = await getErpPool();

    // Get offer's SalesDivisionName
    const offerRequest = pool.request();
    offerRequest.input('offerId', sql.Int, normalizedId);
    const offerResult = await offerRequest.query<{
      SalesDivisionName: string | null;
    }>(`
      SELECT sd.Name AS SalesDivisionName
      FROM dbo.Offer o
      LEFT JOIN dbo.SalesDivision sd ON o.SalesDivitionID = sd.ID
      WHERE o.ID = @offerId
    `);
    const salesDivisionName = offerResult.recordset?.[0]?.SalesDivisionName ?? null;
    // Map SalesDivisionName to BusinessUnit: 'TVS' if contains 'TVS', otherwise 'AVS'
    const businessUnit = salesDivisionName && salesDivisionName.toUpperCase().includes('TVS') ? 'TVS' : 'AVS';

    // Get all products from the offer that have ProductID, including Brand name and Description
    const productsRequest = pool.request();
    productsRequest.input('offerId', sql.Int, normalizedId);
    const productsResult = await productsRequest.query<{
      ProductID: number;
      PartNumberCleared: string | null;
      ModelNumberCleared: string | null;
      PartNumber: string | null;
      ModelNumber: string | null;
      Description: string | null;
      BrandName: string | null;
      BrandID: number | null;
    }>(`
      SELECT DISTINCT
        p.ID AS ProductID,
        p.PartNumberCleared,
        p.ModelNumberCleared,
        p.PartNumber,
        p.ModelNumber,
        p.Description,
        b.Name AS BrandName,
        p.BrandID
      FROM dbo.OfferDetails od
      INNER JOIN dbo.Products p ON od.ProductID = p.ID
      LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      WHERE od.OfferID = @offerId
        AND od.ProductID IS NOT NULL
        AND (p.PartNumberCleared IS NOT NULL OR p.ModelNumberCleared IS NOT NULL)
    `);

    const products = productsResult.recordset ?? [];
    if (products.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No products found in offer',
        needsSelection: [],
        updated: [],
      });
    }

    const productMatches: ProductMatch[] = [];
    const updatePromises: Promise<void>[] = [];

    // If selections are provided, update products directly
    if (selections.length > 0) {
      const selectionMap = new Map(
        selections.map((s) => [s.productId, { MTRL: s.MTRL, CODE: s.CODE }]),
      );

      for (const product of products) {
        const selection = selectionMap.get(product.ProductID);
        if (selection) {
          const updateRequest = pool.request();
          updateRequest.input('productId', sql.Int, product.ProductID);
          updateRequest.input('erpId', sql.Int, selection.MTRL);
          updateRequest.input('erpCode', sql.NVarChar(255), selection.CODE);

          updatePromises.push(
            updateRequest.query(`
              UPDATE dbo.Products
              SET ERPID = @erpId,
                  ERPCode = @erpCode,
                  ModifiedOn = SYSUTCDATETIME()
              WHERE ID = @productId
            `).then(() => undefined),
          );
        } else {
          // No selection provided, need to search
          try {
            const erpRequest = erpPool.request();
            erpRequest.input('PartNo', sql.NVarChar(200), product.PartNumberCleared);
            erpRequest.input('ModelNo', sql.NVarChar(200), product.ModelNumberCleared);
            erpRequest.input('TopN', sql.Int, 200);

            // Call stored procedure - it returns two result sets
            const erpResult = await erpRequest.query(`
              DECLARE @FoundCount INT;
              EXEC [tlm].[_mtrlFindProduct]
                @PartNo = @PartNo,
                @ModelNo = @ModelNo,
                @TopN = @TopN,
                @FoundCount = @FoundCount OUTPUT;
            `) as { recordset: Array<{ FoundCount: number }>; recordsets?: Array<Array<unknown>> };
          
          // The procedure returns two result sets:
          // 1. FoundCount (single row) - recordsets[0]
          // 2. Matches (multiple rows) - recordsets[1]
          const foundCountResult = (erpResult.recordsets?.[0] as Array<{ FoundCount: number }>) ?? erpResult.recordset;
          const foundCount = foundCountResult[0]?.FoundCount ?? 0;
          
            const matches = (erpResult.recordsets?.[1] ?? []) as Array<{
              MTRL: number;
              CODE: string | null;
              NAME1: string | null;
              CODE1: string | null;
              CODE2: string | null;
            }>;

            if (foundCount === 0) {
              // No matches found - automatically create product in ERP
              try {
                // Validate required fields
                if (!product.Description || !product.BrandID) {
                  console.error(`Product ${product.ProductID} missing Description or BrandID`);
                  productMatches.push({
                    productId: product.ProductID,
                    partNumber: product.PartNumberCleared,
                    modelNumber: product.ModelNumberCleared,
                    partNumberActual: product.PartNumber,
                    modelNumberActual: product.ModelNumber,
                    matches: [],
                  });
                  continue;
                }

                // Try to create product with retry logic for duplicate CODE errors
                let retryCount = 0;
                const MAX_RETRIES = 3;
                let createdMTRL: number | null = null;
                let createdCode: string | null = null;

                while (retryCount <= MAX_RETRIES && !createdMTRL) {
                  try {
                    // Generate new CODE (will increment on retries)
                    const newCode = await generateNewErpCode(erpPool, retryCount);

                    // Call tlm._mtrlCreateProduct
                    const createRequest = erpPool.request();
                    createRequest.input('CODE', sql.NVarChar(25), newCode);
                    createRequest.input('CODE1', sql.NVarChar(25), product.ModelNumberCleared);
                    createRequest.input('CODE2', sql.NVarChar(50), product.PartNumberCleared);
                    createRequest.input('Description', sql.NVarChar(128), product.Description);
                    createRequest.input('BrandId', sql.Int, product.BrandID);
                    createRequest.input('BusinessUnit', sql.NVarChar(20), businessUnit);

                    const createResult = await createRequest.query(`
                      DECLARE @CreatedMTRL INT;
                      EXEC [tlm].[_mtrlCreateProduct]
                        @CODE = @CODE,
                        @CODE1 = @CODE1,
                        @CODE2 = @CODE2,
                        @Description = @Description,
                        @BrandId = @BrandId,
                        @BusinessUnit = @BusinessUnit,
                        @CreatedMTRL = @CreatedMTRL OUTPUT;
                      SELECT @CreatedMTRL AS CreatedMTRL;
                    `) as { recordset: Array<{ CreatedMTRL: number }>; recordsets?: Array<Array<{ MTRL: number; CODE: string | null }>> };

                    // The procedure returns the created product in recordsets[0] and CreatedMTRL in recordset
                    createdMTRL = createResult.recordset?.[0]?.CreatedMTRL ?? createResult.recordsets?.[0]?.[0]?.MTRL ?? null;
                    createdCode = createResult.recordsets?.[0]?.[0]?.CODE ?? newCode;
                  } catch (retryErr) {
                    const isDuplicateKey = isRequestErrorWithNumber(retryErr) && retryErr.number === 2627;
                    if (isDuplicateKey && retryCount < MAX_RETRIES) {
                      // Duplicate CODE error - retry with a new CODE
                      retryCount++;
                      console.warn(`Duplicate CODE detected for product ${product.ProductID}, retrying (attempt ${retryCount}/${MAX_RETRIES})...`);
                      continue;
                    }
                    // Re-throw if not a duplicate key error or max retries reached
                    throw retryErr;
                  }
                }

                if (createdMTRL && createdCode) {
                  // Update FastQuote Products table with the new ERP IDs
                  const updateRequest = pool.request();
                  updateRequest.input('productId', sql.Int, product.ProductID);
                  updateRequest.input('erpId', sql.Int, createdMTRL);
                  updateRequest.input('erpCode', sql.NVarChar(255), createdCode);

                  updatePromises.push(
                    updateRequest.query(`
                      UPDATE dbo.Products
                      SET ERPID = @erpId,
                          ERPCode = @erpCode,
                          ModifiedOn = SYSUTCDATETIME()
                      WHERE ID = @productId
                    `).then(() => undefined),
                  );
                } else {
                  throw new Error('Failed to create product after retries - could not get CreatedMTRL from tlm._mtrlCreateProduct');
                }
              } catch (createErr) {
                const errorMessage = createErr instanceof Error ? createErr.message : String(createErr);
                const isTemplateError = errorMessage.includes('Template MTRL not found') || 
                                       (isRequestErrorWithNumber(createErr) && createErr.number === 53012);
                const isDuplicateKey = isRequestErrorWithNumber(createErr) && createErr.number === 2627;
                
                if (isTemplateError) {
                  console.error(
                    `Failed to create product in ERP for product ${product.ProductID}: Template MTRL (147124) not found in ERP database. ` +
                    `This is a database configuration issue - the template MTRL must exist in COMPANY=1.`,
                    createErr
                  );
                } else if (isDuplicateKey) {
                  console.error(
                    `Failed to create product in ERP for product ${product.ProductID}: Duplicate CODE detected after 3 retries. ` +
                    `The generated CODE already exists in the ERP database. This may indicate a race condition or CODE generation issue.`,
                    createErr
                  );
                } else {
                  console.error(`Failed to create product in ERP for product ${product.ProductID}:`, createErr);
                }
                // Add to productMatches for manual attention
                productMatches.push({
                  productId: product.ProductID,
                  partNumber: product.PartNumberCleared,
                  modelNumber: product.ModelNumberCleared,
                  partNumberActual: product.PartNumber,
                  modelNumberActual: product.ModelNumber,
                  matches: [],
                });
              }
            } else if (foundCount === 1) {
              // Single match - update directly
              const match = matches[0];
              const updateRequest = pool.request();
              updateRequest.input('productId', sql.Int, product.ProductID);
              updateRequest.input('erpId', sql.Int, match.MTRL);
              updateRequest.input('erpCode', sql.NVarChar(255), match.CODE);

              updatePromises.push(
                updateRequest.query(`
                  UPDATE dbo.Products
                  SET ERPID = @erpId,
                      ERPCode = @erpCode,
                      ModifiedOn = SYSUTCDATETIME()
                  WHERE ID = @productId
                `).then(() => undefined),
              );
            } else {
              // Multiple matches - need user selection
              productMatches.push({
                productId: product.ProductID,
                partNumber: product.PartNumberCleared,
                modelNumber: product.ModelNumberCleared,
                partNumberActual: product.PartNumber,
                modelNumberActual: product.ModelNumber,
                matches,
              });
            }
          } catch (erpErr) {
            // Handle stored procedure not found or other ERP errors
            console.error(`Failed to search ERP for product ${product.ProductID}:`, erpErr);
            productMatches.push({
              productId: product.ProductID,
              partNumber: product.PartNumberCleared,
              modelNumber: product.ModelNumberCleared,
              partNumberActual: product.PartNumber,
              modelNumberActual: product.ModelNumber,
              matches: [],
            });
          }
        }
      }

      await Promise.all(updatePromises);

      return NextResponse.json({
        ok: true,
        message: 'Products updated successfully',
        needsSelection: productMatches,
        updated: selections.map((s) => s.productId),
      });
    }

    // No selections provided - search for all products
    for (const product of products) {
      try {
        const erpRequest = erpPool.request();
        erpRequest.input('PartNo', sql.NVarChar(200), product.PartNumberCleared);
        erpRequest.input('ModelNo', sql.NVarChar(200), product.ModelNumberCleared);
        erpRequest.input('TopN', sql.Int, 200);

        // Call stored procedure - it returns two result sets
        const erpResult = await erpRequest.query(`
          DECLARE @FoundCount INT;
          EXEC [tlm].[_mtrlFindProduct]
            @PartNo = @PartNo,
            @ModelNo = @ModelNo,
            @TopN = @TopN,
            @FoundCount = @FoundCount OUTPUT;
        `) as { recordset: Array<{ FoundCount: number }>; recordsets?: Array<Array<unknown>> };
      
      // The procedure returns two result sets:
      // 1. FoundCount (single row) - recordsets[0]
      // 2. Matches (multiple rows) - recordsets[1]
      const foundCountResult = (erpResult.recordsets?.[0] as Array<{ FoundCount: number }>) ?? erpResult.recordset;
      const foundCount = foundCountResult[0]?.FoundCount ?? 0;
      
        const matches = (erpResult.recordsets?.[1] ?? []) as Array<{
          MTRL: number;
          CODE: string | null;
          NAME1: string | null;
          CODE1: string | null;
          CODE2: string | null;
        }>;

        if (foundCount === 0) {
          // No matches found - automatically create product in ERP
          try {
            // Validate required fields
            if (!product.Description || !product.BrandID) {
              console.error(`Product ${product.ProductID} missing Description or BrandID`);
              productMatches.push({
                productId: product.ProductID,
                partNumber: product.PartNumberCleared,
                modelNumber: product.ModelNumberCleared,
                partNumberActual: product.PartNumber,
                modelNumberActual: product.ModelNumber,
                matches: [],
              });
              continue;
            }

            // Try to create product with retry logic for duplicate CODE errors
            let retryCount = 0;
            const MAX_RETRIES = 3;
            let createdMTRL: number | null = null;
            let createdCode: string | null = null;

            while (retryCount <= MAX_RETRIES && !createdMTRL) {
              try {
                // Generate new CODE (will increment on retries)
                const newCode = await generateNewErpCode(erpPool, retryCount);

                // Call tlm._mtrlCreateProduct
                const createRequest = erpPool.request();
                createRequest.input('CODE', sql.NVarChar(25), newCode);
                createRequest.input('CODE1', sql.NVarChar(25), product.ModelNumberCleared);
                createRequest.input('CODE2', sql.NVarChar(50), product.PartNumberCleared);
                createRequest.input('Description', sql.NVarChar(128), product.Description);
                createRequest.input('BrandId', sql.Int, product.BrandID);
                createRequest.input('BusinessUnit', sql.NVarChar(20), businessUnit);

                const createResult = await createRequest.query(`
                  DECLARE @CreatedMTRL INT;
                  EXEC [tlm].[_mtrlCreateProduct]
                    @CODE = @CODE,
                    @CODE1 = @CODE1,
                    @CODE2 = @CODE2,
                    @Description = @Description,
                    @BrandId = @BrandId,
                    @BusinessUnit = @BusinessUnit,
                    @CreatedMTRL = @CreatedMTRL OUTPUT;
                  SELECT @CreatedMTRL AS CreatedMTRL;
                `) as { recordset: Array<{ CreatedMTRL: number }>; recordsets?: Array<Array<{ MTRL: number; CODE: string | null }>> };

                // The procedure returns the created product in recordsets[0] and CreatedMTRL in recordset
                createdMTRL = createResult.recordset?.[0]?.CreatedMTRL ?? createResult.recordsets?.[0]?.[0]?.MTRL ?? null;
                createdCode = createResult.recordsets?.[0]?.[0]?.CODE ?? newCode;
              } catch (retryErr) {
                const isDuplicateKey = isRequestErrorWithNumber(retryErr) && retryErr.number === 2627;
                if (isDuplicateKey && retryCount < MAX_RETRIES) {
                  // Duplicate CODE error - retry with a new CODE
                  retryCount++;
                  console.warn(`Duplicate CODE detected for product ${product.ProductID}, retrying (attempt ${retryCount}/${MAX_RETRIES})...`);
                  continue;
                }
                // Re-throw if not a duplicate key error or max retries reached
                throw retryErr;
              }
            }

            if (createdMTRL && createdCode) {
              // Update FastQuote Products table with the new ERP IDs
              const updateRequest = pool.request();
              updateRequest.input('productId', sql.Int, product.ProductID);
              updateRequest.input('erpId', sql.Int, createdMTRL);
              updateRequest.input('erpCode', sql.NVarChar(255), createdCode);

              await updateRequest.query(`
                UPDATE dbo.Products
                SET ERPID = @erpId,
                    ERPCode = @erpCode,
                    ModifiedOn = SYSUTCDATETIME()
                WHERE ID = @productId
              `);
            } else {
              throw new Error('Failed to create product after retries - could not get CreatedMTRL from tlm._mtrlCreateProduct');
            }
          } catch (createErr) {
            const errorMessage = createErr instanceof Error ? createErr.message : String(createErr);
            const isTemplateError = errorMessage.includes('Template MTRL not found') || 
                                   (isRequestErrorWithNumber(createErr) && createErr.number === 53012);
            const isDuplicateKey = isRequestErrorWithNumber(createErr) && createErr.number === 2627;
            
            if (isTemplateError) {
              console.error(
                `Failed to create product in ERP for product ${product.ProductID}: Template MTRL (147124) not found in ERP database. ` +
                `This is a database configuration issue - the template MTRL must exist in COMPANY=1.`,
                createErr
              );
            } else if (isDuplicateKey) {
              console.error(
                `Failed to create product in ERP for product ${product.ProductID}: Duplicate CODE detected after 3 retries. ` +
                `The generated CODE already exists in the ERP database. This may indicate a race condition or CODE generation issue.`,
                createErr
              );
            } else {
              console.error(`Failed to create product in ERP for product ${product.ProductID}:`, createErr);
            }
            // Add to productMatches for manual attention
            productMatches.push({
              productId: product.ProductID,
              partNumber: product.PartNumberCleared,
              modelNumber: product.ModelNumberCleared,
              partNumberActual: product.PartNumber,
              modelNumberActual: product.ModelNumber,
              matches: [],
            });
          }
        } else if (foundCount === 1) {
          // Single match - update directly
          const match = matches[0];
          const updateRequest = pool.request();
          updateRequest.input('productId', sql.Int, product.ProductID);
          updateRequest.input('erpId', sql.Int, match.MTRL);
          updateRequest.input('erpCode', sql.NVarChar(255), match.CODE);

          await updateRequest.query(`
            UPDATE dbo.Products
            SET ERPID = @erpId,
                ERPCode = @erpCode,
                ModifiedOn = SYSUTCDATETIME()
            WHERE ID = @productId
          `);
        } else {
          // Multiple matches - need user selection
          productMatches.push({
            productId: product.ProductID,
            partNumber: product.PartNumberCleared,
            modelNumber: product.ModelNumberCleared,
            partNumberActual: product.PartNumber,
            modelNumberActual: product.ModelNumber,
            matches,
          });
        }
      } catch (erpErr) {
        // Handle stored procedure not found or other ERP errors
        console.error(`Failed to search ERP for product ${product.ProductID}:`, erpErr);
        productMatches.push({
          productId: product.ProductID,
          partNumber: product.PartNumberCleared,
          modelNumber: product.ModelNumberCleared,
          partNumberActual: product.PartNumber,
          modelNumberActual: product.ModelNumber,
          matches: [],
        });
      }
    }

    return NextResponse.json({
      ok: true,
      needsSelection: productMatches,
      updated: products
        .filter((p) => {
          const match = productMatches.find((pm) => pm.productId === p.ProductID);
          return match && match.matches.length === 0;
        })
        .map((p) => p.ProductID),
    });
  } catch (err) {
    console.error('Failed to create draft offer', err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to create draft offer',
      },
      { status: 500 },
    );
  }
}
