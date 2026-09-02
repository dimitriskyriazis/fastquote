import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { getRequestId } from "../../../lib/requestId";
import { handleApiError } from "../../../lib/errorHandler";
import {clearPartModelNumberUpper} from "../../../lib/partModelNumber";
import { SEARCH_COLLATION } from "../../../lib/textSearch";
import { findSimilarNames } from "../../../lib/similarNameIndexCache";
import type { SimilarName } from "../../../lib/similarNames";

// Duplicate detection is deliberately fuzzy: creating "Ελλας ΑΕ" when "Ελλάς ΑΕ"
// already exists is exactly the collision we want to warn about, but the database
// collation is accent-sensitive so those two never matched.
const AI = `COLLATE ${SEARCH_COLLATION}`;

type DuplicateMatch = {
  id: number;
  name: string;
  taxId?: string | null;
  partNumber?: string | null;
  modelNumber?: string | null;
  disabled?: boolean;
  /** Customers: the official name the match was made on, when not the name itself. */
  officialName?: string | null;
};

type WarningGroup = {
  type: string;
  label: string;
  matches: DuplicateMatch[];
};

// Name similarity for customers, suppliers and brands is scored in memory by
// lib/similarNames against an index of the whole table (lib/similarNameIndexCache
// keeps it fresh). It used to be a SQL LIKE / SOUNDEX / DIFFERENCE query capped
// at TOP 50 with no ORDER BY, which for Greek names, where SOUNDEX is blind,
// returned 50 arbitrary customers; see the header of lib/similarNames.
const toNameMatch = (match: SimilarName): DuplicateMatch => ({
  id: match.id,
  name: match.name,
  taxId: match.taxId,
  disabled: match.enabled === false,
  officialName: match.officialName,
});

export async function POST(req: NextRequest) {
  logRequest(req, '/api/duplicates');
  const requestId = await getRequestId(req);

  try {
    const body = (await req.json()) as {
      entity?: string;
      name?: string;
      taxId?: string;
      firstName?: string;
      lastName?: string;
      partNumber?: string;
      modelNumber?: string;
      brandId?: string;
    };

    const entity = body.entity;
    if (!entity) {
      return NextResponse.json({ ok: false, error: "Entity type is required." }, { status: 400 });
    }

    const pool = await getPool();
    const warnings: WarningGroup[] = [];

    if (entity === "customer") {
      const taxId = body.taxId?.trim();
      const name = body.name?.trim();

      if (taxId) {
        const result = await pool.request()
          .input("taxId", sql.NVarChar(128), taxId)
          .query<{ ID: number; Name: string; TaxID: string | null; Enabled: boolean | null }>(
            `SELECT TOP 10 ID, Name, TaxID, Enabled FROM dbo.Customers WHERE TaxID = @taxId`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "taxId",
            label: "Same Tax ID",
            matches: result.recordset.map((r) => ({
              id: r.ID, name: r.Name, taxId: r.TaxID, disabled: r.Enabled === false,
            })),
          });
        }
      }

      if (name && name.length >= 2) {
        const matches = await findSimilarNames("customer", name);
        if (matches.length > 0) {
          warnings.push({ type: "name", label: "Similar Name", matches: matches.map(toNameMatch) });
        }
      }
    }

    if (entity === "supplier") {
      const taxId = body.taxId?.trim();
      const name = body.name?.trim();

      if (taxId) {
        const result = await pool.request()
          .input("taxId", sql.NVarChar(128), taxId)
          .query<{ ID: number; Name: string; TaxID: string | null; Enabled: boolean | null }>(
            `SELECT TOP 10 ID, Name, RTRIM(TaxID) AS TaxID, Enabled FROM dbo.Suppliers WHERE TaxID = @taxId`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "taxId",
            label: "Same Tax ID",
            matches: result.recordset.map((r) => ({
              id: r.ID, name: r.Name, taxId: r.TaxID, disabled: r.Enabled === false,
            })),
          });
        }
      }

      if (name && name.length >= 2) {
        const matches = await findSimilarNames("supplier", name);
        if (matches.length > 0) {
          warnings.push({ type: "name", label: "Similar Name", matches: matches.map(toNameMatch) });
        }
      }
    }

    if (entity === "brand") {
      const name = body.name?.trim();

      if (name && name.length >= 2) {
        const matches = await findSimilarNames("brand", name);
        if (matches.length > 0) {
          warnings.push({ type: "name", label: "Similar Name", matches: matches.map(toNameMatch) });
        }
      }
    }

    if (entity === "contact") {
      const firstName = body.firstName?.trim();
      const lastName = body.lastName?.trim();

      if (firstName && firstName.length >= 2 && lastName && lastName.length >= 2) {
        const result = await pool.request()
          .input("firstName", sql.NVarChar(120), `%${firstName}%`)
          .input("lastName", sql.NVarChar(120), `%${lastName}%`)
          .query<{ ContactID: number; FirstName: string | null; LastName: string | null }>(
            `SELECT TOP 10 ContactID, FirstName, LastName FROM dbo.CustomerContacts WHERE FirstName ${AI} LIKE @firstName AND LastName ${AI} LIKE @lastName`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: result.recordset.map((r) => ({
              id: r.ContactID,
              name: [r.FirstName, r.LastName].filter(Boolean).join(" "),
            })),
          });
        }
      } else if (lastName && lastName.length >= 2) {
        const result = await pool.request()
          .input("lastName", sql.NVarChar(120), `%${lastName}%`)
          .query<{ ContactID: number; FirstName: string | null; LastName: string | null }>(
            `SELECT TOP 10 ContactID, FirstName, LastName FROM dbo.CustomerContacts WHERE LastName ${AI} LIKE @lastName`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Last Name",
            matches: result.recordset.map((r) => ({
              id: r.ContactID,
              name: [r.FirstName, r.LastName].filter(Boolean).join(" "),
            })),
          });
        }
      }
    }

    if (entity === "product") {
      const partNumber = body.partNumber?.trim();
      const modelNumber = body.modelNumber?.trim();
      const brandId = body.brandId ? parseInt(body.brandId, 10) : null;

      const clearedPart = partNumber ? clearPartModelNumberUpper(partNumber) : "";
      if (clearedPart) {
        const cleared = clearedPart;
        const request = pool.request()
          .input("partNumber", sql.NVarChar(255), cleared);
        let partQuery = `SELECT TOP 10 p.ID, p.PartNumber, p.ModelNumber, p.Description,
            CASE WHEN ${'p.PartNumberCleared'} = @partNumber OR ${'p.LegacyPartNoCleaned'} = @partNumber THEN 1 ELSE 0 END AS MatchedPart,
            CASE WHEN ${'p.ModelNumberCleared'} = @partNumber THEN 1 ELSE 0 END AS MatchedModel
          FROM dbo.Products p WHERE (${'p.PartNumberCleared'} = @partNumber OR ${'p.LegacyPartNoCleaned'} = @partNumber OR ${'p.ModelNumberCleared'} = @partNumber)`;
        if (brandId) {
          request.input("brandId", sql.Int, brandId);
          partQuery += ` AND p.BrandID = @brandId`;
        }
        const result = await request.query<{ ID: number; PartNumber: string | null; ModelNumber: string | null; Description: string | null; MatchedPart: number; MatchedModel: number }>(partQuery);
        const samePart = result.recordset.filter((r) => r.MatchedPart === 1);
        const crossModel = result.recordset.filter((r) => r.MatchedPart !== 1 && r.MatchedModel === 1);
        if (samePart.length > 0) {
          warnings.push({
            type: "partNumber",
            label: "Same Part Number",
            matches: samePart.map((r) => ({
              id: r.ID,
              name: r.Description || `Product #${r.ID}`,
              partNumber: r.PartNumber,
              modelNumber: r.ModelNumber,
            })),
          });
        }
        if (crossModel.length > 0) {
          warnings.push({
            type: "partNumberAsModel",
            label: "Part Number entered matches existing Model Number",
            matches: crossModel.map((r) => ({
              id: r.ID,
              name: r.Description || `Product #${r.ID}`,
              partNumber: r.PartNumber,
              modelNumber: r.ModelNumber,
            })),
          });
        }
      }

      const clearedModel = modelNumber ? clearPartModelNumberUpper(modelNumber) : "";
      if (clearedModel) {
        const cleared = clearedModel;
        const request = pool.request()
          .input("modelNumber", sql.NVarChar(255), cleared);
        let modelQuery = `SELECT TOP 10 p.ID, p.PartNumber, p.ModelNumber, p.Description,
            CASE WHEN ${'p.ModelNumberCleared'} = @modelNumber THEN 1 ELSE 0 END AS MatchedModel,
            CASE WHEN ${'p.PartNumberCleared'} = @modelNumber OR ${'p.LegacyPartNoCleaned'} = @modelNumber THEN 1 ELSE 0 END AS MatchedPart
          FROM dbo.Products p WHERE (${'p.ModelNumberCleared'} = @modelNumber OR ${'p.PartNumberCleared'} = @modelNumber OR ${'p.LegacyPartNoCleaned'} = @modelNumber)`;
        if (brandId) {
          request.input("brandId", sql.Int, brandId);
          modelQuery += ` AND p.BrandID = @brandId`;
        }
        const result = await request.query<{ ID: number; PartNumber: string | null; ModelNumber: string | null; Description: string | null; MatchedModel: number; MatchedPart: number }>(modelQuery);
        const sameModel = result.recordset.filter((r) => r.MatchedModel === 1);
        const crossPart = result.recordset.filter((r) => r.MatchedModel !== 1 && r.MatchedPart === 1);
        if (sameModel.length > 0) {
          warnings.push({
            type: "modelNumber",
            label: "Same Model Number",
            matches: sameModel.map((r) => ({
              id: r.ID,
              name: r.Description || `Product #${r.ID}`,
              partNumber: r.PartNumber,
              modelNumber: r.ModelNumber,
            })),
          });
        }
        if (crossPart.length > 0) {
          warnings.push({
            type: "modelNumberAsPart",
            label: "Model Number entered matches existing Part Number",
            matches: crossPart.map((r) => ({
              id: r.ID,
              name: r.Description || `Product #${r.ID}`,
              partNumber: r.PartNumber,
              modelNumber: r.ModelNumber,
            })),
          });
        }
      }
    }

    return NextResponse.json({ ok: true, warnings });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/duplicates",
      method: "POST",
    });
  }
}
