-- ============================================================================
-- Migration: Align dbo.ProductSubCategories.ID with Soft1 CCCCLSUBCATEG IDs
-- Date    : 2026-04-19
-- Database: FastQuote (dbo)
-- ============================================================================
-- Purpose
--   Re-key dbo.ProductSubCategories so its ID matches Soft1's CCCCLSUBCATEG
--   numeric IDs (10100..60300). Then setItem can pass FastQuote's
--   SubCategoryID directly to Soft1 without translation.
--
-- Mapping (joined by Code):
--   Video  (10):  1..20  -> 10110..10300 (steps of 10)
--   Audio  (20):  21..30 -> 20100..20190
--   Light  (30):  31..35 -> 30100..30140
--   Comp   (40):  36..40 -> 40100..40140
--   Telec  (50):  41..44 -> 50100..50130
--   InstM  (60):  45..56 -> 60100..60210
--                 57..64 -> 60230..60300  (Soft1 skips 60220)
--
-- Plus inserts the one Soft1 row missing in FastQuote:
--   10100 / VPla / Video Players & Recorders (CategoryID=10)
--
-- BEFORE RUNNING:
--   * Take a backup of FastQuote.
--   * Run discovery_productsubcategories_fks.sql first and confirm that
--     dbo.Products is the ONLY table with an FK to ProductSubCategories.
--     If others appear, this script must be extended for them.
-- ============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

BEGIN TRY
    -- Mapping (FastQuote OldID -> Soft1 NewID, with Code for verification)
    DECLARE @Map TABLE (OldID INT PRIMARY KEY, NewID INT NOT NULL, Code NVARCHAR(50) NOT NULL);
    INSERT INTO @Map (OldID, NewID, Code) VALUES
        ( 1, 10110, 'Mon'),  ( 2, 10120, 'Clo'),  ( 3, 10130, 'Prom'), ( 4, 10140, 'Proj'),
        ( 5, 10150, 'VW'),   ( 6, 10160, 'Vinf'), ( 7, 10170, 'Vmat'), ( 8, 10180, 'Vmix'),
        ( 9, 10190, 'EnDe'), (10, 10200, 'Cam'),  (11, 10210, 'Lan'),  (12, 10220, 'Tri'),
        (13, 10230, 'VCrd'), (14, 10240, 'EdGr'), (15, 10250, 'BrAu'), (16, 10260, 'MeMa'),
        (17, 10270, 'VCnf'), (18, 10280, 'Cntr'), (19, 10290, 'Vins'), (20, 10300, 'Voth'),
        (21, 20100, 'Amix'), (22, 20110, 'Apla'), (23, 20120, 'SpAm'), (24, 20130, 'MicH'),
        (25, 20140, 'Ainf'), (26, 20150, 'CoIn'), (27, 20160, 'Pag'),  (28, 20170, 'Intr'),
        (29, 20180, 'Ains'), (30, 20190, 'Aoth'),
        (31, 30100, 'Lfi'),  (32, 30110, 'Lmo'),  (33, 30120, 'Lco'),  (34, 30130, 'Ldim'),
        (35, 30140, 'Loth'),
        (36, 40100, 'Cnet'), (37, 40110, 'CPC'),  (38, 40120, 'CStr'), (39, 40130, 'CLT'),
        (40, 40140, 'Coth'),
        (41, 50100, 'Tins'), (42, 50110, 'TxMw'), (43, 50120, 'AntS'), (44, 50130, 'Toth'),
        (45, 60100, 'Iprj'), (46, 60110, 'Irck'), (47, 60120, 'CV'),   (48, 60130, 'CA'),
        (49, 60140, 'CD'),   (50, 60150, 'CP'),   (51, 60160, 'CS'),   (52, 60170, 'TA'),
        (53, 60180, 'TV'),   (54, 60190, 'TD'),   (55, 60200, 'TP'),   (56, 60210, 'TS'),
        (57, 60230, 'PPV'),  (58, 60240, 'PPA'),  (59, 60250, 'PPD'),  (60, 60260, 'Cbox'),
        (61, 60270, 'Mnt'),  (62, 60280, 'Fcas'), (63, 60290, 'Furn'), (64, 60300, 'IOth');

    -- Pre-flight: verify mapping codes match the live rows (catch drift)
    IF EXISTS (
        SELECT 1
        FROM @Map m
        INNER JOIN dbo.ProductSubCategories sc ON sc.ID = m.OldID
        WHERE sc.Code <> m.Code
    )
    BEGIN
        RAISERROR('Code mismatch between mapping and live data. Aborting before any change.', 16, 1);
    END;

    -- Pre-flight: detect already-migrated state
    DECLARE @MissingOld INT, @AlreadyHasNew INT;
    SELECT @MissingOld   = COUNT(*) FROM @Map m
        WHERE NOT EXISTS (SELECT 1 FROM dbo.ProductSubCategories sc WHERE sc.ID = m.OldID);
    SELECT @AlreadyHasNew = COUNT(*) FROM @Map m
        WHERE EXISTS (SELECT 1 FROM dbo.ProductSubCategories sc WHERE sc.ID = m.NewID);

    PRINT CONCAT('Pre-flight: missing OldID rows = ', @MissingOld, ', NewID rows already present = ', @AlreadyHasNew);

    IF @MissingOld = 64 AND @AlreadyHasNew = 64
    BEGIN
        PRINT 'Looks already migrated. Committing empty transaction.';
        COMMIT TRANSACTION;
        RETURN;
    END;

    -- 1. INSERT new-ID rows (skip any that already exist)
    SET IDENTITY_INSERT dbo.ProductSubCategories ON;

    INSERT INTO dbo.ProductSubCategories
        (ID, Enabled, Name, Code, Comments, CategoryID, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
    SELECT
        m.NewID, sc.Enabled, sc.Name, sc.Code, sc.Comments, sc.CategoryID,
        SYSUTCDATETIME(), 36, SYSUTCDATETIME(), 36
    FROM @Map m
    INNER JOIN dbo.ProductSubCategories sc ON sc.ID = m.OldID
    WHERE NOT EXISTS (SELECT 1 FROM dbo.ProductSubCategories sc2 WHERE sc2.ID = m.NewID);

    PRINT CONCAT('Inserted new-ID rows: ', @@ROWCOUNT);

    -- 1b. INSERT the Soft1-only row (10100 / VPla / Video Players & Recorders)
    IF NOT EXISTS (SELECT 1 FROM dbo.ProductSubCategories WHERE ID = 10100)
    BEGIN
        INSERT INTO dbo.ProductSubCategories
            (ID, Enabled, Name, Code, Comments, CategoryID, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
        VALUES
            (10100, 1, N'Video Players & Recorders', N'VPla', NULL, 10,
             SYSUTCDATETIME(), 36, SYSUTCDATETIME(), 36);
        PRINT 'Inserted missing Soft1 row 10100 (VPla)';
    END;

    SET IDENTITY_INSERT dbo.ProductSubCategories OFF;

    -- 2. Re-point Products.SubCategoryID old -> new
    UPDATE p
    SET p.SubCategoryID = m.NewID,
        p.ModifiedOn    = SYSUTCDATETIME()
    FROM dbo.Products p
    INNER JOIN @Map m ON p.SubCategoryID = m.OldID;

    PRINT CONCAT('Updated Products.SubCategoryID rows: ', @@ROWCOUNT);

    -- 3. DELETE old-ID rows
    DELETE sc
    FROM dbo.ProductSubCategories sc
    INNER JOIN @Map m ON sc.ID = m.OldID;

    PRINT CONCAT('Deleted old-ID rows: ', @@ROWCOUNT);

    -- 4. Reseed IDENTITY above the new max
    DECLARE @MaxID INT = (SELECT ISNULL(MAX(ID), 0) FROM dbo.ProductSubCategories);
    DBCC CHECKIDENT ('dbo.ProductSubCategories', RESEED, @MaxID);
    PRINT CONCAT('Reseeded IDENTITY to ', @MaxID);

    COMMIT TRANSACTION;
    PRINT 'Migration committed successfully.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT 'Migration FAILED. Rolled back.';
    THROW;
END CATCH;
