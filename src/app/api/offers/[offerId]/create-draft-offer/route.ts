import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool, getErpPool } from '../../../../../lib/sql';
import { findProject, PROJECT_FIND_STATUS } from '../../../../../lib/projectValidation';
import { getRequestId } from '../../../../../lib/requestId';
import { logger } from '../../../../../lib/logger';

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

type LookupRow = {
  ID: number | null;
  Name: string | null;
};

type SubCategoryRow = LookupRow & {
  CategoryID: number | null;
};

type LookupOption = {
  id: number;
  name: string;
};

type SubCategoryOption = LookupOption & {
  categoryId: number | null;
};

const normalizeName = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.trim();
};

const mapLookup = (rows: LookupRow[]): LookupOption[] =>
  (rows ?? [])
    .filter((row): row is LookupRow & { ID: number } => row?.ID != null)
    .map((row) => ({ id: Number(row.ID), name: normalizeName(row.Name) }));

const mapSubCategories = (rows: SubCategoryRow[]): SubCategoryOption[] =>
  (rows ?? [])
    .filter((row): row is SubCategoryRow & { ID: number } => row?.ID != null)
    .map((row) => ({
      id: Number(row.ID),
      name: normalizeName(row.Name),
      categoryId: row.CategoryID ?? null,
    }));

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

// Suggest product categories using AI
async function suggestProductCategories(
  pool: Awaited<ReturnType<typeof getPool>>,
  brandName: string | null,
  modelNumber: string | null,
  description: string | null,
): Promise<{ categoryId: number | null; subCategoryId: number | null; typeId: number | null }> {
  if (!brandName || !description) {
    return { categoryId: null, subCategoryId: null, typeId: null };
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    logger.warn('OpenAI API key not configured, skipping AI category suggestion');
    return { categoryId: null, subCategoryId: null, typeId: null };
  }

  try {
    // Load available options from database
    const [categoriesRes, subCategoriesRes, typesRes] = await Promise.all([
      pool
        .request()
        .query<LookupRow>("SELECT ID, Name FROM dbo.ProductCategories ORDER BY Name"),
      pool
        .request()
        .query<SubCategoryRow>("SELECT ID, Name, CategoryID FROM dbo.ProductSubCategories ORDER BY Name"),
      pool
        .request()
        .query<LookupRow>("SELECT ID, Name FROM dbo.ProductTypes ORDER BY Name"),
    ]);

    const categories = mapLookup(categoriesRes.recordset ?? []);
    const subCategories = mapSubCategories(subCategoriesRes.recordset ?? []);
    const types = mapLookup(typesRes.recordset ?? []);

    // Build prompt for AI - Group subcategories hierarchically under their parent categories
    const categoriesList = categories.map(c => `${c.id}: ${c.name}`).join('\n');
    const typesList = types.map(t => `${t.id}: ${t.name}`).join('\n');
    
    // Group subcategories by their parent category for hierarchical display
    const subCategoriesByCategory = new Map<number, SubCategoryOption[]>();
    for (const subCat of subCategories) {
      if (subCat.categoryId != null) {
        const existing = subCategoriesByCategory.get(subCat.categoryId) ?? [];
        existing.push(subCat);
        subCategoriesByCategory.set(subCat.categoryId, existing);
      }
    }
    
    // Build hierarchical subcategories list grouped by category
    const subCategoriesList = categories
      .map(cat => {
        const subCats = subCategoriesByCategory.get(cat.id) ?? [];
        if (subCats.length === 0) return null;
        const subCatList = subCats.map(sc => `    ${sc.id}: ${sc.name}`).join('\n');
        return `  Category ${cat.id} (${cat.name}):\n${subCatList}`;
      })
      .filter(Boolean)
      .join('\n\n');

    const prompt = `You are a product categorization assistant. Based on the following product information, suggest the most appropriate category, subcategory, and type from the available options.

Product Information:
- Brand: ${brandName}
- Model: ${modelNumber || 'Not provided'}
- Description: ${description}

AVAILABLE OPTIONS:

Categories (top-level):
${categoriesList}

Sub-Categories (grouped by parent Category - each subcategory BELONGS TO a specific category):
${subCategoriesList}

Types (independent of categories):
${typesList}

CRITICAL RELATIONSHIP RULES:
1. Subcategories BELONG TO specific Categories - this is a parent-child relationship
2. The subCategoryId you choose MUST belong to the categoryId you choose
3. If you pick Category X, you can ONLY pick subcategories listed under "Category X" above
4. If you pick SubCategory Y, the categoryId MUST match the parent Category of that SubCategory
5. Work in this order for best accuracy:
   a) First, identify the best matching SubCategory (most specific match)
   b) Then, set categoryId to the parent Category of that SubCategory
   c) OR: First pick the Category, then pick a SubCategory from that Category's list only

Please respond with ONLY a JSON object in this exact format:
{
  "categoryId": <number or null>,
  "subCategoryId": <number or null>,
  "typeId": <number or null>
}

IMPORTANT RULES:
1. Only return IDs that exist in the lists above
2. You MUST suggest a typeId - do not return null for typeId unless absolutely impossible to determine
3. The categoryId and subCategoryId MUST be consistent - subCategoryId must belong to categoryId
4. For typeId, choose the most appropriate type based on the product description:
   - "Main" (ID: 12) - Primary products, equipment, hardware
   - "Peripheral" (ID: 13) - Accessories, add-ons, supporting equipment
   - "Spare" (ID: 14) - Replacement parts, spare components
   - "Consumable" (ID: 15) - Items that get used up (cables, batteries, etc.)
   - "Software" (ID: 16) - Software products, licenses
   - "Services" (ID: 17) - Service offerings, support, installation
5. If the product is a main piece of equipment, use "Main"
6. If it's an accessory or add-on, use "Peripheral"
7. If it's a replacement part, use "Spare"
8. Default to "Main" (ID: 12) if uncertain, as most products are main equipment`;

    // Call OpenAI API
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that categorizes products. Always respond with valid JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json().catch(() => ({}));
      logger.error("OpenAI API error", { status: openaiResponse.status, error: errorData });
      return { categoryId: null, subCategoryId: null, typeId: null };
    }

    const aiData = await openaiResponse.json();
    const aiContent = aiData.choices?.[0]?.message?.content?.trim() || "{}";

    // Parse AI response
    let suggestions: { categoryId: number | null; subCategoryId: number | null; typeId: number | null };
    try {
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : aiContent;
      suggestions = JSON.parse(jsonStr);
      logger.info("Parsed AI response", { 
        rawContent: aiContent.substring(0, 200),
        parsed: suggestions,
        availableTypesCount: types.length,
        availableTypes: types.slice(0, 10).map(t => ({ id: t.id, name: t.name })),
      });
    } catch (parseError) {
      logger.warn("Failed to parse AI response", { content: aiContent, error: parseError });
      return { categoryId: null, subCategoryId: null, typeId: null };
    }

    // Validate that the suggested IDs exist AND that subcategory belongs to category
    let validatedCategoryId = suggestions.categoryId && categories.find(c => c.id === suggestions.categoryId) 
      ? suggestions.categoryId 
      : null;
    
    // Validate subcategory exists AND belongs to the suggested category
    let validatedSubCategoryId: number | null = null;
    if (suggestions.subCategoryId) {
      const foundSubCategory = subCategories.find(sc => sc.id === suggestions.subCategoryId);
      if (foundSubCategory) {
        // Check if the subcategory belongs to the suggested category
        if (validatedCategoryId && foundSubCategory.categoryId === validatedCategoryId) {
          validatedSubCategoryId = suggestions.subCategoryId;
        } else if (!validatedCategoryId && foundSubCategory.categoryId != null) {
          // If category wasn't suggested but subcategory was, use subcategory's parent category
          validatedCategoryId = foundSubCategory.categoryId;
          validatedSubCategoryId = suggestions.subCategoryId;
          logger.info("Auto-corrected categoryId from subcategory parent", {
            originalCategoryId: suggestions.categoryId,
            correctedCategoryId: validatedCategoryId,
            subCategoryId: validatedSubCategoryId,
          });
        } else if (validatedCategoryId && foundSubCategory.categoryId !== validatedCategoryId) {
          // Category was suggested but doesn't match subcategory's parent - use subcategory's parent
          logger.warn("SubCategory does not belong to suggested Category, using subcategory's parent", {
            suggestedCategoryId: validatedCategoryId,
            suggestedSubCategoryId: suggestions.subCategoryId,
            subCategoryParentId: foundSubCategory.categoryId,
          });
          validatedCategoryId = foundSubCategory.categoryId;
          validatedSubCategoryId = suggestions.subCategoryId;
        }
      }
    }
    
    const validatedTypeId = suggestions.typeId && types.find(t => t.id === suggestions.typeId)
      ? suggestions.typeId
      : null;

    if (suggestions.typeId && !validatedTypeId) {
      logger.warn("TypeID suggestion failed validation", {
        suggestedTypeId: suggestions.typeId,
        availableTypeIds: types.map(t => t.id),
      });
    }

    return {
      categoryId: validatedCategoryId,
      subCategoryId: validatedSubCategoryId,
      typeId: validatedTypeId,
    };
  } catch (err) {
    logger.error("Failed to get AI category suggestion", {}, err instanceof Error ? err : undefined);
    return { categoryId: null, subCategoryId: null, typeId: null };
  }
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

    // Get offer's SalesDivisionName and ProjectID
    const offerRequest = pool.request();
    offerRequest.input('offerId', sql.Int, normalizedId);
    const offerResult = await offerRequest.query<{
      SalesDivisionName: string | null;
      ProjectID: number | null;
    }>(`
      SELECT sd.Name AS SalesDivisionName, o.ProjectID
      FROM dbo.Offer o
      LEFT JOIN dbo.SalesDivision sd ON o.SalesDivitionID = sd.ID
      WHERE o.ID = @offerId
    `);
    const salesDivisionName = offerResult.recordset?.[0]?.SalesDivisionName ?? null;
    const offerProjectId = offerResult.recordset?.[0]?.ProjectID ?? null;
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
      CategoryID: number | null;
      SubCategoryID: number | null;
      TypeID: number | null;
    }>(`
      SELECT DISTINCT
        p.ID AS ProductID,
        p.PartNumberCleared,
        p.ModelNumberCleared,
        p.PartNumber,
        p.ModelNumber,
        p.Description,
        b.Name AS BrandName,
        p.BrandID,
        p.CategoryID,
        p.SubCategoryID,
        p.TypeID
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

    // Auto-fill missing CategoryID, SubCategoryID, TypeID using AI
    const requestId = await getRequestId(req);
    const categoryUpdatePromises: Promise<void>[] = [];
    for (const product of products) {
      // Check if any category fields are missing (explicitly check for null/undefined)
      const needsCategory = product.CategoryID == null;
      const needsSubCategory = product.SubCategoryID == null;
      const needsType = product.TypeID == null;
      
      if (needsCategory || needsSubCategory || needsType) {
        categoryUpdatePromises.push(
          (async () => {
            try {
              logger.info('Requesting AI category suggestions', {
                requestId,
                productId: product.ProductID,
                currentCategoryID: product.CategoryID,
                currentSubCategoryID: product.SubCategoryID,
                currentTypeID: product.TypeID,
                brandName: product.BrandName,
                modelNumber: product.ModelNumber,
              });

              const suggestions = await suggestProductCategories(
                pool,
                product.BrandName,
                product.ModelNumber,
                product.Description,
              );

              logger.info('Received AI category suggestions', {
                requestId,
                productId: product.ProductID,
                suggestedCategoryId: suggestions.categoryId,
                suggestedSubCategoryId: suggestions.subCategoryId,
                suggestedTypeId: suggestions.typeId,
              });

              // Only update if we got suggestions and the field is currently null
              if (suggestions.categoryId || suggestions.subCategoryId || suggestions.typeId) {
                const updateRequest = pool.request();
                updateRequest.input('productId', sql.Int, product.ProductID);
                
                // Build dynamic UPDATE query based on what needs updating
                const updates: string[] = [];
                if (needsCategory && suggestions.categoryId) {
                  updateRequest.input('categoryId', sql.Int, suggestions.categoryId);
                  updates.push('CategoryID = @categoryId');
                }
                if (needsSubCategory && suggestions.subCategoryId) {
                  updateRequest.input('subCategoryId', sql.Int, suggestions.subCategoryId);
                  updates.push('SubCategoryID = @subCategoryId');
                }
                if (needsType && suggestions.typeId) {
                  updateRequest.input('typeId', sql.Int, suggestions.typeId);
                  updates.push('TypeID = @typeId');
                }

                if (updates.length > 0) {
                  await updateRequest.query(`
                    UPDATE dbo.Products
                    SET ${updates.join(', ')},
                        ModifiedOn = SYSUTCDATETIME()
                    WHERE ID = @productId
                  `);
                  
                  logger.info('Auto-filled product categories using AI', {
                    requestId,
                    productId: product.ProductID,
                    updatedCategoryId: needsCategory && suggestions.categoryId ? suggestions.categoryId : null,
                    updatedSubCategoryId: needsSubCategory && suggestions.subCategoryId ? suggestions.subCategoryId : null,
                    updatedTypeId: needsType && suggestions.typeId ? suggestions.typeId : null,
                  });
                } else {
                  logger.warn('AI suggestions received but no updates needed', {
                    requestId,
                    productId: product.ProductID,
                    needsCategory,
                    needsSubCategory,
                    needsType,
                    suggestions,
                  });
                }
              } else {
                logger.warn('No AI suggestions received for product', {
                  requestId,
                  productId: product.ProductID,
                });
              }
            } catch (err) {
              logger.error(`Failed to auto-fill categories for product ${product.ProductID}`, {
                requestId,
                productId: product.ProductID,
              }, err instanceof Error ? err : undefined);
              // Continue processing other products even if one fails
            }
          })(),
        );
      }
    }

    // Wait for all category updates to complete before continuing
    await Promise.all(categoryUpdatePromises);

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
                const isDefaultsError = isRequestErrorWithNumber(createErr) && createErr.number === 53012;
                const isDuplicateKey = isRequestErrorWithNumber(createErr) && createErr.number === 2627;
                
                if (isDefaultsError) {
                  console.error(
                    `Failed to create product in ERP for product ${product.ProductID}: MtrlCreateDefaults missing for (COMPANY=1, SODTYPE=51). ` +
                    `Ensure tlm.MtrlCreateDefaults has a row for COMPANY=1, SODTYPE=51.`,
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

      // Validate project if present
      if (offerProjectId && offerProjectId > 0) {
        // Fetch project CODE from ERP
        const erpPool = await getErpPool();
        const projectRequest = erpPool.request();
        projectRequest.input('PRJC', sql.Int, offerProjectId);
        const projectResult = await projectRequest.query<{
          CODE: string | null;
        }>(`
          SELECT CODE
          FROM dbo.PRJC
          WHERE PRJC = @PRJC
        `);
        const projectCode = projectResult.recordset?.[0]?.CODE ?? null;

        if (projectCode) {
          const projectValidation = await findProject(offerProjectId, projectCode);
          if (projectValidation.statusCode !== PROJECT_FIND_STATUS.OK) {
            return NextResponse.json(
              {
                ok: false,
                error: `Project validation failed: ${projectValidation.statusText}`,
                projectValidation,
              },
              { status: 400 },
            );
          }
        }
      }

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
            const isDefaultsError = isRequestErrorWithNumber(createErr) && createErr.number === 53012;
            const isDuplicateKey = isRequestErrorWithNumber(createErr) && createErr.number === 2627;
            
            if (isDefaultsError) {
              console.error(
                `Failed to create product in ERP for product ${product.ProductID}: MtrlCreateDefaults missing for (COMPANY=1, SODTYPE=51). ` +
                `Ensure tlm.MtrlCreateDefaults has a row for COMPANY=1, SODTYPE=51.`,
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

    // Validate project if present
    if (offerProjectId && offerProjectId > 0) {
      // Fetch project CODE from ERP
      const erpPool = await getErpPool();
      const projectRequest = erpPool.request();
      projectRequest.input('PRJC', sql.Int, offerProjectId);
      const projectResult = await projectRequest.query<{
        CODE: string | null;
      }>(`
        SELECT CODE
        FROM dbo.PRJC
        WHERE PRJC = @PRJC
      `);
      const projectCode = projectResult.recordset?.[0]?.CODE ?? null;

      if (projectCode) {
        const projectValidation = await findProject(offerProjectId, projectCode);
        if (projectValidation.statusCode !== PROJECT_FIND_STATUS.OK) {
          return NextResponse.json(
            {
              ok: false,
              error: `Project validation failed: ${projectValidation.statusText}`,
              projectValidation,
            },
            { status: 400 },
          );
        }
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
