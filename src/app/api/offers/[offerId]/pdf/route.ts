import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';
import { requirePermission } from '../../../../../lib/authz';
import type { OfferPdfData, OfferProductRow, PdfLang, PdfOrientation, PdfPrintSettings, PdfTotalsDisplaySettings } from '../../../../../lib/pdfGenerator';
import { parsePdfProductColumnsParam } from '../../../../../lib/pdfColumns';
import { normalizeOfferLanguage, offerLanguageToPdfLang } from '../../../../../lib/offerLanguage';
import { computeDisplayOrderingMap } from '../../../../../lib/offerItemNumbering';

// SQL Server DECIMAL columns may surface as a number or a string depending on the
// driver; accept both and fall back to null.
const toFiniteNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type OfferHeaderRow = {
  ID: number;
  Title: string | null;
  Description: string | null;
  OfferDescription: string | null;
  OfferDate: Date | string | null;
  PaymentTerms: string | null;
  DeliveryTime: string | null;
  OfferValidity: string | null;
  InstallationSchedule: string | null;
  OfferNotesIntroduction: string | null;
  OfferNotesClosing: string | null;
  DiscountNote: string | null;
  OfferContact: string | null;
  FinalPriceLabel: string | null;
  OfferLanguage: string | null;
  ExtraListDiscount: number | null;
  ExtraListDiscountMode: string | null;
  ExtraNetDiscount: number | null;
  ExtraNetDiscountMode: string | null;
  CurrencyName: string | null;
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
  SalesPersonEmail: string | null;
};

type ProductRow = {
  OfferDetailID: number;
  TreeOrdering: string | null;
  IsCategory: boolean | number | null;
  IsComment: boolean | number | null;
  IsPrintable: boolean | number | null;
  IsService: boolean | number | null;
  IsOption: boolean | number | null;
  Quantity: number | null;
  ProductDescription: string | null;
  Warranty: string | number | null;
  Origin: string | null;
  Comment: string | null;
  Delivery: string | null;
  NetUnitPrice: number | null;
  TotalPrice: number | null;
  TotalNet: number | null;
  BrandName: string | null;
  ModelNumber: string | null;
  PartNumber: string | null;
  WebLink: string | null;
  ListPrice: number | null;
  CustomerDiscount: number | null;
  RequestedBrand: string | null;
  RequestedPartNo: string | null;
  RequestedModelNo: string | null;
  RequestedDescription: string | null;
  RequestedQuantity: number | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/pdf');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId } = await params;
    const numericId = Number(offerId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid offer ID' }, { status: 400 });
    }

    const langParam = req.nextUrl.searchParams.get('lang');

    const columnsParam = req.nextUrl.searchParams.get('columns');
    const productColumns = parsePdfProductColumnsParam(columnsParam);

    const orientationParam = req.nextUrl.searchParams.get('orientation')?.toLowerCase();
    const orientation: PdfOrientation = orientationParam === 'landscape' ? 'landscape' : 'portrait';

    const printProducts = req.nextUrl.searchParams.get('printProducts') === '1' ? 1 : 0;
    const printCategories = req.nextUrl.searchParams.get('printCategories') === '1' ? 1 : 0;
    const printSubCategories = req.nextUrl.searchParams.get('printSubCategories') === '1' ? 1 : 0;
    const printSubSubCategories = req.nextUrl.searchParams.get('printSubSubCategories') === '1' ? 1 : 0;
    const totalsDisplaySettings: PdfTotalsDisplaySettings = {
      showGrandTotal: req.nextUrl.searchParams.get('showGrandTotal') !== '0',
      showDiscount: req.nextUrl.searchParams.get('showDiscount') !== '0',
      showFinalPrice: req.nextUrl.searchParams.get('showFinalPrice') !== '0',
    };
    const smallOffer = req.nextUrl.searchParams.get('smallOffer') === '1';

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
          o.OfferDescription,
          o.OfferDate,
          o.PaymentTerms,
          o.DeliveryTime,
          o.OfferValidity,
          o.InstallationSchedule,
          o.OfferNotesIntroduction,
          o.OfferNotesClosing,
          o.DiscountNote,
          o.OfferContact,
          o.FinalPriceLabel,
          o.OfferLanguage,
          o.ExtraListDiscount,
          o.ExtraListDiscountMode,
          o.ExtraNetDiscount,
          o.ExtraNetDiscountMode,
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
          sales.Email AS SalesPersonEmail,
          approver.FullName AS ApprovalUserNameEN,
          approver.FullNameGR AS ApprovalUserNameGR,
          approver.SignTitle AS ApprovalUserSignTitle,
          sd.Name AS SalesDivisionName,
          cur.Name AS CurrencyName
        FROM dbo.[Offer] o
        LEFT JOIN dbo.Customers c ON o.CustomerID = c.ID
        LEFT JOIN dbo.Contacts cnt ON o.ContactID = cnt.ID
        LEFT JOIN dbo.AspNetUsers sales ON o.SalesPersonId = sales.Id
        LEFT JOIN dbo.AspNetUsers approver ON o.ApprovalUserId = approver.Id
        LEFT JOIN dbo.SalesDivision sd ON o.SalesDivisionID = sd.ID
        LEFT JOIN dbo.Currencies cur ON o.CurrencyID = cur.ID
        WHERE o.ID = @offerId
      `);

    const header = headerResult.recordset?.[0];
    if (!header) {
      return NextResponse.json({ ok: false, error: 'Offer not found' }, { status: 404 });
    }

    const offerLanguage = normalizeOfferLanguage(header.OfferLanguage);
    const lang: PdfLang = langParam === 'en' || langParam === 'el'
      ? (langParam as PdfLang)
      : offerLanguageToPdfLang(offerLanguage);

    const equipmentList = req.nextUrl.searchParams.get('equipmentList') === '1';
    const requiredTerms: { key: keyof OfferHeaderRow; label: string }[] = [
      { key: 'OfferValidity', label: 'Offer Validity' },
      { key: 'DeliveryTime', label: 'Delivery Time' },
    ];
    if (!equipmentList) {
      requiredTerms.splice(1, 0, { key: 'PaymentTerms', label: 'Payment Terms' });
    }
    const missingTerms = requiredTerms.filter((t) => !(header[t.key] as string | null)?.trim());
    if (missingTerms.length > 0) {
      const names = missingTerms.map((t) => t.label).join(', ');
      const message = `Cannot generate PDF. Please fill in the following fields on the offer's Basic Data page: ${names}.`;
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    // ── Fetch offer products ──────────────────────────────────────────
    // Include everything EXCEPT non-printable comments
    const productsResult = await pool
      .request()
      .input('offerId', sql.Int, numericId)
      .query<ProductRow>(`
        SELECT
          od.ID AS OfferDetailID,
          od.TreeOrdering,
          od.IsCategory,
          od.IsComment,
          od.IsPrintable,
          od.IsService,
          od.IsOption,
          od.Quantity,
          od.ProductDescription,
          od.Warranty,
          p.Origin,
          od.[Comment],
          od.Delivery,
          od.NetUnitPrice,
          od.TotalPrice,
          od.TotalNet,
          od.ListPrice,
          od.CustomerDiscount,
          od.RequestedBrand,
          od.RequestedPartNo,
          od.RequestedModelNo,
          od.RequestedDescription,
          od.RequestedQuantity,
          b.Name AS BrandName,
          od.ModelNumber,
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

    // ── Compute and save print settings ────────────────────────────────
    const noOfLevels = (productsResult.recordset ?? []).reduce((max, r) => {
      if (!r.TreeOrdering) return max;
      const depth = r.TreeOrdering.split('.').length;
      return depth > max ? depth : max;
    }, 0);

    await pool
      .request()
      .input('offerId2', sql.Int, numericId)
      .input('noOfLevels', sql.Int, noOfLevels)
      .input('printProducts', sql.Bit, printProducts)
      .input('printCategories', sql.Bit, printCategories)
      .input('printSubCategories', sql.Bit, printSubCategories)
      .input('printSubSubCategories', sql.Bit, printSubSubCategories)
      .query(`
        UPDATE dbo.Offer
        SET NoOfLevels = @noOfLevels,
            PrintProducts = @printProducts,
            PrintCategories = @printCategories,
            PrintSubCategories = @printSubCategories,
            PrintSubSubCategories = @printSubSubCategories
        WHERE ID = @offerId2
      `);

    // ── Compute the printable-only "Item No" display ───────────────────
    // Uses the same logic as the products grid (auto mode), so the printed
    // "No" column matches the grid exactly: non-printable rows are anchored
    // annotations and never consume a number, while the raw TreeOrdering keeps
    // its structural slots.
    const displayNoById = computeDisplayOrderingMap(
      (productsResult.recordset ?? []) as unknown as Record<string, unknown>[],
      { manualMode: false },
    );

    // ── Transform to OfferPdfData ──────────────────────────────────────
    const products: OfferProductRow[] = (productsResult.recordset ?? []).map((r) => ({
      treeOrdering: r.TreeOrdering,
      displayNo: displayNoById.get(String(r.OfferDetailID)) ?? r.TreeOrdering,
      isCategory: !!r.IsCategory,
      isComment: !!r.IsComment,
      isOption: !!r.IsOption,
      // Non-printable services are kept for totals but hidden from the table.
      // A service is non-printable only when IsPrintable is explicitly falsy
      // (matching resolveOfferProductRowType); a null IsPrintable is printable.
      hidden: !!r.IsService && (r.IsPrintable === 0 || r.IsPrintable === false),
      quantity: r.Quantity,
      brandName: r.BrandName,
      modelNumber: r.ModelNumber,
      partNumber: r.PartNumber,
      description: r.ProductDescription,
      warranty: r.Warranty,
      origin: r.Origin,
      comment: r.Comment,
      delivery: r.Delivery,
      unitPrice: r.NetUnitPrice,
      totalPrice: r.TotalPrice,
      totalNet: r.TotalNet,
      webLink: r.WebLink,
      listPrice: r.ListPrice,
      customerDiscount: r.CustomerDiscount,
      requestedBrand: r.RequestedBrand,
      requestedPartNo: r.RequestedPartNo,
      requestedModelNo: r.RequestedModelNo,
      requestedDescription: r.RequestedDescription,
      requestedQuantity: r.RequestedQuantity,
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
      offerDescription: header.OfferDescription,
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
        email: header.SalesPersonEmail,
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
      discountNote: header.DiscountNote,
      finalPriceLabel: header.FinalPriceLabel?.trim() || null,
      currencySymbol: header.CurrencyName?.trim() || null,
      extraListDiscount: toFiniteNumberOrNull(header.ExtraListDiscount),
      extraListDiscountMode: header.ExtraListDiscountMode === 'abs' ? 'abs' : 'pct',
      extraNetDiscount: toFiniteNumberOrNull(header.ExtraNetDiscount),
      extraNetDiscountMode: header.ExtraNetDiscountMode === 'abs' ? 'abs' : 'pct',
    };

    // ── Generate PDF ───────────────────────────────────────────────────
    const pdfPrintSettings: PdfPrintSettings = {
      noOfLevels,
      printProducts: !!printProducts,
      printCategories: !!printCategories,
      printSubCategories: !!printSubCategories,
      printSubSubCategories: !!printSubSubCategories,
    };

    const { generateOfferPdf } = await import('../../../../../lib/pdfGenerator');
    const buffer = await generateOfferPdf(
      pdfData,
      lang,
      orientation,
      productColumns,
      pdfPrintSettings,
      totalsDisplaySettings,
      smallOffer,
      equipmentList,
    );

    const customerSlug = (header.CustomerName ?? 'Offer')
      .replace(/[^a-zA-Z0-9\u0370-\u03FF\u0400-\u04FF _-]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 40);
    const langSuffix = lang === 'el' ? '_GR' : '_EN';
    const prefix = equipmentList ? 'EquipmentList' : 'Offer';
    const filename = `${prefix}_${numericId}_${customerSlug}${langSuffix}.pdf`;

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
