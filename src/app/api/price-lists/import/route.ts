import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import sql from "mssql";
import type { ConnectionPool } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";

export const runtime = "nodejs";

type ParsedPriceListRow = {
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  listPrice: number | null;
  warning: string | null;
};

type ProductRow = {
  ID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandID: number | null;
};

type HeaderColumnKey = "partNumber" | "modelNumber" | "description" | "listPrice" | "warning";

const HEADER_SYNONYMS: Record<HeaderColumnKey, string[]> = {
  partNumber: ["partnumber", "part number", "partno", "part no"],
  modelNumber: ["modelnumber", "model number", "modelno", "model no"],
  description: ["name", "description"],
  listPrice: ["listprice", "list price", "price"],
  warning: ["warning"],
};

const UPLOAD_ROOT = path.join("C:", "Users", "dim.kyriazis", "PriceLists");
// const UPLOAD_ROOT = path.join("C:", "inetpub", "wwwroot", "Telmaco", "PriceListUploads");

type SqlTypeLike = unknown;

type RequestLike = {
  input: (name: string, type: SqlTypeLike, value: unknown) => RequestLike;
  query: (query: string) => Promise<{ recordset?: unknown[] }>;
};

type TransactionLike = {
  begin: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

const createRequest = (owner: TransactionLike) => {
  const RequestCtor = sql.Request as unknown as new (o: TransactionLike) => RequestLike;
  return new RequestCtor(owner);
};

const getDecimalType = () => {
  const decimalFactory = (sql as unknown as {
    Decimal: (precision: number, scale: number) => SqlTypeLike;
  }).Decimal;
  return decimalFactory(18, 4);
};

const normalizeString = (value: unknown, maxLength = 500): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const str = String(value);
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
};

const normalizeUserId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const str = String(value);
    return str.trim() || null;
  }
  return null;
};

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeBool = (value: unknown): boolean | null => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
};

const normalizeDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const normalizeKey = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
};

const normalizeHeaderValue = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = typeof value === "number" ? String(value) : value;
  const trimmed = str.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, "");
};

const parsePrice = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const numericPortion = raw.replace(/[^\d.,-]/g, "");
  if (!numericPortion) return null;
  const commaCount = (numericPortion.match(/,/g) || []).length;
  const dotCount = (numericPortion.match(/\./g) || []).length;
  let normalized = numericPortion;
  if (commaCount > 0 && dotCount === 0) {
    normalized = numericPortion.replace(/,/g, ".");
  } else {
    normalized = numericPortion.replace(/,/g, "");
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeCellString = (value: unknown, maxLength = 1000): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const str = String(value);
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
};

const findHeaderRow = (rows: unknown[][]) => {
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const columnMap: Partial<Record<HeaderColumnKey, number>> = {};
    row.forEach((cell, colIdx) => {
      const normalized = normalizeHeaderValue(cell);
      if (!normalized) return;
      (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
        if (columnMap[key] != null) return;
        const matchesHeader = HEADER_SYNONYMS[key].some(
          (candidate) => normalizeHeaderValue(candidate) === normalized,
        );
        if (matchesHeader) {
          columnMap[key] = colIdx;
        }
      });
    });

    const detectedCount = Object.keys(columnMap).length;
    if (detectedCount > 0) {
      return { headerRowIndex: idx, columnMap };
    }
  }
  return null;
};

const parseSheet = (rows: unknown[][]): ParsedPriceListRow[] | null => {
  const header = findHeaderRow(rows);
  if (!header) return null;
  const { headerRowIndex, columnMap } = header;
  const parsed: ParsedPriceListRow[] = [];

  const getValue = (row: unknown[], key: HeaderColumnKey) => {
    const idx = columnMap[key];
    if (idx == null) return null;
    return row[idx] ?? null;
  };

  for (let rIdx = headerRowIndex + 1; rIdx < rows.length; rIdx += 1) {
    const row = rows[rIdx];
    if (!Array.isArray(row)) continue;
    const partNumber = normalizeCellString(getValue(row, "partNumber"));
    const modelNumber = normalizeCellString(getValue(row, "modelNumber"));
    const description = normalizeCellString(getValue(row, "description"), 2000);
    const listPrice = parsePrice(getValue(row, "listPrice"));
    const warning = normalizeCellString(getValue(row, "warning"), 1000);

    if (!partNumber && !modelNumber && !description && listPrice == null && !warning) continue;
    if (!partNumber || !modelNumber || !description || listPrice == null) continue;

    parsed.push({
      partNumber,
      modelNumber,
      description,
      listPrice,
      warning,
    });
  }

  return parsed;
};

const parseWorkbook = (buffer: Buffer): ParsedPriceListRow[] => {
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });
    for (const sheetName of wb.SheetNames ?? []) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
      const parsed = parseSheet(rows);
      if (parsed && parsed.length > 0) return parsed;
    }
  } catch (err) {
    console.error("Failed to parse uploaded workbook", err);
  }
  return [];
};

const formatTimestampFileName = (date: Date) => {
  const pad = (val: number) => val.toString().padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
};

const saveUploadedFile = async (buffer: Buffer, originalName: string | null | undefined) => {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  const timestamp = formatTimestampFileName(new Date());
  const ext = (typeof originalName === "string" && path.extname(originalName)) || ".xlsx";
  const safeExt = ext.trim() || ".xlsx";
  const fileName = `${timestamp}${safeExt}`;
  const absolutePath = path.join(UPLOAD_ROOT, fileName);
  await fs.writeFile(absolutePath, buffer);
  const relativePath = path.relative(process.cwd(), absolutePath);
  return { absolutePath, relativePath, fileName };
};

const loadExistingProducts = async (pool: ConnectionPool, parsedRows: ParsedPriceListRow[]) => {
  const partKeys = Array.from(
    new Set(
      parsedRows
        .map((row) => normalizeKey(row.partNumber))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const modelKeys = Array.from(
    new Set(
      parsedRows
        .map((row) => normalizeKey(row.modelNumber))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  if (partKeys.length === 0 && modelKeys.length === 0) return [] as ProductRow[];

  const request = pool.request();
  const clauses: string[] = [];

  if (partKeys.length > 0) {
    const paramNames = partKeys.map((val, idx) => {
      const param = `pn_${idx}`;
      request.input(param, sql.NVarChar(255), val);
      return `@${param}`;
    });
    clauses.push(`LOWER(LTRIM(RTRIM(PartNumber))) IN (${paramNames.join(", ")})`);
  }

  if (modelKeys.length > 0) {
    const paramNames = modelKeys.map((val, idx) => {
      const param = `mn_${idx}`;
      request.input(param, sql.NVarChar(255), val);
      return `@${param}`;
    });
    clauses.push(`LOWER(LTRIM(RTRIM(ModelNumber))) IN (${paramNames.join(", ")})`);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" OR ")}` : "";
  const result = await request.query(`
    SELECT ID, PartNumber, ModelNumber, BrandID
    FROM dbo.Products
    ${whereClause}
  `);
  const products = (result.recordset ?? []) as ProductRow[];
  return products;
};

const createProduct = async (
  transaction: TransactionLike,
  row: ParsedPriceListRow,
  brandId: number,
  auditUserId: string | null,
) => {
  const request = createRequest(transaction);
  request.input("BrandID", sql.Int, brandId);
  request.input("PartNumber", sql.NVarChar(255), row.partNumber);
  request.input("ModelNumber", sql.NVarChar(255), row.modelNumber);
  request.input("Description", sql.NVarChar(2000), row.description);
  request.input("CreatedBy", sql.NVarChar(450), auditUserId);
  request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

  const insertResult = await request.query(`
    INSERT INTO dbo.Products (
      BrandID,
      PartNumber,
      ModelNumber,
      Description,
      Enabled,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    OUTPUT INSERTED.ID AS ProductID
    VALUES (
      @BrandID,
      @PartNumber,
      @ModelNumber,
      @Description,
      1,
      SYSUTCDATETIME(),
      @CreatedBy,
      SYSUTCDATETIME(),
      @ModifiedBy
    )
  `);

  const productId = (insertResult.recordset?.[0] as { ProductID?: number } | undefined)?.ProductID ?? null;
  if (!productId) throw new Error("Failed to create product");
  return productId;
};

const insertPriceListItem = async (
  transaction: TransactionLike,
  priceListId: number,
  productId: number,
  row: ParsedPriceListRow,
  auditUserId: string | null,
) => {
  const request = createRequest(transaction);
  request.input("PriceListID", sql.Int, priceListId);
  request.input("ProductID", sql.Int, productId);
  const listPrice = row.listPrice == null ? undefined : Number(row.listPrice);
  const decimalType = getDecimalType();
  request.input("ListPrice", decimalType, listPrice);
  request.input("Warning", sql.NVarChar(1000), row.warning);
  request.input("CreatedBy", sql.NVarChar(450), auditUserId);
  request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

  await request.query(`
    INSERT INTO dbo.PriceListItems (
      PriceListID,
      ProductID,
      ListPrice,
      Warning,
      Enabled,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    VALUES (
      @PriceListID,
      @ProductID,
      @ListPrice,
      @Warning,
      1,
      SYSUTCDATETIME(),
      @CreatedBy,
      SYSUTCDATETIME(),
      @ModifiedBy
    )
  `);
};

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Please attach an Excel file." }, { status: 400 });
    }

    const name = normalizeString(formData.get("name"), 255);
    const comments = normalizeString(formData.get("comments"), 2000);
    const supplierComments = normalizeString(formData.get("supplierComments"), 2000);
    const pricingPolicyId = normalizeInt(formData.get("pricingPolicyId"));
    const pricingPolicyRuleId = normalizeInt(formData.get("pricingPolicyRuleId"));
    const responsibleUserId = normalizeUserId(formData.get("responsibleUserId"));
    const supplierId = normalizeInt(formData.get("supplierId"));
    const hasDuty = normalizeBool(formData.get("hasDuty"));
    const currencyId = normalizeInt(formData.get("currencyId"));
    const countryId = normalizeInt(formData.get("countryId"));
    const validFromDate = normalizeDate(formData.get("validFromDate"));
    const validToDate = normalizeDate(formData.get("validToDate"));
    const brandId = normalizeInt(formData.get("brandId"));
    const previousPriceListId = normalizeInt(formData.get("previousPriceListId"));

    const errors: string[] = [];
    if (!name) errors.push("Price list name is required.");
    if (!brandId) errors.push("Brand is required.");
    if (!pricingPolicyId) errors.push("Pricing policy is required.");
    if (!responsibleUserId) errors.push("Responsible user is required.");
    if (!supplierId) errors.push("Supplier is required.");
    if (!currencyId) errors.push("Currency is required.");
    if (!validFromDate) errors.push("Valid from date is required.");
    if (!validToDate) errors.push("Valid to date is required.");

    if (validFromDate && validToDate && validFromDate > validToDate) {
      errors.push("Valid from date cannot be after valid to date.");
    }

    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors.join(" ") }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const parsedRows = parseWorkbook(buffer);
    if (!parsedRows.length) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No valid rows found. Please include Part Number, Model Number, Name/Description, and List Price columns with data.",
        },
        { status: 400 },
      );
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();
    const existingProducts = await loadExistingProducts(pool, parsedRows);

    const byPartNumber = new Map<string, ProductRow>();
    const byModelNumber = new Map<string, ProductRow>();

    existingProducts.forEach((product: ProductRow) => {
      const partKey = normalizeKey(product.PartNumber);
      const modelKey = normalizeKey(product.ModelNumber);
      if (partKey && !byPartNumber.has(partKey)) byPartNumber.set(partKey, product);
      if (modelKey && !byModelNumber.has(modelKey)) byModelNumber.set(modelKey, product);
    });

    const { relativePath, fileName, absolutePath } = await saveUploadedFile(buffer, file.name);

    const TransactionCtor = (sql as unknown as {
      Transaction: new (pool: ConnectionPool) => TransactionLike;
    }).Transaction;
    const transaction = new TransactionCtor(pool);

    await transaction.begin();

    try {
      const priceListRequest = createRequest(transaction);
      priceListRequest.input("Name", sql.NVarChar(255), name);
      priceListRequest.input("BrandID", sql.Int, brandId);
      priceListRequest.input("Comments", sql.NVarChar(2000), comments);
      priceListRequest.input("SupplierComment", sql.NVarChar(2000), supplierComments);
      priceListRequest.input("PricingPolicyID", sql.Int, pricingPolicyId);
      priceListRequest.input("PricingPolicyRuleID", sql.Int, pricingPolicyRuleId);
      priceListRequest.input("ResponsibleUserId", sql.NVarChar(450), responsibleUserId);
      priceListRequest.input("SupplierID", sql.Int, supplierId);
      priceListRequest.input("HasDuty", sql.Bit, hasDuty ?? false);
      priceListRequest.input("CurrencyId", sql.Int, currencyId);
      priceListRequest.input("CountryId", sql.Int, countryId);
      priceListRequest.input("ValidFromDate", sql.DateTime2, validFromDate);
      priceListRequest.input("ValidToDate", sql.DateTime2, validToDate);
      priceListRequest.input("FilePath", sql.NVarChar(1000), relativePath || fileName);
      priceListRequest.input("CreatedBy", sql.NVarChar(450), auditUserId);
      priceListRequest.input("ModifiedBy", sql.NVarChar(450), auditUserId);

      const insertPriceList = await priceListRequest.query(`
        INSERT INTO dbo.PriceLists (
          Name,
          BrandID,
          Comments,
          SupplierComment,
          PricingPolicyID,
          PricingPolicyRuleID,
          ResponsibleUserId,
          SupplierID,
          HasDuty,
          CurrencyId,
          CountryId,
          ValidFromDate,
          ValidToDate,
          Enabled,
          Finalized,
          FilePath,
          CreatedOn,
          CreatedBy,
          ModifiedOn,
          ModifiedBy
        )
        OUTPUT INSERTED.ID AS PriceListID
        VALUES (
          @Name,
          @BrandID,
          @Comments,
          @SupplierComment,
          @PricingPolicyID,
          @PricingPolicyRuleID,
          @ResponsibleUserId,
          @SupplierID,
          @HasDuty,
          @CurrencyId,
          @CountryId,
          @ValidFromDate,
          @ValidToDate,
          1,
          1,
          @FilePath,
          SYSUTCDATETIME(),
          @CreatedBy,
          SYSUTCDATETIME(),
          @ModifiedBy
        )
      `);

      const priceListId =
        (insertPriceList.recordset?.[0] as { PriceListID?: number } | undefined)?.PriceListID ?? null;
      if (!priceListId) throw new Error("Failed to create price list");

      if (previousPriceListId) {
        const disableRequest = createRequest(transaction);
        disableRequest.input("PreviousID", sql.Int, previousPriceListId);
        disableRequest.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await disableRequest.query(`
          UPDATE dbo.PriceLists
          SET Enabled = 0,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @PreviousID
        `);
      }

      const createdProducts = new Map<string, number>();
      const seenProducts = new Set<number>();
      let createdProductCount = 0;
      let matchedProductCount = 0;
      let skippedRows = 0;

      for (const row of parsedRows) {
        const partKey = normalizeKey(row.partNumber);
        const modelKey = normalizeKey(row.modelNumber);
        if (!partKey && !modelKey) {
          skippedRows += 1;
          continue;
        }
        if (row.listPrice == null) {
          skippedRows += 1;
          continue;
        }

        let productId: number | null = null;
        let isExistingProduct = false;

        if (partKey && byPartNumber.has(partKey)) {
          productId = byPartNumber.get(partKey)?.ID ?? null;
          isExistingProduct = productId != null;
        } else if (modelKey && byModelNumber.has(modelKey)) {
          productId = byModelNumber.get(modelKey)?.ID ?? null;
          isExistingProduct = productId != null;
        } else if (partKey && createdProducts.has(partKey)) {
          productId = createdProducts.get(partKey) ?? null;
        } else if (modelKey && createdProducts.has(modelKey)) {
          productId = createdProducts.get(modelKey) ?? null;
        }

        if (!productId) {
          productId = await createProduct(transaction, row, brandId!, auditUserId);
          createdProductCount += 1;
        }

        if (!productId || seenProducts.has(productId)) {
          skippedRows += 1;
          continue;
        }

        if (isExistingProduct) {
          matchedProductCount += 1;
        }

        const productRecord: ProductRow = {
          ID: productId,
          PartNumber: row.partNumber,
          ModelNumber: row.modelNumber,
          BrandID: brandId,
        };

        if (partKey) {
          createdProducts.set(partKey, productId);
          if (!byPartNumber.has(partKey)) byPartNumber.set(partKey, productRecord);
        }
        if (modelKey) {
          createdProducts.set(modelKey, productId);
          if (!byModelNumber.has(modelKey)) byModelNumber.set(modelKey, productRecord);
        }

        await insertPriceListItem(transaction, priceListId, productId, row, auditUserId);
        seenProducts.add(productId);
      }

      await transaction.commit();
      return NextResponse.json({
        ok: true,
        priceListId,
        filePath: relativePath || fileName,
        createdProductCount,
        matchedProductCount,
        skippedRows,
        totalRows: parsedRows.length,
      });
    } catch (err) {
      await transaction.rollback();
      await fs.rm(absolutePath, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    console.error("Failed to import price list", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
