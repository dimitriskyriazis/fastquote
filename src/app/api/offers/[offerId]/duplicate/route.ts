import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { buildAuditContext } from '../../../../../lib/auditTrail';
import { getPool } from '../../../../../lib/sql';

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
  PricingPolicyID: number | null;
  MarketID: number | null;
  SalesDivitionID: number | null;
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
  DefaultCalcMethodFormulasID: string | null;
  ProjectID: number | null;
  PrintLevelGroupingID: number | null;
  CustomerRef: string | null;
  InitialRequest: Date | null;
  DraftOffer: Date | null;
  OfficialRequest: Date | null;
  OfferDeadline: Date | null;
  OfficialQuoteOffer: Date | null;
  OrderSigned: Date | null;
  DeliveryDue: Date | null;
  Delivery: Date | null;
  OfferDate: Date | null;
  ApprovalUserId: string | null;
  ProtocolNo: number | null;
  OfferVersion: number | null;
  Enabled: number | boolean | null;
  CreatedBy: string | null;
  ModifiedBy: string | null;
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
  ProductDescription NVARCHAR(2000) NULL,
  BrandID INT NULL,
  PartNumber NVARCHAR(400) NULL,
  ModelNumber NVARCHAR(400) NULL,
  ProductID INT NULL,
  Quantity DECIMAL(18,4) NULL,
  CustomerDiscount DECIMAL(18,4) NULL,
  NetUnitPrice DECIMAL(18,4) NULL,
  TotalPrice DECIMAL(18,4) NULL,
  TotalNet DECIMAL(18,4) NULL,
  Warranty NVARCHAR(500) NULL,
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
  RequestedDescription NVARCHAR(2000) NULL,
  RequestedDescription2 NVARCHAR(2000) NULL,
  RequestedDescription3 NVARCHAR(2000) NULL,
  RequestedQuantity DECIMAL(18,4) NULL
);

INSERT INTO @SourceDetails (Seq, OldId, ParentOfferDetailID, TreeOrdering, Ordering, IsPrintable, IsComment, IsCategory, ProductDescription, BrandID, PartNumber, ModelNumber, ProductID, Quantity, CustomerDiscount, NetUnitPrice, TotalPrice, TotalNet, Warranty, ListPrice, TelmacoDiscount, NetCostOtherCurrency, OtherCurrencyID, CurrencyCostModifier, NetCost, Margin, GrossProfit, TotalCost, PriceListID, PriceListItemID, RequestedItemNo, RequestedBrand, RequestedModelNo, RequestedPartNo, RequestedDescription, RequestedDescription2, RequestedDescription3, RequestedQuantity)
SELECT
  ROW_NUMBER() OVER (ORDER BY od.ID),
  od.ID,
  od.ParentOfferDetailID,
  od.TreeOrdering,
  od.Ordering,
  od.IsPrintable,
  od.IsComment,
  od.IsCategory,
  od.ProductDescription,
  od.BrandID,
  od.PartNumber,
  od.ModelNumber,
  od.ProductID,
  od.Quantity,
  od.CustomerDiscount,
  od.NetUnitPrice,
  od.TotalPrice,
  od.TotalNet,
  od.Warranty,
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
  ProductDescription,
  ProductID,
  Quantity,
  CustomerDiscount,
  NetUnitPrice,
  TotalPrice,
  TotalNet,
  Warranty,
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
  src.ProductDescription,
  src.ProductID,
  src.Quantity,
  src.CustomerDiscount,
  src.NetUnitPrice,
  src.TotalPrice,
  src.TotalNet,
  src.Warranty,
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
  try {
    const { offerId: offerIdParam } = await params;
    const normalizedId = normalizeOfferIdParam(offerIdParam);
    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid offer id' },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const summaryRequest = pool.request();
    summaryRequest.input('offerId', sql.Int, normalizedId);
    const existingResult = await summaryRequest.query<ExistingOfferRecord>(`
      SELECT
        CustomerID,
        StatusID,
        PricingPolicyID,
        MarketID,
        SalesDivitionID,
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
        DefaultCalcMethodFormulasID,
        ProjectID,
        PrintLevelGroupingID,
        CustomerRef,
        InitialRequest,
        DraftOffer,
        OfficialRequest,
        OfferDeadline,
        OfficialQuoteOffer,
        OrderSigned,
        DeliveryDue,
        Delivery,
        OfferDate,
        ApprovalUserId,
        ProtocolNo,
        OfferVersion,
        Enabled,
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
    const nextVersion = Math.max(0, Number(existingOffer.OfferVersion ?? 0)) + 1;
    const enabledValue = typeof existingOffer.Enabled === 'boolean'
      ? existingOffer.Enabled
      : existingOffer.Enabled != null
        ? Boolean(existingOffer.Enabled)
        : true;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const normalizedSalesPersonId = normalizeNullableString(existingOffer.SalesPersonId);
      const normalizedSalesManagerId = normalizeNullableString(existingOffer.SalesManagerID);
      const normalizedApprovalUserId = normalizeNullableString(existingOffer.ApprovalUserId);
      const insertRequest = transaction.request();
      insertRequest.input('CustomerID', sql.Int, existingOffer.CustomerID);
      insertRequest.input('StatusID', sql.Int, existingOffer.StatusID);
      insertRequest.input('PricingPolicyID', sql.Int, existingOffer.PricingPolicyID);
      insertRequest.input('MarketID', sql.Int, existingOffer.MarketID);
      insertRequest.input('SalesDivitionID', sql.Int, existingOffer.SalesDivitionID);
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
      insertRequest.input('DefaultCalcMethodFormulasID', sql.NVarChar(100), existingOffer.DefaultCalcMethodFormulasID);
      insertRequest.input('ProjectID', sql.Int, existingOffer.ProjectID);
      insertRequest.input('PrintLevelGroupingID', sql.Int, existingOffer.PrintLevelGroupingID);
      insertRequest.input('CustomerRef', sql.NVarChar(500), existingOffer.CustomerRef);
      insertRequest.input('InitialRequest', sql.DateTime2, existingOffer.InitialRequest);
      insertRequest.input('DraftOffer', sql.DateTime2, existingOffer.DraftOffer);
      insertRequest.input('OfficialRequest', sql.DateTime2, existingOffer.OfficialRequest);
      insertRequest.input('OfferDeadline', sql.DateTime2, existingOffer.OfferDeadline);
      insertRequest.input('OfficialQuoteOffer', sql.DateTime2, existingOffer.OfficialQuoteOffer);
      insertRequest.input('OrderSigned', sql.DateTime2, existingOffer.OrderSigned);
      insertRequest.input('DeliveryDue', sql.DateTime2, existingOffer.DeliveryDue);
      insertRequest.input('Delivery', sql.DateTime2, existingOffer.Delivery);
      insertRequest.input('OfferDate', sql.DateTime2, existingOffer.OfferDate);
      insertRequest.input('ApprovalUserId', sql.NVarChar(450), normalizedApprovalUserId);
      insertRequest.input('ProtocolNo', sql.Int, existingOffer.ProtocolNo);
      insertRequest.input('OfferVersion', sql.Int, nextVersion);
      insertRequest.input('Enabled', sql.Bit, enabledValue);

      const insertSql = `
        INSERT INTO dbo.Offer (
          CustomerID,
          StatusID,
          PricingPolicyID,
          MarketID,
          SalesDivitionID,
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
          DefaultCalcMethodFormulasID,
          ProjectID,
          PrintLevelGroupingID,
          CustomerRef,
          InitialRequest,
          DraftOffer,
          OfficialRequest,
          OfferDeadline,
          OfficialQuoteOffer,
          OrderSigned,
          DeliveryDue,
          Delivery,
          OfferDate,
          ApprovalUserId,
          ProtocolNo,
          OfferVersion,
          Enabled,
          CreatedOn,
          ModifiedOn
        )
        OUTPUT INSERTED.ID AS OfferID
        VALUES (
          @CustomerID,
          @StatusID,
          @PricingPolicyID,
          @MarketID,
          @SalesDivitionID,
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
          @DefaultCalcMethodFormulasID,
          @ProjectID,
          @PrintLevelGroupingID,
          @CustomerRef,
          @InitialRequest,
          @DraftOffer,
          @OfficialRequest,
          @OfferDeadline,
          @OfficialQuoteOffer,
          @OrderSigned,
          @DeliveryDue,
          @Delivery,
          @OfferDate,
          @ApprovalUserId,
          @ProtocolNo,
          @OfferVersion,
          @Enabled,
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        );
      `;

      const insertResult = await insertRequest.query<{ OfferID: number }>(insertSql);
      const newOfferId = insertResult.recordset?.[0]?.OfferID;
      if (!newOfferId) {
        throw new Error('Unable to create offer version');
      }

      const duplicateRequest = transaction.request();
      duplicateRequest.input('sourceOfferId', sql.Int, normalizedId);
      duplicateRequest.input('targetOfferId', sql.Int, newOfferId);
      duplicateRequest.input('auditUser', sql.NVarChar(450), auditUserId);
      await duplicateRequest.query(duplicateOfferDetailsSql);

      await transaction.commit();
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
