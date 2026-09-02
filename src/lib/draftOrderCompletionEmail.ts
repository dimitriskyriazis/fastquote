import 'server-only';
import { getPool, sql } from './sql';
import { sendEmail } from './email';
import { logger } from './logger';

/**
 * How the offer-level additional discount (Offer.ExtraNetDiscount) was projected
 * onto the Soft1 pre-order: 'lines' = baked into the unit prices, 'document' =
 * sent as the document discount (setDocs `discval`).
 */
/**
 * Result of reading the created document back to confirm a document-level discount
 * actually landed. SoftOne confirmed `discval` works, so this is a regression guard
 * — but a silently ignored discount ships the order at full value, so every order
 * checks rather than trusting that the request succeeded.
 *
 * Only `landed === false` is reported to the user. The read-back looks for the
 * discount in FINDOC's DISCVAL/DISCAMNT/DISCOUNT columns, and this install keeps it
 * in its Εκπτ.1 fields instead, so `landed` is null (inconclusive) on every order —
 * reporting that would be a false alarm on every single one.
 */
export type DraftOrderDiscountVerification = {
  /** Whether the read-back ran. False = we could not check (never blocks the order). */
  checked: boolean;
  /** true = discount is on the document, false = it is not, null = cannot tell. */
  landed: boolean | null;
  /** Discount value found on the created document, when readable. */
  foundValue: number | null;
  /** FINDOC amount columns this install exposes, for diagnosis. */
  headerAmounts?: Record<string, number | null>;
};

export type DraftOrderDiscountSummary = {
  hasDiscount: boolean;
  /** Raw header value — a percentage when mode='pct', euros when mode='abs'. */
  value: number;
  mode: 'pct' | 'abs';
  /** The discount as a percentage of net value, whatever the stored mode. */
  fractionPct: number;
  allocation: 'lines' | 'document' | null;
  subtotalBeforeDiscount: number;
  discountAmount: number;
  subtotalAfterDiscount: number;
  /** Amount sent as the document discount, null when baked into unit prices. */
  documentDiscount: number | null;
  /** Present only when a document discount was sent and read back. */
  verification?: DraftOrderDiscountVerification | null;
};

/**
 * What happened to the offer's option lines (OfferDetails.IsOption). The offer's
 * own totals exclude them, so whether they were ordered is a decision worth
 * recording — the reader cannot tell from the line list alone.
 */
export type DraftOrderOptionsSummary = {
  hasOptions: boolean;
  includeOptions: boolean;
  optionLineCount: number;
  optionValue: number;
};

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
  orderLines?: Array<{
    position: number | null;
    code: string;
    brandName: string | null;
    partNumber: string | null;
    description: string | null;
    qty: number;
    price: number;
    lineval: number;
    cost: number | null;
    costTotal: number | null;
    warrantyMonths: number | null;
    comment: string | null;
  }>;
  // Present only when the offer carried an additional discount.
  discount?: DraftOrderDiscountSummary | null;
  // Present only when the offer carried option lines.
  options?: DraftOrderOptionsSummary | null;
  // Lines sent to setDocs that SoftOne did not register in the created document.
  droppedLines?: Array<{
    position: number | null;
    code: string;
    brandName: string | null;
    partNumber: string | null;
    description: string | null;
    qty: number;
    price: number;
    lineval: number;
    cost: number | null;
    costTotal: number | null;
    warrantyMonths: number | null;
    comment: string | null;
  }>;
};

const moneyFmt = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });

const formatMoney = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '-' : `${moneyFmt.format(v)} €`;
const formatQty = (v: number): string => qtyFmt.format(v);

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

const STATIC_CC_EMAILS = ['neworder@telmaco.gr', 'procurement@telmaco.gr', 'dim.kyriazis@telmaco.gr'];
const BUSINESS_UNIT_ADMIN_EMAILS: Record<'AVS' | 'TVS', string> = {
  AVS: 'avsadmin@telmaco.gr',
  TVS: 'tvsadmin@telmaco.gr',
};

async function loadOfferStakeholderEmails(offerId: number): Promise<string[]> {
  const pool = await getPool();
  const req = pool.request();
  req.input('offerId', sql.Int, offerId);
  const res = await req.query<{ SalesEmail: string | null; ApproverEmail: string | null }>(`
    SELECT sales.Email AS SalesEmail, approver.Email AS ApproverEmail
    FROM dbo.Offer o
    LEFT JOIN dbo.AspNetUsers sales ON o.SalesPersonId = sales.Id
    LEFT JOIN dbo.AspNetUsers approver ON o.ApprovalUserId = approver.Id
    WHERE o.ID = @offerId
  `);
  const row = res.recordset?.[0];
  if (!row) return [];
  const emails: string[] = [];
  if (row.SalesEmail?.trim()) emails.push(row.SalesEmail.trim());
  if (row.ApproverEmail?.trim()) emails.push(row.ApproverEmail.trim());
  return emails;
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
  customerName: string | null | undefined,
  results: DraftOrderCompletionResults,
): { subject: string; html: string; text: string } {
  const greeting = 'Γεια σας,';
  const orderCode = results.order?.finCode ?? '-';
  const projectCode = results.project?.code ?? '-';
  const customerLabel = customerName?.trim() || '-';
  const projectDescription = offerDescription?.trim() || '-';
  const projectCodeLabel = results.project?.isNew ? 'Κωδικός νέου έργου:' : 'Κωδικός έργου:';

  const pl = (count: number, singular: string, plural: string) => (count === 1 ? singular : plural);
  const eidos = (count: number) => pl(count, 'είδους', 'ειδών');

  const droppedLines = results.droppedLines ?? [];
  const droppedTotal = droppedLines.reduce((sum, l) => sum + l.lineval, 0);
  const hasDropped = droppedLines.length > 0;

  // Derived up here because the subject line reports both failure modes: a
  // document discount SoftOne ignored is as serious as a dropped line — the order
  // silently goes out at full value.
  const discount = results.discount ?? null;
  const showDiscount = !!discount?.hasDiscount;
  const discountNotLanded = discount?.allocation === 'document'
    && discount.verification?.checked === true
    && discount.verification.landed === false;
  // An inconclusive read-back is deliberately silent. This Soft1 install keeps the
  // document discount in its Εκπτ.1 fields, which are not among the FINDOC columns
  // the read-back knows about, so it comes back "unverified" on every order even
  // though the discount lands correctly (confirmed on ΠΡΟΠΑΡΑ075 / offer #8621:
  // Εκπτ.1 4,00 %, Αξία έκπτ.1 1.498,73 €, Καθαρή 35.969,59 €). Warning on every
  // order for a non-problem trains people to ignore the warnings that matter, so
  // only a discount positively read back as missing is reported.

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

  const subjectAlerts = [
    hasDropped
      ? `${droppedLines.length} ${pl(droppedLines.length, 'γραμμή ΔΕΝ καταχωρήθηκε', 'γραμμές ΔΕΝ καταχωρήθηκαν')}`
      : null,
    discountNotLanded ? 'Η ΕΚΠΤΩΣΗ ΔΕΝ ΚΑΤΑΧΩΡΗΘΗΚΕ' : null,
  ].filter((a): a is string => a != null);
  const subject = `${subjectAlerts.length > 0 ? '⚠ ' : ''}FastQuote - Δημιουργήθηκε προπαραγγελία Soft1 (${orderCode}) για προσφορά #${offerId}${subjectAlerts.length > 0 ? ` - ${subjectAlerts.join(', ')}` : ''}`;

  const actionsHtml = actions.length > 0
    ? `<ul>${actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
    : '<p><em>Καμία ενέργεια δεν καταγράφηκε.</em></p>';

  const formatCatLine = (p: { categoryName: string | null; subCategoryName: string | null; typeName: string | null }) =>
    [p.categoryName, p.subCategoryName, p.typeName].filter(Boolean).join(' › ') || '-';

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

  const orderLines = results.orderLines ?? [];
  const orderLinesTotal = orderLines.reduce((sum, l) => sum + l.lineval, 0);
  const orderLinesCostTotal = orderLines.reduce(
    (sum, l) => sum + (l.costTotal != null ? l.costTotal : 0),
    0,
  );

  // ── Offer-level additional discount ──────────────────────────────────────
  // Spelled out because the two allocations look identical in the line totals
  // otherwise: with 'lines' the prices above are already net of the discount,
  // with 'document' they are not and the discount sits on the header instead.
  // (`discount` / `showDiscount` / the verification flags are derived above, so
  // the subject line can report a discount that never landed.)
  const discountValueLabel = discount
    ? (discount.mode === 'abs' ? formatMoney(discount.value) : `${moneyFmt.format(discount.value)} %`)
    : '';
  const bakedIntoPrices = discount?.allocation === 'lines';
  const discountAllocationLabel = bakedIntoPrices
    ? 'Ενσωματώθηκε στις τιμές των ειδών. Οι τιμές του πίνακα είναι μετά την έκπτωση.'
    : 'Καταχωρήθηκε ως συνολική έκπτωση παραστατικού (discval). Οι τιμές του πίνακα είναι οι τιμές της προσφοράς.';
  // ── Option lines ─────────────────────────────────────────────────────────
  const optionsInfo = results.options ?? null;
  const showOptions = !!optionsInfo?.hasOptions;
  const optionsHtml = showOptions && optionsInfo
    ? `
      <p style="margin-top: 16px;">
        <strong>Γραμμές επιλογών (options):</strong>
        ${optionsInfo.includeOptions
          ? `συμπεριλήφθηκαν στην προπαραγγελία, ${optionsInfo.optionLineCount} ${pl(optionsInfo.optionLineCount, 'γραμμή', 'γραμμές')}, αξία ${formatMoney(optionsInfo.optionValue)}.`
          : `ΔΕΝ συμπεριλήφθηκαν στην προπαραγγελία, ${optionsInfo.optionLineCount} ${pl(optionsInfo.optionLineCount, 'γραμμή', 'γραμμές')}, αξία ${formatMoney(optionsInfo.optionValue)}.`}
      </p>
    `
    : '';

  // A document discount that SoftOne ignored leaves the order at full value —
  // the exact failure the Discount step exists to prevent, so it gets the same
  // loud treatment as silently dropped lines rather than a footnote.
  const discountAlertHtml = discountNotLanded && discount
    ? `
      <div style="border: 2px solid #dc2626; background: #fef2f2; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; color: #b91c1c; font-weight: 700;">⚠ Η συνολική έκπτωση ΔΕΝ καταχωρήθηκε στο παραστατικό</p>
        <p style="margin: 0; color: #7f1d1d;">
          Στάλθηκε έκπτωση ${formatMoney(discount.discountAmount)} στην προπαραγγελία ${escapeHtml(orderCode)},
          αλλά το παραστατικό στο Soft1 δεν την έχει${discount.verification?.foundValue != null
            ? ` (βρέθηκε ${formatMoney(discount.verification.foundValue)})`
            : ''}.
          Η προπαραγγελία είναι στην πλήρη αξία ${formatMoney(discount.subtotalBeforeDiscount)}.
          Καταχωρήστε την έκπτωση χειροκίνητα ή ξανα-εκδώστε την προπαραγγελία με την έκπτωση στις τιμές των ειδών.
        </p>
      </div>
    `
    : '';

  const discountHtml = showDiscount && discount
    ? `
      <div style="border: 1px solid #fde68a; background: #fffbeb; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-weight: 700; color: #92400e;">Επιπλέον έκπτωση προσφοράς: ${escapeHtml(discountValueLabel)}</p>
        <p style="margin: 0 0 8px; color: #78350f;">${escapeHtml(discountAllocationLabel)}</p>
        <table style="border-collapse: collapse; font-size: 0.9rem;">
          <tbody>
            <tr>
              <td style="padding: 3px 12px 3px 0; color: #78350f;">Αξία γραμμών πριν την έκπτωση:</td>
              <td style="padding: 3px 0; text-align: right; font-weight: 600;">${formatMoney(discount.subtotalBeforeDiscount)}</td>
            </tr>
            <tr>
              <td style="padding: 3px 12px 3px 0; color: #78350f;">Έκπτωση:</td>
              <td style="padding: 3px 0; text-align: right; font-weight: 600;">-${formatMoney(discount.discountAmount)}</td>
            </tr>
            <tr>
              <td style="padding: 3px 12px 3px 0; color: #78350f;">Τελική αξία παραστατικού:</td>
              <td style="padding: 3px 0; text-align: right; font-weight: 700;">${formatMoney(discount.subtotalAfterDiscount)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `
    : '';

  const orderLinesHtml = orderLines.length > 0
    ? `
      <p style="margin-top: 16px;"><strong>Γραμμές προπαραγγελίας:</strong></p>
      <table style="border-collapse: collapse; font-size: 0.9rem; width: 100%; max-width: 1100px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: left;">#</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: left;">Κωδικός</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: left;">Brand</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: left;">Part No</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: left;">Περιγραφή</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Ποσότητα</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Τιμή</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Αξία γραμμής</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Κόστος</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Συνολικό κόστος</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Εγγύηση (μήνες)</th>
            <th style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: left;">Σχόλια</th>
          </tr>
        </thead>
        <tbody>
          ${orderLines
            .map((l, idx) => {
              const pos = l.position != null ? l.position : idx + 1;
              return `<tr>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px;">${pos}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px;">${escapeHtml(l.code)}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px;">${escapeHtml(l.brandName ?? '-')}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px;">${escapeHtml(l.partNumber ?? '-')}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px;">${escapeHtml(l.description ?? '-')}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right;">${formatQty(l.qty)}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right;">${formatMoney(l.price)}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right;">${formatMoney(l.lineval)}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right;">${formatMoney(l.cost)}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right;">${formatMoney(l.costTotal)}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right;">${l.warrantyMonths != null ? l.warrantyMonths : '-'}</td>
                <td style="border: 1px solid #e5e7eb; padding: 6px 8px;">${escapeHtml(l.comment ?? '-')}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
        <tfoot>
          <tr style="background: #f9fafb; font-weight: 600;">
            <td colspan="7" style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">Σύνολα:</td>
            <td style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">${formatMoney(orderLinesTotal)}</td>
            <td style="border: 1px solid #d1d5db; padding: 6px 8px;"></td>
            <td style="border: 1px solid #d1d5db; padding: 6px 8px; text-align: right;">${formatMoney(orderLinesCostTotal)}</td>
            <td colspan="2" style="border: 1px solid #d1d5db; padding: 6px 8px;"></td>
          </tr>
        </tfoot>
      </table>
      ${optionsHtml}
      ${discountHtml}
      ${discountAlertHtml}
    `
    : `${optionsHtml}${discountHtml}${discountAlertHtml}`;

  // Lines that are not in the created document and have to be keyed in by hand.
  type MissingLine = NonNullable<DraftOrderCompletionResults['droppedLines']>[number];
  const renderMissingLinesHtml = (
    lines: MissingLine[],
    heading: string,
    explanation: string,
  ): string => lines.length === 0 ? '' : `
      <div style="border: 2px solid #dc2626; background: #fef2f2; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; color: #b91c1c; font-weight: 700;">⚠ ${escapeHtml(heading)}</p>
        <p style="margin: 0 0 10px; color: #7f1d1d;">${explanation}</p>
        <table style="border-collapse: collapse; font-size: 0.9rem; width: 100%; max-width: 900px;">
          <thead>
            <tr style="background: #fee2e2;">
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: left;">#</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: left;">Κωδικός</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: left;">Brand</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: left;">Part No</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: left;">Περιγραφή</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: right;">Ποσότητα</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: right;">Τιμή</th>
              <th style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: right;">Αξία γραμμής</th>
            </tr>
          </thead>
          <tbody>
            ${lines
              .map((l, idx) => {
                const pos = l.position != null ? l.position : idx + 1;
                return `<tr>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px;">${pos}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px;">${escapeHtml(l.code)}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px;">${escapeHtml(l.brandName ?? '-')}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px;">${escapeHtml(l.partNumber ?? '-')}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px;">${escapeHtml(l.description ?? '-')}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px; text-align: right;">${formatQty(l.qty)}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px; text-align: right;">${formatMoney(l.price)}</td>
                  <td style="border: 1px solid #fecaca; padding: 6px 8px; text-align: right;">${formatMoney(l.lineval)}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
          <tfoot>
            <tr style="background: #fee2e2; font-weight: 600;">
              <td colspan="7" style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: right;">Σύνολο αξίας που λείπει:</td>
              <td style="border: 1px solid #fca5a5; padding: 6px 8px; text-align: right;">${formatMoney(lines.reduce((s, l) => s + l.lineval, 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;

  const droppedHtml = renderMissingLinesHtml(
    droppedLines,
    `Προσοχή: ${droppedLines.length} ${pl(droppedLines.length, 'γραμμή δεν καταχωρήθηκε', 'γραμμές δεν καταχωρήθηκαν')} στο Soft1`,
    `Οι παρακάτω γραμμές στάλθηκαν αλλά δεν εμφανίζονται στην προπαραγγελία ${escapeHtml(orderCode)}. Πρέπει να καταχωρηθούν χειροκίνητα.`,
  );

  const introProblems = [
    hasDropped
      ? `${droppedLines.length} ${pl(droppedLines.length, 'γραμμή δεν καταχωρήθηκε', 'γραμμές δεν καταχωρήθηκαν')}`
      : null,
    discountNotLanded ? 'η συνολική έκπτωση δεν καταχωρήθηκε' : null,
  ].filter((p): p is string => p != null);
  const introHtml = introProblems.length > 0
    ? `<p>Η προπαραγγελία στο Soft1 για την προσφορά <strong>#${offerId}</strong>${offerDescription ? ` (${escapeHtml(offerDescription)})` : ''} δημιουργήθηκε, <strong style="color: #b91c1c;">αλλά ${escapeHtml(introProblems.join(' και '))}</strong> (δείτε παρακάτω).</p>`
    : `<p>Η προπαραγγελία στο Soft1 για την προσφορά <strong>#${offerId}</strong>${offerDescription ? ` (${escapeHtml(offerDescription)})` : ''} δημιουργήθηκε με επιτυχία.</p>`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <p>${greeting}</p>
      ${introHtml}
      <table style="border-collapse: collapse; margin: 12px 0;">
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Κωδικός προπαραγγελίας:</strong></td><td style="padding: 4px 0;">${escapeHtml(orderCode)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>${projectCodeLabel}</strong></td><td style="padding: 4px 0;">${escapeHtml(projectCode)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Πελάτης:</strong></td><td style="padding: 4px 0;">${escapeHtml(customerLabel)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Περιγραφή έργου:</strong></td><td style="padding: 4px 0;">${escapeHtml(projectDescription)}</td></tr>
      </table>
      ${droppedHtml}
      <p><strong>Ενέργειες που εκτελέστηκαν:</strong></p>
      ${actionsHtml}
      ${newProductsHtml}
      ${existingProductsHtml}
      ${orderLinesHtml}
      <p style="color: #6b7280; font-size: 0.85rem; margin-top: 24px;">Αυτό το email στάλθηκε αυτόματα από το FastQuote.</p>
    </div>
  `;

  const textLines = [
    greeting,
    '',
    introProblems.length > 0
      ? `Η προπαραγγελία στο Soft1 για την προσφορά #${offerId}${offerDescription ? ` (${offerDescription})` : ''} δημιουργήθηκε, ΑΛΛΑ ${introProblems.join(' και ')} (δείτε παρακάτω).`
      : `Η προπαραγγελία στο Soft1 για την προσφορά #${offerId}${offerDescription ? ` (${offerDescription})` : ''} δημιουργήθηκε με επιτυχία.`,
    '',
    ...(discountNotLanded && discount
      ? [
          `⚠ ΠΡΟΣΟΧΗ - Η συνολική έκπτωση ${formatMoney(discount.discountAmount)} ΔΕΝ καταχωρήθηκε στο παραστατικό${discount.verification?.foundValue != null ? ` (βρέθηκε ${formatMoney(discount.verification.foundValue)})` : ''}.`,
          `  Η προπαραγγελία είναι στην πλήρη αξία ${formatMoney(discount.subtotalBeforeDiscount)}. Καταχωρήστε την έκπτωση χειροκίνητα.`,
          '',
        ]
      : []),
    ...(hasDropped
      ? [
          `⚠ ΠΡΟΣΟΧΗ - ${droppedLines.length} ${pl(droppedLines.length, 'γραμμή δεν καταχωρήθηκε', 'γραμμές δεν καταχωρήθηκαν')} στο Soft1 (στάλθηκαν αλλά δεν εμφανίζονται στο παραστατικό). Καταχωρήστε τες χειροκίνητα:`,
          ...droppedLines.map((l, idx) => {
            const pos = l.position != null ? l.position : idx + 1;
            return `  ${pos}. ${l.code} - ${l.brandName ?? '-'} | ${l.partNumber ?? '-'} | ${l.description ?? '-'} | qty ${formatQty(l.qty)} | price ${formatMoney(l.price)} | lineval ${formatMoney(l.lineval)}`;
          }),
          `  Σύνολο αξίας που λείπει: ${formatMoney(droppedTotal)}`,
          '',
        ]
      : []),
    `Κωδικός προπαραγγελίας: ${orderCode}`,
    `${projectCodeLabel} ${projectCode}`,
    `Πελάτης: ${customerLabel}`,
    `Περιγραφή έργου: ${projectDescription}`,
    '',
    'Ενέργειες που εκτελέστηκαν:',
    ...(actions.length > 0 ? actions.map(a => `- ${a}`) : ['- (καμία)']),
    ...(newProductsCats.length > 0
      ? ['', 'Κατηγοριοποίηση νέων ειδών:', ...newProductsCats.map(p => `- ${p.label}: ${formatCatLine(p)}`)]
      : []),
    ...(existingProductsCats.length > 0
      ? ['', 'Κατηγοριοποίηση υπαρχόντων ειδών:', ...existingProductsCats.map(p => `- ${p.label}: ${formatCatLine(p)}`)]
      : []),
    ...(orderLines.length > 0
      ? [
          '',
          'Γραμμές προπαραγγελίας:',
          ...orderLines.map((l, idx) => {
            const pos = l.position != null ? l.position : idx + 1;
            const cost = l.cost != null ? formatMoney(l.cost) : '-';
            const costTotal = l.costTotal != null ? formatMoney(l.costTotal) : '-';
            const warranty = l.warrantyMonths != null ? `${l.warrantyMonths}m` : '-';
            const desc = l.description ?? '-';
            const brand = l.brandName ?? '-';
            const part = l.partNumber ?? '-';
            const comment = l.comment != null && l.comment.trim() !== '' ? l.comment : '-';
            return `${pos}. ${l.code} - ${brand} | ${part} | ${desc} | qty ${formatQty(l.qty)} | price ${formatMoney(l.price)} | lineval ${formatMoney(l.lineval)} | cost ${cost} | costTotal ${costTotal} | warranty ${warranty} | comment ${comment}`;
          }),
          `Σύνολο αξίας γραμμών: ${formatMoney(orderLinesTotal)}`,
          `Σύνολο κόστους: ${formatMoney(orderLinesCostTotal)}`,
        ]
      : []),
    ...(showOptions && optionsInfo
      ? [
          '',
          `Γραμμές επιλογών (options): ${optionsInfo.includeOptions ? 'συμπεριλήφθηκαν' : 'ΔΕΝ συμπεριλήφθηκαν'}`
            + `, ${optionsInfo.optionLineCount} ${pl(optionsInfo.optionLineCount, 'γραμμή', 'γραμμές')},`
            + ` αξία ${formatMoney(optionsInfo.optionValue)}`,
        ]
      : []),
    ...(showDiscount && discount
      ? [
          '',
          `Επιπλέον έκπτωση προσφοράς: ${discountValueLabel}`,
          discountAllocationLabel,
          `  Αξία γραμμών πριν την έκπτωση: ${formatMoney(discount.subtotalBeforeDiscount)}`,
          `  Έκπτωση: -${formatMoney(discount.discountAmount)}`,
          `  Τελική αξία παραστατικού: ${formatMoney(discount.subtotalAfterDiscount)}`,
        ]
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
  customerName?: string | null;
  results: DraftOrderCompletionResults;
  requestId?: string;
  overrideRecipientEmail?: string | null;
  businessUnit?: 'AVS' | 'TVS' | null;
}): Promise<void> {
  try {
    const recipient = await loadRecipient(params.userId);
    if (!recipient && !params.overrideRecipientEmail) {
      logger.warn('draft-order email: no recipient email found', { userId: params.userId, requestId: params.requestId });
      return;
    }

    const templateRecipient = recipient ?? { email: params.overrideRecipientEmail!, fullName: null };
    const toAddress = params.overrideRecipientEmail?.trim() || recipient!.email;

    const stakeholderEmails = await loadOfferStakeholderEmails(params.offerId);
    const ccSet = new Set<string>();
    for (const e of stakeholderEmails) ccSet.add(e.toLowerCase());
    for (const e of STATIC_CC_EMAILS) ccSet.add(e.toLowerCase());
    if (params.businessUnit) {
      ccSet.add(BUSINESS_UNIT_ADMIN_EMAILS[params.businessUnit].toLowerCase());
    }
    ccSet.delete(toAddress.toLowerCase());
    const cc = Array.from(ccSet);

    const { subject, html, text } = renderEmail(
      templateRecipient,
      params.offerId,
      params.offerDescription,
      params.customerName,
      params.results,
    );
    const result = await sendEmail({ to: toAddress, cc, subject, html, text });
    if (!result.sent) {
      logger.warn('draft-order email: not sent', { to: toAddress, cc, reason: result.skipped, requestId: params.requestId });
    } else {
      logger.info('draft-order email: sent', { to: toAddress, cc, offerId: params.offerId, requestId: params.requestId });
    }
  } catch (err) {
    logger.error('draft-order email: unexpected failure', { userId: params.userId, requestId: params.requestId }, err instanceof Error ? err : undefined);
  }
}
