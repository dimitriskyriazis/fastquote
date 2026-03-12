-- Add LegacyPartNo columns to dbo.Products for tracking old part numbers
-- when a brand (e.g. Biamp) changes their part numbering scheme.

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Products' AND COLUMN_NAME = 'LegacyPartNo'
)
BEGIN
  ALTER TABLE dbo.Products ADD LegacyPartNo NVARCHAR(255) NULL;
END
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Products' AND COLUMN_NAME = 'LegacyPartNoCleaned'
)
BEGIN
  ALTER TABLE dbo.Products ADD LegacyPartNoCleaned NVARCHAR(255) NULL;
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Products_LegacyPartNoCleaned' AND object_id = OBJECT_ID('dbo.Products')
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Products_LegacyPartNoCleaned
    ON dbo.Products(LegacyPartNoCleaned)
    WHERE LegacyPartNoCleaned IS NOT NULL;
END
GO
