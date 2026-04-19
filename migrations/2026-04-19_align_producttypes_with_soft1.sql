-- ============================================================================
-- Migration: Align dbo.ProductTypes.ID with Soft1 CCCCLTYPE IDs
-- Date    : 2026-04-19
-- Database: FastQuote (dbo)
-- ============================================================================
-- Purpose
--   Re-key dbo.ProductTypes so its ID matches Soft1's CCCCLTYPE numeric IDs
--   (10, 20, 30, 40, 50, 60). Then setItem can pass FastQuote's TypeID
--   directly to Soft1 without translation.
--
-- Mapping (joined by Code):
--   12 (Main / M)       -> 10
--   13 (Peripheral / P) -> 20
--   14 (Spare / S)      -> 30
--   15 (Consumable / C) -> 40
--   16 (Software / W)   -> 50
--   17 (Services / V)   -> 60   (Soft1 calls it "Service", FastQuote name kept)
--
-- BEFORE RUNNING:
--   * Take a backup of FastQuote.
--   * Run discovery_producttypes_fks.sql first and confirm that
--     dbo.Products is the ONLY table with an FK to ProductTypes.
--     If others appear, this script must be extended.
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

BEGIN TRY
    -- Mapping
    DECLARE @Map TABLE (OldID INT PRIMARY KEY, NewID INT NOT NULL, Code NVARCHAR(50) NOT NULL);
    INSERT INTO @Map (OldID, NewID, Code) VALUES
        (12, 10, 'M'),
        (13, 20, 'P'),
        (14, 30, 'S'),
        (15, 40, 'C'),
        (16, 50, 'W'),
        (17, 60, 'V');

    -- Pre-flight: verify mapping codes match the live rows
    IF EXISTS (
        SELECT 1
        FROM @Map m
        INNER JOIN dbo.ProductTypes t ON t.ID = m.OldID
        WHERE t.Code <> m.Code
    )
    BEGIN
        RAISERROR('Code mismatch between mapping and live data. Aborting before any change.', 16, 1);
    END;

    -- Pre-flight: bail if there are FastQuote rows we don't know how to remap
    IF EXISTS (
        SELECT 1 FROM dbo.ProductTypes t
        WHERE t.ID NOT IN (SELECT OldID FROM @Map)
          AND t.ID NOT IN (SELECT NewID FROM @Map)
    )
    BEGIN
        DECLARE @ExtraIDs NVARCHAR(MAX) = (
            SELECT STRING_AGG(CONCAT(t.ID, ' (', t.Code, '/', t.Name, ')'), ', ')
            FROM dbo.ProductTypes t
            WHERE t.ID NOT IN (SELECT OldID FROM @Map)
              AND t.ID NOT IN (SELECT NewID FROM @Map)
        );
        DECLARE @Msg NVARCHAR(MAX) = CONCAT('Unmapped rows present in dbo.ProductTypes: ', @ExtraIDs, '. Extend the mapping before re-running.');
        RAISERROR(@Msg, 16, 1);
    END;

    -- Pre-flight: detect already-migrated state
    DECLARE @MissingOld INT, @AlreadyHasNew INT;
    SELECT @MissingOld = COUNT(*) FROM @Map m
        WHERE NOT EXISTS (SELECT 1 FROM dbo.ProductTypes t WHERE t.ID = m.OldID);
    SELECT @AlreadyHasNew = COUNT(*) FROM @Map m
        WHERE EXISTS (SELECT 1 FROM dbo.ProductTypes t WHERE t.ID = m.NewID);

    PRINT CONCAT('Pre-flight: missing OldID rows = ', @MissingOld, ', NewID rows already present = ', @AlreadyHasNew);

    IF @MissingOld = 6 AND @AlreadyHasNew = 6
    BEGIN
        PRINT 'Looks already migrated. Committing empty transaction.';
        COMMIT TRANSACTION;
        RETURN;
    END;

    -- 1. INSERT new-ID rows (skip any that already exist)
    SET IDENTITY_INSERT dbo.ProductTypes ON;

    INSERT INTO dbo.ProductTypes
        (ID, Name, Code, Comments, Enabled, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
    SELECT
        m.NewID, t.Name, t.Code, t.Comments, t.Enabled,
        SYSUTCDATETIME(), 36, SYSUTCDATETIME(), 36
    FROM @Map m
    INNER JOIN dbo.ProductTypes t ON t.ID = m.OldID
    WHERE NOT EXISTS (SELECT 1 FROM dbo.ProductTypes t2 WHERE t2.ID = m.NewID);

    PRINT CONCAT('Inserted new-ID rows: ', @@ROWCOUNT);

    SET IDENTITY_INSERT dbo.ProductTypes OFF;

    -- 2. Re-point Products.TypeID old -> new
    UPDATE p
    SET p.TypeID    = m.NewID,
        p.ModifiedOn = SYSUTCDATETIME()
    FROM dbo.Products p
    INNER JOIN @Map m ON p.TypeID = m.OldID;

    PRINT CONCAT('Updated Products.TypeID rows: ', @@ROWCOUNT);

    -- 3. DELETE old-ID rows
    DELETE t
    FROM dbo.ProductTypes t
    INNER JOIN @Map m ON t.ID = m.OldID;

    PRINT CONCAT('Deleted old-ID rows: ', @@ROWCOUNT);

    -- 4. Reseed IDENTITY above the new max
    DECLARE @MaxID INT = (SELECT ISNULL(MAX(ID), 0) FROM dbo.ProductTypes);
    DBCC CHECKIDENT ('dbo.ProductTypes', RESEED, @MaxID);
    PRINT CONCAT('Reseeded IDENTITY to ', @MaxID);

    COMMIT TRANSACTION;
    PRINT 'Migration committed successfully.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT 'Migration FAILED. Rolled back.';
    THROW;
END CATCH;
