/*
Run on: teldb2
Database: FastQuote

Purpose:
- Build/refresh staging tables from source DB:
  - oldTelquote.dbo.Customers -> FastQuote.dbo._Customers
  - oldTelquote.dbo.[Customer Groups] -> FastQuote.dbo._CustomerGroups
- Optionally apply city/country text overrides from:
  - FastQuote.dbo._CustomerLocationOverrides
- Populate dbo.Customers safely and idempotently
- Keep legacy location text in:
  - dbo.Customers._OldCountryName
  - dbo.Customers._OldCityName
- Resolve CountryID by exact name match
- Write Customers.City as text from legacy city
- Resolve ParentCustomerID by _OldCustomerID mapping

How to use:
1) Open this file in SSMS connected to teldb2.
2) Set @ReloadStaging = 1 to recreate/reload _Customers and _CustomerGroups.
3) Option A: set @LoadOverridesFromCsv = 1 and set @OverridesCsvPath.
4) Option B: keep @LoadOverridesFromCsv = 0 and manually load dbo._CustomerLocationOverridesRaw.
5) Set @DoCommit = 0 for dry run (recommended first).
6) Run script, review result sets.
7) Set @DoCommit = 1 and run again to commit.
*/

USE [FastQuote];
GO

DECLARE @DoCommit bit;      -- 0 = dry run (ROLLBACK), 1 = COMMIT
DECLARE @AuditUserID int;   -- CreatedBy / ModifiedBy
DECLARE @ReloadStaging bit; -- 1 = rebuild staging tables from oldTelquote, 0 = reuse existing _ tables
DECLARE @LoadOverridesFromCsv bit; -- 1 = BULK INSERT from CSV into raw override table
DECLARE @OverridesCsvPath nvarchar(4000);

SET @DoCommit = 0;
SET @AuditUserID = 36;
SET @ReloadStaging = 1;
SET @LoadOverridesFromCsv = 0;
SET @OverridesCsvPath = N'C:\Users\dim.kyriazis\fastquote\docs\tes.csv';

IF @ReloadStaging = 1
BEGIN
    IF DB_ID(N'oldTelquote') IS NULL
    BEGIN
        RAISERROR('Source database oldTelquote not found on this SQL Server instance.', 16, 1);
        RETURN;
    END

    IF OBJECT_ID('dbo._Customers', 'U') IS NOT NULL
        DROP TABLE dbo._Customers;

    IF OBJECT_ID('dbo._CustomerGroups', 'U') IS NOT NULL
        DROP TABLE dbo._CustomerGroups;

    SELECT *
    INTO dbo._Customers
    FROM [oldTelquote].dbo.Customers;

    SELECT *
    INTO dbo._CustomerGroups
    FROM [oldTelquote].dbo.[Customer Groups];
END

IF OBJECT_ID('dbo._Customers', 'U') IS NULL OR OBJECT_ID('dbo._CustomerGroups', 'U') IS NULL
BEGIN
    RAISERROR('Staging tables dbo._Customers or dbo._CustomerGroups are missing.', 16, 1);
    RETURN;
END

IF OBJECT_ID('dbo._CustomerLocationOverrides', 'U') IS NULL
BEGIN
    CREATE TABLE dbo._CustomerLocationOverrides (
        _OldCustomerID int NOT NULL PRIMARY KEY,
        CurrentCity nvarchar(200) NULL,
        CurrentCountry nvarchar(100) NULL
    );
END

IF OBJECT_ID('dbo._CustomerLocationOverridesRaw', 'U') IS NULL
BEGIN
    CREATE TABLE dbo._CustomerLocationOverridesRaw (
        _OldCustomerID int NULL,
        _OldCityName nvarchar(200) NULL,
        CurrentCity nvarchar(200) NULL,
        _OldCountryName nvarchar(100) NULL,
        CurrentCountry nvarchar(100) NULL,
        Address nvarchar(300) NULL,
        _TrailingEmpty nvarchar(10) NULL
    );
END

IF COL_LENGTH('dbo._CustomerLocationOverridesRaw', '_TrailingEmpty') IS NULL
BEGIN
    ALTER TABLE dbo._CustomerLocationOverridesRaw
    ADD _TrailingEmpty nvarchar(10) NULL;
END

IF @LoadOverridesFromCsv = 1
BEGIN
    IF NULLIF(LTRIM(RTRIM(@OverridesCsvPath)), '') IS NULL
    BEGIN
        RAISERROR('@OverridesCsvPath is empty while @LoadOverridesFromCsv = 1.', 16, 1);
        RETURN;
    END

    TRUNCATE TABLE dbo._CustomerLocationOverridesRaw;

    DECLARE @BulkSql nvarchar(max);
    SET @BulkSql = N'BULK INSERT dbo._CustomerLocationOverridesRaw
          FROM ' + QUOTENAME(@OverridesCsvPath, '''') + N'
          WITH (
            FIRSTROW = 2,
            FIELDTERMINATOR = '';'',
            ROWTERMINATOR = ''0x0A'',
            CODEPAGE = ''65001'',
            TABLOCK
          );';

    EXEC sys.sp_executesql @BulkSql;
END

IF EXISTS (SELECT 1 FROM dbo._CustomerLocationOverridesRaw)
BEGIN
    TRUNCATE TABLE dbo._CustomerLocationOverrides;

    INSERT INTO dbo._CustomerLocationOverrides (_OldCustomerID, CurrentCity, CurrentCountry)
    SELECT
        r._OldCustomerID,
        MAX(NULLIF(LTRIM(RTRIM(r.CurrentCity)), '')) AS CurrentCity,
        MAX(NULLIF(LTRIM(RTRIM(r.CurrentCountry)), '')) AS CurrentCountry
    FROM dbo._CustomerLocationOverridesRaw r
    WHERE r._OldCustomerID IS NOT NULL
    GROUP BY r._OldCustomerID;
END

BEGIN TRY
    BEGIN TRAN;

    /* Auto-create missing countries found in overrides raw/final */
    IF OBJECT_ID('dbo.Countries', 'U') IS NULL
    BEGIN
        RAISERROR('Target table dbo.Countries is missing.', 16, 1);
        RETURN;
    END

    DECLARE @CountryInsertCols nvarchar(max);
    DECLARE @CountrySelectCols nvarchar(max);
    DECLARE @CountryInsertSql nvarchar(max);

    SET @CountryInsertCols = N'[Name]';
    SET @CountrySelectCols = N's.CountryName';

    IF COL_LENGTH('dbo.Countries', 'Enabled') IS NOT NULL
    BEGIN
        SET @CountryInsertCols = @CountryInsertCols + N',[Enabled]';
        SET @CountrySelectCols = @CountrySelectCols + N',1';
    END
    IF COL_LENGTH('dbo.Countries', 'CreatedOn') IS NOT NULL
    BEGIN
        SET @CountryInsertCols = @CountryInsertCols + N',[CreatedOn]';
        SET @CountrySelectCols = @CountrySelectCols + N',GETDATE()';
    END
    IF COL_LENGTH('dbo.Countries', 'CreatedBy') IS NOT NULL
    BEGIN
        SET @CountryInsertCols = @CountryInsertCols + N',[CreatedBy]';
        SET @CountrySelectCols = @CountrySelectCols + N',@AuditUserID';
    END
    IF COL_LENGTH('dbo.Countries', 'ModifiedOn') IS NOT NULL
    BEGIN
        SET @CountryInsertCols = @CountryInsertCols + N',[ModifiedOn]';
        SET @CountrySelectCols = @CountrySelectCols + N',GETDATE()';
    END
    IF COL_LENGTH('dbo.Countries', 'ModifiedBy') IS NOT NULL
    BEGIN
        SET @CountryInsertCols = @CountryInsertCols + N',[ModifiedBy]';
        SET @CountrySelectCols = @CountrySelectCols + N',@AuditUserID';
    END

    SET @CountryInsertSql = N'
;WITH src AS (
    SELECT DISTINCT NULLIF(LTRIM(RTRIM(r.CurrentCountry)), '''') AS CountryName
    FROM dbo._CustomerLocationOverridesRaw r
    WHERE NULLIF(LTRIM(RTRIM(r.CurrentCountry)), '''') IS NOT NULL
    UNION
    SELECT DISTINCT NULLIF(LTRIM(RTRIM(o.CurrentCountry)), '''') AS CountryName
    FROM dbo._CustomerLocationOverrides o
    WHERE NULLIF(LTRIM(RTRIM(o.CurrentCountry)), '''') IS NOT NULL
)
INSERT INTO dbo.Countries (' + @CountryInsertCols + N')
SELECT ' + @CountrySelectCols + N'
FROM src s
LEFT JOIN dbo.Countries c
  ON LTRIM(RTRIM(c.[Name])) = LTRIM(RTRIM(s.CountryName))
WHERE c.[Name] IS NULL;';

    EXEC sys.sp_executesql @CountryInsertSql, N'@AuditUserID int', @AuditUserID;

    /* Ensure legacy text helper columns exist */
    IF COL_LENGTH('dbo.Customers', '_OldCountryName') IS NULL
        ALTER TABLE dbo.Customers ADD _OldCountryName nvarchar(100) NULL;

    IF COL_LENGTH('dbo.Customers', '_OldCityName') IS NULL
        ALTER TABLE dbo.Customers ADD _OldCityName nvarchar(100) NULL;

    IF COL_LENGTH('dbo.Customers', 'City') IS NULL
    BEGIN
        RAISERROR('Expected dbo.Customers.City column (nvarchar) was not found.', 16, 1);
        RETURN;
    END

    DECLARE @CityMaxLen int;
    SET @CityMaxLen =
    CASE
        WHEN COL_LENGTH('dbo.Customers', 'City') = -1 THEN 4000
        WHEN COL_LENGTH('dbo.Customers', 'City') IS NULL THEN 100
        ELSE COL_LENGTH('dbo.Customers', 'City') / 2
    END;

    /* Optional truncation audit table (create once) */
    IF OBJECT_ID('dbo._Customers_TruncationAudit', 'U') IS NULL
    BEGIN
        SELECT
            c.CustomerID,
            c.[Company Name],
            c.[Official Name],
            c.[Address],
            c.[Postal Code],
            c.[Phone],
            c.[Email],
            c.[Web Site]
        INTO dbo._Customers_TruncationAudit
        FROM dbo._Customers c
        WHERE LEN(ISNULL(LTRIM(RTRIM(c.[Postal Code])), '')) > 15
           OR LEN(ISNULL(LTRIM(RTRIM(c.[Phone])), '')) > 20
           OR LEN(ISNULL(LTRIM(RTRIM(c.[Address])), '')) > 50
           OR LEN(ISNULL(LTRIM(RTRIM(c.[Company Name])), '')) > 50
           OR LEN(ISNULL(LTRIM(RTRIM(c.[Official Name])), '')) > 50
           OR LEN(ISNULL(LTRIM(RTRIM(c.[Email])), '')) > 50
           OR LEN(ISNULL(LTRIM(RTRIM(c.[Web Site])), '')) > 50;
    END

    /* Group map: old GroupID -> new CustomerGroups.ID by name */
    IF OBJECT_ID('tempdb..#GroupMap') IS NOT NULL DROP TABLE #GroupMap;
    CREATE TABLE #GroupMap (
        OldGroupID nvarchar(3) PRIMARY KEY,
        NewCustomerGroupID int NOT NULL
    );

    INSERT INTO #GroupMap (OldGroupID, NewCustomerGroupID)
    SELECT og.GroupID, ng.ID
    FROM dbo._CustomerGroups og
    JOIN dbo.CustomerGroups ng
      ON LTRIM(RTRIM(og.[Group])) = LTRIM(RTRIM(ng.Name));

    /* Insert missing customers only (idempotent by _OldCustomerID) */
    ;WITH src AS (
        SELECT c.*
        FROM dbo._Customers c
        WHERE NOT EXISTS (
            SELECT 1
            FROM dbo.Customers x
            WHERE x._OldCustomerID = c.CustomerID
        )
    )
    INSERT INTO dbo.Customers (
        Name, BrandName, CustomerGroupID, TaxID, TaxOffice, CountryID, City,
        Address, PostalCode, Phone, Profession, Email, WebSite,
        IsParent, ParentCustomerID, Importance, Notes, Enabled,
        CreatedOn, CreatedBy, ModifiedOn, ModifiedBy, PricingPolicyID, _OldCustomerID,
        _OldCountryName, _OldCityName
    )
    SELECT
        LEFT(src.[Company Name], 50),
        LEFT(src.[Official Name], 50),
        gm.NewCustomerGroupID,
        LEFT(NULLIF(LTRIM(RTRIM(src.[ΑΦΜ])), ''), 18),
        LEFT(NULLIF(LTRIM(RTRIM(src.[ΔΟΥ])), ''), 50),
        co.ID,  -- exact country name match only
        LEFT(
            COALESCE(
                NULLIF(LTRIM(RTRIM(ov.CurrentCity)), ''),
                NULLIF(LTRIM(RTRIM(src.City)), '')
            ),
            @CityMaxLen
        ),
        LEFT(src.[Address], 50),
        LEFT(NULLIF(LTRIM(RTRIM(src.[Postal Code])), ''), 15),
        LEFT(NULLIF(LTRIM(RTRIM(src.[Phone])), ''), 20),
        LEFT(NULLIF(LTRIM(RTRIM(src.[Profession])), ''), 100),
        LEFT(NULLIF(LTRIM(RTRIM(src.[Email])), ''), 50),
        LEFT(NULLIF(LTRIM(RTRIM(src.[Web Site])), ''), 50),
        CASE WHEN src.ParentCustomerID IS NULL THEN 1 ELSE 0 END,
        NULL, -- set after insert
        src.Importance,
        CONVERT(nvarchar(max), src.Notes),
        CASE WHEN ISNULL(src.DeletedItem, 0) = 1 THEN 0 ELSE 1 END,
        GETDATE(), @AuditUserID, GETDATE(), @AuditUserID,
        N'',
        src.CustomerID,
        NULLIF(LTRIM(RTRIM(src.Country)), ''),
        NULLIF(LTRIM(RTRIM(src.City)), '')
    FROM src
    LEFT JOIN dbo._CustomerLocationOverrides ov
      ON ov._OldCustomerID = src.CustomerID
    LEFT JOIN #GroupMap gm
      ON gm.OldGroupID = src.GroupID
    LEFT JOIN dbo.Countries co
      ON LTRIM(RTRIM(co.Name)) = LTRIM(RTRIM(
            COALESCE(
                NULLIF(LTRIM(RTRIM(ov.CurrentCountry)), ''),
                NULLIF(LTRIM(RTRIM(src.Country)), '')
            )
          ));

    /* Parent mapping via _OldCustomerID */
    UPDATE child
    SET child.ParentCustomerID = parent.ID
    FROM dbo.Customers child
    JOIN dbo._Customers oldc
      ON oldc.CustomerID = child._OldCustomerID
    JOIN dbo.Customers parent
      ON parent._OldCustomerID = oldc.ParentCustomerID
    WHERE oldc.ParentCustomerID IS NOT NULL
      AND child.ParentCustomerID IS NULL;

    /* Backfill old text helper columns for already existing migrated rows */
    UPDATE c
    SET c._OldCountryName = COALESCE(c._OldCountryName, NULLIF(LTRIM(RTRIM(s.Country)), '')),
        c._OldCityName = COALESCE(c._OldCityName, NULLIF(LTRIM(RTRIM(s.City)), ''))
    FROM dbo.Customers c
    JOIN dbo._Customers s
      ON s.CustomerID = c._OldCustomerID;

    /* Apply explicit country overrides from Excel (when provided) */
    UPDATE c
    SET c.CountryID = co.ID
    FROM dbo.Customers c
    JOIN dbo._CustomerLocationOverrides ov
      ON ov._OldCustomerID = c._OldCustomerID
    JOIN dbo.Countries co
      ON LTRIM(RTRIM(co.Name)) = LTRIM(RTRIM(ov.CurrentCountry))
    WHERE c._OldCustomerID IS NOT NULL
      AND NULLIF(LTRIM(RTRIM(ov.CurrentCountry)), '') IS NOT NULL;

    /* Exact-match refresh for country on rows still null (fallback to raw old text) */
    UPDATE c
    SET c.CountryID = co.ID
    FROM dbo.Customers c
    JOIN dbo.Countries co
      ON LTRIM(RTRIM(co.Name)) = LTRIM(RTRIM(c._OldCountryName))
    WHERE c._OldCustomerID IS NOT NULL
      AND c.CountryID IS NULL
      AND c._OldCountryName IS NOT NULL;

    /* Apply explicit city overrides from Excel (when provided) */
    UPDATE c
    SET c.City = LEFT(NULLIF(LTRIM(RTRIM(ov.CurrentCity)), ''), @CityMaxLen)
    FROM dbo.Customers c
    JOIN dbo._CustomerLocationOverrides ov
      ON ov._OldCustomerID = c._OldCustomerID
    WHERE c._OldCustomerID IS NOT NULL
      AND NULLIF(LTRIM(RTRIM(ov.CurrentCity)), '') IS NOT NULL;

    /* Keep City text in sync for already-existing migrated rows (fallback to raw old text) */
    UPDATE c
    SET c.City = LEFT(
                    NULLIF(LTRIM(RTRIM(c._OldCityName)), ''),
                    @CityMaxLen
                 )
    FROM dbo.Customers c
    WHERE c._OldCustomerID IS NOT NULL
      AND c.City IS NULL
      AND c._OldCityName IS NOT NULL;

    /* Validation output */
    SELECT COUNT(*) AS OldCount FROM dbo._Customers;
    SELECT COUNT(*) AS NewCountWithOldKey FROM dbo.Customers WHERE _OldCustomerID IS NOT NULL;

    SELECT _OldCustomerID, COUNT(*) AS Cnt
    FROM dbo.Customers
    WHERE _OldCustomerID IS NOT NULL
    GROUP BY _OldCustomerID
    HAVING COUNT(*) > 1
    ORDER BY Cnt DESC, _OldCustomerID;

    SELECT COUNT(*) AS MissingParent
    FROM dbo.Customers c
    JOIN dbo._Customers oc
      ON oc.CustomerID = c._OldCustomerID
    WHERE oc.ParentCustomerID IS NOT NULL
      AND c.ParentCustomerID IS NULL;

    SELECT COUNT(*) AS CountryUnmapped
    FROM dbo.Customers c
    WHERE c._OldCustomerID IS NOT NULL
      AND c._OldCountryName IS NOT NULL
      AND c.CountryID IS NULL;

    SELECT COUNT(*) AS CityMissingText
    FROM dbo.Customers c
    WHERE c._OldCustomerID IS NOT NULL
      AND c._OldCityName IS NOT NULL
      AND c.City IS NULL;

    SELECT COUNT(*) AS OverridesLoaded
    FROM dbo._CustomerLocationOverrides;

    SELECT COUNT(*) AS OverrideRawRows
    FROM dbo._CustomerLocationOverridesRaw;

    IF @DoCommit = 1
        COMMIT;
    ELSE
        ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;

    DECLARE @ErrMsg nvarchar(4000);
    SET @ErrMsg = ERROR_MESSAGE();

    RAISERROR(@ErrMsg, 16, 1);
    RETURN;
END CATCH;
GO
