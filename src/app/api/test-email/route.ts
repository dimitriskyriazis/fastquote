import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '../../../lib/authz';
import { sendDraftOrderCompletionEmail } from '../../../lib/draftOrderCompletionEmail';
import { sendEmail } from '../../../lib/email';
import { getPool, sql } from '../../../lib/sql';

export async function GET(req: NextRequest) {
  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'summary';
  const overrideTo = url.searchParams.get('to');

  const pool = await getPool();
  const userReq = pool.request();
  userReq.input('userId', sql.NVarChar(450), auth.userId);
  const userRes = await userReq.query<{ Email: string | null; FullName: string | null }>(`
    SELECT Email, FullName FROM dbo.AspNetUsers WHERE Id = @userId
  `);
  const row = userRes.recordset?.[0];
  const recipientEmail = overrideTo?.trim() || row?.Email?.trim() || null;

  if (!recipientEmail) {
    return NextResponse.json({ ok: false, error: 'No recipient email (user has no Email column and no ?to= override)' }, { status: 400 });
  }

  if (mode === 'plain') {
    const result = await sendEmail({
      to: recipientEmail,
      subject: 'FastQuote test email',
      html: '<p>This is a <strong>test</strong> email from FastQuote.</p><p>If you received this, SMTP is configured correctly.</p>',
      text: 'This is a test email from FastQuote.\nIf you received this, SMTP is configured correctly.',
    });
    return NextResponse.json({ ok: true, mode, to: recipientEmail, ...result });
  }

  // Default: render the actual draft-order completion email with fake data
  await sendDraftOrderCompletionEmail({
    userId: auth.userId,
    offerId: 99999,
    offerDescription: 'TEST — Δοκιμαστική προσφορά',
    customerName: 'TEST CUSTOMER Α.Ε.',
    results: {
      brandsCreated: ['TestBrand1', 'TestBrand2'],
      productsCreated: [{ productId: 1, mtrl: 50001, code: 'TEST.001' }],
      productsLinked: [
        { productId: 2, mtrl: 50002, code: 'TEST.002' },
        { productId: 3, mtrl: 50003, code: 'TEST.003' },
      ],
      project: { id: 89999, code: 'COV.9999', isNew: true },
      order: { findocId: 11999, finCode: 'ΠΑΡ9999999' },
      categoriesUpdated: 5,
      subcategoriesUpdated: 4,
      typesUpdated: 3,
      orderLines: [
        { position: 1, code: 'TEST.001', brandName: 'TestBrand1', partNumber: 'PN-001', description: 'Δοκιμαστικό προϊόν Α', qty: 2, price: 855, lineval: 1710, cost: 600, costTotal: 1200, warrantyMonths: 24, comment: 'Σχόλιο γραμμής 1' },
        { position: 2, code: 'TEST.002', brandName: 'TestBrand2', partNumber: 'PN-002', description: 'Δοκιμαστικό προϊόν Β με μεγαλύτερη περιγραφή', qty: 1, price: 500, lineval: 500, cost: 350, costTotal: 350, warrantyMonths: 12, comment: null },
        { position: 3, code: 'TEST.003', brandName: null, partNumber: null, description: 'Δοκιμαστικό προϊόν Γ', qty: 5, price: 102.43, lineval: 512.15, cost: null, costTotal: null, warrantyMonths: null, comment: null },
      ],
    },
    overrideRecipientEmail: overrideTo?.trim() || null,
  });
  return NextResponse.json({ ok: true, mode: 'summary', to: recipientEmail });
}
