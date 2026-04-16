import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool, getErpPool } from '../../../../../lib/sql';
import { findProject, PROJECT_FIND_STATUS } from '../../../../../lib/projectValidation';
import { createProjectFromIntegration } from '../../../../../lib/projectCreation';
import { createOrderWithLines } from '../../../../../lib/orderCreation';
import type { OrderLineForCreation } from '../../../../../lib/orderCreation';
import { createItemInErp } from '../../../../../lib/itemCreation';
import { createManufacturerInErp } from '../../../../../lib/itemCreationWS';
import { getRequestId } from '../../../../../lib/requestId';
import { logger } from '../../../../../lib/logger';
import { requirePermission } from '../../../../../lib/authz';
import { fuzzyCustomerSearch } from '../../../../../lib/customerSearch';
import { clearPartModelNumberUpper } from '../../../../../lib/partModelNumber';

type ProductMatch = {
  productId: number;
  partNumber: string | null;
  modelNumber: string | null;
  partNumberActual: string | null;
  modelNumberActual: string | null;
  description?: string | null;
  brandName?: string | null;
  categoryName?: string | null;
  subCategoryName?: string | null;
  typeName?: string | null;
  canCreate?: boolean;
  missingFields?: string[];
  matches: Array<{
    MTRL: number;
    CODE: string | null;
    CODE1: string | null;
    CODE2: string | null;
    NAME1: string | null;
    BRANDNAME?: string | null;
  }>;
};

type ProductSelection = {
  productId: number;
  MTRL: number;
  CODE: string | null;
};

type CustomerSelection = {
  TRDR: number;
  CODE: string | null;
};

type CategoryUpdate = {
  productId: number;
  categoryId: number | null;
  subCategoryId: number | null;
  typeId: number | null;
};

type CreateDraftOfferRequestBody = {
  step?: WizardStep;
  selections?: ProductSelection[];
  customerSelection?: CustomerSelection;
  customerCode?: string;
  customerConfirmed?: boolean;
  brandCreationConfirmed?: boolean;
  categoryUpdate?: CategoryUpdate;
  // Accumulated wizard state (passed forward by frontend)
  resolvedCustomer?: { TRDR: number; CODE: string | null; NAME: string | null };
  missingBrands?: string[];
  matchResults?: MatchResultsState;
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

// ── Wizard step types ──────────────────────────────────────────────────────────

type WizardStep =
  | 'resolve-customer'
  | 'categorize-products'
  | 'update-product-category'
  | 'check-brands'
  | 'match-products'
  | 'prepare-summary'
  | 'execute';

type OfferContext = {
  pool: Awaited<ReturnType<typeof getPool>>;
  erpPool: Awaited<ReturnType<typeof getErpPool>>;
  offerId: number;
  requestId: string;
  offerDescription: string;
  salesDivisionId: number | null;
  businessUnit: 'AVS' | 'TVS';
  erpCustomerId: number | null;
  customerName: string | null;
  erpProjectId: number | null;
  erpProjectCode: string | null;
};

type MatchResultsState = {
  autoMatched: Array<{ productId: number; MTRL: number; CODE: string | null }>;
  userConfirmedCreate: Array<{ productId: number }>;
  userSelected: Array<{ productId: number; MTRL: number; CODE: string | null }>;
  skipped: Array<{ productId: number }>;
};

// ── End wizard step types ──────────────────────────────────────────────────────

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

// Suggest product categories using AI
async function suggestProductCategories(
  pool: Awaited<ReturnType<typeof getPool>>,
  brandName: string | null,
  modelNumber: string | null,
  description: string | null,
  existingCategoryId?: number | null,
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

    // Validate that the suggested IDs exist.
    // Subcategory is the most specific, so trust it first and derive the category from its parent.
    let validatedCategoryId: number | null = null;
    let validatedSubCategoryId: number | null = null;

    if (suggestions.subCategoryId) {
      const foundSubCategory = subCategories.find(sc => sc.id === suggestions.subCategoryId);
      if (foundSubCategory) {
        // Accept the subcategory and use its parent as the category (most specific wins)
        validatedSubCategoryId = suggestions.subCategoryId;
        validatedCategoryId = foundSubCategory.categoryId;

        if (existingCategoryId && foundSubCategory.categoryId !== existingCategoryId) {
          logger.info("Overriding existing categoryId to match subcategory parent", {
            existingCategoryId,
            suggestedSubCategoryId: suggestions.subCategoryId,
            newCategoryId: foundSubCategory.categoryId,
          });
        }
      }
    }

    // If no valid subcategory, fall back to AI-suggested or existing category
    if (!validatedCategoryId) {
      const fallbackCategoryId = suggestions.categoryId ?? existingCategoryId;
      validatedCategoryId = fallbackCategoryId && categories.find(c => c.id === fallbackCategoryId)
        ? fallbackCategoryId
        : null;
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

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function fetchOfferProducts(
  pool: Awaited<ReturnType<typeof getPool>>,
  offerId: number,
) {
  const productsRequest = pool.request();
  productsRequest.input('offerId', sql.Int, offerId);
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
  return productsResult.recordset ?? [];
}

async function searchProductInErp(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  partNumberCleared: string | null,
  modelNumberCleared: string | null,
) {
  const erpRequest = erpPool.request();
  erpRequest.input('PartNo', sql.NVarChar(200), partNumberCleared);
  erpRequest.input('ModelNo', sql.NVarChar(200), modelNumberCleared);
  erpRequest.input('TopN', sql.Int, 200);

  const erpResult = await erpRequest.query(`
    DECLARE @FoundCount INT;
    EXEC [tlm].[_mtrlFindProduct]
      @PartNo = @PartNo,
      @ModelNo = @ModelNo,
      @TopN = @TopN,
      @FoundCount = @FoundCount OUTPUT;
  `) as { recordset: Array<{ FoundCount: number }>; recordsets?: Array<Array<unknown>> };

  const foundCountResult = (erpResult.recordsets?.[0] as Array<{ FoundCount: number }>) ?? erpResult.recordset;
  const foundCount = foundCountResult[0]?.FoundCount ?? 0;
  const matches = (erpResult.recordsets?.[1] ?? []) as Array<{
    MTRL: number;
    CODE: string | null;
    NAME1: string | null;
    CODE1: string | null;
    CODE2: string | null;
  }>;

  return { foundCount, matches };
}

type ErpProductMatch = {
  MTRL: number;
  CODE: string | null;
  CODE1: string | null;
  CODE2: string | null;
  NAME1: string | null;
  BRANDNAME?: string | null;
};

function findExactCode2Match(
  matches: ErpProductMatch[],
  partNumberCleared: string | null,
): ErpProductMatch | null {
  if (!partNumberCleared) return null;
  const target = clearPartModelNumberUpper(partNumberCleared);
  if (!target) return null;
  return matches.find(m => {
    if (!m.CODE2) return false;
    return clearPartModelNumberUpper(m.CODE2) === target;
  }) ?? null;
}

async function fuzzySearchByCode2(
  erpPool: Awaited<ReturnType<typeof getErpPool>>,
  partNumberCleared: string,
): Promise<ErpProductMatch[]> {
  const erpRequest = erpPool.request();
  erpRequest.input('Code2Cleaned', sql.NVarChar(200), partNumberCleared);
  erpRequest.input('TopN', sql.Int, 20);

  const result = await erpRequest.query<ErpProductMatch>(`
    EXEC [tlm].[_mtrlFuzzySearchByCode2]
      @Code2Cleaned = @Code2Cleaned,
      @TopN = @TopN;
  `);

  return result.recordset ?? [];
}

async function loadCategoryNameMaps(pool: Awaited<ReturnType<typeof getPool>>) {
  const [categoriesRes, subCategoriesRes, typesRes] = await Promise.all([
    pool.request().query<LookupRow>("SELECT ID, Name FROM dbo.ProductCategories"),
    pool.request().query<SubCategoryRow>("SELECT ID, Name, CategoryID FROM dbo.ProductSubCategories"),
    pool.request().query<LookupRow>("SELECT ID, Name FROM dbo.ProductTypes"),
  ]);
  return {
    catMap: new Map((categoriesRes.recordset ?? []).map(r => [r.ID, r.Name])),
    subCatMap: new Map((subCategoriesRes.recordset ?? []).map(r => [r.ID, r.Name])),
    typeMap: new Map((typesRes.recordset ?? []).map(r => [r.ID, r.Name])),
  };
}

async function resolveOrCreateProject(
  ctx: OfferContext,
  erpCustomerCode: string | null,
): Promise<{ prjcId: number; prjcCode: string; isNew: boolean }> {
  let finalErpProjectId = ctx.erpProjectId;
  let finalErpProjectCode = ctx.erpProjectCode;

  if (finalErpProjectId && finalErpProjectId > 0) {
    let codeToValidate = finalErpProjectCode;
    if (!codeToValidate) {
      const projectRequest = ctx.erpPool.request();
      projectRequest.input('PRJC', sql.Int, finalErpProjectId);
      const projectResult = await projectRequest.query<{ CODE: string | null }>(`
        SELECT CODE FROM dbo.PRJC WHERE PRJC = @PRJC
      `);
      codeToValidate = projectResult.recordset?.[0]?.CODE ?? null;
    }

    if (codeToValidate) {
      const projectValidation = await findProject(finalErpProjectId, codeToValidate);
      if (projectValidation.statusCode === PROJECT_FIND_STATUS.OK) {
        finalErpProjectCode = codeToValidate;
      } else if (projectValidation.statusCode === PROJECT_FIND_STATUS.NOT_FOUND) {
        finalErpProjectId = null;
        finalErpProjectCode = null;
      } else {
        throw new Error(`Project validation failed: ${projectValidation.statusText}`);
      }
    }
  }

  if (!finalErpProjectId || finalErpProjectId <= 0) {
    if (!ctx.erpCustomerId) {
      throw new Error('Cannot create project without a valid customer.');
    }
    const createdProject = await createProjectFromIntegration({
      integrationKey: 'FASTQUOTE_CREATE_PRJC',
      codePrefix: 'COV',
      name: ctx.offerDescription,
      prjcParent: null,
      trdr: ctx.erpCustomerId,
      customerCode: erpCustomerCode,
      prjCategory: null,
      sourceSystem: 'FQ',
      createdByUser: 1011,
      businessUnit: ctx.businessUnit,
      prjState: 90,
    });

    // Persist ERP project back to FastQuote Offer
    const updateOfferRequest = ctx.pool.request();
    updateOfferRequest.input('offerId', sql.Int, ctx.offerId);
    updateOfferRequest.input('erpProjectId', sql.Int, createdProject.prjcId);
    updateOfferRequest.input('erpProjectCode', sql.NVarChar(25), createdProject.prjcCode);
    await updateOfferRequest.query(`
      UPDATE dbo.Offer
      SET ERPProjectID = @erpProjectId,
          ERPProjectCode = @erpProjectCode,
          ModifiedOn = SYSUTCDATETIME()
      WHERE ID = @offerId
    `);

    return { prjcId: createdProject.prjcId, prjcCode: createdProject.prjcCode, isNew: true };
  }

  return { prjcId: finalErpProjectId, prjcCode: finalErpProjectCode!, isNew: false };
}

// ── Step handlers ──────────────────────────────────────────────────────────────

async function handleResolveCustomer(
  ctx: OfferContext,
  body: CreateDraftOfferRequestBody,
): Promise<NextResponse> {
  const { pool, erpPool, offerId, requestId } = ctx;
  let erpCustomerId = ctx.erpCustomerId;
  let erpCustomerCode: string | null = null;

  const customerSelection = body.customerSelection ?? null;
  const customerCode = body.customerCode ?? null;
  const customerConfirmed = body.customerConfirmed ?? false;

  if (!erpCustomerId) {
    if (customerSelection && customerConfirmed) {
      erpCustomerId = customerSelection.TRDR;
      erpCustomerCode = customerSelection.CODE ?? null;
    } else if (customerSelection && !customerConfirmed) {
      return NextResponse.json({
        ok: true, step: 'resolve-customer',
        needsConfirmation: customerSelection,
      });
    } else if (customerCode) {
      const searchReq = erpPool.request();
      searchReq.input('SearchValue', sql.NVarChar(200), customerCode.trim());
      const searchRes = await searchReq.query<{ TRDR: number; CODE: string | null; NAME: string | null }>(`
        EXEC tlm.FindCustomer @SearchValue = @SearchValue
      `);
      const matches = searchRes.recordset ?? [];

      if (matches.length === 0) {
        return NextResponse.json({ ok: true, step: 'resolve-customer', needsCode: true, message: `No customer found with code: ${customerCode}` });
      } else if (matches.length === 1) {
        return NextResponse.json({ ok: true, step: 'resolve-customer', needsConfirmation: matches[0] });
      } else {
        return NextResponse.json({ ok: true, step: 'resolve-customer', needsSelection: matches });
      }
    } else if (ctx.customerName) {
      const searchReq = erpPool.request();
      searchReq.input('SearchValue', sql.NVarChar(200), ctx.customerName);
      const searchRes = await searchReq.query<{ TRDR: number; CODE: string | null; NAME: string | null }>(`
        EXEC tlm.FindCustomer @SearchValue = @SearchValue
      `);
      let matches = searchRes.recordset ?? [];

      if (matches.length === 0) {
        matches = await fuzzyCustomerSearch(erpPool, ctx.customerName);
      }

      if (matches.length === 0) {
        return NextResponse.json({ ok: true, step: 'resolve-customer', needsCode: true, message: `No customer found matching: ${ctx.customerName}` });
      } else if (matches.length === 1) {
        return NextResponse.json({ ok: true, step: 'resolve-customer', needsConfirmation: matches[0] });
      } else {
        return NextResponse.json({ ok: true, step: 'resolve-customer', needsSelection: matches });
      }
    } else {
      return NextResponse.json({ ok: false, error: 'No customer information available.' }, { status: 400 });
    }

    // Persist customer ERPID to FastQuote DB
    if (erpCustomerId) {
      const updateReq = pool.request();
      updateReq.input('offerId', sql.Int, offerId);
      updateReq.input('erpCustomerId', sql.Int, erpCustomerId);
      await updateReq.query(`
        UPDATE dbo.Customers
        SET ERPID = @erpCustomerId, ModifiedOn = SYSUTCDATETIME()
        WHERE ID = (SELECT CustomerID FROM dbo.Offer WHERE ID = @offerId) AND ERPID IS NULL
      `);
    }
  }

  // Resolve customer CODE from ERP
  if (erpCustomerId && !erpCustomerCode) {
    const codeReq = erpPool.request();
    codeReq.input('TRDR', sql.Int, erpCustomerId);
    const codeRes = await codeReq.query<{ CODE: string | null }>(`SELECT TOP (1) CODE FROM dbo.TRDR WHERE TRDR = @TRDR`);
    erpCustomerCode = codeRes.recordset?.[0]?.CODE ?? null;
  }

  // Resolve customer NAME from ERP for display
  let resolvedName = ctx.customerName;
  if (erpCustomerId && !resolvedName) {
    const nameReq = erpPool.request();
    nameReq.input('TRDR', sql.Int, erpCustomerId);
    const nameRes = await nameReq.query<{ NAME: string | null }>(`SELECT TOP (1) NAME FROM dbo.TRDR WHERE TRDR = @TRDR`);
    resolvedName = nameRes.recordset?.[0]?.NAME ?? null;
  }

  logger.info('wizard resolve-customer done', { requestId, offerId, erpCustomerId, erpCustomerCode });

  return NextResponse.json({
    ok: true, step: 'resolve-customer',
    resolved: { TRDR: erpCustomerId, CODE: erpCustomerCode, NAME: resolvedName },
  });
}

async function handleCategorizeProducts(
  ctx: OfferContext,
  body: CreateDraftOfferRequestBody,
): Promise<NextResponse> {
  const { pool, offerId, requestId } = ctx;
  const products = await fetchOfferProducts(pool, offerId);

  if (products.length === 0) {
    return NextResponse.json({ ok: true, step: 'categorize-products', products: [] });
  }

  // ── Phase 1: Sync categories from matched Soft1 items ──────────────────
  const matchResults = body.matchResults;
  const erpSynced = new Set<number>();

  if (matchResults) {
    const matchedProducts: Array<{ productId: number; CODE: string | null }> = [
      ...matchResults.autoMatched,
      ...matchResults.userSelected,
    ];

    if (matchedProducts.length > 0) {
      // Load subcategories and types with Code columns for matching
      const [subCatCodeRes, typeCodeRes] = await Promise.all([
        pool.request().query<{ ID: number; Code: string | null; CategoryID: number | null }>(
          "SELECT ID, Code, CategoryID FROM dbo.ProductSubCategories",
        ),
        pool.request().query<{ ID: number; Code: string | null }>(
          "SELECT ID, Code FROM dbo.ProductTypes",
        ),
      ]);
      const subCatsWithCode = (subCatCodeRes.recordset ?? []).filter(r => r.Code);
      const typesWithCode = (typeCodeRes.recordset ?? []).filter(r => r.Code);

      for (const match of matchedProducts) {
        const product = products.find(p => p.ProductID === match.productId);
        if (!product || !match.CODE) continue;

        // Parse ERP CODE: [SubCatCode3][TypeCode].[BrandCode].[Sequence]
        const parts = match.CODE.split('.');
        if (parts.length < 2 || parts[0].length < 4) continue;

        const prefix = parts[0];
        const subCatCode3 = prefix.substring(0, 3).toUpperCase();
        const typeCode = prefix.substring(3).toUpperCase();

        const matchedSubCat = subCatsWithCode.find(
          sc => sc.Code!.substring(0, 3).toUpperCase() === subCatCode3,
        );
        const matchedType = typesWithCode.find(
          t => t.Code!.toUpperCase() === typeCode,
        );

        const resolvedCategoryId = matchedSubCat?.CategoryID ?? null;
        const resolvedSubCategoryId = matchedSubCat?.ID ?? null;
        const resolvedTypeId = matchedType?.ID ?? null;

        if (!resolvedCategoryId && !resolvedSubCategoryId && !resolvedTypeId) continue;

        // Soft1 takes priority — overwrite even if FastQuote already has values
        const updateReq = pool.request();
        updateReq.input('productId', sql.Int, product.ProductID);
        const sets: string[] = [];

        if (resolvedCategoryId && product.CategoryID !== resolvedCategoryId) {
          updateReq.input('categoryId', sql.Int, resolvedCategoryId);
          sets.push('CategoryID = @categoryId');
          product.CategoryID = resolvedCategoryId;
        }
        if (resolvedSubCategoryId && product.SubCategoryID !== resolvedSubCategoryId) {
          updateReq.input('subCategoryId', sql.Int, resolvedSubCategoryId);
          sets.push('SubCategoryID = @subCategoryId');
          product.SubCategoryID = resolvedSubCategoryId;
        }
        if (resolvedTypeId && product.TypeID !== resolvedTypeId) {
          updateReq.input('typeId', sql.Int, resolvedTypeId);
          sets.push('TypeID = @typeId');
          product.TypeID = resolvedTypeId;
        }

        if (sets.length > 0) {
          sets.push('ModifiedOn = SYSUTCDATETIME()');
          await updateReq.query(`UPDATE dbo.Products SET ${sets.join(', ')} WHERE ID = @productId`);
          erpSynced.add(product.ProductID);
        }
      }

      logger.info('wizard categorize-products ERP sync', { requestId, offerId, synced: erpSynced.size });
    }
  }

  // ── Phase 2: AI categorization for remaining products missing categories ─
  const aiCategorized = new Set<number>();
  const categoryUpdatePromises: Promise<void>[] = [];

  for (const product of products) {
    const needsCategory = product.CategoryID == null;
    const needsSubCategory = product.SubCategoryID == null;
    const needsType = product.TypeID == null;

    if (needsCategory || needsSubCategory || needsType) {
      categoryUpdatePromises.push(
        (async () => {
          try {
            const suggestions = await suggestProductCategories(
              pool, product.BrandName, product.ModelNumber, product.Description, product.CategoryID,
            );
            if (suggestions.categoryId || suggestions.subCategoryId || suggestions.typeId) {
              const updateRequest = pool.request();
              updateRequest.input('productId', sql.Int, product.ProductID);
              const updates: string[] = [];
              const shouldUpdateCategory = needsCategory || (suggestions.categoryId && suggestions.categoryId !== product.CategoryID);
              if (shouldUpdateCategory && suggestions.categoryId) {
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
                  UPDATE dbo.Products SET ${updates.join(', ')}, ModifiedOn = SYSUTCDATETIME() WHERE ID = @productId
                `);
                if (shouldUpdateCategory && suggestions.categoryId) product.CategoryID = suggestions.categoryId;
                if (needsSubCategory && suggestions.subCategoryId) product.SubCategoryID = suggestions.subCategoryId;
                if (needsType && suggestions.typeId) product.TypeID = suggestions.typeId;
                aiCategorized.add(product.ProductID);
              }
            }
          } catch (err) {
            logger.error(`Failed to auto-fill categories for product ${product.ProductID}`, { requestId, productId: product.ProductID }, err instanceof Error ? err : undefined);
          }
        })(),
      );
    }
  }

  await Promise.all(categoryUpdatePromises);

  // Resolve category/subcategory/type names for display
  const [categoriesRes, subCategoriesRes, typesRes] = await Promise.all([
    pool.request().query<LookupRow>("SELECT ID, Name FROM dbo.ProductCategories"),
    pool.request().query<SubCategoryRow>("SELECT ID, Name, CategoryID FROM dbo.ProductSubCategories"),
    pool.request().query<LookupRow>("SELECT ID, Name FROM dbo.ProductTypes"),
  ]);
  const catMap = new Map((categoriesRes.recordset ?? []).map(r => [r.ID, r.Name]));
  const subCatMap = new Map((subCategoriesRes.recordset ?? []).map(r => [r.ID, r.Name]));
  const typeMap = new Map((typesRes.recordset ?? []).map(r => [r.ID, r.Name]));

  const productList = products.map(p => ({
    productId: p.ProductID,
    partNumber: p.PartNumber,
    modelNumber: p.ModelNumber,
    description: p.Description,
    brandName: p.BrandName,
    categoryId: p.CategoryID ?? null,
    subCategoryId: p.SubCategoryID ?? null,
    typeId: p.TypeID ?? null,
    categoryName: p.CategoryID ? (catMap.get(p.CategoryID) ?? null) : null,
    subCategoryName: p.SubCategoryID ? (subCatMap.get(p.SubCategoryID) ?? null) : null,
    typeName: p.TypeID ? (typeMap.get(p.TypeID) ?? null) : null,
    wasAiCategorized: aiCategorized.has(p.ProductID),
    wasErpSynced: erpSynced.has(p.ProductID),
  }));

  const categories = (categoriesRes.recordset ?? [])
    .filter((r): r is LookupRow & { ID: number } => r.ID != null)
    .map(r => ({ id: r.ID, name: r.Name ?? '' }));
  const subCategories = (subCategoriesRes.recordset ?? [])
    .filter((r): r is SubCategoryRow & { ID: number } => r.ID != null)
    .map(r => ({ id: r.ID, name: r.Name ?? '', categoryId: r.CategoryID ?? null }));
  const types = (typesRes.recordset ?? [])
    .filter((r): r is LookupRow & { ID: number } => r.ID != null)
    .map(r => ({ id: r.ID, name: r.Name ?? '' }));

  logger.info('wizard categorize-products done', { requestId, offerId, total: products.length, erpSynced: erpSynced.size, aiCategorized: aiCategorized.size });

  return NextResponse.json({ ok: true, step: 'categorize-products', products: productList, categories, subCategories, types });
}

async function handleUpdateProductCategory(
  ctx: OfferContext,
  body: CreateDraftOfferRequestBody,
): Promise<NextResponse> {
  const { pool, requestId } = ctx;
  const update = body.categoryUpdate;
  if (!update || !update.productId) {
    return NextResponse.json({ ok: false, error: 'Missing categoryUpdate' }, { status: 400 });
  }

  const req = pool.request();
  req.input('productId', sql.Int, update.productId);
  const sets: string[] = [];

  if (update.categoryId !== undefined) {
    req.input('categoryId', sql.Int, update.categoryId);
    sets.push('CategoryID = @categoryId');
  }
  if (update.subCategoryId !== undefined) {
    req.input('subCategoryId', sql.Int, update.subCategoryId);
    sets.push('SubCategoryID = @subCategoryId');
  }
  if (update.typeId !== undefined) {
    req.input('typeId', sql.Int, update.typeId);
    sets.push('TypeID = @typeId');
  }

  if (sets.length > 0) {
    sets.push('ModifiedOn = SYSUTCDATETIME()');
    await req.query(`UPDATE dbo.Products SET ${sets.join(', ')} WHERE ID = @productId`);
  }

  logger.info('wizard update-product-category done', { requestId, productId: update.productId });
  return NextResponse.json({ ok: true, step: 'update-product-category' });
}

async function handleCheckBrands(
  ctx: OfferContext,
): Promise<NextResponse> {
  const { pool, erpPool, offerId, requestId } = ctx;
  const products = await fetchOfferProducts(pool, offerId);

  const uniqueBrandNames = [...new Set(
    products.filter(p => p.BrandName && p.BrandID).map(p => p.BrandName!.trim()),
  )];

  const missingBrands: string[] = [];
  const existingBrands: string[] = [];
  const nearMatchBrands: Array<{ fastquoteName: string; matches: Array<{ erpName: string; MTRMANFCTR: number }> }> = [];

  for (const brandName of uniqueBrandNames) {
    // 1. Try exact match (trimmed, case-insensitive)
    const checkReq = erpPool.request();
    checkReq.input('brandName', sql.NVarChar(128), brandName);
    const checkRes = await checkReq.query<{ MTRMANFCTR: number }>(`
      SELECT TOP (1) MTRMANFCTR FROM dbo.MTRMANFCTR
      WHERE UPPER(LTRIM(RTRIM(NAME))) = UPPER(LTRIM(RTRIM(@brandName)))
      ORDER BY MTRMANFCTR
    `);
    if (checkRes.recordset?.[0]) {
      existingBrands.push(brandName);
      continue;
    }

    // 2. Try fuzzy match — strip spaces/special chars, check both directions, accent-insensitive
    const cleanedBrand = brandName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_\s./,()"'&+]+/g, '').toUpperCase();
    if (cleanedBrand) {
      const fuzzyReq = erpPool.request();
      fuzzyReq.input('cleanedBrand', sql.NVarChar(130), '%' + cleanedBrand + '%');
      fuzzyReq.input('cleanedBrandRaw', sql.NVarChar(128), cleanedBrand);
      const fuzzyRes = await fuzzyReq.query<{ MTRMANFCTR: number; NAME: string }>(`
        SELECT TOP (5) MTRMANFCTR, NAME FROM dbo.MTRMANFCTR
        WHERE (
          UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                NAME,
                '-', ''), ' ', ''), '_', ''), '.', ''), '/', ''), ',', ''), '(', ''), ')', ''))
              COLLATE Latin1_General_CI_AI LIKE @cleanedBrand
          OR @cleanedBrandRaw COLLATE Latin1_General_CI_AI LIKE
              '%' + UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                NAME,
                '-', ''), ' ', ''), '_', ''), '.', ''), '/', ''), ',', ''), '(', ''), ')', '')) + '%'
        )
        ORDER BY MTRMANFCTR
      `);
      if (fuzzyRes.recordset?.length) {
        nearMatchBrands.push({
          fastquoteName: brandName,
          matches: fuzzyRes.recordset.map(r => ({ erpName: r.NAME.trim(), MTRMANFCTR: r.MTRMANFCTR })),
        });
        continue;
      }
    }

    missingBrands.push(brandName);
  }

  logger.info('wizard check-brands done', {
    requestId, offerId,
    existing: existingBrands.length, nearMatch: nearMatchBrands.length, missing: missingBrands.length,
  });

  return NextResponse.json({ ok: true, step: 'check-brands', missingBrands, existingBrands, nearMatchBrands });
}

async function handleMatchProducts(
  ctx: OfferContext,
  body: CreateDraftOfferRequestBody,
): Promise<NextResponse> {
  const { pool, erpPool, offerId, requestId } = ctx;
  const products = await fetchOfferProducts(pool, offerId);
  const userSelections = body.selections ?? [];
  const selectionMap = new Map(userSelections.map(s => [s.productId, { MTRL: s.MTRL, CODE: s.CODE }]));

  // Load category/subcategory/type names for display
  const { catMap, subCatMap, typeMap } = await loadCategoryNameMaps(pool);

  const autoMatched: Array<{ productId: number; partNumber: string | null; modelNumber: string | null; description: string | null; brandName: string | null; MTRL: number; CODE: string | null; NAME1: string | null }> = [];
  const needsSelection: ProductMatch[] = [];
  const skipped: Array<{ productId: number; partNumber: string | null; modelNumber: string | null; reason: string }> = [];

  const buildMissingFields = (product: typeof products[0]): string[] => {
    const missing: string[] = [];
    if (!product.Description) missing.push('description');
    if (!product.BrandID) missing.push('brand');
    // subcategory/type are resolved in the Categories step (runs after Products)
    return missing;
  };

  const buildNeedsSelection = (product: typeof products[0], matches: ErpProductMatch[]): ProductMatch => {
    const missing = buildMissingFields(product);
    return {
      productId: product.ProductID,
      partNumber: product.PartNumberCleared,
      modelNumber: product.ModelNumberCleared,
      partNumberActual: product.PartNumber,
      modelNumberActual: product.ModelNumber,
      description: product.Description,
      brandName: product.BrandName,
      categoryName: catMap.get(product.CategoryID) ?? null,
      subCategoryName: subCatMap.get(product.SubCategoryID) ?? null,
      typeName: typeMap.get(product.TypeID) ?? null,
      canCreate: missing.length === 0,
      missingFields: missing,
      matches,
    };
  };

  for (const product of products) {
    // If user already selected a match for this product, it goes into autoMatched
    const userSel = selectionMap.get(product.ProductID);
    if (userSel) {
      autoMatched.push({
        productId: product.ProductID,
        partNumber: product.PartNumber,
        modelNumber: product.ModelNumber,
        description: product.Description,
        brandName: product.BrandName,
        MTRL: userSel.MTRL,
        CODE: userSel.CODE,
        NAME1: null,
      });
      continue;
    }

    try {
      const { foundCount, matches } = await searchProductInErp(erpPool, product.PartNumberCleared, product.ModelNumberCleared);

      logger.info('wizard match-products FindProduct', {
        requestId, offerId, productId: product.ProductID,
        partNo: product.PartNumberCleared, modelNo: product.ModelNumberCleared,
        foundCount,
      });

      // Check for exact cleaned CODE2 match
      const exactMatch = findExactCode2Match(matches, product.PartNumberCleared);

      if (exactMatch) {
        // Exact CODE2 match → auto-match, no user intervention
        autoMatched.push({
          productId: product.ProductID,
          partNumber: product.PartNumber,
          modelNumber: product.ModelNumber,
          description: product.Description,
          brandName: product.BrandName,
          MTRL: exactMatch.MTRL,
          CODE: exactMatch.CODE,
          NAME1: exactMatch.NAME1,
        });
      } else if (foundCount > 0) {
        // SP returned results but no exact CODE2 match → user must select or create
        needsSelection.push(buildNeedsSelection(product, matches));
      } else if (product.PartNumberCleared) {
        // SP returned 0 results, try fuzzy search by CODE2
        let fuzzyMatches: ErpProductMatch[] = [];
        try {
          fuzzyMatches = await fuzzySearchByCode2(erpPool, product.PartNumberCleared);
          logger.info('wizard match-products fuzzyCode2', {
            requestId, offerId, productId: product.ProductID,
            partNo: product.PartNumberCleared, fuzzyCount: fuzzyMatches.length,
          });
        } catch {
          logger.warn('wizard match-products fuzzy search failed, continuing without', {
            requestId, offerId, productId: product.ProductID,
          });
        }
        // Show fuzzy results (may be empty) — user picks or creates
        needsSelection.push(buildNeedsSelection(product, fuzzyMatches));
      } else {
        // No PartNumberCleared at all — check if we can still present for creation
        if (!product.PartNumberCleared && !product.ModelNumberCleared) {
          skipped.push({
            productId: product.ProductID,
            partNumber: product.PartNumber,
            modelNumber: product.ModelNumber,
            reason: 'No part number or model number',
          });
        } else {
          needsSelection.push(buildNeedsSelection(product, []));
        }
      }
    } catch (err) {
      logger.error(`wizard match-products error for product ${product.ProductID}`, { requestId, offerId }, err instanceof Error ? err : undefined);
      skipped.push({
        productId: product.ProductID,
        partNumber: product.PartNumber,
        modelNumber: product.ModelNumber,
        reason: 'ERP search failed',
      });
    }
  }

  // Enrich needsSelection matches with brand names from ERP
  const allMatchMtrls = new Set<number>();
  for (const ns of needsSelection) {
    for (const m of ns.matches) allMatchMtrls.add(m.MTRL);
  }
  if (allMatchMtrls.size > 0) {
    try {
      const ids = [...allMatchMtrls];
      const ph = ids.map((_, i) => `@m${i}`).join(', ');
      const brandReq = erpPool.request();
      ids.forEach((id, i) => brandReq.input(`m${i}`, sql.Int, id));
      const brandRes = await brandReq.query<{ MTRL: number; BRANDNAME: string | null }>(
        `SELECT mt.MTRL, mf.NAME AS BRANDNAME FROM dbo.MTRL mt LEFT JOIN dbo.MTRMANFCTR mf ON mt.MTRMANFCTR = mf.MTRMANFCTR WHERE mt.MTRL IN (${ph})`,
      );
      const brandMap = new Map((brandRes.recordset ?? []).map(r => [r.MTRL, r.BRANDNAME]));
      for (const ns of needsSelection) {
        for (const m of ns.matches) {
          m.BRANDNAME = brandMap.get(m.MTRL) ?? null;
        }
      }
    } catch (err) {
      logger.warn('wizard match-products brand enrichment failed', { requestId }, err instanceof Error ? err : undefined);
    }
  }

  logger.info('wizard match-products done', {
    requestId, offerId,
    autoMatched: autoMatched.length,
    needsSelection: needsSelection.length, skipped: skipped.length,
  });

  return NextResponse.json({
    ok: true, step: 'match-products',
    autoMatched, needsSelection, skipped,
  });
}

async function handlePrepareSummary(
  ctx: OfferContext,
  body: CreateDraftOfferRequestBody,
): Promise<NextResponse> {
  const { pool, erpPool, offerId, requestId } = ctx;
  const resolvedCustomer = body.resolvedCustomer;
  const matchResults = body.matchResults;
  const missingBrands = body.missingBrands ?? [];

  if (!resolvedCustomer) {
    return NextResponse.json({ ok: false, error: 'Missing resolved customer' }, { status: 400 });
  }

  // Determine project status
  let projectStatus: 'existing' | 'will-create' = 'will-create';
  let projectCode: string | null = ctx.erpProjectCode;

  if (ctx.erpProjectId && ctx.erpProjectId > 0) {
    let codeToValidate = ctx.erpProjectCode;
    if (!codeToValidate) {
      const projReq = erpPool.request();
      projReq.input('PRJC', sql.Int, ctx.erpProjectId);
      const projRes = await projReq.query<{ CODE: string | null }>(`SELECT CODE FROM dbo.PRJC WHERE PRJC = @PRJC`);
      codeToValidate = projRes.recordset?.[0]?.CODE ?? null;
    }
    if (codeToValidate) {
      const validation = await findProject(ctx.erpProjectId, codeToValidate);
      if (validation.statusCode === PROJECT_FIND_STATUS.OK) {
        projectStatus = 'existing';
        projectCode = codeToValidate;
      }
    }
  }

  // Fetch order lines
  const linesReq = pool.request();
  linesReq.input('offerId', sql.Int, offerId);
  const linesRes = await linesReq.query<{
    TreeOrdering: number | null;
    ProductID: number | null;
    Quantity: number | null;
    ListPrice: number | null;
    NetCost: number | null;
    ERPID: number | null;
    ERPCode: string | null;
    ProductDescription: string | null;
    PartNumber: string | null;
    ModelNumber: string | null;
  }>(`
    SELECT
      od.TreeOrdering,
      od.ProductID,
      od.Quantity,
      od.ListPrice,
      od.NetCost,
      p.ERPID,
      p.ERPCode,
      p.Description AS ProductDescription,
      p.PartNumber,
      p.ModelNumber
    FROM dbo.OfferDetails od
    INNER JOIN dbo.Products p ON od.ProductID = p.ID
    WHERE od.OfferID = @offerId
      AND od.ProductID IS NOT NULL
  `);

  const allLines = (linesRes.recordset ?? []).sort((a, b) => (a.TreeOrdering ?? 0) - (b.TreeOrdering ?? 0));

  // Build order lines from all products (matched, to-create, user-selected)
  const resolvedProductIds = new Set<number>();
  if (matchResults) {
    for (const m of matchResults.autoMatched) resolvedProductIds.add(m.productId);
    for (const m of matchResults.userConfirmedCreate) resolvedProductIds.add(m.productId);
    for (const m of matchResults.userSelected) resolvedProductIds.add(m.productId);
  }

  const orderLines = allLines
    .filter(line => line.ProductID != null && resolvedProductIds.has(line.ProductID!) && line.Quantity != null && line.Quantity > 0 && line.ListPrice != null && line.ListPrice >= 0)
    .map(line => ({
      productId: line.ProductID,
      productCode: line.ERPCode ?? '(new)',
      productName: [line.ModelNumber, line.ProductDescription].filter(Boolean).join(' - ') || 'Unknown',
      qty: Number(line.Quantity),
      price: Number(line.ListPrice),
      lineTotal: Number(line.Quantity!) * Number(line.ListPrice!),
    }));

  const totalValue = orderLines.reduce((sum, l) => sum + l.lineTotal, 0);

  logger.info('wizard prepare-summary done', { requestId, offerId, lineCount: orderLines.length, totalValue });

  return NextResponse.json({
    ok: true, step: 'prepare-summary',
    customer: resolvedCustomer,
    project: { status: projectStatus, code: projectCode, id: ctx.erpProjectId },
    orderLines,
    totals: { lineCount: orderLines.length, totalValue },
    actions: {
      brandsToCreate: missingBrands.length,
      productsToCreate: matchResults?.userConfirmedCreate?.length ?? 0,
      productsToMatch: (matchResults?.autoMatched?.length ?? 0) + (matchResults?.userSelected?.length ?? 0),
      projectToCreate: projectStatus === 'will-create',
    },
    missingBrands,
  });
}

async function handleExecute(
  ctx: OfferContext,
  body: CreateDraftOfferRequestBody,
): Promise<NextResponse> {
  const { pool, erpPool, offerId, requestId } = ctx;
  const resolvedCustomer = body.resolvedCustomer;
  const matchResults = body.matchResults;
  const missingBrands = body.missingBrands ?? [];

  if (!resolvedCustomer) {
    return NextResponse.json({ ok: false, error: 'Missing resolved customer' }, { status: 400 });
  }

  const erpCustomerId = resolvedCustomer.TRDR;
  const erpCustomerCode = resolvedCustomer.CODE;
  const results: {
    brandsCreated: string[];
    productsCreated: Array<{ productId: number; mtrl: number; code: string }>;
    productsLinked: Array<{ productId: number; mtrl: number; code: string }>;
    project: { id: number; code: string; isNew: boolean } | null;
    order: { findocId: number; finCode: string } | null;
  } = {
    brandsCreated: [],
    productsCreated: [],
    productsLinked: [],
    project: null,
    order: null,
  };

  // 1. Create missing brands
  for (const brandName of missingBrands) {
    // Idempotency: check if brand was already created
    const checkReq = erpPool.request();
    checkReq.input('brandName', sql.NVarChar(128), brandName);
    const checkRes = await checkReq.query<{ MTRMANFCTR: number }>(`
      SELECT TOP (1) MTRMANFCTR FROM dbo.MTRMANFCTR
      WHERE UPPER(LTRIM(RTRIM(NAME))) = UPPER(LTRIM(RTRIM(@brandName)))
      ORDER BY MTRMANFCTR
    `);
    if (!checkRes.recordset?.[0]) {
      const created = await createManufacturerInErp(erpPool, brandName);
      logger.info('wizard execute brand created', { requestId, offerId, brandName, mtrmanfctrId: created.mtrmanfctrId });
    }
    results.brandsCreated.push(brandName);
  }

  // 2. Create new products + link matched/selected products
  const products = await fetchOfferProducts(pool, offerId);
  const productMap = new Map(products.map(p => [p.ProductID, p]));

  if (matchResults) {
    // Link auto-matched products
    for (const match of matchResults.autoMatched) {
      const updateReq = pool.request();
      updateReq.input('productId', sql.Int, match.productId);
      updateReq.input('erpId', sql.Int, match.MTRL);
      updateReq.input('erpCode', sql.NVarChar(255), match.CODE);
      await updateReq.query(`
        UPDATE dbo.Products SET ERPID = @erpId, ERPCode = @erpCode, ModifiedOn = SYSUTCDATETIME() WHERE ID = @productId
      `);
      results.productsLinked.push({ productId: match.productId, mtrl: match.MTRL, code: match.CODE ?? '' });
    }

    // Link user-selected products
    for (const sel of matchResults.userSelected) {
      const updateReq = pool.request();
      updateReq.input('productId', sql.Int, sel.productId);
      updateReq.input('erpId', sql.Int, sel.MTRL);
      updateReq.input('erpCode', sql.NVarChar(255), sel.CODE);
      await updateReq.query(`
        UPDATE dbo.Products SET ERPID = @erpId, ERPCode = @erpCode, ModifiedOn = SYSUTCDATETIME() WHERE ID = @productId
      `);
      results.productsLinked.push({ productId: sel.productId, mtrl: sel.MTRL, code: sel.CODE ?? '' });
    }

    // Create new products in ERP
    for (const item of matchResults.userConfirmedCreate) {
      const product = productMap.get(item.productId);
      if (!product || !product.Description || !product.BrandID || !product.SubCategoryID || !product.TypeID) {
        logger.warn('wizard execute skip product creation - missing fields', { requestId, productId: item.productId });
        continue;
      }

      try {
        const created = await createItemInErp(pool, erpPool, {
          productId: product.ProductID,
          description: product.Description,
          modelNumber: product.ModelNumberCleared,
          partNumber: product.PartNumberCleared,
          brandId: product.BrandID,
          brandName: product.BrandName!,
          categoryId: product.CategoryID!,
          subCategoryId: product.SubCategoryID,
          typeId: product.TypeID,
          businessUnit: ctx.businessUnit,
        });

        const updateReq = pool.request();
        updateReq.input('productId', sql.Int, product.ProductID);
        updateReq.input('erpId', sql.Int, created.mtrl);
        updateReq.input('erpCode', sql.NVarChar(255), created.code);
        await updateReq.query(`
          UPDATE dbo.Products SET ERPID = @erpId, ERPCode = @erpCode, ModifiedOn = SYSUTCDATETIME() WHERE ID = @productId
        `);

        results.productsCreated.push({ productId: product.ProductID, mtrl: created.mtrl, code: created.code });
      } catch (err) {
        logger.error(`wizard execute failed to create product ${item.productId}`, { requestId, offerId }, err instanceof Error ? err : undefined);
        throw new Error(`Failed to create product ${product.PartNumber || product.ModelNumber || item.productId} in Soft1: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  }

  // 3. Create/validate project
  const projectCtx: OfferContext = { ...ctx, erpCustomerId };
  const project = await resolveOrCreateProject(projectCtx, erpCustomerCode);
  results.project = { id: project.prjcId, code: project.prjcCode, isNew: project.isNew };
  logger.info('wizard execute project', { requestId, offerId, prjcId: project.prjcId, prjcCode: project.prjcCode, isNew: project.isNew });

  // 4. Create order
  if (erpCustomerId && erpCustomerId > 0) {
    const linesReq = pool.request();
    linesReq.input('offerId', sql.Int, offerId);
    const linesRes = await linesReq.query<{
      TreeOrdering: number | null;
      ProductID: number | null;
      Quantity: number | null;
      ListPrice: number | null;
      NetCost: number | null;
      ERPID: number | null;
      ERPCode: string | null;
    }>(`
      SELECT od.TreeOrdering, od.ProductID, od.Quantity, od.ListPrice, od.NetCost, p.ERPID, p.ERPCode
      FROM dbo.OfferDetails od
      INNER JOIN dbo.Products p ON od.ProductID = p.ID
      WHERE od.OfferID = @offerId AND od.ProductID IS NOT NULL AND p.ERPID IS NOT NULL
    `);

    const lines = (linesRes.recordset ?? []).sort((a, b) => (a.TreeOrdering ?? 0) - (b.TreeOrdering ?? 0));
    const orderLines: OrderLineForCreation[] = lines
      .filter(l => l.ERPID != null && l.ERPCode != null && l.Quantity != null && l.Quantity > 0 && l.ListPrice != null && l.ListPrice >= 0)
      .map(l => ({ erpId: l.ERPID!, erpCode: l.ERPCode!, qty: Number(l.Quantity), price: Number(l.ListPrice), netCost: l.NetCost != null ? Number(l.NetCost) : null }));

    const orderInfo = await createOrderWithLines({
      offerId,
      description: ctx.offerDescription,
      customerCode: erpCustomerCode ?? String(erpCustomerId),
      projectCode: project.prjcCode,
      prjcId: project.prjcId,
      businessUnit: ctx.businessUnit,
      trdr: erpCustomerId,
      integrationKey: 'FASTQUOTE_CREATE_FINDOC',
      series: 9001,
      createdByUser: 1011,
      lines: orderLines,
    });

    results.order = { findocId: orderInfo.findocId, finCode: orderInfo.finCode };
    logger.info('wizard execute order created', { requestId, offerId, findocId: orderInfo.findocId, finCode: orderInfo.finCode });
  }

  return NextResponse.json({ ok: true, step: 'execute', ...results });
}

// ── Legacy handler (existing monolithic flow) ──────────────────────────────────

// First call: Find matches for all products
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/create-draft-order-soft1');
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

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
    const requestId = await getRequestId(req);

    // Get offer metadata needed for ERP integration
    const offerRequest = pool.request();
    offerRequest.input('offerId', sql.Int, normalizedId);
    const offerResult = await offerRequest.query<{
      Description: string | null;
      SalesDivisionID: number | null;
      SalesDivisionName: string | null;
      ERPCustomerID: number | null;
      CustomerName: string | null;
      ERPProjectID: number | null;
      ERPProjectCode: string | null;
    }>(`
      SELECT
        o.Description,
        o.SalesDivisionID,
        sd.Name AS SalesDivisionName,
        c.ERPID AS ERPCustomerID,
        c.Name AS CustomerName,
        o.ERPProjectID,
        o.ERPProjectCode
      FROM dbo.Offer o
      INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
      LEFT JOIN dbo.SalesDivision sd ON o.SalesDivisionID = sd.ID
      WHERE o.ID = @offerId
    `);
    const offerRow = offerResult.recordset?.[0] ?? null;
    const offerDescription = offerRow?.Description ?? `FastQuote Project for offer ${normalizedId}`;
    const salesDivisionId = offerRow?.SalesDivisionID ?? null;
    const salesDivisionName = offerRow?.SalesDivisionName ?? null;
    let erpCustomerId = offerRow?.ERPCustomerID ?? null;
    let erpCustomerCode: string | null = null; // alphanumeric CODE from dbo.TRDR.CODE (needed for WS setDocs)
    const customerName = offerRow?.CustomerName ?? null;
    const erpProjectId = offerRow?.ERPProjectID ?? null;
    const erpProjectCode = offerRow?.ERPProjectCode ?? null;
    // Map SalesDivisionID to BusinessUnit: 4 -> AVS, 3 -> TVS, fallback based on name
    let businessUnit: 'AVS' | 'TVS';
    if (salesDivisionId === 3) {
      businessUnit = 'TVS';
    } else if (salesDivisionId === 4) {
      businessUnit = 'AVS';
    } else {
      const name = salesDivisionName?.toUpperCase() ?? '';
      businessUnit = name.includes('TVS') ? 'TVS' : 'AVS';
    }

    // ── Wizard step dispatcher ───────────────────────────────────────────────
    if (body?.step) {
      const ctx: OfferContext = {
        pool, erpPool, offerId: normalizedId, requestId,
        offerDescription,
        salesDivisionId,
        businessUnit,
        erpCustomerId,
        customerName,
        erpProjectId,
        erpProjectCode,
      };

      switch (body.step as WizardStep) {
        case 'resolve-customer':
          return await handleResolveCustomer(ctx, body);
        case 'categorize-products':
          return await handleCategorizeProducts(ctx, body);
        case 'update-product-category':
          return await handleUpdateProductCategory(ctx, body);
        case 'check-brands':
          return await handleCheckBrands(ctx);
        case 'match-products':
          return await handleMatchProducts(ctx, body);
        case 'prepare-summary':
          return await handlePrepareSummary(ctx, body);
        case 'execute':
          return await handleExecute(ctx, body);
        default:
          return NextResponse.json({ ok: false, error: `Unknown step: ${body.step}` }, { status: 400 });
      }
    }

    // ── Legacy monolithic flow (backward compatibility) ──────────────────────

    // Customer finding logic: search for customer before searching for project
    const customerSelection = body?.customerSelection ?? null;
    const customerCode = body?.customerCode ?? null;
    const customerConfirmed = body?.customerConfirmed ?? false;

    if (!erpCustomerId) {
      // No ERP customer ID found, need to search for customer
      if (customerSelection && customerConfirmed) {
        // User confirmed the customer selection
        erpCustomerId = customerSelection.TRDR;
        erpCustomerCode = customerSelection.CODE ?? null;
        logger.info('create-draft-order-soft1 customer confirmed', {
          requestId,
          offerId: normalizedId,
          erpCustomerId,
          customerCode: erpCustomerCode,
        });
      } else if (customerSelection && !customerConfirmed) {
        // User selected but not confirmed yet, ask for confirmation
        return NextResponse.json({
          ok: true,
          needsCustomerConfirmation: customerSelection,
          message: 'Please confirm the selected customer.',
        });
      } else if (customerCode) {
        // User provided customer code, search by code
        const customerSearchRequest = erpPool.request();
        customerSearchRequest.input('SearchValue', sql.NVarChar(200), customerCode.trim());
        const customerSearchResult = await customerSearchRequest.query<{
          TRDR: number;
          CODE: string | null;
          NAME: string | null;
        }>(`
          EXEC tlm.FindCustomer @SearchValue = @SearchValue
        `);
        const customerMatches = customerSearchResult.recordset ?? [];

        if (customerMatches.length === 0) {
          return NextResponse.json({
            ok: false,
            error: `No customer found with code: ${customerCode}`,
            needsCustomerCode: true,
          });
        } else if (customerMatches.length === 1) {
          // Single match found, ask for confirmation
          return NextResponse.json({
            ok: true,
            needsCustomerConfirmation: customerMatches[0],
            message: 'Please confirm this is the correct customer.',
          });
        } else {
          // Multiple matches, return for user selection
          return NextResponse.json({
            ok: true,
            needsCustomerSelection: customerMatches,
            message: `Multiple customers found with code: ${customerCode}. Please select one.`,
          });
        }
      } else if (customerName) {
        // Search by customer name — SP first, then fuzzy LIKE fallback
        const customerSearchRequest = erpPool.request();
        customerSearchRequest.input('SearchValue', sql.NVarChar(200), customerName);
        const customerSearchResult = await customerSearchRequest.query<{
          TRDR: number;
          CODE: string | null;
          NAME: string | null;
        }>(`
          EXEC tlm.FindCustomer @SearchValue = @SearchValue
        `);
        let customerMatches = customerSearchResult.recordset ?? [];

        // If FindCustomer returned 0 matches, try fuzzy search (Latin + Greek)
        if (customerMatches.length === 0) {
          customerMatches = await fuzzyCustomerSearch(erpPool, customerName);
        }

        if (customerMatches.length === 0) {
          // No matches even with fuzzy search, ask for customer code
          return NextResponse.json({
            ok: false,
            error: `No customer found matching: ${customerName}. Please provide customer code.`,
            needsCustomerCode: true,
          });
        } else if (customerMatches.length === 1) {
          // Single match found, ask for confirmation
          return NextResponse.json({
            ok: true,
            needsCustomerConfirmation: customerMatches[0],
            message: 'Please confirm this is the correct customer.',
          });
        } else {
          // Multiple matches, return for user selection
          return NextResponse.json({
            ok: true,
            needsCustomerSelection: customerMatches,
            message: `Multiple customers found matching: ${customerName}. Please select one.`,
          });
        }
      } else {
        return NextResponse.json(
          {
            ok: false,
            error: 'No customer information available. Cannot create draft offer.',
          },
          { status: 400 },
        );
      }

      // Persist the found customer ERP ID back to the Customers table
      if (erpCustomerId && (customerSelection || customerCode || customerName)) {
        const updateCustomerRequest = pool.request();
        updateCustomerRequest.input('offerId', sql.Int, normalizedId);
        updateCustomerRequest.input('erpCustomerId', sql.Int, erpCustomerId);
        await updateCustomerRequest.query(`
          UPDATE dbo.Customers
          SET ERPID = @erpCustomerId,
              ModifiedOn = SYSUTCDATETIME()
          WHERE ID = (SELECT CustomerID FROM dbo.Offer WHERE ID = @offerId)
            AND ERPID IS NULL
        `);
        logger.info('create-draft-order-soft1 customer ERPID persisted', {
          requestId,
          offerId: normalizedId,
          erpCustomerId,
        });
      }
    }

    // Resolve customer CODE from ERP if we have a TRDR but no CODE yet
    if (erpCustomerId && !erpCustomerCode) {
      const custCodeRequest = erpPool.request();
      custCodeRequest.input('TRDR', sql.Int, erpCustomerId);
      const custCodeResult = await custCodeRequest.query<{ CODE: string | null }>(`
        SELECT TOP (1) CODE FROM dbo.TRDR WHERE TRDR = @TRDR
      `);
      erpCustomerCode = custCodeResult.recordset?.[0]?.CODE ?? null;
      logger.info('create-draft-order-soft1 resolved customer CODE', {
        requestId,
        offerId: normalizedId,
        erpCustomerId,
        erpCustomerCode,
      });
    }

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
      logger.info('create-draft-order-soft1 no products', { requestId, offerId: normalizedId });
      return NextResponse.json({
        ok: true,
        message: 'No products found in offer',
        needsSelection: [],
        updated: [],
      });
    }

    logger.info('create-draft-order-soft1 started', {
      requestId,
      offerId: normalizedId,
      businessUnit,
      productsCount: products.length,
      selectionsCount: selections.length,
      erpProjectId: erpProjectId ?? null,
      erpProjectCode: erpProjectCode ?? null,
      erpCustomerId: erpCustomerId ?? null,
    });

    // Auto-fill missing CategoryID, SubCategoryID, TypeID using AI
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
                product.CategoryID,
              );

              logger.info('Received AI category suggestions', {
                requestId,
                productId: product.ProductID,
                suggestedCategoryId: suggestions.categoryId,
                suggestedSubCategoryId: suggestions.subCategoryId,
                suggestedTypeId: suggestions.typeId,
              });

              // Only update if we got suggestions
              if (suggestions.categoryId || suggestions.subCategoryId || suggestions.typeId) {
                const updateRequest = pool.request();
                updateRequest.input('productId', sql.Int, product.ProductID);

                // Build dynamic UPDATE query based on what needs updating
                const updates: string[] = [];

                // Update category if missing, or if subcategory's parent differs from existing
                const shouldUpdateCategory = needsCategory
                  || (suggestions.categoryId && suggestions.categoryId !== product.CategoryID);
                if (shouldUpdateCategory && suggestions.categoryId) {
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

                  // Also update in-memory product so downstream checks see the new values
                  if (shouldUpdateCategory && suggestions.categoryId) {
                    product.CategoryID = suggestions.categoryId;
                  }
                  if (needsSubCategory && suggestions.subCategoryId) {
                    product.SubCategoryID = suggestions.subCategoryId;
                  }
                  if (needsType && suggestions.typeId) {
                    product.TypeID = suggestions.typeId;
                  }

                  logger.info('Auto-filled product categories using AI', {
                    requestId,
                    productId: product.ProductID,
                    updatedCategoryId: shouldUpdateCategory && suggestions.categoryId ? suggestions.categoryId : null,
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

    // Check if any brands need to be created in ERP
    const brandCreationConfirmed = body?.brandCreationConfirmed ?? false;
    const uniqueBrandNames = [...new Set(
      products
        .filter((p) => p.BrandName && p.BrandID)
        .map((p) => p.BrandName!.trim()),
    )];

    if (uniqueBrandNames.length > 0) {
      const missingBrands: string[] = [];
      for (const brandName of uniqueBrandNames) {
        const checkRequest = erpPool.request();
        checkRequest.input('brandName', sql.NVarChar(128), brandName);
        const checkResult = await checkRequest.query<{ MTRMANFCTR: number }>(`
          SELECT TOP (1) MTRMANFCTR
          FROM dbo.MTRMANFCTR
          WHERE UPPER(LTRIM(RTRIM(NAME))) = UPPER(LTRIM(RTRIM(@brandName)))
          ORDER BY MTRMANFCTR
        `);
        if (!checkResult.recordset?.[0]) {
          missingBrands.push(brandName);
        }
      }

      if (missingBrands.length > 0) {
        if (!brandCreationConfirmed) {
          logger.info('create-draft-order-soft1 brands missing in ERP, prompting user', {
            requestId,
            offerId: normalizedId,
            missingBrands,
          });
          return NextResponse.json({
            ok: true,
            needsBrandCreation: missingBrands,
          });
        }

        // User confirmed — create the missing brands
        for (const brandName of missingBrands) {
          try {
            const created = await createManufacturerInErp(erpPool, brandName);
            logger.info('create-draft-order-soft1 brand created in ERP', {
              requestId,
              offerId: normalizedId,
              brandName,
              mtrmanfctrId: created.mtrmanfctrId,
              mtrmanfctrCode: created.mtrmanfctrCode,
            });
          } catch (brandErr) {
            logger.error('Failed to create brand in ERP', {
              requestId,
              offerId: normalizedId,
              brandName,
            }, brandErr instanceof Error ? brandErr : undefined);
            return NextResponse.json(
              { ok: false, error: `Failed to create brand "${brandName}" in Soft1: ${brandErr instanceof Error ? brandErr.message : 'Unknown error'}` },
              { status: 500 },
            );
          }
        }
      }
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
          logger.info('create-draft-order-soft1 DB update (selection)', {
            requestId,
            offerId: normalizedId,
            productId: product.ProductID,
            erpId: selection.MTRL,
            erpCode: selection.CODE,
          });
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

            logger.info('create-draft-order-soft1 FindProduct result', {
              requestId,
              offerId: normalizedId,
              productId: product.ProductID,
              partNo: product.PartNumberCleared,
              modelNo: product.ModelNumberCleared,
              foundCount,
              matches: matches.map((m) => ({ MTRL: m.MTRL, CODE: m.CODE, CODE1: m.CODE1, CODE2: m.CODE2 })),
            });

            if (foundCount === 0) {
              // No matches found - automatically create product in ERP
              try {
                if (
                  !product.Description ||
                  !product.BrandID ||
                  !product.CategoryID ||
                  !product.SubCategoryID ||
                  !product.TypeID
                ) {
                  logger.warn('Product missing required fields for create', {
                    requestId,
                    offerId: normalizedId,
                    productId: product.ProductID,
                    hasDescription: !!product.Description,
                    hasBrandID: !!product.BrandID,
                    hasCategoryID: !!product.CategoryID,
                    hasSubCategoryID: !!product.SubCategoryID,
                    hasTypeID: !!product.TypeID,
                  });
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

                const created = await createItemInErp(pool, erpPool, {
                  productId: product.ProductID,
                  description: product.Description,
                  modelNumber: product.ModelNumberCleared,
                  partNumber: product.PartNumberCleared,
                  brandId: product.BrandID,
                  brandName: product.BrandName!,
                  categoryId: product.CategoryID!,
                  subCategoryId: product.SubCategoryID,
                  typeId: product.TypeID,
                  businessUnit,
                });

                logger.info('create-draft-order-soft1 CreateProduct result', {
                  requestId,
                  offerId: normalizedId,
                  productId: product.ProductID,
                  createdMTRL: created.mtrl,
                  createdCode: created.code,
                });

                const updateRequest = pool.request();
                updateRequest.input('productId', sql.Int, product.ProductID);
                updateRequest.input('erpId', sql.Int, created.mtrl);
                updateRequest.input('erpCode', sql.NVarChar(255), created.code);

                updatePromises.push(
                  updateRequest.query(`
                    UPDATE dbo.Products
                    SET ERPID = @erpId,
                        ERPCode = @erpCode,
                        ModifiedOn = SYSUTCDATETIME()
                    WHERE ID = @productId
                  `).then(() => undefined),
                );
              } catch (createErr) {
                console.error(`Failed to create product in ERP for product ${product.ProductID}:`, createErr);
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
              logger.info('create-draft-order-soft1 DB update (single match)', {
                requestId,
                offerId: normalizedId,
                productId: product.ProductID,
                erpId: match.MTRL,
                erpCode: match.CODE,
              });
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

      // Split unresolved products: selectable (2+ matches) vs unresolvable (0 matches / failed creation)
      const selectableMatches = productMatches.filter((pm) => pm.matches.length > 0);
      const unresolvableProducts = productMatches.filter((pm) => pm.matches.length === 0);

      // Only block if there are products the user can actually resolve via the modal
      if (selectableMatches.length > 0) {
        const updatedIds = selections.map((s) => s.productId);
        logger.info('create-draft-order-soft1 returning needsSelection (selections path)', {
          requestId,
          offerId: normalizedId,
          updatedCount: updatedIds.length,
          needsSelectionCount: selectableMatches.length,
          needsSelectionProductIds: selectableMatches.map((pm) => pm.productId),
          skippedUnresolvableCount: unresolvableProducts.length,
          skippedUnresolvableProductIds: unresolvableProducts.map((pm) => pm.productId),
        });
        return NextResponse.json({
          ok: true,
          message: 'Some products need selection before the order can be created.',
          needsSelection: selectableMatches,
          updated: updatedIds,
        });
      }

      if (unresolvableProducts.length > 0) {
        logger.warn('create-draft-order-soft1 skipping unresolvable products (selections path)', {
          requestId,
          offerId: normalizedId,
          skippedCount: unresolvableProducts.length,
          skippedProductIds: unresolvableProducts.map((pm) => pm.productId),
        });
      }

      // Ensure ERP project exists and is valid
      let finalErpProjectId = erpProjectId;
      let finalErpProjectCode = erpProjectCode;

      if (finalErpProjectId && finalErpProjectId > 0) {
        // If we don't have a code in FastQuote, fetch it from ERP
        let codeToValidate = finalErpProjectCode;
        if (!codeToValidate) {
          const projectRequest = erpPool.request();
          projectRequest.input('PRJC', sql.Int, finalErpProjectId);
          const projectResult = await projectRequest.query<{
            CODE: string | null;
          }>(`
            SELECT CODE
            FROM dbo.PRJC
            WHERE PRJC = @PRJC
          `);
          codeToValidate = projectResult.recordset?.[0]?.CODE ?? null;
        }

        logger.info('create-draft-order-soft1 project fetch', {
          requestId,
          offerId: normalizedId,
          erpProjectId: finalErpProjectId,
          erpProjectCode: codeToValidate,
        });

        if (codeToValidate) {
          const projectValidation = await findProject(finalErpProjectId, codeToValidate);
          logger.info('create-draft-order-soft1 project validation', {
            requestId,
            offerId: normalizedId,
            erpProjectId: finalErpProjectId,
            erpProjectCode: codeToValidate,
            statusCode: projectValidation.statusCode,
            statusText: projectValidation.statusText,
          });

          if (projectValidation.statusCode === PROJECT_FIND_STATUS.OK) {
            finalErpProjectCode = codeToValidate;
          } else if (projectValidation.statusCode === PROJECT_FIND_STATUS.NOT_FOUND) {
            // Treat as "no existing project found" -> create new one
            finalErpProjectId = null;
            finalErpProjectCode = null;
          } else {
            return NextResponse.json(
              {
                ok: false,
                error: `Project validation failed: ${projectValidation.statusText}`,
                projectValidation,
              },
              { status: 400 },
            );
          }
        } else {
          logger.info('create-draft-order-soft1 project validation skipped (no project code)', {
            requestId,
            offerId: normalizedId,
            erpProjectId: finalErpProjectId,
          });
        }
      }

      // If there is no existing valid project, create one via integration
      if (!finalErpProjectId || finalErpProjectId <= 0) {
        // Ensure we have a customer before creating project
        if (!erpCustomerId) {
          return NextResponse.json(
            {
              ok: false,
              error: 'Cannot create project without a valid customer. Please ensure the offer has a customer assigned.',
            },
            { status: 400 },
          );
        }

        const createdProject = await createProjectFromIntegration({
          integrationKey: 'FASTQUOTE_CREATE_PRJC',
          codePrefix: 'COV',
          name: offerDescription,
          prjcParent: null,
          trdr: erpCustomerId,
          customerCode: erpCustomerCode,
          prjCategory: null,
          sourceSystem: 'FQ',
          createdByUser: 1011,
          businessUnit,
          prjState: 90,
        });

        finalErpProjectId = createdProject.prjcId;
        finalErpProjectCode = createdProject.prjcCode;

        logger.info('create-draft-order-soft1 project created', {
          requestId,
          offerId: normalizedId,
          erpProjectId: finalErpProjectId,
          erpProjectCode: finalErpProjectCode,
        });

        // Persist ERP project back to FastQuote Offer
        const updateOfferRequest = pool.request();
        updateOfferRequest.input('offerId', sql.Int, normalizedId);
        updateOfferRequest.input('erpProjectId', sql.Int, finalErpProjectId);
        updateOfferRequest.input('erpProjectCode', sql.NVarChar(25), finalErpProjectCode);
        await updateOfferRequest.query(`
          UPDATE dbo.Offer
          SET ERPProjectID = @erpProjectId,
              ERPProjectCode = @erpProjectCode,
              ModifiedOn = SYSUTCDATETIME()
          WHERE ID = @offerId
        `);
      }

      // Create customer order (FINDOC) and lines if we have the required data
      if (finalErpProjectId && finalErpProjectId > 0 && erpCustomerId && erpCustomerId > 0) {
        try {
          // Load offer details that should become order lines
          const linesRequest = pool.request();
          linesRequest.input('offerId', sql.Int, normalizedId);
          const linesResult = await linesRequest.query<{
            TreeOrdering: number | null;
            ProductID: number | null;
            Quantity: number | null;
            ListPrice: number | null;
            NetCost: number | null;
            ERPID: number | null;
            ERPCode: string | null;
          }>(`
            SELECT
              od.TreeOrdering,
              od.ProductID,
              od.Quantity,
              od.ListPrice,
              od.NetCost,
              p.ERPID,
              p.ERPCode
            FROM dbo.OfferDetails od
            INNER JOIN dbo.Products p ON od.ProductID = p.ID
            WHERE od.OfferID = @offerId
              AND od.ProductID IS NOT NULL
              AND p.ERPID IS NOT NULL
          `);

          const lines = (linesResult.recordset ?? []).sort((a, b) => {
            const ta = a.TreeOrdering ?? 0;
            const tb = b.TreeOrdering ?? 0;
            return ta - tb;
          });

          const orderLines: OrderLineForCreation[] = lines
            .filter(
              (line) =>
                line.ERPID != null &&
                line.ERPCode != null &&
                line.Quantity != null &&
                line.Quantity > 0 &&
                line.ListPrice != null &&
                line.ListPrice >= 0,
            )
            .map((line) => ({
              erpId: line.ERPID!,
              erpCode: line.ERPCode!,
              qty: Number(line.Quantity),
              price: Number(line.ListPrice),
              netCost: line.NetCost != null ? Number(line.NetCost) : null,
            }));

          const orderInfo = await createOrderWithLines({
            offerId: normalizedId,
            description: offerDescription,
            customerCode: erpCustomerCode ?? String(erpCustomerId),
            projectCode: finalErpProjectCode,
            prjcId: finalErpProjectId,
            businessUnit,
            trdr: erpCustomerId,
            integrationKey: 'FASTQUOTE_CREATE_FINDOC',
            series: 9001,
            createdByUser: 1011,
            lines: orderLines,
          });

          logger.info('create-draft-order-soft1 order created (selections path)', {
            requestId,
            offerId: normalizedId,
            findocId: orderInfo.findocId,
            finCode: orderInfo.finCode,
          });
        } catch (orderErr) {
          logger.error(
            'Failed to create customer order (selections path)',
            { requestId, offerId: normalizedId, erpProjectId: finalErpProjectId, erpCustomerId },
            orderErr instanceof Error ? orderErr : undefined,
          );
        }
      }

      const updatedIds = selections.map((s) => s.productId);
      logger.info('create-draft-order-soft1 completed (selections path)', {
        requestId,
        offerId: normalizedId,
        updatedCount: updatedIds.length,
      });

      return NextResponse.json({
        ok: true,
        message: unresolvableProducts.length > 0
          ? `Draft order created. ${unresolvableProducts.length} product(s) could not be matched and were skipped.`
          : 'Draft order created successfully.',
        needsSelection: [],
        updated: updatedIds,
        skippedProducts: unresolvableProducts.map((pm) => pm.productId),
      });
    }

    // No selections provided - search for all products
    const successfullyUpdatedIds: number[] = [];
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

        logger.info('create-draft-order-soft1 FindProduct result', {
          requestId,
          offerId: normalizedId,
          productId: product.ProductID,
          partNo: product.PartNumberCleared,
          modelNo: product.ModelNumberCleared,
          foundCount,
          matches: matches.map((m) => ({ MTRL: m.MTRL, CODE: m.CODE, CODE1: m.CODE1, CODE2: m.CODE2 })),
        });

        if (foundCount === 0) {
          // No matches found - automatically create product in ERP
          try {
            if (
              !product.Description ||
              !product.BrandID ||
              !product.SubCategoryID ||
              !product.TypeID
            ) {
              logger.warn('Product missing required fields for create', {
                requestId,
                offerId: normalizedId,
                productId: product.ProductID,
                hasDescription: !!product.Description,
                hasBrandID: !!product.BrandID,
                hasSubCategoryID: !!product.SubCategoryID,
                hasTypeID: !!product.TypeID,
              });
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

            const created = await createItemInErp(pool, erpPool, {
              productId: product.ProductID,
              description: product.Description,
              modelNumber: product.ModelNumberCleared,
              partNumber: product.PartNumberCleared,
              brandId: product.BrandID,
              brandName: product.BrandName!,
              categoryId: product.CategoryID!,
              subCategoryId: product.SubCategoryID,
              typeId: product.TypeID,
              businessUnit,
            });

            logger.info('create-draft-order-soft1 CreateProduct result', {
              requestId,
              offerId: normalizedId,
              productId: product.ProductID,
              createdMTRL: created.mtrl,
              createdCode: created.code,
            });

            const updateRequest = pool.request();
            updateRequest.input('productId', sql.Int, product.ProductID);
            updateRequest.input('erpId', sql.Int, created.mtrl);
            updateRequest.input('erpCode', sql.NVarChar(255), created.code);

            await updateRequest.query(`
              UPDATE dbo.Products
              SET ERPID = @erpId,
                  ERPCode = @erpCode,
                  ModifiedOn = SYSUTCDATETIME()
              WHERE ID = @productId
            `);
            successfullyUpdatedIds.push(product.ProductID);
          } catch (createErr) {
            console.error(`Failed to create product in ERP for product ${product.ProductID}:`, createErr);
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
          logger.info('create-draft-order-soft1 DB update (single match)', {
            requestId,
            offerId: normalizedId,
            productId: product.ProductID,
            erpId: match.MTRL,
            erpCode: match.CODE,
          });
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
          successfullyUpdatedIds.push(product.ProductID);
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

    // Split unresolved products: selectable (2+ matches) vs unresolvable (0 matches / failed creation)
    const selectableMatches = productMatches.filter((pm) => pm.matches.length > 0);
    const unresolvableProducts = productMatches.filter((pm) => pm.matches.length === 0);

    // Only block if there are products the user can actually resolve via the modal
    if (selectableMatches.length > 0) {
      logger.info('create-draft-order-soft1 returning needsSelection (no-selections path)', {
        requestId,
        offerId: normalizedId,
        updatedCount: successfullyUpdatedIds.length,
        needsSelectionCount: selectableMatches.length,
        needsSelectionProductIds: selectableMatches.map((pm) => pm.productId),
        skippedUnresolvableCount: unresolvableProducts.length,
        skippedUnresolvableProductIds: unresolvableProducts.map((pm) => pm.productId),
      });
      return NextResponse.json({
        ok: true,
        message: 'Some products need selection before the order can be created.',
        needsSelection: selectableMatches,
        updated: successfullyUpdatedIds,
      });
    }

    if (unresolvableProducts.length > 0) {
      logger.warn('create-draft-order-soft1 skipping unresolvable products (no-selections path)', {
        requestId,
        offerId: normalizedId,
        skippedCount: unresolvableProducts.length,
        skippedProductIds: unresolvableProducts.map((pm) => pm.productId),
      });
    }

    // Ensure ERP project exists and is valid
    let finalErpProjectId = erpProjectId;
    let finalErpProjectCode = erpProjectCode;

    if (finalErpProjectId && finalErpProjectId > 0) {
      // If we don't have a code in FastQuote, fetch it from ERP
      let codeToValidate = finalErpProjectCode;
      if (!codeToValidate) {
        const projectRequest = erpPool.request();
        projectRequest.input('PRJC', sql.Int, finalErpProjectId);
        const projectResult = await projectRequest.query<{
          CODE: string | null;
        }>(`
          SELECT CODE
          FROM dbo.PRJC
          WHERE PRJC = @PRJC
        `);
        codeToValidate = projectResult.recordset?.[0]?.CODE ?? null;
      }

      logger.info('create-draft-order-soft1 project fetch', {
        requestId,
        offerId: normalizedId,
        erpProjectId: finalErpProjectId,
        erpProjectCode: codeToValidate,
      });

      if (codeToValidate) {
        const projectValidation = await findProject(finalErpProjectId, codeToValidate);
        logger.info('create-draft-order-soft1 project validation', {
          requestId,
          offerId: normalizedId,
          erpProjectId: finalErpProjectId,
          erpProjectCode: codeToValidate,
          statusCode: projectValidation.statusCode,
          statusText: projectValidation.statusText,
        });

        if (projectValidation.statusCode === PROJECT_FIND_STATUS.OK) {
          finalErpProjectCode = codeToValidate;
        } else if (projectValidation.statusCode === PROJECT_FIND_STATUS.NOT_FOUND) {
          // Treat as "no existing project found" -> create new one
          finalErpProjectId = null;
          finalErpProjectCode = null;
        } else {
          return NextResponse.json(
            {
              ok: false,
              error: `Project validation failed: ${projectValidation.statusText}`,
              projectValidation,
            },
            { status: 400 },
          );
        }
      } else {
        logger.info('create-draft-order-soft1 project validation skipped (no project code)', {
          requestId,
          offerId: normalizedId,
          erpProjectId: finalErpProjectId,
        });
      }
    }

    // If there is no existing valid project, create one via integration
    if (!finalErpProjectId || finalErpProjectId <= 0) {
      // Ensure we have a customer before creating project
      if (!erpCustomerId) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Cannot create project without a valid customer. Please ensure the offer has a customer assigned.',
          },
          { status: 400 },
        );
      }

      const createdProject = await createProjectFromIntegration({
        integrationKey: 'FASTQUOTE_CREATE_PRJC',
        codePrefix: 'COV',
        name: offerDescription,
        prjcParent: null,
        trdr: erpCustomerId,
        customerCode: erpCustomerCode,
        prjCategory: null,
        sourceSystem: 'FQ',
        createdByUser: 1011,
        businessUnit,
        prjState: 90,
      });

      finalErpProjectId = createdProject.prjcId;
      finalErpProjectCode = createdProject.prjcCode;

      logger.info('create-draft-order-soft1 project created', {
        requestId,
        offerId: normalizedId,
        erpProjectId: finalErpProjectId,
        erpProjectCode: finalErpProjectCode,
      });

      // Persist ERP project back to FastQuote Offer
      const updateOfferRequest = pool.request();
      updateOfferRequest.input('offerId', sql.Int, normalizedId);
      updateOfferRequest.input('erpProjectId', sql.Int, finalErpProjectId);
      updateOfferRequest.input('erpProjectCode', sql.NVarChar(25), finalErpProjectCode);
      await updateOfferRequest.query(`
        UPDATE dbo.Offer
        SET ERPProjectID = @erpProjectId,
            ERPProjectCode = @erpProjectCode,
            ModifiedOn = SYSUTCDATETIME()
        WHERE ID = @offerId
      `);
    }

    // Create customer order (FINDOC) and lines if we have the required data
    if (finalErpProjectId && finalErpProjectId > 0 && erpCustomerId && erpCustomerId > 0) {
      try {
        // Load offer details that should become order lines
        const linesRequest = pool.request();
        linesRequest.input('offerId', sql.Int, normalizedId);
        const linesResult = await linesRequest.query<{
          TreeOrdering: number | null;
          ProductID: number | null;
          Quantity: number | null;
          ListPrice: number | null;
          NetCost: number | null;
          ERPID: number | null;
          ERPCode: string | null;
        }>(`
          SELECT
            od.TreeOrdering,
            od.ProductID,
            od.Quantity,
            od.ListPrice,
            od.NetCost,
            p.ERPID,
            p.ERPCode
          FROM dbo.OfferDetails od
          INNER JOIN dbo.Products p ON od.ProductID = p.ID
          WHERE od.OfferID = @offerId
            AND od.ProductID IS NOT NULL
            AND p.ERPID IS NOT NULL
        `);

        const lines = (linesResult.recordset ?? []).sort((a, b) => {
          const ta = a.TreeOrdering ?? 0;
          const tb = b.TreeOrdering ?? 0;
          return ta - tb;
        });

        const orderLines: OrderLineForCreation[] = lines
          .filter(
            (line) =>
              line.ERPID != null &&
              line.ERPCode != null &&
              line.Quantity != null &&
              line.Quantity > 0 &&
              line.ListPrice != null &&
              line.ListPrice >= 0,
          )
          .map((line) => ({
            erpId: line.ERPID!,
            erpCode: line.ERPCode!,
            qty: Number(line.Quantity),
            price: Number(line.ListPrice),
            netCost: line.NetCost != null ? Number(line.NetCost) : null,
          }));

        const orderInfo = await createOrderWithLines({
          offerId: normalizedId,
          description: offerDescription,
          customerCode: erpCustomerCode ?? String(erpCustomerId),
          projectCode: finalErpProjectCode,
          prjcId: finalErpProjectId,
          businessUnit,
          trdr: erpCustomerId,
          integrationKey: 'FASTQUOTE_CREATE_FINDOC',
          series: 9001,
          createdByUser: 1011,
          lines: orderLines,
        });

        logger.info('create-draft-order-soft1 order created (no-selections path)', {
          requestId,
          offerId: normalizedId,
          findocId: orderInfo.findocId,
          finCode: orderInfo.finCode,
        });
      } catch (orderErr) {
        logger.error(
          'Failed to create customer order (no-selections path)',
          { requestId, offerId: normalizedId, erpProjectId: finalErpProjectId, erpCustomerId },
          orderErr instanceof Error ? orderErr : undefined,
        );
      }
    }

    logger.info('create-draft-order-soft1 completed (no-selections path)', {
      requestId,
      offerId: normalizedId,
      updatedCount: successfullyUpdatedIds.length,
    });

    return NextResponse.json({
      ok: true,
      message: unresolvableProducts.length > 0
        ? `Draft order created. ${unresolvableProducts.length} product(s) could not be matched and were skipped.`
        : 'Draft order created successfully.',
      needsSelection: [],
      updated: successfullyUpdatedIds,
      skippedProducts: unresolvableProducts.map((pm) => pm.productId),
    });
  } catch (err) {
    logger.error('Failed to create draft offer', {}, err instanceof Error ? err : undefined);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to create draft offer',
      },
      { status: 500 },
    );
  }
}
