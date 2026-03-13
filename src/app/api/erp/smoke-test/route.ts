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
        mode: process.env.SOFTONE_WS_PROJECT_CREATION === 'true' ? 'webservice' : 'sql',
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

    const overallOk = Object.values(steps).every(
      (step) => (step as { ok?: boolean })?.ok === true,
    );

    return NextResponse.json({
      ok: overallOk,
      steps,
      note: 'Read-only smoke test. No data is written to any database.',
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
