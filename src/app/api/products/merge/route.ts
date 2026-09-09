/**
 * Commits a product merge.
 *
 * In one transaction the primary takes the chosen field values, every offer line
 * and every price-list row of the secondaries, and the secondaries are then
 * disabled. Two things need more than a repoint:
 *
 *  - IDENTITY. (BrandID, PartNumber) is unique per brand
 *    (UX_Products_PartNumber_BrandID), and a retired row keeps its part number.
 *    So when the user picks a secondary's brand + part number for the survivor,
 *    the two rows SWAP identities: the secondary is parked on a placeholder, the
 *    primary takes the pair, the secondary takes the primary's old pair. Both
 *    pairs already existed, so the index is never violated.
 *
 *  - PRICE LISTS. Two of the sources may each have a row in the same price list.
 *    The survivor must end up with one price per list (every price lookup joins
 *    on ProductID + PriceListID and would double up otherwise), so the losing
 *    row is DELETED — the one destructive step in this merge. Its full row is
 *    written to the audit log first, and offer lines that pointed at it via
 *    PriceListItemID are repointed to the surviving row.
 *
 * Offer lines are snapshots of what was quoted (PartNumber / ModelNumber /
 * BrandID / ProductDescription live on the line). The caller chooses whether
 * they stay as quoted ('keep') or are rewritten to the survivor ('rewrite').
 *
 * Everything the client sends is re-derived and re-validated here — the preview
 * route's numbers are for the human, not for this route.
 */
import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { logRequest } from '../../../../lib/apiHelpers';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { getRequestId } from '../../../../lib/requestId';
import { logEditAuditDetails, type FieldChange } from '../../../../lib/mutationAudit';
import { normalizeId } from '../../../../lib/normalize';
import { clearPartModelNumberUpper } from '../../../../lib/partModelNumber';
import {
  MERGE_FIELD_COLUMNS,
  availableMergeFields,
  bindMergeField,
  collectMergeIds,
  MAX_MERGE_SECONDARIES,
} from '../../../../lib/productMergeSql';
import type {
  MergeCommitRequest,
  MergeFieldKey,
  OfferLineMode,
} from '../../../products/merge/productMergeTypes';

type LockRow = {
  ID: number;
  BrandID: number;
  PartNumber: string | null;
  PartNumberCleared: string | null;
  ModelNumber: string | null;
  LegacyPartNo: string | null;
  ERPID: number | null;
  ERPCode: string | null;
  Enabled: boolean | number | null;
};

/** One row of the reversal map: what moved, and where it came from. */
type MovedRow = {
  MovedId: number;
  PreviousProductID: number | null;
};

type PriceListLockRow = {
  ID: number;
  ProductID: number;
  PriceListID: number;
};

/** Keeps the audit payload bounded when a very popular product is merged. */
const MAX_LOGGED_MOVES = 500;

const summariseMoves = (rows: readonly MovedRow[]) => {
  const byPrevious = new Map<number, number[]>();
  rows.forEach((row) => {
    const previous = row.PreviousProductID;
    if (previous == null) return;
    const bucket = byPrevious.get(previous);
    if (bucket) bucket.push(row.MovedId);
    else byPrevious.set(previous, [row.MovedId]);
  });
  return Object.fromEntries(
    Array.from(byPrevious.entries()).map(([previous, ids]) => [
      String(previous),
      ids.length > MAX_LOGGED_MOVES
        ? { count: ids.length, ids: ids.slice(0, MAX_LOGGED_MOVES), truncated: true }
        : { count: ids.length, ids },
    ]),
  );
};

const boundList = <T>(rows: readonly T[]) =>
  rows.length > MAX_LOGGED_MOVES
    ? { count: rows.length, rows: rows.slice(0, MAX_LOGGED_MOVES), truncated: true }
    : { count: rows.length, rows };

const toCleared = (value: string | null): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed ? clearPartModelNumberUpper(trimmed) : null;
};

const parseBoolean = (raw: unknown): boolean | null => {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return null;
};

const parseOfferLineMode = (raw: unknown): OfferLineMode =>
  raw === 'rewrite' ? 'rewrite' : 'keep';

export async function POST(req: NextRequest) {
  logRequest(req, '/api/products/merge');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  // dbo.Products.ModifiedBy, dbo.PriceListItems.ModifiedBy and
  // dbo.OfferDetails.ModifiedBy are INT columns (Products' carries a foreign key
  // to AspNetUsers). A non-numeric audit id means the existing value is left
  // alone rather than writing a broken one or failing the merge.
  const candidateModifiedBy = auditUserId != null && /^\d+$/.test(auditUserId.trim())
    ? Number.parseInt(auditUserId.trim(), 10)
    : null;

  try {
    const auth = await requirePermission(req, 'mergeProducts');
    if (!auth.ok) return auth.response;

    let body: MergeCommitRequest | null = null;
    try {
      body = (await req.json()) as MergeCommitRequest;
    } catch {
      body = null;
    }

    const primaryId = normalizeId(body?.primaryId);
    const secondaryIds = collectMergeIds(body?.secondaryIds).filter((id) => id !== primaryId);
    const dryRun = body?.dryRun === true;
    const offerLineMode = parseOfferLineMode(body?.offerLines?.mode);
    const rewriteDescription = offerLineMode === 'rewrite' && body?.offerLines?.rewriteDescription === true;

    if (primaryId == null) {
      return NextResponse.json({ ok: false, error: 'A primary product is required.' }, { status: 400 });
    }
    if (secondaryIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Select at least one other product to merge into the primary.' },
        { status: 400 },
      );
    }
    if (secondaryIds.length > MAX_MERGE_SECONDARIES) {
      return NextResponse.json(
        { ok: false, error: `Merge at most ${MAX_MERGE_SECONDARIES + 1} products at a time.` },
        { status: 400 },
      );
    }

    // Price-list winners: PriceListID -> ProductID whose row survives that list.
    const priceListWinners = new Map<number, number>();
    const rawWinners = body?.priceListWinners;
    if (rawWinners && typeof rawWinners === 'object') {
      Object.entries(rawWinners).forEach(([key, value]) => {
        const listId = normalizeId(key);
        const productId = normalizeId(value);
        if (listId != null && productId != null) priceListWinners.set(listId, productId);
      });
    }

    const pool = await getPool();
    const allowedFields = new Set(availableMergeFields().map((f) => f.field));

    // FK_Products_AspNetUsers1 on ModifiedBy: an id that does not resolve there
    // would abort the merge with SQL 547 at the first UPDATE, so it is checked
    // once and simply not written when it does not match a real user.
    const modifiedBy = await (async () => {
      if (candidateModifiedBy == null) return null;
      const check = await pool
        .request()
        .input('userId', sql.Int, candidateModifiedBy)
        .query<{ ID: number }>('SELECT TOP (1) ID FROM dbo.AspNetUsers WHERE ID = @userId');
      return check.recordset?.[0] ? candidateModifiedBy : null;
    })();

    // Normalise the field picks: unknown fields and nulls for NOT NULL columns
    // are dropped rather than written.
    const rawValues = (body?.fieldValues ?? {}) as Partial<Record<MergeFieldKey, unknown>>;
    const fieldUpdates: Array<{ field: MergeFieldKey; value: string | number | boolean | null }> = [];
    const skippedRequired: MergeFieldKey[] = [];

    (Object.keys(rawValues) as MergeFieldKey[]).forEach((field) => {
      if (!allowedFields.has(field)) return;
      const config = MERGE_FIELD_COLUMNS[field];
      if (!config) return;

      const raw = rawValues[field];
      let value: string | number | boolean | null;
      if (raw === null || raw === undefined || raw === '') {
        value = null;
      } else if (config.type === 'number') {
        const parsed = Number(raw);
        value = Number.isFinite(parsed) ? parsed : null;
      } else if (config.type === 'boolean') {
        value = parseBoolean(raw);
      } else {
        const trimmed = String(raw).trim();
        value = trimmed.length > 0 ? trimmed : null;
      }

      if (value === null && config.notNull) {
        skippedRequired.push(field);
        return;
      }
      fieldUpdates.push({ field, value });
    });

    const warnings: string[] = [];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    let movedOfferLines: MovedRow[] = [];
    let movedPriceListItems: MovedRow[] = [];
    let movedSpecialItems: MovedRow[] = [];
    const deletedPriceListItems: Array<Record<string, unknown>> = [];
    const priceListItemRepoints: Array<{ OfferDetailID: number; From: number | null; To: number }> = [];
    let rewrittenLines: Array<Record<string, unknown>> = [];
    let erpCleared: Array<{ ProductID: number; ERPID: number | null; ERPCode: string | null }> = [];
    let disabled = 0;
    let primaryBefore: Record<string, unknown> = {};
    let primaryLabel: string | null = null;
    let identitySwap: {
      secondaryId: number;
      primaryBefore: { BrandID: number; PartNumber: string | null; PartNumberCleared: string | null };
      secondaryBefore: { BrandID: number; PartNumber: string | null; PartNumberCleared: string | null };
    } | null = null;
    let legacyFilled: string | null = null;
    let survivor: { BrandID: number; PartNumber: string | null; ModelNumber: string | null; Description: string | null } | null = null;

    try {
      // --- lock the whole working set for the duration of the merge --------
      const lockRequest = transaction.request();
      lockRequest.input('primaryId', sql.Int, primaryId);
      const lockPlaceholders = secondaryIds
        .map((id, index) => {
          lockRequest.input(`sec${index}`, sql.Int, id);
          return `@sec${index}`;
        })
        .join(', ');

      const locked = await lockRequest.query<LockRow>(`
        SELECT ID, BrandID, PartNumber, PartNumberCleared, ModelNumber, LegacyPartNo, ERPID, ERPCode, Enabled
        FROM dbo.Products WITH (UPDLOCK, HOLDLOCK)
        WHERE ID IN (@primaryId, ${lockPlaceholders})
      `);
      const lockedRows = locked.recordset ?? [];
      const lockedIds = new Set(lockedRows.map((row) => row.ID));

      if (!lockedIds.has(primaryId)) {
        await transaction.rollback();
        return NextResponse.json({ ok: false, error: 'Primary product not found.' }, { status: 404 });
      }
      const missing = secondaryIds.filter((id) => !lockedIds.has(id));
      if (missing.length > 0) {
        await transaction.rollback();
        return NextResponse.json(
          { ok: false, error: `Product${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}` },
          { status: 404 },
        );
      }
      const primaryRow = lockedRows.find((row) => row.ID === primaryId) as LockRow;
      primaryLabel = primaryRow.PartNumber?.trim() || null;

      const refusedToClear = skippedRequired.filter((field) => {
        if (field === 'PartNumber') return Boolean(primaryRow.PartNumber?.trim());
        return true;
      });
      if (refusedToClear.length > 0) {
        warnings.push(`Left unchanged because they cannot be empty: ${refusedToClear.join(', ')}.`);
      }

      // A secondary that is already disabled has very likely been merged away
      // once before (the 2026-08/09 script merges retired their losers this
      // way). Folding it in again is allowed, but must not pass silently.
      const alreadyDisabled = lockedRows
        .filter((row) => row.ID !== primaryId && !(row.Enabled === true || row.Enabled === 1))
        .map((row) => row.ID);
      if (alreadyDisabled.length > 0) {
        warnings.push(
          `Already disabled before this merge: ${alreadyDisabled.join(', ')}. If one of these was retired by an earlier merge, check dbo.PncMergeLog / dbo.Logs for it before relying on this one.`,
        );
      }

      /** Fresh request with the shared id parameters already bound. */
      const scopedRequest = () => {
        const request = transaction.request();
        request.input('primaryId', sql.Int, primaryId);
        secondaryIds.forEach((id, index) => request.input(`sec${index}`, sql.Int, id));
        if (modifiedBy != null) request.input('modifiedBy', sql.Int, modifiedBy);
        return request;
      };
      const secondaryList = secondaryIds.map((_, index) => `@sec${index}`).join(', ');
      const modifiedByClause = modifiedBy != null ? 'ModifiedBy = @modifiedBy, ' : '';

      // --- 0. the identity pair must come whole from ONE source --------------
      // (BrandID, PartNumber) is the product's key. The client keeps the pair
      // together, but a hand-made request could send brand A with part number
      // B, which would mint a product that exists in no price list and is
      // unique only by accident. Refuse anything that is not one source's pair.
      const pickedBrand = fieldUpdates.find((u) => u.field === 'BrandID');
      const pickedPart = fieldUpdates.find((u) => u.field === 'PartNumber');
      const finalBrandId = pickedBrand ? Number(pickedBrand.value) : primaryRow.BrandID;
      const finalPartNumber = pickedPart ? String(pickedPart.value) : (primaryRow.PartNumber ?? '');
      const identitySource = lockedRows.find(
        (row) => row.BrandID === finalBrandId
          && (row.PartNumber ?? '').trim().toUpperCase() === finalPartNumber.trim().toUpperCase(),
      );
      if (!identitySource) {
        await transaction.rollback();
        return NextResponse.json(
          { ok: false, error: 'Brand and part number must be taken together from one of the products being merged.' },
          { status: 400 },
        );
      }
      const swapWith = identitySource.ID !== primaryId ? identitySource : null;

      // --- 1a. park the secondary whose identity the primary is taking ------
      // UX_Products_PartNumber_BrandID is unfiltered, so the secondary must let
      // go of the pair before the primary can take it. The placeholder is
      // replaced in 1c; it never survives the transaction.
      if (swapWith) {
        identitySwap = {
          secondaryId: swapWith.ID,
          primaryBefore: {
            BrandID: primaryRow.BrandID,
            PartNumber: primaryRow.PartNumber,
            PartNumberCleared: primaryRow.PartNumberCleared,
          },
          secondaryBefore: {
            BrandID: swapWith.BrandID,
            PartNumber: swapWith.PartNumber,
            PartNumberCleared: swapWith.PartNumberCleared,
          },
        };
        await transaction
          .request()
          .input('swapId', sql.Int, swapWith.ID)
          .input('placeholder', sql.NVarChar(255), `~merge-${swapWith.ID}`)
          .query('UPDATE dbo.Products SET PartNumber = @placeholder WHERE ID = @swapId');

        // The primary's old part number stays findable: it becomes the legacy
        // part number unless the user picked one. This is exactly what the
        // price-list import does when a part number is respelled.
        const pickedLegacy = fieldUpdates.find((u) => u.field === 'LegacyPartNo');
        if (!pickedLegacy || pickedLegacy.value === null) {
          const oldPart = primaryRow.PartNumber?.trim() || null;
          if (oldPart && oldPart.toUpperCase() !== finalPartNumber.trim().toUpperCase()) {
            legacyFilled = oldPart;
            if (pickedLegacy) pickedLegacy.value = oldPart;
            else fieldUpdates.push({ field: 'LegacyPartNo', value: oldPart });
          }
        }
      }

      // --- 1b. the surviving product takes the chosen values ---------------
      // Read what it holds FIRST, so the audit carries real before-values and a
      // revert can restore the fields as well as the moved rows.
      if (fieldUpdates.length > 0) {
        const beforeRequest = transaction.request();
        beforeRequest.input('primaryId', sql.Int, primaryId);
        const beforeColumns = fieldUpdates
          .map(({ field }) => `[${MERGE_FIELD_COLUMNS[field].column}]`)
          .join(', ');
        const beforeResult = await beforeRequest.query<Record<string, unknown>>(
          `SELECT TOP (1) ${beforeColumns}, PartNumberCleared, ModelNumberCleared, LegacyPartNoCleaned FROM dbo.Products WHERE ID = @primaryId`,
        );
        primaryBefore = beforeResult.recordset?.[0] ?? {};

        const request = scopedRequest();
        const setClauses = fieldUpdates.map(({ field, value }, index) => {
          const paramName = `f${index}`;
          bindMergeField(request, paramName, field, value);
          return `[${MERGE_FIELD_COLUMNS[field].column}] = @${paramName}`;
        });
        // The search keys are plain columns the app maintains, never computed
        // in SQL: derive them from whatever key value was picked.
        const derived: Array<[MergeFieldKey, string]> = [
          ['PartNumber', 'PartNumberCleared'],
          ['ModelNumber', 'ModelNumberCleared'],
          ['LegacyPartNo', 'LegacyPartNoCleaned'],
        ];
        derived.forEach(([field, column]) => {
          const pick = fieldUpdates.find((u) => u.field === field);
          if (!pick) return;
          const paramName = `d${column}`;
          request.input(paramName, sql.NVarChar(255), toCleared(pick.value == null ? null : String(pick.value)));
          setClauses.push(`[${column}] = @${paramName}`);
        });
        await request.query(`
          UPDATE dbo.Products
          SET ${setClauses.join(', ')}, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID = @primaryId
        `);
      }

      // --- 1c. the parked secondary takes the primary's old identity ---------
      if (swapWith && identitySwap) {
        const request = scopedRequest();
        request.input('swapId', sql.Int, swapWith.ID);
        request.input('oldBrand', sql.Int, identitySwap.primaryBefore.BrandID);
        request.input('oldPart', sql.NVarChar(255), identitySwap.primaryBefore.PartNumber);
        request.input('oldCleared', sql.NVarChar(255), identitySwap.primaryBefore.PartNumberCleared);
        await request.query(`
          UPDATE dbo.Products
          SET BrandID = @oldBrand, PartNumber = @oldPart, PartNumberCleared = @oldCleared,
              ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID = @swapId
        `);
      }

      // --- 2. one Soft1 item, one row -----------------------------------------
      // Whatever link the primary now carries is cleared from any secondary
      // that claims the same item, so a retired row can never be picked up by a
      // draft order as "the" product for that MTRL. A secondary linked to a
      // DIFFERENT item keeps its link (the preview warned about it).
      {
        const finalLink = await transaction
          .request()
          .input('primaryId', sql.Int, primaryId)
          .query<{ ERPID: number | null; ERPCode: string | null; BrandID: number; PartNumber: string | null; ModelNumber: string | null; Description: string | null }>(
            'SELECT ERPID, ERPCode, BrandID, PartNumber, ModelNumber, Description FROM dbo.Products WHERE ID = @primaryId',
          );
        const link = finalLink.recordset?.[0];
        survivor = link
          ? { BrandID: link.BrandID, PartNumber: link.PartNumber, ModelNumber: link.ModelNumber, Description: link.Description }
          : null;
        const erpCode = link?.ERPCode?.trim() || null;
        if (link && (link.ERPID != null || erpCode)) {
          const request = scopedRequest();
          request.input('erpId', sql.Int, link.ERPID);
          request.input('erpCode', sql.NVarChar(50), erpCode);
          const result = await request.query<{ ProductID: number; ERPID: number | null; ERPCode: string | null }>(`
            UPDATE dbo.Products
            SET ERPID = NULL, ERPCode = NULL, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
            OUTPUT INSERTED.ID AS ProductID, DELETED.ERPID, DELETED.ERPCode
            WHERE ID IN (${secondaryList})
              AND (
                (@erpId IS NOT NULL AND ERPID = @erpId)
                OR (@erpCode IS NOT NULL AND UPPER(LTRIM(RTRIM(ISNULL(ERPCode, '')))) = UPPER(@erpCode))
              )
          `);
          erpCleared = result.recordset ?? [];
        }
        const stillLinked = await scopedRequest().query<{ ID: number; ERPCode: string | null; ERPID: number | null }>(`
          SELECT ID, ERPID, ERPCode FROM dbo.Products
          WHERE ID IN (${secondaryList}) AND (ERPID IS NOT NULL OR NULLIF(LTRIM(RTRIM(ERPCode)), '') IS NOT NULL)
        `);
        (stillLinked.recordset ?? []).forEach((row) => {
          warnings.push(
            `Retired product #${row.ID} still carries a different Soft1 link (${row.ERPCode?.trim() || row.ERPID}). Nothing was changed in the ERP; if that item is the same physical product, tidy it up in Soft1.`,
          );
        });
      }

      // --- 3. price lists: one price per list on the survivor -----------------
      {
        const lockPli = scopedRequest();
        const pliRows = (await lockPli.query<PriceListLockRow>(`
          SELECT ID, ProductID, PriceListID
          FROM dbo.PriceListItems WITH (UPDLOCK, HOLDLOCK)
          WHERE ProductID IN (@primaryId, ${secondaryList})
          ORDER BY PriceListID, ID
        `)).recordset ?? [];

        const byList = new Map<number, PriceListLockRow[]>();
        pliRows.forEach((row) => {
          const bucket = byList.get(row.PriceListID);
          if (bucket) bucket.push(row);
          else byList.set(row.PriceListID, [row]);
        });

        for (const [listId, rows] of byList) {
          if (rows.length < 2) continue;
          const products = rows.map((row) => row.ProductID);
          const requested = priceListWinners.get(listId);
          const winnerProduct = requested != null && products.includes(requested)
            ? requested
            : products.includes(primaryId)
              ? primaryId
              : secondaryIds.find((id) => products.includes(id)) ?? products[0];
          // A product normally has ONE row per list; should it ever have two,
          // the lowest id wins and the other is treated like a losing row.
          const winnerRow = rows.find((row) => row.ProductID === winnerProduct) as PriceListLockRow;
          const losers = rows.filter((row) => row.ID !== winnerRow.ID);

          for (const loser of losers) {
            const del = transaction.request();
            del.input('pliId', sql.Int, loser.ID);
            const deleted = await del.query<Record<string, unknown>>(`
              DELETE FROM dbo.PriceListItems
              OUTPUT DELETED.*
              WHERE ID = @pliId
            `);
            deletedPriceListItems.push(...(deleted.recordset ?? []));

            // dbo.OfferDetails.PriceListItemID has no FK but is read back when a
            // line's price is refreshed; leave it pointing at the row that now
            // holds that product's price in that list.
            const repoint = scopedRequest();
            repoint.input('fromPli', sql.Int, loser.ID);
            repoint.input('toPli', sql.Int, winnerRow.ID);
            const moved = await repoint.query<{ OfferDetailID: number; From: number | null }>(`
              UPDATE dbo.OfferDetails
              SET PriceListItemID = @toPli, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
              OUTPUT INSERTED.ID AS OfferDetailID, DELETED.PriceListItemID AS [From]
              WHERE PriceListItemID = @fromPli
            `);
            (moved.recordset ?? []).forEach((row) => {
              priceListItemRepoints.push({ OfferDetailID: row.OfferDetailID, From: row.From, To: winnerRow.ID });
            });
          }
        }

        // Everything the secondaries still have in a price list moves over.
        const request = scopedRequest();
        const result = await request.query<MovedRow>(`
          UPDATE dbo.PriceListItems
          SET ProductID = @primaryId, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS MovedId, DELETED.ProductID AS PreviousProductID
          WHERE ProductID IN (${secondaryList})
        `);
        movedPriceListItems = result.recordset ?? [];
      }

      // dbo.SpecialPriceListItems is empty and unused today; repointed anyway so
      // no table is left pointing at a retired row.
      {
        const result = await scopedRequest().query<MovedRow>(`
          UPDATE dbo.SpecialPriceListItems
          SET ProductID = @primaryId
          OUTPUT INSERTED.ID AS MovedId, DELETED.ProductID AS PreviousProductID
          WHERE ProductID IN (${secondaryList})
        `);
        movedSpecialItems = result.recordset ?? [];
      }

      // --- 4. every offer line follows its product ----------------------------
      // The OUTPUT clause is the reversal record: a moved line keeps no memory
      // of the product it used to point at.
      {
        const result = await scopedRequest().query<MovedRow>(`
          UPDATE dbo.OfferDetails
          SET ProductID = @primaryId, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS MovedId, DELETED.ProductID AS PreviousProductID
          WHERE ProductID IN (${secondaryList})
        `);
        movedOfferLines = result.recordset ?? [];
      }

      // --- 5. optionally rewrite what the lines say --------------------------
      // 'keep' leaves the quoted part / model / brand exactly as the customer
      // saw them. 'rewrite' makes every line of the merged product read as the
      // survivor. Only lines that actually differ are touched, and their old
      // values go to the audit log.
      if (offerLineMode === 'rewrite' && survivor) {
        const request = scopedRequest();
        request.input('pn', sql.NVarChar(255), survivor.PartNumber);
        request.input('mn', sql.NVarChar(255), survivor.ModelNumber);
        request.input('brand', sql.Int, survivor.BrandID);
        request.input('descr', sql.NVarChar(sql.MAX), survivor.Description);
        const descriptionSet = rewriteDescription ? 'ProductDescription = @descr,' : '';
        const descriptionDiff = rewriteDescription
          ? "OR ISNULL(ProductDescription, '') <> ISNULL(@descr, '')"
          : '';
        const result = await request.query<Record<string, unknown>>(`
          UPDATE dbo.OfferDetails
          SET PartNumber = @pn, ModelNumber = @mn, BrandID = @brand, ${descriptionSet}
              ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS OfferDetailID, INSERTED.OfferID,
                 DELETED.PartNumber, DELETED.ModelNumber, DELETED.BrandID, DELETED.ProductDescription
          WHERE ProductID = @primaryId
            AND (
              ISNULL(PartNumber, '') <> ISNULL(@pn, '')
              OR ISNULL(ModelNumber, '') <> ISNULL(@mn, '')
              OR ISNULL(BrandID, -1) <> ISNULL(@brand, -1)
              ${descriptionDiff}
            )
        `);
        rewrittenLines = result.recordset ?? [];
        if (!rewriteDescription) {
          // The description was deliberately left alone: drop it from the log
          // so the reversal map is not padded with unchanged text.
          rewrittenLines = rewrittenLines.map((row) => {
            const { ProductDescription: _omit, ...rest } = row;
            void _omit;
            return rest;
          });
        }
      }

      // --- 6. retire the duplicates -------------------------------------------
      {
        const result = await scopedRequest().query(`
          UPDATE dbo.Products
          SET Enabled = 0, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID IN (${secondaryList})
        `);
        disabled = result.rowsAffected?.[0] ?? 0;
      }

      if (dryRun) {
        await transaction.rollback();
      } else {
        await transaction.commit();
      }
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      const sqlNumber = (txErr as { number?: number } | null)?.number;
      if (sqlNumber === 2627 || sqlNumber === 2601) {
        return NextResponse.json(
          {
            ok: false,
            error: 'The chosen brand already has another product with that part number, so the survivor could not take it. Nothing was changed.',
          },
          { status: 409 },
        );
      }
      throw txErr;
    }

    const reversal = {
      offerLinesByPreviousProduct: summariseMoves(movedOfferLines),
      priceListItemsByPreviousProduct: summariseMoves(movedPriceListItems),
      specialPriceListItemsByPreviousProduct: summariseMoves(movedSpecialItems),
      deletedPriceListItems,
      offerLinePriceListItemRepoints: boundList(priceListItemRepoints),
      rewrittenOfferLines: boundList(rewrittenLines),
      identitySwap,
      legacyPartNoFilledFromOldPartNumber: legacyFilled,
      erpLinkClearedOnSecondaries: erpCleared,
    };

    if (!dryRun) {
      const auditValue = (value: unknown): string | number | boolean | null => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        const text = String(value).trim();
        return text.length > 0 ? text : null;
      };
      const fieldChanges: FieldChange[] = fieldUpdates
        .map((update) => ({
          targetId: primaryId,
          targetName: primaryLabel,
          field: update.field,
          before: auditValue(primaryBefore[MERGE_FIELD_COLUMNS[update.field].column]),
          after: auditValue(update.value),
        }))
        .filter((change) => String(change.before ?? '') !== String(change.after ?? ''));
      if (identitySwap) {
        fieldChanges.push(
          {
            targetId: identitySwap.secondaryId,
            field: 'PartNumber',
            before: identitySwap.secondaryBefore.PartNumber,
            after: identitySwap.primaryBefore.PartNumber,
          },
          {
            targetId: identitySwap.secondaryId,
            field: 'BrandID',
            before: identitySwap.secondaryBefore.BrandID,
            after: identitySwap.primaryBefore.BrandID,
          },
        );
      }

      // dbo.Logs is the only record of a merge, so it carries everything needed
      // to reverse one by hand: which ids were folded in, what moved, what was
      // removed and what the lines used to say.
      logEditAuditDetails({
        endpoint: '/api/products/merge',
        method: 'POST',
        requestId,
        userId: auditUserId,
        targetEntity: 'products',
        targetIds: [primaryId, ...secondaryIds],
        changes: [
          {
            targetId: primaryId,
            targetName: primaryLabel,
            field: 'MergedFrom',
            before: null,
            after: secondaryIds.join(', '),
          },
          ...fieldChanges,
        ],
        message: `Products merged into #${primaryId}`,
        extra: {
          mergePrimaryId: primaryId,
          mergeSecondaryIds: secondaryIds,
          offerLineMode,
          rewriteDescription,
          movedOfferLines: movedOfferLines.length,
          movedPriceListItems: movedPriceListItems.length,
          deletedPriceListItems: deletedPriceListItems.length,
          rewrittenOfferLines: rewrittenLines.length,
          disabledProducts: disabled,
          reversal,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      primaryId,
      secondaryIds,
      moved: { offerLines: movedOfferLines.length, priceListItems: movedPriceListItems.length },
      deletedPriceListItems: deletedPriceListItems.length,
      rewrittenOfferLines: rewrittenLines.length,
      disabled,
      identitySwapped: identitySwap != null,
      fieldsUpdated: fieldUpdates.map((update) => update.field),
      warnings,
      // Echoed back so the operator can copy it before leaving the page: this is
      // the same map written to dbo.Logs, and the only route back from a merge.
      reversal,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
