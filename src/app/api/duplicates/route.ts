import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { getRequestId } from "../../../lib/requestId";
import { handleApiError } from "../../../lib/errorHandler";

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
          .input("name", sql.NVarChar(512), `%${name}%`)
          .query<{ ID: number; Name: string; TaxID: string | null }>(
            `SELECT TOP 10 ID, Name, TaxID FROM dbo.Customers WHERE Name LIKE @name`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: result.recordset.map((r) => ({ id: r.ID, name: r.Name, taxId: r.TaxID })),
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
          .input("name", sql.NVarChar(255), `%${name}%`)
          .query<{ ID: number; Name: string; TaxID: string | null }>(
            `SELECT TOP 10 ID, Name, TaxID FROM dbo.Suppliers WHERE Name LIKE @name`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: result.recordset.map((r) => ({ id: r.ID, name: r.Name, taxId: r.TaxID })),
          });
        }
      }
    }

    if (entity === "brand") {
      const name = body.name?.trim();

      if (name && name.length >= 2) {
        const result = await pool.request()
          .input("name", sql.NVarChar(255), `%${name}%`)
          .query<{ ID: number; Name: string }>(
            `SELECT TOP 10 ID, Name FROM dbo.Brands WHERE Name LIKE @name`
          );
        if (result.recordset.length > 0) {
          warnings.push({
            type: "name",
            label: "Similar Name",
            matches: result.recordset.map((r) => ({ id: r.ID, name: r.Name })),
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

      if (partNumber) {
        const cleared = partNumber.replace(/[-_\s.]+/g, "").toUpperCase();
        const request = pool.request()
          .input("partNumber", sql.NVarChar(255), cleared);
        let partQuery = `SELECT TOP 10 p.ID, p.PartNumber, p.ModelNumber, p.Description FROM dbo.Products p WHERE (p.PartNumberCleared = @partNumber OR p.LegacyPartNoCleaned = @partNumber)`;
        if (brandId) {
          request.input("brandId", sql.Int, brandId);
          partQuery += ` AND p.BrandID = @brandId`;
        }
        const result = await request.query<{ ID: number; PartNumber: string | null; ModelNumber: string | null; Description: string | null }>(partQuery);
        if (result.recordset.length > 0) {
          warnings.push({
            type: "partNumber",
            label: "Same Part Number",
            matches: result.recordset.map((r) => ({
              id: r.ID,
              name: r.Description || `Product #${r.ID}`,
              partNumber: r.PartNumber,
              modelNumber: r.ModelNumber,
            })),
          });
        }
      }

      if (modelNumber) {
        const cleared = modelNumber.replace(/[-_\s.]+/g, "").toUpperCase();
        const request = pool.request()
          .input("modelNumber", sql.NVarChar(255), cleared);
        let modelQuery = `SELECT TOP 10 p.ID, p.PartNumber, p.ModelNumber, p.Description FROM dbo.Products p WHERE p.ModelNumberCleared = @modelNumber`;
        if (brandId) {
          request.input("brandId", sql.Int, brandId);
          modelQuery += ` AND p.BrandID = @brandId`;
        }
        const result = await request.query<{ ID: number; PartNumber: string | null; ModelNumber: string | null; Description: string | null }>(modelQuery);
        if (result.recordset.length > 0) {
          warnings.push({
            type: "modelNumber",
            label: "Same Model Number",
            matches: result.recordset.map((r) => ({
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
