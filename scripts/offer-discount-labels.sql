-- ============================================================================
-- FastQuote — Offer totals: add Discount/Additional-Discount labels,
--             drop the unused Extra List Discount columns.
-- Run against the FastQuote SQL Server database. Idempotent & safe to re-run.
-- ============================================================================

-- 1) ADD — per-offer label overrides for the PDF totals box.
--    Nullable; a blank/NULL value falls back to the localized default
--    ("Discount"/"Έκπτωση", "Additional Discount"/"Πρόσθετη Έκπτωση").
--    Run this BEFORE (or together with) deploying the new application code.
IF COL_LENGTH('dbo.Offer', 'DiscountLabel') IS NULL
    ALTER TABLE dbo.Offer ADD DiscountLabel NVARCHAR(500) NULL;

IF COL_LENGTH('dbo.Offer', 'AdditionalDiscountLabel') IS NULL
    ALTER TABLE dbo.Offer ADD AdditionalDiscountLabel NVARCHAR(500) NULL;
GO

-- 2) DROP — remove the now-unused Extra List Discount columns.
--    Run this AFTER the new application code is deployed (the app no longer
--    reads or writes these columns). Default constraints have auto-generated
--    names, so resolve and drop them first.
DECLARE @dropDefaults NVARCHAR(MAX) = N'';

SELECT @dropDefaults = @dropDefaults
       + N'ALTER TABLE dbo.Offer DROP CONSTRAINT ' + QUOTENAME(dc.name) + N';' + CHAR(10)
FROM sys.default_constraints dc
JOIN sys.columns c
  ON c.object_id = dc.parent_object_id
 AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID('dbo.Offer')
  AND c.name IN ('ExtraListDiscount', 'ExtraListDiscountMode');

IF @dropDefaults <> N'' EXEC sp_executesql @dropDefaults;

IF COL_LENGTH('dbo.Offer', 'ExtraListDiscount') IS NOT NULL
    ALTER TABLE dbo.Offer DROP COLUMN ExtraListDiscount;

IF COL_LENGTH('dbo.Offer', 'ExtraListDiscountMode') IS NOT NULL
    ALTER TABLE dbo.Offer DROP COLUMN ExtraListDiscountMode;
GO
