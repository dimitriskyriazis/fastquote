import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from 'mssql';
import { buildAuditContext, resolveAuditUserId } from '../../../../../lib/auditTrail';
import { getPool } from '../../../../../lib/sql';
import { getRequestId } from '../../../../../lib/requestId';
import { logAddAuditDetails } from '../../../../../lib/mutationAudit';
import { requirePermission } from '../../../../../lib/authz';

const normalizeOfferIdParam = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string') return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    if (!decoded) return null;
    const parsed = Number.parseInt(decoded, 10);
    if (Number.isInteger(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
};

const normalizeNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
};

type ExistingOfferRecord = {
  CustomerID: number | null;
  StatusID: number | null;
  StatusName: string | null;
  PricingPolicyID: number | null;
  MarketID: number | null;
  SalesDivisionID: number | null;
  SalesPersonId: string | null;
  SalesManagerID: string | null;
  Title: string | null;
  Description: string | null;
  PaymentTerms: string | null;
  InstallationSchedule: string | null;
  OfferNotesClosing: string | null;
  OfferValidity: string | null;
  DeliveryTime: string | null;
  OfferNotesIntroduction: string | null;
  Comments: string | null;
  ContactID: number | null;
  OfferContact: string | null;
  ERPProjectCode: string | null;
  ERPFWCProjectID: number | null;
  PrintLevelGroupingID: number | null;
  CustomerRef: string | null;
  DraftRequestDate: Date | null;
  DraftOfferDate: Date | null;
  RequestDate: Date | null;
  OfferDeadlineDate: Date | null;
  OrderSignedDate: Date | null;
  DeliveryDueDate: Date | null;
  PossibleOrderDate: Date | null;
  OfferDate: Date | null;
  ApprovalUserId: string | null;
  ProtocolNo: number | null;
  OfferLanguage: string | null;
  DiscountLabel: string | null;
  AdditionalDiscountLabel: string | null;
  FinalPriceLabel: string | null;
  ExtraNetDiscount: number | null;
  ExtraNetDiscountMode: string | null;
  CurrencyID: number | null;
  CurrencyModifier: number | null;
  ParentOfferID: number | null;
  OfferVersion: number | null;
  Enabled: number | boolean | null;
  IsStandardPackage: number | boolean | null;
  IsTelvin: number | boolean | null;
  CreatedBy: string | null;
  ModifiedBy: string | null;
};

type DuplicateOfferRequestBody = {
  mode?: 'version' | 'copy' | null;
};

const duplicateOfferDetailsSql = `
DECLARE @CopiedRows TABLE (OldId INT, NewId INT, Seq INT);
DECLARE @InsertedRows TABLE (NewId INT, Seq INT IDENTITY(1,1));
DECLARE @SourceDetails TABLE (
  Seq INT,
  OldId INT,
  ParentOfferDetailID INT NULL,
  TreeOrdering NVARCHAR(255) NULL,
  Ordering INT NULL,
  IsPrintable BIT NULL,
  IsComment BIT NULL,
  IsCategory BIT NULL,
  IsOption BIT NULL,
  IsService BIT NULL,
  ServiceType NVARCHAR(20) NULL,
  Enabled BIT NULL,
  ProductDescription NVARCHAR(2000) NULL,
  BrandID INT NULL,
  PartNumber NVARCHAR(400) NULL,
  ModelNumber NVARCHAR(400) NULL,
  ProductID INT NULL,
  Quantity DECIMAL(18,4) NULL,
  CustomerDiscount DECIMAL(18,4) NULL,
  AdditionalCustomerDiscount DECIMAL(18,4) NULL,
  NetUnitPrice DECIMAL(18,4) NULL,
  TotalPrice DECIMAL(18,4) NULL,
  TotalNet DECIMAL(18,4) NULL,
  TelmacoWarranty INT NULL,
  Warranty INT NULL,
  Installation DECIMAL(18,4) NULL,
  ElInstalation DECIMAL(18,4) NULL,
  Commissioning DECIMAL(18,4) NULL,
  Delivery NVARCHAR(255) NULL,
  Comment NVARCHAR(MAX) NULL,
  ListPrice DECIMAL(18,4) NULL,
  TelmacoDiscount DECIMAL(18,4) NULL,
  NetCostOtherCurrency DECIMAL(18,4) NULL,
  OtherCurrencyID INT NULL,
  CurrencyCostModifier DECIMAL(18,4) NULL,
  NetCost DECIMAL(18,4) NULL,
  Margin DECIMAL(18,4) NULL,
  GrossProfit DECIMAL(18,4) NULL,
  TotalCost DECIMAL(18,4) NULL,
  PriceListID INT NULL,
  PriceListItemID INT NULL,
  RequestedItemNo NVARCHAR(256) NULL,
  RequestedBrand NVARCHAR(256) NULL,
  RequestedModelNo NVARCHAR(256) NULL,
  RequestedPartNo NVARCHAR(256) NULL,
  RequestedWebLink NVARCHAR(MAX) NULL,
  RequestedDescription NVARCHAR(2000) NULL,
  RequestedDescription2 NVARCHAR(2000) NULL,
  RequestedDescription3 NVARCHAR(2000) NULL,
  RequestedQuantity DECIMAL(18,4) NULL
);

INSERT INTO @SourceDetails (Seq, OldId, ParentOfferDetailID, TreeOrdering, Ordering, IsPrintable, IsComment, IsCategory, IsOption, IsService, ServiceType, Enabled, ProductDescription, BrandID, PartNumber, ModelNumber, ProductID, Quantity, CustomerDiscount, AdditionalCustomerDiscount, NetUnitPrice, TotalPrice, TotalNet, TelmacoWarranty, Warranty, Installation, ElInstalation, Commissioning, Delivery, Comment, ListPrice, TelmacoDiscount, NetCostOtherCurrency, OtherCurrencyID, CurrencyCostModifier, NetCost, Margin, GrossProfit, TotalCost, PriceListID, PriceListItemID, RequestedItemNo, RequestedBrand, RequestedModelNo, RequestedPartNo, RequestedWebLink, RequestedDescription, RequestedDescription2, RequestedDescription3, RequestedQuantity)
SELECT
  ROW_NUMBER() OVER (ORDER BY od.ID),
  od.ID,
  od.ParentOfferDetailID,
  od.TreeOrdering,
  od.Ordering,
  od.IsPrintable,
  od.IsComment,
  od.IsCategory,
  od.IsOption,
  od.IsService,
  od.ServiceType,
  od.Enabled,
  od.ProductDescription,
  od.BrandID,
  od.PartNumber,
  od.ModelNumber,
  od.ProductID,
  od.Quantity,
  od.CustomerDiscount,
  od.AdditionalCustomerDiscount,
  od.NetUnitPrice,
  od.TotalPrice,
  od.TotalNet,
  od.TelmacoWarranty,
  od.Warranty,
  od.Installation,
  od.ElInstalation,
  od.Commissioning,
  od.Delivery,
  od.Comment,
  od.ListPrice,
  od.TelmacoDiscount,
  od.NetCostOtherCurrency,
  od.OtherCurrencyID,
  od.CurrencyCostModifier,
  od.NetCost,
  od.Margin,
  od.GrossProfit,
  od.TotalCost,
  od.PriceListID,
  od.PriceListItemID,
  od.RequestedItemNo,
  od.RequestedBrand,
  od.RequestedModelNo,
  od.RequestedPartNo,
  od.RequestedWebLink,
  od.RequestedDescription,
  od.RequestedDescription2,
  od.RequestedDescription3,
  od.RequestedQuantity
FROM dbo.OfferDetails AS od
WHERE od.OfferID = @sourceOfferId
ORDER BY od.ID;

INSERT INTO dbo.OfferDetails (
  OfferID,
  ParentOfferDetailID,
  TreeOrdering,
  Ordering,
  IsPrintable,
  IsComment,
  IsCategory,
  IsOption,
  IsService,
  ServiceType,
  Enabled,
  ProductDescription,
  ProductID,
  Quantity,
  CustomerDiscount,
  AdditionalCustomerDiscount,
  NetUnitPrice,
  TotalPrice,
  TotalNet,
  TelmacoWarranty,
  Warranty,
  Installation,
  ElInstalation,
  Commissioning,
  Delivery,
  Comment,
  ListPrice,
  TelmacoDiscount,
  NetCostOtherCurrency,
  OtherCurrencyID,
  CurrencyCostModifier,
  NetCost,
  Margin,
  GrossProfit,
  TotalCost,
  PriceListID,
  PriceListItemID,
  BrandID,
  PartNumber,
  ModelNumber,
  RequestedItemNo,
  RequestedBrand,
  RequestedModelNo,
  RequestedPartNo,
  RequestedWebLink,
  RequestedDescription,
  RequestedDescription2,
  RequestedDescription3,
  RequestedQuantity,
  CreatedOn,
  CreatedBy,
  ModifiedOn,
  ModifiedBy
)
OUTPUT inserted.ID INTO @InsertedRows (NewId)
SELECT
  @targetOfferId,
  src.ParentOfferDetailID,
  src.TreeOrdering,
  src.Ordering,
  src.IsPrintable,
  src.IsComment,
  src.IsCategory,
  src.IsOption,
  src.IsService,
  src.ServiceType,
  src.Enabled,
  src.ProductDescription,
  src.ProductID,
  src.Quantity,
  src.CustomerDiscount,
  src.AdditionalCustomerDiscount,
  src.NetUnitPrice,
  src.TotalPrice,
  src.TotalNet,
  src.TelmacoWarranty,
  src.Warranty,
  src.Installation,
  src.ElInstalation,
  src.Commissioning,
  src.Delivery,
  src.Comment,
  src.ListPrice,
  src.TelmacoDiscount,
  src.NetCostOtherCurrency,
  src.OtherCurrencyID,
  src.CurrencyCostModifier,
  src.NetCost,
  src.Margin,
  src.GrossProfit,
  src.TotalCost,
  src.PriceListID,
  src.PriceListItemID,
  src.BrandID,
  src.PartNumber,
  src.ModelNumber,
  src.RequestedItemNo,
  src.RequestedBrand,
  src.RequestedModelNo,
  src.RequestedPartNo,
  src.RequestedWebLink,
  src.RequestedDescription,
  src.RequestedDescription2,
  src.RequestedDescription3,
  src.RequestedQuantity,
  SYSUTCDATETIME(),
  @auditUser,
  SYSUTCDATETIME(),
  @auditUser
FROM @SourceDetails AS src
ORDER BY src.Seq;

INSERT INTO @CopiedRows (OldId, NewId, Seq)
SELECT
  src.OldId,
  ins.NewId,
  src.Seq
FROM @SourceDetails AS src
INNER JOIN @InsertedRows AS ins ON src.Seq = ins.Seq;

UPDATE od
SET ParentOfferDetailID = parentMapping.NewId
FROM dbo.OfferDetails AS od
INNER JOIN @CopiedRows mapping ON od.ID = mapping.NewId
LEFT JOIN @CopiedRows parentMapping ON parentMapping.OldId =
  (SELECT ParentOfferDetailID FROM @SourceDetails WHERE OldId = mapping.OldId)
WHERE od.OfferID = @targetOfferId;
`;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/duplicate');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "createOffers");
    if (!auth.ok) return auth.response;

    const { offerId: offerIdParam } = await params;
    const normalizedId = normalizeOfferIdParam(offerIdParam);
    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid offer id' },
        { status: 400 },
      );
    }

    const pool = await getPool();
    let body: DuplicateOfferRequestBody | null = null;
    try {
      body = (await req.json()) as DuplicateOfferRequestBody;
    } catch {
      body = null;
    }
    const duplicateMode = body?.mode === 'copy' ? 'copy' : 'version';

    const summaryRequest = pool.request();
    summaryRequest.input('offerId', sql.Int, normalizedId);
    const existingResult = await summaryRequest.query<ExistingOfferRecord>(`
      SELECT
        CustomerID,
        StatusID,
        (SELECT Name FROM dbo.OfferStatus WHERE ID = dbo.Offer.StatusID) AS StatusName,
        PricingPolicyID,
        MarketID,
        SalesDivisionID,
        SalesPersonId,
        SalesManagerID,
        Title,
        Description,
        PaymentTerms,
        InstallationSchedule,
        OfferNotesClosing,
        OfferValidity,
        DeliveryTime,
        OfferNotesIntroduction,
        Comments,
        ContactID,
        OfferContact,
        ERPProjectCode,
        ERPFWCProjectID,
        PrintLevelGroupingID,
        CustomerRef,
        DraftRequestDate,
        DraftOfferDate,
        RequestDate,
        OfferDeadlineDate,
        OrderSignedDate,
        DeliveryDueDate,
        PossibleOrderDate,
        OfferDate,
        ApprovalUserId,
        ParentOfferID,
        ProtocolNo,
        OfferLanguage,
        DiscountLabel,
        AdditionalDiscountLabel,
        FinalPriceLabel,
        ExtraNetDiscount,
        ExtraNetDiscountMode,
        CurrencyID,
        CurrencyModifier,
        OfferVersion,
        Enabled,
        IsStandardPackage,
        IsTelvin,
        CreatedBy,
        ModifiedBy
      FROM dbo.Offer
      WHERE ID = @offerId
    `);

    const existingOffer = existingResult.recordset?.[0] ?? null;
    if (!existingOffer) {
      return NextResponse.json(
        { ok: false, error: 'Offer not found' },
        { status: 404 },
      );
    }

    const audit = buildAuditContext(req);
    const auditUserId =
      normalizeNullableString(audit.userId) ??
      normalizeNullableString(existingOffer.CreatedBy) ??
      normalizeNullableString(existingOffer.ModifiedBy) ??
      null;

    let targetParentOfferId: number | null = null;
    let targetVersion: number;

    if (duplicateMode === 'copy') {
      targetParentOfferId = null;
      targetVersion = 1;
    } else {
      // Resolve the root offer ID by walking up the parent chain
      const rootRequest = pool.request();
      rootRequest.input('offerId', sql.Int, normalizedId);
      const rootResult = await rootRequest.query<{ RootOfferID: number }>(`
        WITH Chain AS (
          SELECT ID, ParentOfferID FROM dbo.Offer WHERE ID = @offerId
          UNION ALL
          SELECT o.ID, o.ParentOfferID FROM dbo.Offer o
          INNER JOIN Chain c ON c.ParentOfferID = o.ID
        )
        SELECT TOP 1 ID AS RootOfferID FROM Chain WHERE ParentOfferID IS NULL
      `);
      const rootOfferId = rootResult.recordset?.[0]?.RootOfferID ?? normalizedId;
      targetParentOfferId = rootOfferId;

      // Get the max version across all offers in this version group
      const maxVerRequest = pool.request();
      maxVerRequest.input('rootOfferId', sql.Int, rootOfferId);
      const maxVerResult = await maxVerRequest.query<{ MaxVersion: number | null }>(`
        SELECT MAX(OfferVersion) AS MaxVersion
        FROM dbo.Offer
        WHERE ID = @rootOfferId OR ParentOfferID = @rootOfferId
      `);
      const maxVersion = Math.max(0, Number(maxVerResult.recordset?.[0]?.MaxVersion ?? 0));
      targetVersion = maxVersion + 1;
    }
    const enabledValue = typeof existingOffer.Enabled === 'boolean'
      ? existingOffer.Enabled
      : existingOffer.Enabled != null
        ? Boolean(existingOffer.Enabled)
        : true;
    const isStandardPackageValue = typeof existingOffer.IsStandardPackage === 'boolean'
      ? existingOffer.IsStandardPackage
      : existingOffer.IsStandardPackage != null
        ? Boolean(existingOffer.IsStandardPackage)
        : false;

    // Both copies and new versions reset status to Draft Request.
    // New versions keep the ERP project code (same project); copies clear it (fresh offer).
    let effectiveStatusId = existingOffer.StatusID;
    const effectiveERPProjectCode: string | null =
      duplicateMode === 'copy' ? null : existingOffer.ERPProjectCode;
    const draftStatusRequest = pool.request();
    const draftStatusResult = await draftStatusRequest.query<{ ID: number }>(`
      SELECT TOP 1 ID FROM dbo.OfferStatus WHERE LOWER(TRIM(Name)) = 'draft request'
    `);
    const draftStatusId = draftStatusResult.recordset?.[0]?.ID ?? null;
    if (draftStatusId != null) {
      effectiveStatusId = draftStatusId;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const normalizedSalesPersonId = normalizeNullableString(existingOffer.SalesPersonId);
      const normalizedSalesManagerId = normalizeNullableString(existingOffer.SalesManagerID);
      const normalizedApprovalUserId = normalizeNullableString(existingOffer.ApprovalUserId);
      const insertRequest = transaction.request();
      insertRequest.input('CustomerID', sql.Int, existingOffer.CustomerID);
      insertRequest.input('StatusID', sql.Int, effectiveStatusId);
      insertRequest.input('PricingPolicyID', sql.Int, existingOffer.PricingPolicyID);
      insertRequest.input('MarketID', sql.Int, existingOffer.MarketID);
      insertRequest.input('SalesDivisionID', sql.Int, existingOffer.SalesDivisionID);
      insertRequest.input('SalesPersonId', sql.NVarChar(450), normalizedSalesPersonId);
      insertRequest.input('SalesManagerID', sql.NVarChar(450), normalizedSalesManagerId);
      insertRequest.input('CreatedBy', sql.NVarChar(450), auditUserId);
      insertRequest.input('ModifiedBy', sql.NVarChar(450), auditUserId);
      insertRequest.input('Title', sql.NVarChar(512), existingOffer.Title);
      insertRequest.input('Description', sql.NVarChar(2000), existingOffer.Description);
      insertRequest.input('PaymentTerms', sql.NVarChar(500), existingOffer.PaymentTerms);
      insertRequest.input('InstallationSchedule', sql.NVarChar(500), existingOffer.InstallationSchedule);
      insertRequest.input('OfferNotesClosing', sql.NVarChar(2000), existingOffer.OfferNotesClosing);
      insertRequest.input('OfferValidity', sql.NVarChar(500), existingOffer.OfferValidity);
      insertRequest.input('DeliveryTime', sql.NVarChar(500), existingOffer.DeliveryTime);
      insertRequest.input('OfferNotesIntroduction', sql.NVarChar(2000), existingOffer.OfferNotesIntroduction);
      insertRequest.input('Comments', sql.NVarChar(2000), existingOffer.Comments);
      insertRequest.input('ContactID', sql.Int, existingOffer.ContactID);
      insertRequest.input('OfferContact', sql.NVarChar(500), existingOffer.OfferContact);
      insertRequest.input('ERPProjectCode', sql.NVarChar(500), effectiveERPProjectCode);
      insertRequest.input('ERPFWCProjectID', sql.Int, existingOffer.ERPFWCProjectID);
      insertRequest.input('PrintLevelGroupingID', sql.Int, existingOffer.PrintLevelGroupingID);
      insertRequest.input('CustomerRef', sql.NVarChar(500), existingOffer.CustomerRef);
      insertRequest.input('DraftRequestDate', sql.DateTime2, existingOffer.DraftRequestDate);
      insertRequest.input('DraftOfferDate', sql.DateTime2, existingOffer.DraftOfferDate);
      insertRequest.input('RequestDate', sql.DateTime2, existingOffer.RequestDate);
      insertRequest.input('OfferDeadlineDate', sql.DateTime2, existingOffer.OfferDeadlineDate);
      insertRequest.input('OrderSignedDate', sql.DateTime2, existingOffer.OrderSignedDate);
      insertRequest.input('DeliveryDueDate', sql.DateTime2, existingOffer.DeliveryDueDate);
      insertRequest.input('PossibleOrderDate', sql.DateTime2, existingOffer.PossibleOrderDate);
      insertRequest.input('OfferDate', sql.DateTime2, existingOffer.OfferDate);
      insertRequest.input('ApprovalUserId', sql.NVarChar(450), normalizedApprovalUserId);
      insertRequest.input('ParentOfferID', sql.Int, targetParentOfferId);
      insertRequest.input('ProtocolNo', sql.Int, existingOffer.ProtocolNo);
      insertRequest.input('OfferLanguage', sql.NVarChar(16), existingOffer.OfferLanguage);
      insertRequest.input('DiscountLabel', sql.NVarChar(500), existingOffer.DiscountLabel);
      insertRequest.input('AdditionalDiscountLabel', sql.NVarChar(500), existingOffer.AdditionalDiscountLabel);
      insertRequest.input('FinalPriceLabel', sql.NVarChar(500), existingOffer.FinalPriceLabel);
      insertRequest.input('ExtraNetDiscount', sql.Decimal(18, 4), existingOffer.ExtraNetDiscount);
      insertRequest.input('ExtraNetDiscountMode', sql.NVarChar(8), existingOffer.ExtraNetDiscountMode);
      insertRequest.input('CurrencyID', sql.Int, existingOffer.CurrencyID);
      insertRequest.input('CurrencyModifier', sql.Decimal(18, 8), existingOffer.CurrencyModifier);
      insertRequest.input('OfferVersion', sql.Int, targetVersion);
      insertRequest.input('Enabled', sql.Bit, enabledValue);
      insertRequest.input('IsStandardPackage', sql.Bit, isStandardPackageValue);
      insertRequest.input('IsTelvin', sql.Bit, existingOffer.IsTelvin ?? false);

      const insertSql = `
        INSERT INTO dbo.Offer (
          CustomerID,
          StatusID,
          PricingPolicyID,
          MarketID,
          SalesDivisionID,
          SalesPersonId,
          SalesManagerID,
          CreatedBy,
          ModifiedBy,
          Title,
          Description,
          PaymentTerms,
          InstallationSchedule,
          OfferNotesClosing,
          OfferValidity,
          DeliveryTime,
          OfferNotesIntroduction,
          Comments,
          ContactID,
          OfferContact,
          ERPProjectCode,
          ERPFWCProjectID,
          PrintLevelGroupingID,
          CustomerRef,
          DraftRequestDate,
          DraftOfferDate,
          RequestDate,
          OfferDeadlineDate,
          OrderSignedDate,
          DeliveryDueDate,
          PossibleOrderDate,
          OfferDate,
          ApprovalUserId,
          ParentOfferID,
          ProtocolNo,
          OfferLanguage,
          DiscountLabel,
          AdditionalDiscountLabel,
          FinalPriceLabel,
          ExtraNetDiscount,
          ExtraNetDiscountMode,
          CurrencyID,
          CurrencyModifier,
          OfferVersion,
          Enabled,
          IsStandardPackage,
          IsTelvin,
          CreatedOn,
          ModifiedOn
        )
        OUTPUT INSERTED.ID AS OfferID, INSERTED.Title
        VALUES (
          @CustomerID,
          @StatusID,
          @PricingPolicyID,
          @MarketID,
          @SalesDivisionID,
          @SalesPersonId,
          @SalesManagerID,
          @CreatedBy,
          @ModifiedBy,
          @Title,
          @Description,
          @PaymentTerms,
          @InstallationSchedule,
          @OfferNotesClosing,
          @OfferValidity,
          @DeliveryTime,
          @OfferNotesIntroduction,
          @Comments,
          @ContactID,
          @OfferContact,
          @ERPProjectCode,
          @ERPFWCProjectID,
          @PrintLevelGroupingID,
          @CustomerRef,
          @DraftRequestDate,
          @DraftOfferDate,
          @RequestDate,
          @OfferDeadlineDate,
          @OrderSignedDate,
          @DeliveryDueDate,
          @PossibleOrderDate,
          @OfferDate,
          @ApprovalUserId,
          @ParentOfferID,
          @ProtocolNo,
          @OfferLanguage,
          @DiscountLabel,
          @AdditionalDiscountLabel,
          @FinalPriceLabel,
          @ExtraNetDiscount,
          @ExtraNetDiscountMode,
          @CurrencyID,
          @CurrencyModifier,
          @OfferVersion,
          @Enabled,
          @IsStandardPackage,
          @IsTelvin,
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        );
      `;

      const insertResult = await insertRequest.query<{ OfferID: number; Title: string | null }>(insertSql);
      const insertedOfferRow = insertResult.recordset?.[0];
      const newOfferId = insertedOfferRow?.OfferID;
      if (!newOfferId) {
        throw new Error('Unable to create offer version');
      }

      const duplicateRequest = transaction.request();
      duplicateRequest.input('sourceOfferId', sql.Int, normalizedId);
      duplicateRequest.input('targetOfferId', sql.Int, newOfferId);
      duplicateRequest.input('auditUser', sql.NVarChar(450), auditUserId);
      await duplicateRequest.query(duplicateOfferDetailsSql);

      await transaction.commit();

      logAddAuditDetails({
        endpoint: '/api/offers/[offerId]/duplicate',
        method: 'POST',
        requestId,
        userId,
        targetEntity: 'offers',
        createdRows: [
          {
            id: newOfferId,
            name: insertedOfferRow?.Title?.trim() || existingOffer.Title?.trim() || null,
          },
        ],
        message: `Offer duplicated (${duplicateMode})`,
        extra: { sourceOfferId: normalizedId },
      });

      return NextResponse.json({ ok: true, offerId: newOfferId });
    } catch (err) {
      await transaction.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    console.error('Failed to duplicate offer', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
