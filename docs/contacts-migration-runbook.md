# Contacts Migration Runbook (oldTelquote -> SQL Server)

This guide documents the exact process used to migrate `Contacts`.

## 1) Files and Objects

- Migration script: `scripts/sql/run_contacts_migration.sql`

Tables used:
- Source staging: `dbo._Contacts`
- Target: `dbo.Contacts`
- Required parent mapping table: `dbo.Customers` (must already contain `_OldCustomerID`)

## 2) Prerequisites

1. `Customers` migration completed.
2. `dbo.Customers._OldCustomerID` populated.
3. `dbo._Contacts` exists in target DB (for test env with `@ReloadStaging = 0`).

## 3) Staging Import (`_Contacts`)

If `oldTelquote` is not available on same instance, import `Contacts` via SSMS wizard into `dbo._Contacts`.

Recommended staging schema is permissive (`nvarchar` widths large enough) to avoid wizard failures.

## 4) Script Settings

For test on `TelQuote`:
- `USE [TelQuote]`
- `SET @ReloadStaging = 0`
- `SET @DoCommit = 0` first, then `1`

For production on `FastQuote` (same instance as `oldTelquote`):
- `USE [FastQuote]`
- `SET @ReloadStaging = 1` (optional, if source DB is reachable)
- `SET @DoCommit = 0` first, then `1`

## 5) Logic Implemented

- Idempotent insert using old key:
  - `dbo.Contacts._OldID` or `dbo.Contacts._OldContactID`
- Customer mapping:
  - `Contacts.CustomerID` <- `Customers.ID` by join on `Customers._OldCustomerID = _Contacts.CustomerID`
- Enabled:
  - `Enabled = CASE WHEN DeletedItem = 1 THEN 0 ELSE 1 END`
- Email status:
  - optional via `@EmailStatusInvalidID` and `@EmailStatusUnsubscribedID`
  - when both are `NULL`, script writes `CAST(NULL AS int)` safely

## 6) Constraints Handled

The script includes fallbacks for strict constraints:

- `LastName NOT NULL`
  - uses `Last Name`, fallback `First Name`, fallback `'-'`
- `FirstName NOT NULL`
  - uses `First Name`, fallback `Last Name`, fallback `'-'`
- `TitleID` FK / `NOT NULL`
  - maps source `TitleID` only if exists in `dbo.Titles`
  - fallback to `@DefaultTitleID` (auto-picked as first `dbo.Titles.ID` when needed)

## 7) Validation Output

Script returns:
- `OldContactsCount`
- `NewContactsWithOldKey`
- duplicate old-contact IDs result set
- `ContactsWithoutCustomerMapping`

Expected healthy run:
- `OldContactsCount = NewContactsWithOldKey`
- no duplicate old-contact IDs
- `ContactsWithoutCustomerMapping = 0`

## 8) Common Errors and Fixes

- `Staging table dbo._Contacts is missing`
  - Import/create `_Contacts` first, or use `@ReloadStaging = 1` if source DB is reachable.

- `Cannot insert NULL into LastName/FirstName`
  - handled in script with fallback values.

- `FK_CustomerContacts_Titles` conflict
  - handled by title join + fallback default title.

## 9) Commit Procedure

1. Run with `@DoCommit = 0`.
2. Review validation result sets.
3. Run again with `@DoCommit = 1`.
4. Keep `@ReloadStaging = 0` for repeat runs in test unless source staging is reloaded.
