/*
Run on: teldb2
Database: FastQuote

Purpose:
- Build/refresh staging tables from source DB:
  - oldTelquote.dbo.Customers -> FastQuote.dbo._Customers
  - oldTelquote.dbo.[Customer Groups] -> FastQuote.dbo._CustomerGroups
- Populate dbo.Customers safely and idempotently
- Keep legacy location text in:
  - dbo.Customers._OldCountryName
  - dbo.Customers._OldCityName
- Resolve CountryID/CityID using exact name match only
- Resolve ParentCustomerID by _OldCustomerID mapping

How to use:
1) Open this file in SSMS connected to teldb2.
2) Set @ReloadStaging = 1 to recreate/reload _Customers and _CustomerGroups.
3) Set @DoCommit = 0 for dry run (recommended first).
4) Run script, review result sets.
5) Set @DoCommit = 1 and run again to commit.
*/

USE [FastQuote];
GO

DECLARE @DoCommit bit = 0;      -- 0 = dry run (ROLLBACK), 1 = COMMIT
DECLARE @AuditUserID int = 36;  -- CreatedBy / ModifiedBy
DECLARE @ReloadStaging bit = 1; -- 1 = rebuild staging tables from oldTelquote, 0 = reuse existing _ tables

IF DB_ID(N'oldTelquote') IS NULL
BEGIN
    THROW 50001, 'Source database oldTelquote not found on this SQL Server instance.', 1;
END

IF @ReloadStaging = 1
BEGIN
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
    THROW 50002, 'Staging tables dbo._Customers or dbo._CustomerGroups are missing.', 1;
END

BEGIN TRY
    BEGIN TRAN;

    /* Ensure legacy text helper columns exist */
    IF COL_LENGTH('dbo.Customers', '_OldCountryName') IS NULL
        ALTER TABLE dbo.Customers ADD _OldCountryName nvarchar(100) NULL;

    IF COL_LENGTH('dbo.Customers', '_OldCityName') IS NULL
        ALTER TABLE dbo.Customers ADD _OldCityName nvarchar(100) NULL;

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
        Name, BrandName, CustomerGroupID, TaxID, TaxOffice, CountryID, CityID,
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
        ci.ID,  -- exact city + country match only
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
    LEFT JOIN #GroupMap gm
      ON gm.OldGroupID = src.GroupID
    LEFT JOIN dbo.Countries co
      ON LTRIM(RTRIM(co.Name)) = LTRIM(RTRIM(src.Country))
    LEFT JOIN dbo.Cities ci
      ON LTRIM(RTRIM(ci.Name)) = LTRIM(RTRIM(src.City))
     AND ci.CountryID = co.ID;

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

    /* Exact-match refresh for location IDs on rows still null */
    UPDATE c
    SET c.CountryID = co.ID
    FROM dbo.Customers c
    JOIN dbo.Countries co
      ON LTRIM(RTRIM(co.Name)) = LTRIM(RTRIM(c._OldCountryName))
    WHERE c._OldCustomerID IS NOT NULL
      AND c.CountryID IS NULL
      AND c._OldCountryName IS NOT NULL;

    UPDATE c
    SET c.CityID = ci.ID
    FROM dbo.Customers c
    JOIN dbo.Cities ci
      ON LTRIM(RTRIM(ci.Name)) = LTRIM(RTRIM(c._OldCityName))
     AND ci.CountryID = c.CountryID
    WHERE c._OldCustomerID IS NOT NULL
      AND c.CityID IS NULL
      AND c._OldCityName IS NOT NULL
      AND c.CountryID IS NOT NULL;

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

    SELECT COUNT(*) AS CityUnmapped
    FROM dbo.Customers c
    WHERE c._OldCustomerID IS NOT NULL
      AND c._OldCityName IS NOT NULL
      AND c.CityID IS NULL;

    IF @DoCommit = 1
        COMMIT;
    ELSE
        ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    THROW;
END CATCH;
GO
