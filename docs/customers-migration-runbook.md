# Customers Migration Runbook (Access/oldTelquote -> SQL Server)

This guide documents the exact process we used to migrate `Customers` safely.

## 1) Files and Objects

- Migration script: `scripts/sql/run_customers_migration.sql`
- Overrides CSV: `docs/tes.csv`

Tables used:
- Source staging: `dbo._Customers`, `dbo._CustomerGroups`
- Override staging: `dbo._CustomerLocationOverridesRaw`
- Override final map: `dbo._CustomerLocationOverrides`
- Target: `dbo.Customers`

## 2) Data Model Decisions

- `Customers.City` is text (`nvarchar`) and is populated as text.
- `CountryID` is resolved by country name match.
- Missing countries appearing in `dbo._CustomerLocationOverridesRaw.CurrentCountry` are auto-created in `dbo.Countries` by the migration script.
- Keep legacy source text:
  - `Customers._OldCountryName`
  - `Customers._OldCityName`
- Do not use alias tables in this flow.

## 3) Pre-Run Safety

Run migration first with:
- `@DoCommit = 0` (dry run)

Then run again with:
- `@DoCommit = 1` (commit)

## 4) Override CSV Import (No BULK permission path)

Because login did not have `bulkadmin`, CSV was imported with SSMS wizard.

Use SSMS `Tasks -> Import Data...`:
- Source: Flat File (`tes.csv`)
- Encoding: UTF-8 (`65001`)
- Row delimiter: `{CR}{LF}`
- Column delimiter: `;`
- First row has headers: checked
- In `Advanced`, set text columns as Unicode (`DT_WSTR`) and adequate widths.
- Destination DB: `TelQuote` (or `FastQuote` in prod)
- Destination table: `dbo._CustomerLocationOverridesRaw`
- Append rows to destination table

Required mappings:
- `OldCustomerID` -> `_OldCustomerID`
- `OldCityName` -> `_OldCityName`
- `Current City` -> `CurrentCity`
- `OldCountryName` -> `_OldCountryName`
- `Current Country` -> `CurrentCountry`
- `Address` -> `Address` (optional; can ignore)

Important:
- Do **not** import into `dbo.tes` or any new table.
- If text looks garbled (mojibake), re-import with proper UTF-8 + Unicode settings.

## 5) Script Settings Per Environment

### Test on `TELQUOTEWEB\SQLEXPRESS` / `TelQuote`

In `scripts/sql/run_customers_migration.sql`, use:
- `USE [TelQuote]`
- `SET @ReloadStaging = 0` (reuse existing `_Customers`, `_CustomerGroups`)
- `SET @LoadOverridesFromCsv = 0` (since overrides already loaded via wizard)
- `SET @DoCommit = 0` first, then `1`

### Production on `teldb2` / `FastQuote`

Use:
- `USE [FastQuote]`
- `SET @ReloadStaging = 1` if source DB `oldTelquote` is reachable on same instance
- `SET @LoadOverridesFromCsv = 0` (recommended unless bulk permissions exist)
- `SET @DoCommit = 0` first, then `1`

## 6) Optional: Clear Target Data Before Test

If needed, delete dependent data first (children before `Customers`) and then clear `Customers`.
We used FK-driven cleanup and self-reference nulling for `ParentCustomerID`.

## 7) Validation Outputs (from migration script)

Script returns:
- `OldCount`
- `NewCountWithOldKey`
- duplicate `_OldCustomerID` resultset
- `MissingParent`
- `CountryUnmapped`
- `CityMissingText`
- `OverridesLoaded`
- `OverrideRawRows`

Expected healthy run:
- `OldCount = NewCountWithOldKey`
- no duplicate `_OldCustomerID`
- `MissingParent = 0`
- `CityMissingText = 0`
- `OverridesLoaded > 0` if override file was loaded
- `CountryUnmapped` can remain > 0 if no match exists in `Countries`

## 8) Known Issues and Fixes

- Error: `Source database oldTelquote not found`
  - Set `@ReloadStaging = 0` or run on server where `oldTelquote` exists.

- Error: `You do not have permission to use the bulk load statement`
  - Set `@LoadOverridesFromCsv = 0`
  - Use SSMS Import Wizard into `dbo._CustomerLocationOverridesRaw`.

- Import truncation/codepage errors
  - Use UTF-8 + Unicode columns in wizard
  - Increase source width
  - Ignore `Address` if not needed

- Syntax errors on old SQL Server (`DECLARE @x = ...`, `THROW`)
  - Script was made backward-compatible (`DECLARE` + `SET`, `RAISERROR`).

## 9) Commit Procedure

1. Run script with dry run:
   - `@DoCommit = 0`
2. Confirm validation outputs.
3. Run script again with:
   - `@DoCommit = 1`
4. Keep:
   - `@ReloadStaging = 0`
   - `@LoadOverridesFromCsv = 0`
   for repeat commit runs unless source/override data changed.
