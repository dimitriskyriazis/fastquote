-- Adds offer-level "additional discount" fields applied on top of the offer totals.
-- These are display/summary discounts (List and Net), each storing a value plus a
-- mode ('pct' for percentage or 'abs' for an absolute amount in the offer currency).
-- They do NOT alter individual product-line prices; they only adjust the totals shown
-- in the products grid totals bar and in the generated PDF summary.
--
-- Run once against the FastQuote database.

IF COL_LENGTH('dbo.Offer', 'ExtraListDiscount') IS NULL
  ALTER TABLE dbo.Offer ADD ExtraListDiscount DECIMAL(18, 4) NULL;
GO

IF COL_LENGTH('dbo.Offer', 'ExtraListDiscountMode') IS NULL
  ALTER TABLE dbo.Offer ADD ExtraListDiscountMode NVARCHAR(8) NULL;
GO

IF COL_LENGTH('dbo.Offer', 'ExtraNetDiscount') IS NULL
  ALTER TABLE dbo.Offer ADD ExtraNetDiscount DECIMAL(18, 4) NULL;
GO

IF COL_LENGTH('dbo.Offer', 'ExtraNetDiscountMode') IS NULL
  ALTER TABLE dbo.Offer ADD ExtraNetDiscountMode NVARCHAR(8) NULL;
GO
