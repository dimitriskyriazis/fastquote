import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { getErpPool, getPool } from '../../../../lib/sql';
import { findProject, PROJECT_FIND_STATUS } from '../../../../lib/projectValidation';
import { createProjectFromIntegration } from '../../../../lib/projectCreation';
import { createCustomerOrder, addOrderLine } from '../../../../lib/orderCreation';

type SmokeTestPostBody = {
  trdr?: number | null; // ERP customer (TRDR) for standalone order test; optional
  mtrl?: number | null; // ERP material (MTRL) for standalone line test; optional
  offerId: number; // FastQuote offer ID to run full create-draft-offer flow against
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

    return NextResponse.json({
      ok: true,
      erpConnectionOk,
      integrationConfig: configResult.recordset ?? [],
      message:
        'ERP connectivity and IntegrationConfig checked. POST with { "offerId": <number> } (optional: "trdr", "mtrl") to run smoke test.',
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
        error:
          'Body must be JSON with "offerId" (positive number). Optional: "trdr", "mtrl" for standalone order/line tests.',
      },
      { status: 400 },
    );
  }

  const offerId = body.offerId;
  const trdr =
    body.trdr != null && typeof body.trdr === 'number' && body.trdr > 0
      ? body.trdr
      : null;
  const mtrl =
    body.mtrl != null && typeof body.mtrl === 'number' && body.mtrl > 0
      ? body.mtrl
      : null;

  const steps: Record<string, unknown> = {};

  try {
    const erpPool = await getErpPool();

    // Step 1: ERP connectivity
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
      // If even this fails, abort early
      return NextResponse.json({ ok: false, steps }, { status: 500 });
    }

    // Step 2: IntegrationConfig check
    try {
      const configResult = await erpPool.request().query<{
        IntegrationKey: string;
        IsEnabled: boolean;
      }>(`
        SELECT IntegrationKey, IsEnabled
        FROM tlm.IntegrationConfig
        WHERE IntegrationKey IN (N'FASTQUOTE_CREATE_PRJC', N'FASTQUOTE_CREATE_FINDOC');
      `);
      steps.integrationConfig = {
        ok: true,
        entries: configResult.recordset ?? [],
      };
    } catch (err) {
      steps.integrationConfig = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 3: Project validation using known test values (if present)
    // Uses example: PRJC = 89191, CODE = 'COV.0004'
    try {
      const validation = await findProject(89191, 'COV.0004');
      steps.projectValidation = {
        ok: validation.statusCode === PROJECT_FIND_STATUS.OK,
        result: validation,
      };
    } catch (err) {
      steps.projectValidation = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 4: Project creation via prjc_CreateFromIntegration
    let testProjectId: number | null = null;
    try {
      const created = await createProjectFromIntegration({
        integrationKey: 'FASTQUOTE_CREATE_PRJC',
        codePrefix: 'COV',
        name: 'FastQuote ERP Smoke Test Project',
        prjcParent: null,
        trdr: null,
        prjCategory: null,
        sourceSystem: 'FQ',
        createdByUser: 1011,
        businessUnit: 'AVS',
        prjState: 90,
      });

      testProjectId = created.prjcId;

      steps.projectCreation = {
        ok: true,
        prjcId: created.prjcId,
        prjcCode: created.prjcCode,
      };
    } catch (err) {
      steps.projectCreation = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 5: Customer order creation (only if trdr provided)
    let testFindocId: number | null = null;
    if (trdr == null) {
      steps.orderCreation = { ok: true, skipped: true, reason: 'trdr not provided' };
    } else {
      try {
        if (!testProjectId) {
          throw new Error('Project creation failed; cannot create order');
        }

        const orderInfo = await createCustomerOrder({
          prjcId: testProjectId,
          businessUnit: 'AVS',
          trdr,
          integrationKey: 'FASTQUOTE_CREATE_FINDOC',
          series: 9001,
          createdByUser: 1011,
        });

        testFindocId = orderInfo.findocId;
        steps.orderCreation = {
          ok: true,
          findocId: orderInfo.findocId,
          finCode: orderInfo.finCode,
          seriesNum: orderInfo.seriesNum,
        };
      } catch (err) {
        steps.orderCreation = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Step 6: Order line creation (only if mtrl provided and order was created)
    if (mtrl == null || testFindocId == null) {
      steps.lineCreation = {
        ok: true,
        skipped: true,
        reason: mtrl == null ? 'mtrl not provided' : 'order not created',
      };
    } else {
      try {
        await addOrderLine({
          findocId: testFindocId,
          cccPosNo: '1',
          mtrl,
          qty: 1,
          price: 1,
          num01: 0,
          createdByUser: 1011,
        });

        steps.lineCreation = {
          ok: true,
          findocId: testFindocId,
          mtrl,
        };
      } catch (err) {
        steps.lineCreation = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Step 7: Full create-draft-offer flow for the given offerId
    try {
      const pool = await getPool();

      // Snapshot offer state before
      const beforeOfferResult = await pool
        .request()
        .input('offerId', sql.Int, offerId)
        .query<{
          ID: number;
          ERPProjectID: number | null;
          ERPProjectCode: string | null;
          ERPCustomerID: number | null;
        }>(`
          SELECT 
            o.ID,
            o.ERPProjectID,
            o.ERPProjectCode,
            c.ERPID AS ERPCustomerID
          FROM dbo.Offer o
          INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
          WHERE o.ID = @offerId;
        `);

      const beforeOffer = beforeOfferResult.recordset?.[0] ?? null;

      const origin = req.nextUrl.origin;
      const offerIdStr = String(offerId);

      const draftResp = await fetch(
        `${origin}/api/offers/${encodeURIComponent(offerIdStr)}/create-draft-offer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          // Empty selections -> exercise the full auto path
          body: JSON.stringify({ selections: [] }),
        },
      );

      const draftJson = await draftResp.json().catch(() => null);

      // Snapshot offer state after
      const afterOfferResult = await pool
        .request()
        .input('offerId', sql.Int, offerId)
        .query<{
          ID: number;
          ERPProjectID: number | null;
          ERPProjectCode: string | null;
          ERPCustomerID: number | null;
        }>(`
          SELECT 
            o.ID,
            o.ERPProjectID,
            o.ERPProjectCode,
            c.ERPID AS ERPCustomerID
          FROM dbo.Offer o
          INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
          WHERE o.ID = @offerId;
        `);

      const afterOffer = afterOfferResult.recordset?.[0] ?? null;

      let projectRow: unknown = null;
      let orderRow: unknown = null;
      let orderLineCount: number | null = null;

      if (afterOffer?.ERPProjectID) {
        // Check project exists in ERP
        const projResult = await erpPool
          .request()
          .input('PRJC', sql.Int, afterOffer.ERPProjectID)
          .query<{
            PRJC: number;
            CODE: string | null;
            COMPANY: number;
          }>(`
            SELECT TOP (1)
              p.PRJC,
              p.CODE,
              p.COMPANY
            FROM dbo.PRJC p
            WHERE p.PRJC = @PRJC;
          `);

        projectRow = projResult.recordset?.[0] ?? null;

        // Check latest order for this project and customer
        if (afterOffer.ERPCustomerID) {
          const orderResult = await erpPool
            .request()
            .input('PRJC', sql.Int, afterOffer.ERPProjectID)
            .input('TRDR', sql.Int, afterOffer.ERPCustomerID)
            .query<{
              FINDOC: number;
              FINCODE: string | null;
              SERIESNUM: number | null;
              TRNDATE: Date | null;
            }>(`
              SELECT TOP (1)
                f.FINDOC,
                f.FINCODE,
                f.SERIESNUM,
                f.TRNDATE
              FROM dbo.FINDOC f
              WHERE f.COMPANY = 1
                AND f.SODTYPE = 13
                AND f.PRJC = @PRJC
                AND f.TRDR = @TRDR
              ORDER BY f.FINDOC DESC;
            `);

          const ord = orderResult.recordset?.[0] ?? null;
          orderRow = ord;

          if (ord) {
            const lineResult = await erpPool
              .request()
              .input('FINDOC', sql.Int, ord.FINDOC)
              .query<{ Cnt: number }>(`
                SELECT COUNT(*) AS Cnt
                FROM dbo.MTRLINES
                WHERE FINDOC = @FINDOC
                  AND SODTYPE = 51;
              `);

            orderLineCount = lineResult.recordset?.[0]?.Cnt ?? 0;
          }
        }
      }

      const draftApiOk =
        draftResp.ok === true && (draftJson as { ok?: boolean } | null)?.ok === true;
      const hasProject = !!afterOffer?.ERPProjectID && !!projectRow;
      const hasCustomer = !!(afterOffer?.ERPCustomerID && afterOffer.ERPCustomerID > 0);
      const hasOrderAndLines =
        !!orderRow && (orderLineCount ?? 0) > 0;
      // Success: API ok, project created/valid. If customer has ERPID we also expect order + lines.
      const createDraftOfferOk = draftApiOk &&
        hasProject &&
        (!hasCustomer || hasOrderAndLines);

      steps.createDraftOffer = {
        ok: createDraftOfferOk,
        request: {
          status: draftResp.status,
        },
        response: draftJson,
        beforeOffer,
        afterOffer,
        project: projectRow,
        order: orderRow,
        orderLineCount,
      };
    } catch (err) {
      steps.createDraftOffer = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const overallOk =
      (steps.erpConnection as { ok?: boolean } | undefined)?.ok === true &&
      (steps.integrationConfig as { ok?: boolean } | undefined)?.ok === true &&
      (steps.projectCreation as { ok?: boolean } | undefined)?.ok === true &&
      (steps.orderCreation as { ok?: boolean } | undefined)?.ok === true &&
      (steps.lineCreation as { ok?: boolean } | undefined)?.ok === true &&
      (steps.createDraftOffer as { ok?: boolean } | undefined)?.ok === true;

    return NextResponse.json({
      ok: overallOk,
      steps,
      note:
        'Performs real writes (project, optionally order+line). createDraftOffer runs for offerId. When customer has no ERPID, order/lines are not required for success.',
    });
  } catch (err) {
    console.error('ERP smoke-test POST failed', err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'ERP smoke-test POST failed',
        steps: {},
      },
      { status: 500 },
    );
  }
}

