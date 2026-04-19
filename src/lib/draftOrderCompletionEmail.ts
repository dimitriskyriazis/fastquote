import 'server-only';
import { getPool, sql } from './sql';
import { sendEmail } from './email';
import { logger } from './logger';

export type DraftOrderCompletionResults = {
  brandsCreated: string[];
  productsCreated: Array<{ productId: number; mtrl: number; code: string }>;
  productsLinked: Array<{ productId: number; mtrl: number; code: string }>;
  project: { id: number; code: string; isNew: boolean } | null;
  order: { findocId: number; finCode: string } | null;
  categoriesUpdated?: number;
  subcategoriesUpdated?: number;
  typesUpdated?: number;
  newProductsCategorization?: Array<{
    productId: number;
    label: string;
    categoryName: string | null;
    subCategoryName: string | null;
    typeName: string | null;
  }>;
  existingProductsCategorization?: Array<{
    productId: number;
    label: string;
    categoryName: string | null;
    subCategoryName: string | null;
    typeName: string | null;
  }>;
};

type Recipient = {
  email: string;
  fullName: string | null;
};

async function loadRecipient(userId: string): Promise<Recipient | null> {
  const pool = await getPool();
  const req = pool.request();
  req.input('userId', sql.NVarChar(450), userId);
  const res = await req.query<{ Email: string | null; FullName: string | null; FullNameGR: string | null }>(`
    SELECT Email, FullName, FullNameGR
    FROM dbo.AspNetUsers
    WHERE Id = @userId
  `);
  const row = res.recordset?.[0];
  if (!row || !row.Email) return null;
  const email = row.Email.trim();
  if (!email) return null;
  return { email, fullName: row.FullNameGR?.trim() || row.FullName?.trim() || null };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEmail(
  _recipient: Recipient,
  offerId: number,
  offerDescription: string,
  results: DraftOrderCompletionResults,
): { subject: string; html: string; text: string } {
  const greeting = 'Γεια σας,';
  const orderCode = results.order?.finCode ?? '—';
  const projectCode = results.project?.code ?? '—';
  const projectCodeLabel = results.project?.isNew ? 'Κωδικός νέου έργου:' : 'Κωδικός έργου:';

  const pl = (count: number, singular: string, plural: string) => (count === 1 ? singular : plural);
  const eidos = (count: number) => pl(count, 'είδους', 'ειδών');

  const actions: string[] = [];
  if (results.brandsCreated.length > 0) {
    const n = results.brandsCreated.length;
    actions.push(`Δημιουργία ${n} ${pl(n, 'κατασκευαστή', 'κατασκευαστών')}: ${results.brandsCreated.join(', ')}`);
  }
  if (results.productsCreated.length > 0) {
    const n = results.productsCreated.length;
    actions.push(`Δημιουργία ${n} ${pl(n, 'νέου είδους', 'νέων ειδών')} στο Soft1`);
  }
  if (results.productsLinked.length > 0) {
    const n = results.productsLinked.length;
    actions.push(`Σύνδεση ${n} ${eidos(n)} του FastQuote με το Soft1`);
  }
  if ((results.categoriesUpdated ?? 0) > 0) {
    const n = results.categoriesUpdated!;
    actions.push(`Ενημέρωση κατηγοριών ${n} ${eidos(n)} προϊόντων του Soft1`);
  }
  if ((results.subcategoriesUpdated ?? 0) > 0) {
    const n = results.subcategoriesUpdated!;
    actions.push(`Ενημέρωση υποκατηγοριών ${n} ${eidos(n)} προϊόντων του Soft1`);
  }
  if ((results.typesUpdated ?? 0) > 0) {
    const n = results.typesUpdated!;
    actions.push(`Ενημέρωση τύπων ${n} ${eidos(n)} προϊόντων του Soft1`);
  }
  if (results.project) {
    actions.push(
      results.project.isNew
        ? `Δημιουργία νέου έργου: ${results.project.code}`
        : `Σύνδεση υπάρχοντος έργου: ${results.project.code}`,
    );
  }
  if (results.order) {
    actions.push(`Δημιουργία προπαραγγελίας: ${results.order.finCode}`);
  }

  const subject = `FastQuote — Δημιουργήθηκε προπαραγγελία Soft1 (${orderCode}) για προσφορά #${offerId}`;

  const actionsHtml = actions.length > 0
    ? `<ul>${actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
    : '<p><em>Καμία ενέργεια δεν καταγράφηκε.</em></p>';

  const formatCatLine = (p: { categoryName: string | null; subCategoryName: string | null; typeName: string | null }) =>
    [p.categoryName, p.subCategoryName, p.typeName].filter(Boolean).join(' › ') || '—';

  const newProductsCats = (results.newProductsCategorization ?? []).filter(
    p => p.categoryName || p.subCategoryName || p.typeName,
  );
  const existingProductsCats = (results.existingProductsCategorization ?? []).filter(
    p => p.categoryName || p.subCategoryName || p.typeName,
  );

  const renderCatList = (title: string, items: typeof newProductsCats) =>
    items.length > 0
      ? `
        <p><strong>${title}</strong></p>
        <ul>${items
          .map(p => `<li><strong>${escapeHtml(p.label)}</strong>: ${escapeHtml(formatCatLine(p))}</li>`)
          .join('')}</ul>
      `
      : '';

  const newProductsHtml = renderCatList('Κατηγοριοποίηση νέων ειδών:', newProductsCats);
  const existingProductsHtml = renderCatList('Κατηγοριοποίηση υπαρχόντων ειδών:', existingProductsCats);

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <p>${greeting}</p>
      <p>Η προπαραγγελία στο Soft1 για την προσφορά <strong>#${offerId}</strong>${offerDescription ? ` (${escapeHtml(offerDescription)})` : ''} δημιουργήθηκε με επιτυχία.</p>
      <table style="border-collapse: collapse; margin: 12px 0;">
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Κωδικός προπαραγγελίας:</strong></td><td style="padding: 4px 0;">${escapeHtml(orderCode)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>${projectCodeLabel}</strong></td><td style="padding: 4px 0;">${escapeHtml(projectCode)}</td></tr>
      </table>
      <p><strong>Ενέργειες που εκτελέστηκαν:</strong></p>
      ${actionsHtml}
      ${newProductsHtml}
      ${existingProductsHtml}
      <p style="color: #6b7280; font-size: 0.85rem; margin-top: 24px;">Αυτό το email στάλθηκε αυτόματα από το FastQuote.</p>
    </div>
  `;

  const textLines = [
    greeting,
    '',
    `Η προπαραγγελία στο Soft1 για την προσφορά #${offerId}${offerDescription ? ` (${offerDescription})` : ''} δημιουργήθηκε με επιτυχία.`,
    '',
    `Κωδικός προπαραγγελίας: ${orderCode}`,
    `${projectCodeLabel} ${projectCode}`,
    '',
    'Ενέργειες που εκτελέστηκαν:',
    ...(actions.length > 0 ? actions.map(a => `- ${a}`) : ['- (καμία)']),
    ...(newProductsCats.length > 0
      ? ['', 'Κατηγοριοποίηση νέων ειδών:', ...newProductsCats.map(p => `- ${p.label}: ${formatCatLine(p)}`)]
      : []),
    ...(existingProductsCats.length > 0
      ? ['', 'Κατηγοριοποίηση υπαρχόντων ειδών:', ...existingProductsCats.map(p => `- ${p.label}: ${formatCatLine(p)}`)]
      : []),
    '',
    'Αυτό το email στάλθηκε αυτόματα από το FastQuote.',
  ];

  return { subject, html, text: textLines.join('\n') };
}

export async function sendDraftOrderCompletionEmail(params: {
  userId: string;
  offerId: number;
  offerDescription: string;
  results: DraftOrderCompletionResults;
  requestId?: string;
  overrideRecipientEmail?: string | null;
}): Promise<void> {
  try {
    const recipient = await loadRecipient(params.userId);
    if (!recipient && !params.overrideRecipientEmail) {
      logger.warn('draft-order email: no recipient email found', { userId: params.userId, requestId: params.requestId });
      return;
    }

    const templateRecipient = recipient ?? { email: params.overrideRecipientEmail!, fullName: null };
    const toAddress = params.overrideRecipientEmail?.trim() || recipient!.email;

    const { subject, html, text } = renderEmail(templateRecipient, params.offerId, params.offerDescription, params.results);
    const result = await sendEmail({ to: toAddress, subject, html, text });
    if (!result.sent) {
      logger.warn('draft-order email: not sent', { to: toAddress, reason: result.skipped, requestId: params.requestId });
    } else {
      logger.info('draft-order email: sent', { to: toAddress, offerId: params.offerId, requestId: params.requestId });
    }
  } catch (err) {
    logger.error('draft-order email: unexpected failure', { userId: params.userId, requestId: params.requestId }, err instanceof Error ? err : undefined);
  }
}
