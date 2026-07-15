-- =============================================================================
-- Scheduled price list activation — 2026-07-14
--
-- Adds dbo.PriceLists.ReplacedByPriceListID: when an import selects a
-- "previous price list" and the new list's ValidFromDate is in the future,
-- the app no longer disables the old list immediately. Instead it records the
-- succession here; the old list stays active until the new list's Valid From
-- arrives, at which point pricing queries stop using it (exact cutover) and an
-- opportunistic sweep flips its Enabled flag to 0.
--
-- MUST be run BEFORE deploying the app build of the same date: the pricing
-- queries reference this column and will fail while it is missing. Running the
-- script first is safe — the old build simply ignores the column.
--
-- Idempotent: safe to run multiple times.
-- =============================================================================

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.PriceLists')
    AND name = N'ReplacedByPriceListID'
)
BEGIN
  ALTER TABLE dbo.PriceLists ADD ReplacedByPriceListID INT NULL;
  PRINT 'Added dbo.PriceLists.ReplacedByPriceListID';
END
ELSE
  PRINT 'dbo.PriceLists.ReplacedByPriceListID already exists — skipped';
GO

-- No FK constraint on purpose: a dangling reference (replacement list deleted)
-- must not block deletes, and the app treats a missing replacement row as
-- "no active replacement" (the old list simply stays in effect).

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.PriceLists')
    AND name = N'IX_PriceLists_ReplacedByPriceListID'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_PriceLists_ReplacedByPriceListID
    ON dbo.PriceLists (ReplacedByPriceListID)
    WHERE ReplacedByPriceListID IS NOT NULL;
  PRINT 'Created IX_PriceLists_ReplacedByPriceListID';
END
ELSE
  PRINT 'IX_PriceLists_ReplacedByPriceListID already exists — skipped';
GO
