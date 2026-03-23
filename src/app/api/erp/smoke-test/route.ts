import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { getErpPool, getPool } from '../../../../lib/sql';
import { findProject, PROJECT_FIND_STATUS } from '../../../../lib/projectValidation';
import { getSoftOneClient } from '../../../../lib/softone';
import { fuzzyCustomerSearch } from '../../../../lib/customerSearch';

type SmokeTestPostBody = {
  offerId: number; // FastQuote offer ID to validate readiness for ERP integration
};

export async function GET(_req: NextRequest) {
  logRequest(_req, '/api/erp/smoke-test');
  try {
    void _req;
    const erpPool = await getErpPool();

    // Basic connectivity check
    const pingResult = await erpPool
      .request()
      .query<{ Ok: number }>('SELECT TOP (1) 1 AS Ok;');

    const erpConnectionOk = pingResult.recordset?.[0]?.Ok === 1;

    // IntegrationConfig check for both keys
    const configResult = await erpPool.request().query<{
      IntegrationKey: string;
      IsEnabled: boolean;
    }>(`
      SELECT IntegrationKey, IsEnabled
      FROM tlm.IntegrationConfig
      WHERE IntegrationKey IN (N'FASTQUOTE_CREATE_PRJC', N'FASTQUOTE_CREATE_FINDOC');
    `);

    // SoftOne Web Services connectivity check
    let wsHealthCheck: { ok: boolean; error?: string } = { ok: false, error: 'not attempted' };
    try {
      const client = getSoftOneClient();
      wsHealthCheck = await client.healthCheck();
    } catch (err) {
      wsHealthCheck = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return NextResponse.json({
      ok: true,
      erpConnectionOk,
      wsConnectionOk: wsHealthCheck.ok,
      wsConnectionError: wsHealthCheck.error ?? null,
      integrationConfig: configResult.recordset ?? [],
      projectCreationMode: process.env.SOFTONE_WS_PROJECT_CREATION === 'true' ? 'webservice' : 'sql',
      itemCreationMode: process.env.SOFTONE_WS_ITEM_CREATION === 'true' ? 'webservice' : 'sql',
      orderCreationMode: process.env.SOFTONE_WS_ORDER_CREATION === 'true' ? 'webservice' : 'sql',
      message:
        'ERP connectivity, WS connectivity, and IntegrationConfig checked. POST with { "offerId": <number> } to run full read-only smoke test.',
    });
  } catch (err) {
    console.error('ERP smoke-test GET failed', err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'ERP smoke-test GET failed',
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/erp/smoke-test');
  let body: SmokeTestPostBody | null = null;

  try {
    body = (await req.json().catch(() => null)) as SmokeTestPostBody | null;
  } catch {
    body = null;
  }

  if (!body || typeof body.offerId !== 'number' || body.offerId <= 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Body must be JSON with "offerId" (positive number).',
      },
      { status: 400 },
    );
  }

  const offerId = body.offerId;
  const steps: Record<string, unknown> = {};

  try {
    const erpPool = await getErpPool();
    const pool = await getPool();

    // Step 1: SoftOne Web Services connectivity (login + authenticate)
    try {
      const client = getSoftOneClient();
      const wsHealth = await client.healthCheck();
      steps.wsConnection = {
        ok: wsHealth.ok,
        error: wsHealth.error ?? null,
        projectCreationMode: process.env.SOFTONE_WS_PROJECT_CREATION === 'true' ? 'webservice' : 'sql',
        itemCreationMode: process.env.SOFTONE_WS_ITEM_CREATION === 'true' ? 'webservice' : 'sql',
        orderCreationMode: process.env.SOFTONE_WS_ORDER_CREATION === 'true' ? 'webservice' : 'sql',
      };
    } catch (err) {
      steps.wsConnection = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 2: ERP SQL connectivity
    try {
      const pingResult = await erpPool
        .request()
        .query<{ Ok: number }>('SELECT TOP (1) 1 AS Ok;');
      steps.erpConnection = {
        ok: pingResult.recordset?.[0]?.Ok === 1,
      };
    } catch (err) {
      steps.erpConnection = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return NextResponse.json({ ok: false, steps }, { status: 500 });
    }

    // Step 3: IntegrationConfig check
    try {
      const configResult = await erpPool.request().query<{
        IntegrationKey: string;
        IsEnabled: boolean;
      }>(`
        SELECT IntegrationKey, IsEnabled
        FROM tlm.IntegrationConfig
        WHERE IntegrationKey IN (N'FASTQUOTE_CREATE_PRJC', N'FASTQUOTE_CREATE_FINDOC');
      `);
      const entries = configResult.recordset ?? [];
      const allEnabled = entries.length >= 2 && entries.every(e => e.IsEnabled);
      steps.integrationConfig = {
        ok: true,
        allEnabled,
        entries,
      };
    } catch (err) {
      steps.integrationConfig = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 4: Offer lookup (FastQuote DB — read-only)
    let erpCustomerId: number | null = null;
    let erpProjectId: number | null = null;
    let erpProjectCode: string | null = null;
    let customerName: string | null = null;
    try {
      const offerResult = await pool
        .request()
        .input('offerId', sql.Int, offerId)
        .query<{
          ID: number;
          Description: string | null;
          SalesDivisionName: string | null;
          ERPProjectID: number | null;
          ERPProjectCode: string | null;
          ERPCustomerID: number | null;
          CustomerName: string | null;
          ProductCount: number;
        }>(`
          SELECT
            o.ID,
            o.Description,
            sd.Name AS SalesDivisionName,
            o.ERPProjectID,
            o.ERPProjectCode,
            c.ERPID AS ERPCustomerID,
            c.Name AS CustomerName,
            (SELECT COUNT(*) FROM dbo.OfferDetails od
             INNER JOIN dbo.Products p ON od.ProductID = p.ID
             WHERE od.OfferID = o.ID AND od.ProductID IS NOT NULL) AS ProductCount
          FROM dbo.Offer o
          INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
          LEFT JOIN dbo.SalesDivision sd ON o.SalesDivisionID = sd.ID
          WHERE o.ID = @offerId
        `);

      const row = offerResult.recordset?.[0] ?? null;
      if (!row) {
        steps.offerLookup = { ok: false, error: `Offer ${offerId} not found` };
      } else {
        erpCustomerId = row.ERPCustomerID;
        erpProjectId = row.ERPProjectID;
        erpProjectCode = row.ERPProjectCode;
        customerName = row.CustomerName;
        steps.offerLookup = {
          ok: true,
          offerId: row.ID,
          description: row.Description,
          salesDivision: row.SalesDivisionName,
          customerName: row.CustomerName,
          erpCustomerId: row.ERPCustomerID,
          erpProjectId: row.ERPProjectID,
          erpProjectCode: row.ERPProjectCode,
          productCount: row.ProductCount,
        };
      }
    } catch (err) {
      steps.offerLookup = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 5: Project validation (ERP DB — read-only)
    if (erpProjectId && erpProjectId > 0) {
      try {
        // If we don't have a code, fetch it
        let codeToValidate = erpProjectCode;
        if (!codeToValidate) {
          const projResult = await erpPool
            .request()
            .input('PRJC', sql.Int, erpProjectId)
            .query<{ CODE: string | null }>('SELECT CODE FROM dbo.PRJC WHERE PRJC = @PRJC');
          codeToValidate = projResult.recordset?.[0]?.CODE ?? null;
        }

        if (codeToValidate) {
          const validation = await findProject(erpProjectId, codeToValidate);
          steps.projectValidation = {
            ok: validation.statusCode === PROJECT_FIND_STATUS.OK,
            result: validation,
          };
        } else {
          steps.projectValidation = {
            ok: false,
            error: `Project ${erpProjectId} exists in offer but has no CODE in ERP`,
          };
        }
      } catch (err) {
        steps.projectValidation = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      steps.projectValidation = {
        ok: true,
        skipped: true,
        reason: 'Offer has no ERP project yet — one will be created on draft order',
      };
    }

    // Step 6: Customer lookup in ERP (read-only)
    if (erpCustomerId && erpCustomerId > 0) {
      try {
        const custResult = await erpPool
          .request()
          .input('TRDR', sql.Int, erpCustomerId)
          .query<{
            TRDR: number;
            CODE: string | null;
            NAME: string | null;
          }>(`
            SELECT TOP (1) TRDR, CODE, NAME
            FROM dbo.TRDR
            WHERE TRDR = @TRDR
          `);
        const cust = custResult.recordset?.[0] ?? null;
        steps.customerLookup = {
          ok: !!cust,
          found: !!cust,
          erpCustomerId,
          erpCode: cust?.CODE ?? null,
          erpName: cust?.NAME ?? null,
        };
      } catch (err) {
        steps.customerLookup = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (customerName) {
      // Try finding customer by name — SP first, then fuzzy LIKE fallback
      try {
        const searchResult = await erpPool
          .request()
          .input('SearchValue', sql.NVarChar(200), customerName)
          .query<{
            TRDR: number;
            CODE: string | null;
            NAME: string | null;
          }>('EXEC tlm.FindCustomer @SearchValue = @SearchValue');
        const spMatches = searchResult.recordset ?? [];

        // If SP returned no matches, try fuzzy LIKE search on TRDR
        let searchMethod = 'FindCustomer';
        let fuzzyMatches: Array<{ TRDR: number; CODE: string | null; NAME: string | null }> = [];
        if (spMatches.length === 0) {
          searchMethod = 'fuzzy';
          fuzzyMatches = await fuzzyCustomerSearch(erpPool, customerName);
        }

        const allMatches = spMatches.length > 0 ? spMatches : fuzzyMatches;
        steps.customerLookup = {
          ok: true,
          found: allMatches.length > 0,
          matchCount: allMatches.length,
          searchMethod,
          searchedName: customerName,
          matches: allMatches.slice(0, 10).map(m => ({
            TRDR: m.TRDR,
            CODE: m.CODE,
            NAME: m.NAME,
          })),
        };
      } catch (err) {
        steps.customerLookup = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      steps.customerLookup = {
        ok: true,
        skipped: true,
        reason: 'No customer ERPID or name available',
      };
    }

    // Step 7: Product matching in ERP (read-only — test first product from the offer)
    try {
      const productResult = await pool
        .request()
        .input('offerId', sql.Int, offerId)
        .query<{
          ProductID: number;
          PartNumberCleared: string | null;
          ModelNumberCleared: string | null;
          ERPID: number | null;
          ERPCode: string | null;
          BrandName: string | null;
        }>(`
          SELECT TOP (3)
            p.ID AS ProductID,
            p.PartNumberCleared,
            p.ModelNumberCleared,
            p.ERPID,
            p.ERPCode,
            b.Name AS BrandName
          FROM dbo.OfferDetails od
          INNER JOIN dbo.Products p ON od.ProductID = p.ID
          LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
          WHERE od.OfferID = @offerId
            AND od.ProductID IS NOT NULL
            AND (p.PartNumberCleared IS NOT NULL OR p.ModelNumberCleared IS NOT NULL)
        `);

      const products = productResult.recordset ?? [];
      if (products.length === 0) {
        steps.productMatching = {
          ok: true,
          skipped: true,
          reason: 'No products with part/model numbers in this offer',
        };
      } else {
        const matchResults: unknown[] = [];
        for (const product of products) {
          // If product already has an ERPID, just report it
          if (product.ERPID) {
            matchResults.push({
              productId: product.ProductID,
              partNumber: product.PartNumberCleared,
              modelNumber: product.ModelNumberCleared,
              alreadyLinked: true,
              erpId: product.ERPID,
              erpCode: product.ERPCode,
            });
            continue;
          }

          // Try finding in ERP (read-only)
          try {
            const erpResult = await erpPool
              .request()
              .input('PartNo', sql.NVarChar(200), product.PartNumberCleared)
              .input('ModelNo', sql.NVarChar(200), product.ModelNumberCleared)
              .input('TopN', sql.Int, 5)
              .query(`
                DECLARE @FoundCount INT;
                EXEC [tlm].[_mtrlFindProduct]
                  @PartNo = @PartNo,
                  @ModelNo = @ModelNo,
                  @TopN = @TopN,
                  @FoundCount = @FoundCount OUTPUT;
              `) as { recordsets?: Array<Array<unknown>> };

            const foundCountArr = (erpResult.recordsets?.[0] ?? []) as Array<{ FoundCount: number }>;
            const foundCount = foundCountArr[0]?.FoundCount ?? 0;
            const matches = (erpResult.recordsets?.[1] ?? []) as Array<{
              MTRL: number;
              CODE: string | null;
              NAME1: string | null;
            }>;

            matchResults.push({
              productId: product.ProductID,
              partNumber: product.PartNumberCleared,
              modelNumber: product.ModelNumberCleared,
              brandName: product.BrandName,
              alreadyLinked: false,
              foundCount,
              matches: matches.map(m => ({
                MTRL: m.MTRL,
                CODE: m.CODE,
                NAME1: m.NAME1,
              })),
            });
          } catch (err) {
            matchResults.push({
              productId: product.ProductID,
              partNumber: product.PartNumberCleared,
              modelNumber: product.ModelNumberCleared,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        steps.productMatching = {
          ok: true,
          testedCount: products.length,
          results: matchResults,
        };
      }
    } catch (err) {
      steps.productMatching = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 8: Check existing ERP orders for this offer's project (read-only)
    if (erpProjectId && erpProjectId > 0 && erpCustomerId && erpCustomerId > 0) {
      try {
        const orderResult = await erpPool
          .request()
          .input('PRJC', sql.Int, erpProjectId)
          .input('TRDR', sql.Int, erpCustomerId)
          .query<{
            FINDOC: number;
            FINCODE: string | null;
            SERIESNUM: number | null;
            TRNDATE: Date | null;
            LineCount: number;
          }>(`
            SELECT TOP (3)
              f.FINDOC,
              f.FINCODE,
              f.SERIESNUM,
              f.TRNDATE,
              (SELECT COUNT(*) FROM dbo.MTRLINES ml WHERE ml.FINDOC = f.FINDOC AND ml.SODTYPE = 51) AS LineCount
            FROM dbo.FINDOC f
            WHERE f.COMPANY = 1
              AND f.SODTYPE = 13
              AND f.PRJC = @PRJC
              AND f.TRDR = @TRDR
            ORDER BY f.FINDOC DESC
          `);

        const orders = orderResult.recordset ?? [];
        steps.existingOrders = {
          ok: true,
          orderCount: orders.length,
          orders: orders.map(o => ({
            findocId: o.FINDOC,
            finCode: o.FINCODE,
            seriesNum: o.SERIESNUM,
            trnDate: o.TRNDATE,
            lineCount: o.LineCount,
          })),
        };
      } catch (err) {
        steps.existingOrders = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      steps.existingOrders = {
        ok: true,
        skipped: true,
        reason: erpProjectId ? 'No ERP customer ID' : 'No ERP project ID',
      };
    }

    // ── Dry-run simulation ──────────────────────────────────────────────
    // Steps 9–11 simulate what the create-draft-order flow would do,
    // using only SELECT queries — no data is written.

    // Step 9: Simulate item creation for unmatched products
    try {
      // Fetch all products from the offer with category/brand info
      const allProducts = await pool
        .request()
        .input('offerId', sql.Int, offerId)
        .query<{
          ProductID: number;
          PartNumberCleared: string | null;
          ModelNumberCleared: string | null;
          Description: string | null;
          BrandName: string | null;
          BrandID: number | null;
          SubCategoryID: number | null;
          TypeID: number | null;
          ERPID: number | null;
          ERPCode: string | null;
        }>(`
          SELECT DISTINCT
            p.ID AS ProductID,
            p.PartNumberCleared,
            p.ModelNumberCleared,
            p.Description,
            b.Name AS BrandName,
            p.BrandID,
            p.SubCategoryID,
            p.TypeID,
            p.ERPID,
            p.ERPCode
          FROM dbo.OfferDetails od
          INNER JOIN dbo.Products p ON od.ProductID = p.ID
          LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
          WHERE od.OfferID = @offerId
            AND od.ProductID IS NOT NULL
        `);

      const products = allProducts.recordset ?? [];
      const alreadyLinked = products.filter(p => p.ERPID != null);
      const needsCreation = products.filter(
        p => p.ERPID == null && p.Description && p.BrandID && p.SubCategoryID && p.TypeID,
      );
      const missingFields = products.filter(
        p => p.ERPID == null && (!p.Description || !p.BrandID || !p.SubCategoryID || !p.TypeID),
      );

      // For products that would be created, resolve the code prefix (read-only)
      const itemSimulations: unknown[] = [];
      for (const product of needsCreation.slice(0, 5)) {
        try {
          // Resolve SubCategory code
          const scResult = await pool.request()
            .input('scId', sql.Int, product.SubCategoryID)
            .query<{ Code: string | null }>('SELECT Code FROM dbo.ProductSubCategories WHERE ID = @scId');
          const scCode = scResult.recordset?.[0]?.Code;
          const scCode3 = scCode && scCode.length >= 3 ? scCode.substring(0, 3).toUpperCase() : null;

          // Resolve Type first letter
          const typeResult = await pool.request()
            .input('tId', sql.Int, product.TypeID)
            .query<{ Name: string | null }>('SELECT Name FROM dbo.ProductTypes WHERE ID = @tId');
          const typeName = typeResult.recordset?.[0]?.Name;
          const typeLetter = typeName ? typeName.trim().charAt(0).toUpperCase() : null;

          // Resolve Brand code from ERP
          let brandCode: string | null = null;
          if (product.BrandName) {
            const brandResult = await erpPool.request()
              .input('brandName', sql.NVarChar(128), product.BrandName.trim())
              .query<{ CODE: string | null }>(`
                SELECT TOP (1) CODE FROM dbo.MTRMANFCTR
                WHERE UPPER(LTRIM(RTRIM(NAME))) = UPPER(LTRIM(RTRIM(@brandName)))
                ORDER BY MTRMANFCTR
              `);
            brandCode = brandResult.recordset?.[0]?.CODE ?? null;
          }

          const codePrefix = scCode3 && typeLetter && brandCode
            ? `${scCode3}${typeLetter}.${brandCode}`
            : null;

          const wsMode = process.env.SOFTONE_WS_ITEM_CREATION === 'true';

          itemSimulations.push({
            productId: product.ProductID,
            description: product.Description,
            partNumber: product.PartNumberCleared,
            modelNumber: product.ModelNumberCleared,
            brandName: product.BrandName,
            codePrefix,
            codeWouldBe: codePrefix ? `${codePrefix}.<sequence>` : 'cannot resolve prefix',
            mode: wsMode ? 'webservice (setItem)' : 'sql (_mtrlCreateProduct)',
            wsParams: wsMode ? {
              service: 'setItem',
              items: [{
                code: codePrefix ? `${codePrefix}.<sequence>` : '<unresolved>',
                name: product.Description,
                mtrunit: 1,
                vat: 1410,
                mtracn: 0,
                mtrcategory: 1,
              }],
            } : null,
            sqlParams: !wsMode ? {
              procedure: 'tlm._mtrlCreateProduct',
              CODE: codePrefix ? `${codePrefix}.<sequence>` : '<unresolved>',
              CODE1: product.ModelNumberCleared,
              CODE2: product.PartNumberCleared,
              Description: product.Description,
              BrandId: product.BrandID,
            } : null,
          });
        } catch (err) {
          itemSimulations.push({
            productId: product.ProductID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      steps.simulateItemCreation = {
        ok: true,
        totalProducts: products.length,
        alreadyLinkedCount: alreadyLinked.length,
        wouldCreateCount: needsCreation.length,
        missingFieldsCount: missingFields.length,
        missingFieldsProducts: missingFields.map(p => ({
          productId: p.ProductID,
          hasDescription: !!p.Description,
          hasBrandID: !!p.BrandID,
          hasSubCategoryID: !!p.SubCategoryID,
          hasTypeID: !!p.TypeID,
        })),
        preview: itemSimulations,
        note: 'Code sequence (<sequence>) not resolved to avoid reserving numbers. Actual code will be generated at creation time.',
      };
    } catch (err) {
      steps.simulateItemCreation = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 10: Simulate order creation (setDocs / createOrderWithLines)
    try {
      // Resolve customer CODE
      let custCode: string | null = null;
      if (erpCustomerId && erpCustomerId > 0) {
        const custResult = await erpPool.request()
          .input('TRDR', sql.Int, erpCustomerId)
          .query<{ CODE: string | null }>('SELECT TOP (1) CODE FROM dbo.TRDR WHERE TRDR = @TRDR');
        custCode = custResult.recordset?.[0]?.CODE ?? null;
      }

      // Load offer lines (same query as the real flow)
      const linesResult = await pool.request()
        .input('offerId', sql.Int, offerId)
        .query<{
          TreeOrdering: number | null;
          ProductID: number | null;
          Quantity: number | null;
          ListPrice: number | null;
          NetCost: number | null;
          ERPID: number | null;
          ERPCode: string | null;
          Description: string | null;
        }>(`
          SELECT
            od.TreeOrdering,
            od.ProductID,
            od.Quantity,
            od.ListPrice,
            od.NetCost,
            p.ERPID,
            p.ERPCode,
            p.Description
          FROM dbo.OfferDetails od
          INNER JOIN dbo.Products p ON od.ProductID = p.ID
          WHERE od.OfferID = @offerId
            AND od.ProductID IS NOT NULL
          ORDER BY od.TreeOrdering
        `);

      const allLines = linesResult.recordset ?? [];
      // Lines that already have ERPIDs (ready now)
      const readyNow = allLines.filter(l => l.ERPID != null && l.ERPCode != null && l.Quantity != null && l.Quantity > 0 && l.ListPrice != null);
      // Lines missing ERPID but with valid qty/price (would become ready after product matching/creation)
      const pendingErpLink = allLines.filter(l => (l.ERPID == null || l.ERPCode == null) && l.Quantity != null && l.Quantity > 0 && l.ListPrice != null);
      // Lines with invalid qty/price (would be skipped regardless)
      const invalidLines = allLines.filter(l => l.Quantity == null || l.Quantity <= 0 || l.ListPrice == null);

      // In the real flow, products get ERPIDs assigned BEFORE order creation,
      // so we show all lines with valid qty/price as "would be included"
      const allViableLines = allLines.filter(l => l.Quantity != null && l.Quantity > 0 && l.ListPrice != null);

      // Determine business unit
      const offerRow2 = await pool.request()
        .input('offerId', sql.Int, offerId)
        .query<{ SalesDivisionID: number | null; Description: string | null }>(`
          SELECT o.SalesDivisionID, o.Description
          FROM dbo.Offer o WHERE o.ID = @offerId
        `);
      const sdId = offerRow2.recordset?.[0]?.SalesDivisionID ?? null;
      const offerDesc = offerRow2.recordset?.[0]?.Description ?? `FastQuote Project for offer ${offerId}`;
      const bu = sdId === 3 ? 'TVS' : 'AVS';

      const wsMode = process.env.SOFTONE_WS_ORDER_CREATION === 'true';
      const totalLineValue = allViableLines.reduce((sum, l) => sum + (Number(l.Quantity) * Number(l.ListPrice)), 0);

      steps.simulateOrderCreation = {
        ok: true,
        canCreateNow: !!(erpProjectId && erpProjectId > 0 && erpCustomerId && erpCustomerId > 0),
        missingPrerequisites: {
          hasProject: !!(erpProjectId && erpProjectId > 0),
          hasCustomer: !!(erpCustomerId && erpCustomerId > 0),
          customerCode: custCode,
          customerCodeFallback: erpCustomerId ? String(erpCustomerId) : null,
          note: (!erpProjectId || erpProjectId <= 0)
            ? 'Project will be created automatically during the flow'
            : (!erpCustomerId || erpCustomerId <= 0)
              ? 'Customer must be selected/confirmed first'
              : null,
        },
        totalOfferLines: allLines.length,
        linesReadyNow: readyNow.length,
        linesPendingErpLink: pendingErpLink.length,
        linesInvalid: invalidLines.length,
        linesAfterFlow: allViableLines.length,
        totalLineValue: Math.round(totalLineValue * 100) / 100,
        flowNote: pendingErpLink.length > 0
          ? `${pendingErpLink.length} line(s) don't have ERPIDs yet but will get them during the product matching/creation step that runs BEFORE order creation. Showing all ${allViableLines.length} viable lines as the expected order.`
          : undefined,
        mode: wsMode ? 'webservice (setDocs — atomic)' : 'sql (createCustomerOrder + addOrderLine per line)',
        expectedOrder: wsMode ? {
          service: 'setDocs',
          custcode: custCode ?? (erpCustomerId ? String(erpCustomerId) : '<to be resolved>'),
          date: new Date().toISOString().split('T')[0],
          status: '10',
          comments: offerDesc,
          comments1: `FastQuote Offer #${offerId}`,
          items: allViableLines.slice(0, 10).map(l => ({
            productcode: l.ERPCode ?? '<will be assigned>',
            productDescription: l.Description,
            qty1: Number(l.Quantity),
            price: Number(l.ListPrice),
            lineval: Math.round(Number(l.Quantity!) * Number(l.ListPrice!) * 100) / 100,
            erpStatus: l.ERPID ? 'linked' : 'pending — will be matched/created first',
          })),
          itemsTruncated: allViableLines.length > 10,
        } : {
          createOrderProcedure: 'tlm._findocCreateCustomerOrder',
          addLineProcedure: 'tlm._mtrlinesAddLine',
          orderParams: {
            IntegrationKey: 'FASTQUOTE_CREATE_FINDOC',
            Prjc: erpProjectId ?? '<will be created>',
            Trdr: erpCustomerId ?? '<to be resolved>',
            BusinessUnit: bu,
            Series: 9001,
            CreatedByUser: 1011,
          },
          lines: allViableLines.slice(0, 10).map((l, i) => ({
            CCCPosNo: String(i + 1),
            MTRL: l.ERPID ?? '<will be assigned>',
            productDescription: l.Description,
            QTY: Number(l.Quantity),
            PRICE: Number(l.ListPrice),
            NUM01: l.NetCost != null ? Number(l.NetCost) : null,
            erpStatus: l.ERPID ? 'linked' : 'pending — will be matched/created first',
          })),
          linesTruncated: allViableLines.length > 10,
        },
        invalidLines: invalidLines.length > 0 ? invalidLines.slice(0, 5).map(l => ({
          productId: l.ProductID,
          description: l.Description,
          reason: l.Quantity == null || l.Quantity <= 0 ? 'invalid quantity' : 'missing price',
          qty: l.Quantity,
          listPrice: l.ListPrice,
        })) : [],
      };
    } catch (err) {
      steps.simulateOrderCreation = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 11: Simulate project creation (setProject / createProjectFromIntegration)
    try {
      const needsProject = !erpProjectId || erpProjectId <= 0;
      const offerRow3 = await pool.request()
        .input('offerId', sql.Int, offerId)
        .query<{ Description: string | null; SalesDivisionID: number | null }>(`
          SELECT o.Description, o.SalesDivisionID FROM dbo.Offer o WHERE o.ID = @offerId
        `);
      const desc = offerRow3.recordset?.[0]?.Description ?? `FastQuote Project for offer ${offerId}`;
      const sdId2 = offerRow3.recordset?.[0]?.SalesDivisionID ?? null;
      const bu2 = sdId2 === 3 ? 'TVS' : 'AVS';
      const wsProjectMode = process.env.SOFTONE_WS_PROJECT_CREATION === 'true';

      // Resolve customer CODE for project simulation
      let prjCustCode: string | null = null;
      if (erpCustomerId && erpCustomerId > 0) {
        const custResult2 = await erpPool.request()
          .input('TRDR', sql.Int, erpCustomerId)
          .query<{ CODE: string | null }>('SELECT TOP (1) CODE FROM dbo.TRDR WHERE TRDR = @TRDR');
        prjCustCode = custResult2.recordset?.[0]?.CODE ?? null;
      }

      steps.simulateProjectCreation = {
        ok: true,
        needsCreation: needsProject,
        existingProjectId: erpProjectId,
        existingProjectCode: erpProjectCode,
        mode: wsProjectMode ? 'webservice (setProject)' : 'sql (tlm.prjc_CreateFromIntegration)',
        wouldCreate: needsProject ? {
          wsParams: wsProjectMode ? {
            service: 'setProject',
            name: desc,
            shortdesc: desc,
            businessunit: bu2 === 'AVS' ? '10' : '20',
            prjstatus: '90',
            custcode: prjCustCode ?? '<unknown>',
            code: 'COV.*',
          } : null,
          sqlParams: !wsProjectMode ? {
            procedure: 'tlm.prjc_CreateFromIntegration',
            IntegrationKey: 'FASTQUOTE_CREATE_PRJC',
            CodePrefix: 'COV',
            Name: desc,
            Trdr: erpCustomerId,
            BusinessUnit: bu2,
            PrjState: 90,
            SourceSystem: 'FQ',
            CreatedByUser: 1011,
          } : null,
        } : 'not needed — project already exists',
      };
    } catch (err) {
      steps.simulateProjectCreation = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const overallOk = Object.values(steps).every(
      (step) => (step as { ok?: boolean })?.ok === true,
    );

    return NextResponse.json({
      ok: overallOk,
      steps,
      note: 'Read-only smoke test with dry-run simulation. No data is written to any database.',
    });
  } catch (err) {
    console.error('ERP smoke-test POST failed', err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'ERP smoke-test POST failed',
        steps,
      },
      { status: 500 },
    );
  }
}
