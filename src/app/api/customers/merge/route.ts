/**
 * Commits a customer merge.
 *
 * Nothing is deleted. In one transaction the primary takes the chosen field
 * values, the chosen contacts, every offer and every child customer belonging to
 * the secondaries; the secondaries are then disabled. A secondary keeps whatever
 * contacts the user chose NOT to move, so an over-eager merge is undone by
 * re-enabling the record rather than from a backup.
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
import { logEditAuditDetails } from '../../../../lib/mutationAudit';
import { invalidateDuplicateScans } from '../../../../lib/duplicateScanCache';
import { normalizeId, sanitizeJsonUnsafeChars } from '../../../../lib/normalize';
import {
  MERGE_FIELD_COLUMNS,
  availableMergeFields,
  bindMergeField,
  probeCustomerColumns,
  MAX_MERGE_SECONDARIES,
  collectMergeIds,
} from '../../../../lib/customerMergeSql';
import type {
  MergeCommitRequest,
  MergeFieldKey,
} from '../../../customers/merge/customerMergeTypes';

/** Names are sanitised on the detail page too, so the merge cannot smuggle past it. */
const JSON_SANITIZED_FIELDS: ReadonlySet<MergeFieldKey> = new Set(['Name', 'BrandName']);

type LockRow = {
  ID: number;
  Name: string | null;
  Enabled: boolean | number | null;
  ParentCustomerID: number | null;
  /** NOT NULL in the schema, but empty on the overwhelming majority of rows. */
  PricingPolicyID: string | number | null;
};

/** One row of the reversal map: what moved, and where it came from. */
type MovedRow = {
  MovedId: number;
  PreviousCustomerID: number | null;
};

/** Keeps the audit payload bounded when a very large customer is merged. */
const MAX_LOGGED_MOVES = 500;

const summariseMoves = (rows: readonly MovedRow[]) => {
  const byPrevious = new Map<number, number[]>();
  rows.forEach((row) => {
    const previous = row.PreviousCustomerID;
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

export async function POST(req: NextRequest) {
  logRequest(req, '/api/customers/merge');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  // dbo.Customers.ModifiedBy, dbo.Contacts.ModifiedBy and dbo.Offer.ModifiedBy
  // are all INT NOT NULL. A non-numeric audit id means we leave the existing
  // value alone rather than writing a broken one or failing the merge.
  const candidateModifiedBy = auditUserId != null && /^\d+$/.test(auditUserId.trim())
    ? Number.parseInt(auditUserId.trim(), 10)
    : null;

  try {
    const auth = await requirePermission(req, 'mergeCustomers');
    if (!auth.ok) return auth.response;

    let body: MergeCommitRequest | null = null;
    try {
      body = (await req.json()) as MergeCommitRequest;
    } catch {
      body = null;
    }

    const primaryId = normalizeId(body?.primaryId);
    const secondaryIds = collectMergeIds(body?.secondaryIds).filter((id) => id !== primaryId);
    const contactIdsToKeep = collectMergeIds(body?.contactIdsToKeep);
    const contactIdsToDisable = collectMergeIds(body?.contactIdsToDisable)
      .filter((id) => !contactIdsToKeep.includes(id));

    if (primaryId == null) {
      return NextResponse.json({ ok: false, error: 'A primary customer is required.' }, { status: 400 });
    }
    if (secondaryIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Select at least one other customer to merge into the primary.' },
        { status: 400 },
      );
    }
    if (secondaryIds.length > MAX_MERGE_SECONDARIES) {
      return NextResponse.json(
        { ok: false, error: `Merge at most ${MAX_MERGE_SECONDARIES} customers at a time.` },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const columns = await probeCustomerColumns(pool);
    const allowedFields = new Set(availableMergeFields(columns).map((f) => f.field));

    // ModifiedBy on dbo.Customers, dbo.Contacts and dbo.Offer all carry a
    // foreign key to dbo.AspNetUsers (FK_Customers_AspNetUsers1 and friends). An
    // id that does not resolve there would abort the entire merge with SQL 547
    // at whichever statement ran first, so it is checked once up front and
    // simply not written when it does not match a real user — the columns are
    // NOT NULL but already populated, so leaving them alone is safe.
    const modifiedBy = await (async () => {
      if (candidateModifiedBy == null) return null;
      const check = await pool
        .request()
        .input('userId', sql.Int, candidateModifiedBy)
        .query<{ ID: number }>('SELECT TOP (1) ID FROM dbo.AspNetUsers WHERE ID = @userId');
      return check.recordset?.[0] ? candidateModifiedBy : null;
    })();

    // Normalise the field picks: unknown fields, fields this database cannot
    // store, and nulls for NOT NULL columns are dropped rather than written.
    const rawValues = (body?.fieldValues ?? {}) as Partial<Record<MergeFieldKey, unknown>>;
    const fieldUpdates: Array<{ field: MergeFieldKey; value: string | number | null }> = [];
    const skippedRequired: MergeFieldKey[] = [];

    (Object.keys(rawValues) as MergeFieldKey[]).forEach((field) => {
      if (!allowedFields.has(field)) return;
      const config = MERGE_FIELD_COLUMNS[field];
      if (!config) return;

      const raw = rawValues[field];
      let value: string | number | null;
      if (raw === null || raw === undefined || raw === '') {
        value = null;
      } else if (config.type === 'number') {
        const parsed = Number(raw);
        value = Number.isFinite(parsed) ? parsed : null;
      } else {
        const trimmed = String(raw).trim();
        value = trimmed.length > 0 ? trimmed : null;
      }

      if (value !== null && typeof value === 'string' && JSON_SANITIZED_FIELDS.has(field)) {
        value = sanitizeJsonUnsafeChars(value);
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

    let movedContacts = 0;
    let movedOffers = 0;
    let movedChildren = 0;
    let disabled = 0;
    let primaryName: string | null = null;
    let contactMoves: MovedRow[] = [];
    let offerMoves: MovedRow[] = [];
    let childMoves: MovedRow[] = [];
    let strandedOfferContacts = 0;
    let disabledContacts = 0;
    let disabledContactIds: number[] = [];
    let primaryBefore: Record<string, unknown> = {};

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
        SELECT ID, Name, Enabled, ParentCustomerID, PricingPolicyID
        FROM dbo.Customers WITH (UPDLOCK, HOLDLOCK)
        WHERE ID IN (@primaryId, ${lockPlaceholders})
      `);
      const lockedRows = locked.recordset ?? [];
      const lockedIds = new Set(lockedRows.map((row) => row.ID));

      if (!lockedIds.has(primaryId)) {
        await transaction.rollback();
        return NextResponse.json({ ok: false, error: 'Primary customer not found.' }, { status: 404 });
      }
      const missing = secondaryIds.filter((id) => !lockedIds.has(id));
      if (missing.length > 0) {
        await transaction.rollback();
        return NextResponse.json(
          { ok: false, error: `Customer${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}` },
          { status: 404 },
        );
      }
      const primaryRow = lockedRows.find((row) => row.ID === primaryId);
      primaryName = primaryRow?.Name ?? null;

      // A NOT NULL field whose chosen value came out empty was skipped rather
      // than written. That is only worth telling the user about when it
      // actually refused to clear something: PricingPolicyID is empty on
      // essentially every customer, so warning unconditionally would fire on
      // almost every merge to report that nothing changed.
      const refusedToClear = skippedRequired.filter((field) => {
        const existing = field === 'PricingPolicyID'
          ? primaryRow?.PricingPolicyID
          : primaryRow?.Name;
        return existing != null && String(existing).trim() !== '';
      });
      if (refusedToClear.length > 0) {
        warnings.push(
          `Left unchanged because they cannot be empty: ${refusedToClear.join(', ')}.`,
        );
      }

      // A secondary that is already disabled has very likely been merged away
      // once before. Folding it into a second primary is allowed — it is
      // sometimes exactly the cleanup wanted — but it must not pass silently.
      const alreadyDisabled = lockedRows
        .filter((row) => row.ID !== primaryId && !(row.Enabled === true || row.Enabled === 1))
        .map((row) => row.ID);
      if (alreadyDisabled.length > 0) {
        warnings.push(
          `Already disabled before this merge: ${alreadyDisabled.join(', ')}. If one of these was merged away earlier, check dbo.Logs for that merge before relying on this one.`,
        );
      }

      // --- ancestors of the primary, for the parent-cycle guard ------------
      const ancestorResult = await transaction
        .request()
        .input('primaryId', sql.Int, primaryId)
        .query<{ ID: number }>(`
          WITH chain AS (
            SELECT c.ID, c.ParentCustomerID, 0 AS depth
            FROM dbo.Customers AS c WHERE c.ID = @primaryId
            UNION ALL
            SELECT p.ID, p.ParentCustomerID, chain.depth + 1
            FROM dbo.Customers AS p
            INNER JOIN chain ON p.ID = chain.ParentCustomerID
            WHERE chain.depth < 20
          )
          SELECT DISTINCT ID FROM chain WHERE ID <> @primaryId
          OPTION (MAXRECURSION 25)
        `);
      const ancestorIds = (ancestorResult.recordset ?? []).map((row) => row.ID);

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

      // --- 1. the surviving customer takes the chosen values ---------------
      // Read what it holds FIRST. Without this the audit records before: null
      // for every field, and a revert can restore the contacts, offers and
      // disabled records but not the values it overwrote here — which is
      // exactly the hole found when 21 merges had to be undone on 2026-09-01.
      if (fieldUpdates.length > 0) {
        const beforeRequest = transaction.request();
        beforeRequest.input('primaryId', sql.Int, primaryId);
        const beforeColumns = fieldUpdates
          .map(({ field }) => `[${MERGE_FIELD_COLUMNS[field].column}]`)
          .join(', ');
        const beforeResult = await beforeRequest.query<Record<string, unknown>>(
          `SELECT TOP (1) ${beforeColumns} FROM dbo.Customers WHERE ID = @primaryId`,
        );
        primaryBefore = beforeResult.recordset?.[0] ?? {};
      }

      if (fieldUpdates.length > 0) {
        const request = scopedRequest();
        const setClauses = fieldUpdates.map(({ field, value }, index) => {
          const paramName = `f${index}`;
          bindMergeField(request, paramName, field, value);
          return `[${MERGE_FIELD_COLUMNS[field].column}] = @${paramName}`;
        });
        await request.query(`
          UPDATE dbo.Customers
          SET ${setClauses.join(', ')}, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID = @primaryId
        `);
      }

      // --- 2. move the contacts the user chose to keep ----------------------
      // Scoped to contacts that are actually on a secondary right now, so a
      // stale review screen cannot drag in a contact from an unrelated customer.
      if (contactIdsToKeep.length > 0) {
        const request = scopedRequest();
        const contactList = contactIdsToKeep
          .map((id, index) => {
            request.input(`kc${index}`, sql.Int, id);
            return `@kc${index}`;
          })
          .join(', ');
        const result = await request.query<MovedRow>(`
          UPDATE dbo.Contacts
          SET CustomerID = @primaryId, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS MovedId, DELETED.CustomerID AS PreviousCustomerID
          WHERE ID IN (${contactList}) AND CustomerID IN (${secondaryList})
        `);
        contactMoves = result.recordset ?? [];
        movedContacts = contactMoves.length;
      }

      // --- 2b. switch off every contact the user unticked --------------------
      // On the primary or on a secondary: both are disabled, because the mail
      // exports filter on Contacts.Enabled but not on Customers.Enabled, so a
      // contact merely left behind on a disabled customer would carry on being
      // mailed. Runs AFTER the move above, and the two id sets are disjoint, so
      // a contact cannot be moved and disabled by the same merge.
      //
      // The CustomerID scope is what stops a stale review screen disabling
      // somebody else's contact: only rows belonging to the customers actually
      // in this merge can be touched, whatever ids the client posted.
      if (contactIdsToDisable.length > 0) {
        const request = scopedRequest();
        const list = contactIdsToDisable
          .map((id, index) => {
            request.input(`dc${index}`, sql.Int, id);
            return `@dc${index}`;
          })
          .join(', ');
        const result = await request.query<{ MovedId: number }>(`
          UPDATE dbo.Contacts
          SET Enabled = 0, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS MovedId
          WHERE ID IN (${list})
            AND CustomerID IN (@primaryId, ${secondaryList})
            AND Enabled = 1
        `);
        disabledContactIds = (result.recordset ?? []).map((row) => row.MovedId);
        disabledContacts = disabledContactIds.length;
      }

      // --- 3. every offer follows its customer ------------------------------
      // The OUTPUT clause is the reversal record. Offers are the only thing a
      // merge moves that cannot be worked out afterwards from the rows
      // themselves — a disabled secondary still holds its unmoved contacts, but
      // an offer carries no memory of the customer it used to belong to. This
      // map is what makes an un-merge possible from dbo.Logs alone.
      {
        const request = scopedRequest();
        const result = await request.query<MovedRow>(`
          UPDATE dbo.Offer
          SET CustomerID = @primaryId, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS MovedId, DELETED.CustomerID AS PreviousCustomerID
          WHERE CustomerID IN (${secondaryList})
        `);
        offerMoves = result.recordset ?? [];
        movedOffers = offerMoves.length;
      }

      // --- 4. parent / child links ------------------------------------------
      // 4a. the primary must not end up as its own parent.
      {
        const request = scopedRequest();
        await request.query(`
          UPDATE dbo.Customers
          SET ParentCustomerID = NULL, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID = @primaryId AND ParentCustomerID IN (${secondaryList})
        `);
      }

      // 4b. a child of a secondary that is ALSO an ancestor of the primary
      // would close a loop if repointed, so its link is cleared instead.
      const ancestorList = ancestorIds
        .map((_, index) => `@anc${index}`)
        .join(', ');
      if (ancestorIds.length > 0) {
        const request = scopedRequest();
        ancestorIds.forEach((id, index) => request.input(`anc${index}`, sql.Int, id));
        await request.query(`
          UPDATE dbo.Customers
          SET ParentCustomerID = NULL, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ParentCustomerID IN (${secondaryList}) AND ID IN (${ancestorList})
        `);
      }

      // 4c. everything else filed under a secondary moves to the primary.
      {
        const request = scopedRequest();
        ancestorIds.forEach((id, index) => request.input(`anc${index}`, sql.Int, id));
        const excludeAncestors = ancestorIds.length > 0 ? `AND ID NOT IN (${ancestorList})` : '';
        const result = await request.query<MovedRow>(`
          UPDATE dbo.Customers
          SET ParentCustomerID = @primaryId, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          OUTPUT INSERTED.ID AS MovedId, DELETED.ParentCustomerID AS PreviousCustomerID
          WHERE ParentCustomerID IN (${secondaryList})
            AND ID <> @primaryId
            ${excludeAncestors}
        `);
        childMoves = result.recordset ?? [];
        movedChildren = childMoves.length;
      }

      // 4d. a customer that now has children is a parent, whatever it was before.
      if (movedChildren > 0) {
        const request = scopedRequest();
        await request.query(`
          UPDATE dbo.Customers
          SET IsParent = 1, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID = @primaryId
            AND ISNULL(IsParent, 0) = 0
            AND EXISTS (SELECT 1 FROM dbo.Customers AS ch WHERE ch.ParentCustomerID = @primaryId)
        `);
      }

      // --- 5. retire the duplicates ------------------------------------------
      {
        const request = scopedRequest();
        const result = await request.query(`
          UPDATE dbo.Customers
          SET Enabled = 0, ${modifiedByClause}ModifiedOn = SYSUTCDATETIME()
          WHERE ID IN (${secondaryList})
        `);
        disabled = result.rowsAffected?.[0] ?? 0;
      }

      // --- 6. report offers left pointing at a contact that stayed behind ----
      // dbo.Offer.ContactID has no foreign key and is NOT rewritten by the
      // merge: the offer moves to the primary while its contact, if the user
      // chose not to keep it, stays filed under the now-disabled secondary. The
      // link still resolves — the contact row is untouched and still enabled —
      // but the pairing is odd enough that the operator should be told.
      {
        const request = scopedRequest();
        const result = await request.query<{ n: number }>(`
          SELECT COUNT(*) AS n
          FROM dbo.Offer AS o
          INNER JOIN dbo.Contacts AS k ON k.ID = o.ContactID
          WHERE o.CustomerID = @primaryId AND k.CustomerID IN (${secondaryList})
        `);
        strandedOfferContacts = result.recordset?.[0]?.n ?? 0;
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback().catch(() => {});
      throw txErr;
    }

    // Only the fields that genuinely CHANGED, with their real previous value.
    // Most picks re-write the primary's own value unchanged — logging those too
    // buried the handful that mattered in 218 rows of noise the last time a
    // merge had to be examined.
    const auditValue = (value: unknown): string | number | null => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'number') return value;
      // nchar columns (City) come back space-padded; compare and log them trimmed.
      const text = String(value).trim();
      return text.length > 0 ? text : null;
    };
    const fieldChanges = fieldUpdates
      .map((update) => ({
        targetId: primaryId,
        targetName: primaryName,
        field: update.field,
        before: auditValue(primaryBefore[MERGE_FIELD_COLUMNS[update.field].column]),
        after: auditValue(update.value),
      }))
      .filter((change) => String(change.before ?? '') !== String(change.after ?? ''));

    // dbo.Logs is the only record of a merge, so it carries everything needed to
    // reverse one by hand: which ids were folded in, and what moved.
    logEditAuditDetails({
      endpoint: '/api/customers/merge',
      method: 'POST',
      requestId,
      userId: auditUserId,
      targetEntity: 'customers',
      targetIds: [primaryId, ...secondaryIds],
      changes: [
        {
          targetId: primaryId,
          targetName: primaryName,
          field: 'MergedFrom',
          before: null,
          after: secondaryIds.join(', '),
        },
        ...fieldChanges,
      ],
      message: `Customers merged into #${primaryId}`,
      extra: {
        mergePrimaryId: primaryId,
        mergeSecondaryIds: secondaryIds,
        movedContacts,
        movedOffers,
        movedChildren,
        disabledCustomers: disabled,
        strandedOfferContacts,
        disabledContacts,
        disabledContactIds,
        // The reversal map: for each secondary, exactly which rows were taken
        // from it. Without this a merge cannot be undone, because a moved offer
        // or child keeps no record of where it came from.
        reversal: {
          offersByPreviousCustomer: summariseMoves(offerMoves),
          contactsByPreviousCustomer: summariseMoves(contactMoves),
          childrenByPreviousParent: summariseMoves(childMoves),
        },
      },
    });

    // The merge disabled records and moved names around, so any cached
    // duplicate scan is now describing a customer base that no longer exists.
    invalidateDuplicateScans();

    if (strandedOfferContacts > 0) {
      warnings.push(
        `${strandedOfferContacts} offer${strandedOfferContacts === 1 ? '' : 's'} moved to the primary but still name a contact you left on a disabled customer. The link still works; move those contacts too if you want the offer and its contact under the same record.`,
      );
    }

    return NextResponse.json({
      ok: true,
      primaryId,
      secondaryIds,
      moved: { contacts: movedContacts, offers: movedOffers, children: movedChildren },
      disabled,
      disabledContacts,
      fieldsUpdated: fieldUpdates.map((update) => update.field),
      warnings,
      // Echoed back so the operator can copy it before leaving the page: this is
      // the same map written to dbo.Logs, and the only route back from a merge.
      reversal: {
        offersByPreviousCustomer: summariseMoves(offerMoves),
        contactsByPreviousCustomer: summariseMoves(contactMoves),
        childrenByPreviousParent: summariseMoves(childMoves),
      },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
