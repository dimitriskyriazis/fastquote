/*
Run on: teldb2 (or TELQUOTEWEB\SQLEXPRESS for test)
Database: FastQuote (or TelQuote for test)

Purpose:
- Build/refresh staging table from source DB (optional):
  - oldTelquote.dbo.Contacts -> dbo._Contacts
- Populate dbo.Contacts safely and idempotently
- Map Contacts.CustomerID using Customers._OldCustomerID
- Apply Enabled / EmailStatus logic

How to use:
1) Set USE [FastQuote] (or [TelQuote] in test env).
2) Set @ReloadStaging:
   - 1 if oldTelquote is available on same SQL instance
   - 0 if dbo._Contacts already exists in target DB
3) Set @DoCommit = 0 and run (dry run).
4) Review validation result sets.
5) Set @DoCommit = 1 and run again.
*/

USE [FastQuote];
GO

DECLARE @DoCommit bit;      -- 0 = dry run (ROLLBACK), 1 = COMMIT
DECLARE @AuditUserID int;   -- CreatedBy / ModifiedBy
DECLARE @ReloadStaging bit; -- 1 = rebuild dbo._Contacts from oldTelquote, 0 = reuse existing _Contacts

/* Optional EmailStatus mapping IDs (leave NULL to skip status write) */
DECLARE @EmailStatusInvalidID int;        -- e.g. WrongEmail status ID
DECLARE @EmailStatusUnsubscribedID int;   -- e.g. Unsubscribed status ID
DECLARE @DefaultTitleID int;              -- fallback when source TitleID does not match dbo.Titles

SET @DoCommit = 0;
SET @AuditUserID = 36;
SET @ReloadStaging = 1;
SET @EmailStatusInvalidID = NULL;
SET @EmailStatusUnsubscribedID = NULL;
SET @DefaultTitleID = NULL;

IF @ReloadStaging = 1
BEGIN
    IF DB_ID(N'oldTelquote') IS NULL
    BEGIN
        RAISERROR('Source database oldTelquote not found on this SQL Server instance.', 16, 1);
        RETURN;
    END

    IF OBJECT_ID('dbo._Contacts', 'U') IS NOT NULL
        DROP TABLE dbo._Contacts;

    SELECT *
    INTO dbo._Contacts
    FROM [oldTelquote].dbo.Contacts;
END

IF OBJECT_ID('dbo._Contacts', 'U') IS NULL
BEGIN
    RAISERROR('Staging table dbo._Contacts is missing.', 16, 1);
    RETURN;
END

IF OBJECT_ID('dbo.Customers', 'U') IS NULL OR OBJECT_ID('dbo.Contacts', 'U') IS NULL
BEGIN
    RAISERROR('Target tables dbo.Customers or dbo.Contacts are missing.', 16, 1);
    RETURN;
END

DECLARE @OldContactKeyCol sysname;
SET @OldContactKeyCol = NULL;

IF COL_LENGTH('dbo.Contacts', '_OldID') IS NOT NULL
    SET @OldContactKeyCol = '_OldID';
ELSE IF COL_LENGTH('dbo.Contacts', '_OldContactID') IS NOT NULL
    SET @OldContactKeyCol = '_OldContactID';

IF @OldContactKeyCol IS NULL
BEGIN
    RAISERROR('dbo.Contacts requires _OldID or _OldContactID column for idempotent import.', 16, 1);
    RETURN;
END

DECLARE @OldTitleCol sysname;
SET @OldTitleCol = NULL;
IF COL_LENGTH('dbo.Contacts', '_OldTitleID') IS NOT NULL
    SET @OldTitleCol = '_OldTitleID';
ELSE IF COL_LENGTH('dbo.Contacts', 'OldTitleID') IS NOT NULL
    SET @OldTitleCol = 'OldTitleID';

DECLARE @HasEmailStatus bit;
SET @HasEmailStatus = CASE WHEN COL_LENGTH('dbo.Contacts', 'EmailStatusID') IS NULL THEN 0 ELSE 1 END;

DECLARE @TitleNotNull bit;
SET @TitleNotNull =
CASE WHEN EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Contacts')
      AND name = 'TitleID'
      AND is_nullable = 0
) THEN 1 ELSE 0 END;

IF @TitleNotNull = 1 AND @DefaultTitleID IS NULL
BEGIN
    SELECT TOP 1 @DefaultTitleID = ID
    FROM dbo.Titles
    ORDER BY ID;
END

IF @TitleNotNull = 1 AND @DefaultTitleID IS NULL
BEGIN
    RAISERROR('dbo.Contacts.TitleID is NOT NULL and no fallback title exists in dbo.Titles.', 16, 1);
    RETURN;
END

DECLARE @LastNameMax int, @FirstNameMax int, @PositionMax int, @PhoneMax int, @MobileMax int, @EmailMax int, @NotesMax int;
SET @LastNameMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'LastName') IS NULL THEN 100 WHEN COL_LENGTH('dbo.Contacts', 'LastName') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'LastName') / 2 END;
SET @FirstNameMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'FirstName') IS NULL THEN 100 WHEN COL_LENGTH('dbo.Contacts', 'FirstName') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'FirstName') / 2 END;
SET @PositionMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'Position') IS NULL THEN 100 WHEN COL_LENGTH('dbo.Contacts', 'Position') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'Position') / 2 END;
SET @PhoneMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'Phone') IS NULL THEN 100 WHEN COL_LENGTH('dbo.Contacts', 'Phone') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'Phone') / 2 END;
SET @MobileMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'Mobile') IS NULL THEN 100 WHEN COL_LENGTH('dbo.Contacts', 'Mobile') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'Mobile') / 2 END;
SET @EmailMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'Email') IS NULL THEN 200 WHEN COL_LENGTH('dbo.Contacts', 'Email') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'Email') / 2 END;
SET @NotesMax = CASE WHEN COL_LENGTH('dbo.Contacts', 'Notes') IS NULL THEN 4000 WHEN COL_LENGTH('dbo.Contacts', 'Notes') = -1 THEN 4000 ELSE COL_LENGTH('dbo.Contacts', 'Notes') / 2 END;

BEGIN TRY
    BEGIN TRAN;

    DECLARE @Sql nvarchar(max);
    SET @Sql = N'
;WITH src AS (
    SELECT s.*
    FROM dbo._Contacts s
    WHERE NOT EXISTS (
        SELECT 1
        FROM dbo.Contacts t
        WHERE t.' + QUOTENAME(@OldContactKeyCol) + N' = s.ContactID
    )
)
INSERT INTO dbo.Contacts (
    CustomerID, TitleID, LastName, FirstName, Position, Phone, Mobile, Email, Notes,
    Importance, Enabled, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy, ' + QUOTENAME(@OldContactKeyCol) +
    CASE WHEN @HasEmailStatus = 1 THEN N', EmailStatusID' ELSE N'' END +
    CASE WHEN @OldTitleCol IS NOT NULL THEN N', ' + QUOTENAME(@OldTitleCol) ELSE N'' END + N'
)
SELECT
    c.ID AS CustomerID,
    COALESCE(tt.ID, ' + ISNULL(CAST(@DefaultTitleID as nvarchar(20)), N'NULL') + N') AS TitleID,
    LEFT(
        COALESCE(
            NULLIF(LTRIM(RTRIM(src.[Last Name])), ''''),
            NULLIF(LTRIM(RTRIM(src.[First Name])), ''''),
            N''-''
        ),
        ' + CAST(@LastNameMax as nvarchar(20)) + N'
    ),
    LEFT(
        COALESCE(
            NULLIF(LTRIM(RTRIM(src.[First Name])), ''''),
            NULLIF(LTRIM(RTRIM(src.[Last Name])), ''''),
            N''-''
        ),
        ' + CAST(@FirstNameMax as nvarchar(20)) + N'
    ),
    LEFT(NULLIF(LTRIM(RTRIM(src.Position)), ''''), ' + CAST(@PositionMax as nvarchar(20)) + N'),
    LEFT(NULLIF(LTRIM(RTRIM(src.Phone)), ''''), ' + CAST(@PhoneMax as nvarchar(20)) + N'),
    LEFT(NULLIF(LTRIM(RTRIM(src.Mobile)), ''''), ' + CAST(@MobileMax as nvarchar(20)) + N'),
    LEFT(NULLIF(LTRIM(RTRIM(src.Email)), ''''), ' + CAST(@EmailMax as nvarchar(20)) + N'),
    LEFT(NULLIF(LTRIM(RTRIM(src.Note)), ''''), ' + CAST(@NotesMax as nvarchar(20)) + N'),
    src.Importance,
    CASE WHEN ISNULL(src.DeletedItem, 0) = 1 THEN 0 ELSE 1 END AS Enabled,
    GETDATE(), ' + CAST(@AuditUserID as nvarchar(20)) + N', GETDATE(), ' + CAST(@AuditUserID as nvarchar(20)) + N',
    src.ContactID' +
    CASE
        WHEN @HasEmailStatus = 1 AND (@EmailStatusInvalidID IS NOT NULL OR @EmailStatusUnsubscribedID IS NOT NULL)
            THEN N',
    CASE
        WHEN ISNULL(src.WrongEmail, 0) = 1 THEN ' + ISNULL(CAST(@EmailStatusInvalidID as nvarchar(20)), N'NULL') + N'
        WHEN ISNULL(src.EmailUnsubscribed, 0) = 1 THEN ' + ISNULL(CAST(@EmailStatusUnsubscribedID as nvarchar(20)), N'NULL') + N'
        ELSE NULL
    END AS EmailStatusID'
        WHEN @HasEmailStatus = 1
            THEN N', CAST(NULL AS int) AS EmailStatusID'
        ELSE N''
    END +
    CASE WHEN @OldTitleCol IS NOT NULL THEN N',
    src.TitleID' ELSE N'' END + N'
FROM src
JOIN dbo.Customers c
  ON c._OldCustomerID = src.CustomerID
LEFT JOIN dbo.Titles tt
  ON tt.ID = TRY_CONVERT(int, src.TitleID);';

    EXEC sys.sp_executesql @Sql;

    /* Validation output */
    SELECT COUNT(*) AS OldContactsCount FROM dbo._Contacts;

    DECLARE @CountSql nvarchar(max);
    SET @CountSql = N'SELECT COUNT(*) AS NewContactsWithOldKey FROM dbo.Contacts WHERE ' + QUOTENAME(@OldContactKeyCol) + N' IS NOT NULL;';
    EXEC sys.sp_executesql @CountSql;

    DECLARE @DupSql nvarchar(max);
    SET @DupSql = N'
SELECT ' + QUOTENAME(@OldContactKeyCol) + N' AS OldContactID, COUNT(*) AS Cnt
FROM dbo.Contacts
WHERE ' + QUOTENAME(@OldContactKeyCol) + N' IS NOT NULL
GROUP BY ' + QUOTENAME(@OldContactKeyCol) + N'
HAVING COUNT(*) > 1
ORDER BY Cnt DESC, ' + QUOTENAME(@OldContactKeyCol) + N';';
    EXEC sys.sp_executesql @DupSql;

    SELECT COUNT(*) AS ContactsWithoutCustomerMapping
    FROM dbo._Contacts s
    LEFT JOIN dbo.Customers c
      ON c._OldCustomerID = s.CustomerID
    WHERE c.ID IS NULL;

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
