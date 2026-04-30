import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { getRequestId } from "../../../lib/requestId";
import { handleApiError } from "../../../lib/errorHandler";
import { clearPartModelNumberUpper, stripXBetweenDigitsSql } from "../../../lib/partModelNumber";

type DuplicateMatch = {
  id: number;
  name: string;
  taxId?: string | null;
  partNumber?: string | null;
  modelNumber?: string | null;
};

type WarningGroup = {
  type: string;
  label: string;
  matches: DuplicateMatch[];
};

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j];
  }
  return prev[cols - 1];
}

function isSimilarName(needle: string, candidate: string): boolean {
  const a = normalizeForCompare(needle);
  const b = normalizeForCompare(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.includes(a)) return true;
  if (b.length >= 2 && a.includes(b)) return true;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  if (maxLen - minLen > 3) return false;
  const distance = levenshtein(a, b);
  const threshold = Math.max(1, Math.floor(maxLen * 0.25));
  return distance <= threshold;
}

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
          .query<{ ID: number; Name: string; TaxID: string | null }>(
            `SELECT TOP 10 ID, Name, TaxID FROM dbo.Customers WHERE TaxID = @taxId`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "taxId",
            label: "Same Tax ID",
            matches: result.recordset.map((r) => ({ id: r.ID, name: r.Name, taxId: r.TaxID })),
          });
        }
      }

      if (name && name.length >= 2) {
        const result = await pool.request()
          .input("name", sql.NVarChar(512), name)
          .input("nameLike", sql.NVarChar(512), `%${name}%`)
          .query<{ ID: number; Name: string; TaxID: string | null }>(
            `SELECT TOP 50 ID, Name, TaxID FROM dbo.Customers
             WHERE Name LIKE @nameLike
                OR @name LIKE '%' + Name + '%'
                OR SOUNDEX(Name) = SOUNDEX(@name)
                OR DIFFERENCE(Name, @name) >= 3`
          );
        const matches = result.recordset
          .filter((r) => isSimilarName(name, r.Name ?? ""))
          .slice(0, 10);
        if (matches.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: matches.map((r) => ({ id: r.ID, name: r.Name, taxId: r.TaxID })),
          });
        }
      }
    }

    if (entity === "supplier") {
      const taxId = body.taxId?.trim();
      const name = body.name?.trim();

      if (taxId) {
        const result = await pool.request()
          .input("taxId", sql.NVarChar(128), taxId)
          .query<{ ID: number; Name: string; TaxID: string | null }>(
            `SELECT TOP 10 ID, Name, TaxID FROM dbo.Suppliers WHERE TaxID = @taxId`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "taxId",
            label: "Same Tax ID",
            matches: result.recordset.map((r) => ({ id: r.ID, name: r.Name, taxId: r.TaxID })),
          });
        }
      }

      if (name && name.length >= 2) {
        const result = await pool.request()
          .input("name", sql.NVarChar(255), name)
          .input("nameLike", sql.NVarChar(255), `%${name}%`)
          .query<{ ID: number; Name: string; TaxID: string | null }>(
            `SELECT TOP 50 ID, Name, TaxID FROM dbo.Suppliers
             WHERE Name LIKE @nameLike
                OR @name LIKE '%' + Name + '%'
                OR SOUNDEX(Name) = SOUNDEX(@name)
                OR DIFFERENCE(Name, @name) >= 3`
          );
        const matches = result.recordset
          .filter((r) => isSimilarName(name, r.Name ?? ""))
          .slice(0, 10);
        if (matches.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: matches.map((r) => ({ id: r.ID, name: r.Name, taxId: r.TaxID })),
          });
        }
      }
    }

    if (entity === "brand") {
      const name = body.name?.trim();

      if (name && name.length >= 2) {
        const result = await pool.request()
          .input("name", sql.NVarChar(255), name)
          .input("nameLike", sql.NVarChar(255), `%${name}%`)
          .query<{ ID: number; Name: string }>(
            `SELECT TOP 50 ID, Name FROM dbo.Brands
             WHERE Name LIKE @nameLike
                OR @name LIKE '%' + Name + '%'
                OR SOUNDEX(Name) = SOUNDEX(@name)
                OR DIFFERENCE(Name, @name) >= 3`
          );
        const matches = result.recordset
          .filter((r) => isSimilarName(name, r.Name ?? ""))
          .slice(0, 10);
        if (matches.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: matches.map((r) => ({ id: r.ID, name: r.Name })),
          });
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
            `SELECT TOP 10 ContactID, FirstName, LastName FROM dbo.CustomerContacts WHERE FirstName LIKE @firstName AND LastName LIKE @lastName`
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
            `SELECT TOP 10 ContactID, FirstName, LastName FROM dbo.CustomerContacts WHERE LastName LIKE @lastName`
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
            CASE WHEN ${stripXBetweenDigitsSql('p.PartNumberCleared')} = @partNumber OR ${stripXBetweenDigitsSql('p.LegacyPartNoCleaned')} = @partNumber THEN 1 ELSE 0 END AS MatchedPart,
            CASE WHEN ${stripXBetweenDigitsSql('p.ModelNumberCleared')} = @partNumber THEN 1 ELSE 0 END AS MatchedModel
          FROM dbo.Products p WHERE (${stripXBetweenDigitsSql('p.PartNumberCleared')} = @partNumber OR ${stripXBetweenDigitsSql('p.LegacyPartNoCleaned')} = @partNumber OR ${stripXBetweenDigitsSql('p.ModelNumberCleared')} = @partNumber)`;
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
            CASE WHEN ${stripXBetweenDigitsSql('p.ModelNumberCleared')} = @modelNumber THEN 1 ELSE 0 END AS MatchedModel,
            CASE WHEN ${stripXBetweenDigitsSql('p.PartNumberCleared')} = @modelNumber OR ${stripXBetweenDigitsSql('p.LegacyPartNoCleaned')} = @modelNumber THEN 1 ELSE 0 END AS MatchedPart
          FROM dbo.Products p WHERE (${stripXBetweenDigitsSql('p.ModelNumberCleared')} = @modelNumber OR ${stripXBetweenDigitsSql('p.PartNumberCleared')} = @modelNumber OR ${stripXBetweenDigitsSql('p.LegacyPartNoCleaned')} = @modelNumber)`;
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
