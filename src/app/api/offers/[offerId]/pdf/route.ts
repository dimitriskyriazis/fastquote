import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';
import { requirePermission } from '../../../../../lib/authz';
import { generateOfferPdf, type OfferPdfData, type OfferProductRow, type PdfLang, type PdfLayout, type PdfOrientation } from '../../../../../lib/pdfGenerator';

type OfferHeaderRow = {
  ID: number;
  Title: string | null;
  Description: string | null;
  OfferDate: Date | string | null;
  PaymentTerms: string | null;
  DeliveryTime: string | null;
  OfferValidity: string | null;
  InstallationSchedule: string | null;
  OfferNotesIntroduction: string | null;
  OfferNotesClosing: string | null;
  OfferContact: string | null;
  CustomerName: string | null;
  CustomerBrandName: string | null;
  CustomerAddress: string | null;
  CustomerPhone: string | null;
  CustomerEmail: string | null;
  CustomerTaxID: string | null;
  CustomerTaxOffice: string | null;
  ContactFullName: string | null;
  SalesPersonNameEN: string | null;
  SalesPersonNameGR: string | null;
  SalesPersonSignTitle: string | null;
  ApprovalUserNameEN: string | null;
  ApprovalUserNameGR: string | null;
  ApprovalUserSignTitle: string | null;
  SalesDivisionName: string | null;
  SalesPersonNameCode: string | null;
};

type ProductRow = {
  TreeOrdering: string | null;
  IsCategory: boolean | number | null;
  IsComment: boolean | number | null;
  IsPrintable: boolean | number | null;
  Quantity: number | null;
  ProductDescription: string | null;
  Comment: string | null;
  NetUnitPrice: number | null;
  TotalPrice: number | null;
  TotalNet: number | null;
  BrandName: string | null;
  ModelNumber: string | null;
  PartNumber: string | null;
  WebLink: string | null;
  ListPrice: number | null;
  CustomerDiscount: number | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId } = await params;
    const numericId = Number(offerId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid offer ID' }, { status: 400 });
    }

    const langParam = req.nextUrl.searchParams.get('lang');
    const lang: PdfLang = langParam === 'en' ? 'en' : 'el';

    const layoutParam = req.nextUrl.searchParams.get('layout');
    const layout: PdfLayout = layoutParam === 'detailed' ? 'detailed' : 'standard';

    const orientationParam = req.nextUrl.searchParams.get('orientation');
    const orientation: PdfOrientation = orientationParam === 'landscape' ? 'landscape' : 'portrait';

    const pool = await getPool();

    // ── Fetch offer header ─────────────────────────────────────────────
    const headerResult = await pool
      .request()
      .input('offerId', sql.Int, numericId)
      .query<OfferHeaderRow>(`
        SELECT
          o.ID,
          o.Title,
          o.Description,
          o.OfferDate,
          o.PaymentTerms,
          o.DeliveryTime,
          o.OfferValidity,
          o.InstallationSchedule,
          o.OfferNotesIntroduction,
          o.OfferNotesClosing,
          o.OfferContact,
          c.Name AS CustomerName,
          c.BrandName AS CustomerBrandName,
          c.Address AS CustomerAddress,
          c.Phone AS CustomerPhone,
          c.Email AS CustomerEmail,
          c.TaxID AS CustomerTaxID,
          c.TaxOffice AS CustomerTaxOffice,
          LTRIM(RTRIM(CONCAT(
            ISNULL(cnt.FirstName, ''),
            CASE WHEN cnt.FirstName IS NOT NULL AND cnt.LastName IS NOT NULL THEN ' ' ELSE '' END,
            ISNULL(cnt.LastName, '')
          ))) AS ContactFullName,
          sales.FullName AS SalesPersonNameEN,
          sales.FullNameGR AS SalesPersonNameGR,
          sales.SignTitle AS SalesPersonSignTitle,
          sales.NameCode AS SalesPersonNameCode,
          approver.FullName AS ApprovalUserNameEN,
          approver.FullNameGR AS ApprovalUserNameGR,
          approver.SignTitle AS ApprovalUserSignTitle,
          sd.Name AS SalesDivisionName
        FROM dbo.[Offer] o
        LEFT JOIN dbo.Customers c ON o.CustomerID = c.ID
        LEFT JOIN dbo.Contacts cnt ON o.ContactID = cnt.ID
        LEFT JOIN dbo.AspNetUsers sales ON o.SalesPersonId = sales.Id
        LEFT JOIN dbo.AspNetUsers approver ON o.ApprovalUserId = approver.Id
        LEFT JOIN dbo.SalesDivision sd ON o.SalesDivitionID = sd.ID
        WHERE o.ID = @offerId
      `);

    const header = headerResult.recordset?.[0];
    if (!header) {
      return NextResponse.json({ ok: false, error: 'Offer not found' }, { status: 404 });
    }

    // ── Fetch offer products ──────────────────────────────────────────
    // Include everything EXCEPT non-printable comments
    const productsResult = await pool
      .request()
      .input('offerId', sql.Int, numericId)
      .query<ProductRow>(`
        SELECT
          od.TreeOrdering,
          od.IsCategory,
          od.IsComment,
          od.IsPrintable,
          od.Quantity,
          od.ProductDescription,
          od.[Comment],
          od.NetUnitPrice,
          od.TotalPrice,
          od.TotalNet,
          od.ListPrice,
          od.CustomerDiscount,
          b.Name AS BrandName,
          p.ModelNumber,
          p.PartNumber,
          p.WebLink
        FROM dbo.OfferDetails od
        LEFT JOIN dbo.Products p ON od.ProductID = p.ID
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
        WHERE od.OfferID = @offerId
          AND NOT (ISNULL(od.IsComment, 0) = 1 AND ISNULL(od.IsPrintable, 0) = 0)
        ORDER BY TRY_CONVERT(
          hierarchyid,
          CONCAT('/', REPLACE(od.TreeOrdering, '.', '/'), '/')
        ), od.TreeOrdering, od.ID
      `);

    // ── Transform to OfferPdfData ──────────────────────────────────────
    const products: OfferProductRow[] = (productsResult.recordset ?? []).map((r) => ({
      treeOrdering: r.TreeOrdering,
      isCategory: !!r.IsCategory,
      isComment: !!r.IsComment,
      quantity: r.Quantity,
      brandName: r.BrandName,
      modelNumber: r.ModelNumber,
      partNumber: r.PartNumber,
      description: r.ProductDescription,
      comment: r.Comment,
      unitPrice: r.NetUnitPrice,
      totalPrice: r.TotalPrice,
      totalNet: r.TotalNet,
      webLink: r.WebLink,
      listPrice: r.ListPrice,
      customerDiscount: r.CustomerDiscount,
    }));

    const offerDateStr =
      header.OfferDate instanceof Date
        ? header.OfferDate.toISOString()
        : typeof header.OfferDate === 'string'
          ? header.OfferDate
          : null;

    const pdfData: OfferPdfData = {
      offerId: header.ID,
      offerDate: offerDateStr,
      title: header.Title,
      description: header.Description,
      salesDivisionName: header.SalesDivisionName,
      offerContact: header.OfferContact,
      customer: {
        name: header.CustomerName,
        brandName: header.CustomerBrandName,
        address: header.CustomerAddress,
        phone: header.CustomerPhone,
        email: header.CustomerEmail,
        taxId: header.CustomerTaxID,
        taxOffice: header.CustomerTaxOffice,
      },
      contactFullName: header.ContactFullName,
      salesPerson: {
        nameGR: header.SalesPersonNameGR,
        nameEN: header.SalesPersonNameEN,
        signTitle: header.SalesPersonSignTitle,
        nameCode: header.SalesPersonNameCode,
      },
      approvalUser: {
        nameGR: header.ApprovalUserNameGR,
        nameEN: header.ApprovalUserNameEN,
        signTitle: header.ApprovalUserSignTitle,
      },
      products,
      terms: {
        offerValidity: header.OfferValidity,
        paymentTerms: header.PaymentTerms,
        deliveryTime: header.DeliveryTime,
        installationSchedule: header.InstallationSchedule,
      },
      notesIntroduction: header.OfferNotesIntroduction,
      notesClosing: header.OfferNotesClosing,
    };

    // ── Generate PDF ───────────────────────────────────────────────────
    const buffer = await generateOfferPdf(pdfData, lang, layout, orientation);

    const customerSlug = (header.CustomerName ?? 'Offer')
      .replace(/[^a-zA-Z0-9\u0370-\u03FF\u0400-\u04FF _-]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 40);
    const langSuffix = lang === 'el' ? '_GR' : '_EN';
    const filename = `Offer_${numericId}_${customerSlug}${langSuffix}.pdf`;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': String(buffer.length),
      },
    });
  } catch (err) {
    console.error('PDF generation failed:', err);
    return NextResponse.json(
      { ok: false, error: 'Failed to generate PDF' },
      { status: 500 },
    );
  }
}
