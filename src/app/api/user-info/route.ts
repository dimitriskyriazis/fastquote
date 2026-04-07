import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { buildAuditContext } from '../../../lib/auditTrail';
import { fetchUserRoles } from '../../../lib/authz';

type UserRow = {
  UserName: string | null;
  FullName: string | null;
  FullNameGR: string | null;
  Email: string | null;
  SignTitle: string | null;
  NameCode: string | null;
  SalesSeniorityName: string | null;
  SalesDivisionName: string | null;
};

type DivisionRow = { Name: string | null };

type UpdateInput = {
  field?: string | null;
  value?: unknown;
};

const EDITABLE_FIELDS: Record<string, string> = {
  FullName: 'FullName',
  FullNameGR: 'FullNameGR',
  Email: 'Email',
  SignTitle: 'SignTitle',
  NameCode: 'NameCode',
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = (typeof value === 'string' ? value : String(value)).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveUserId = (req: NextRequest): string | null => {
  const audit = buildAuditContext(req);
  const raw = audit.userId;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
};

/**
 * GET /api/user-info
 *
 * Returns the authenticated user's profile and sales division options.
 */
export async function GET(req: NextRequest) {
  logRequest(req, '/api/user-info');
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }

    const pool = await getPool();

    const [userResult, rolesResult, divisionsResult] = await Promise.all([
      (() => {
        const request = pool.request();
        request.input('userId', sql.Int, Number(userId));
        return request.query<UserRow>(`
          SELECT
            u.UserName,
            u.FullName,
            u.FullNameGR,
            u.Email,
            u.SignTitle,
            u.NameCode,
            ss.Name AS SalesSeniorityName,
            sd.Name AS SalesDivisionName
          FROM dbo.AspNetUsers u
          LEFT JOIN dbo.SalesSeniorities ss ON ss.ID = u.SalesSeniorityID
          LEFT JOIN dbo.SalesDivision sd ON sd.ID = u.SalesDivisionID
          WHERE u.Id = @userId
        `);
      })(),
      fetchUserRoles(userId),
      pool.request().query<DivisionRow>(`
        SELECT Name FROM dbo.SalesDivision ORDER BY Name
      `),
    ]);

    const user = userResult.recordset?.[0];
    if (!user) {
      return NextResponse.json({ ok: false, error: 'User not found' }, { status: 404 });
    }

    const salesDivisions = (divisionsResult.recordset ?? [])
      .map((r) => r.Name?.trim())
      .filter((n): n is string => Boolean(n));

    return NextResponse.json({
      ok: true,
      user: {
        userName: (user.UserName ?? '').trim(),
        fullName: (user.FullName ?? '').trim(),
        fullNameGR: (user.FullNameGR ?? '').trim(),
        email: (user.Email ?? '').trim(),
        signTitle: (user.SignTitle ?? '').trim(),
        nameCode: (user.NameCode ?? '').trim(),
        salesSeniority: (user.SalesSeniorityName ?? '').trim(),
        salesDivision: (user.SalesDivisionName ?? '').trim(),
        roles: rolesResult,
      },
      salesDivisions,
    });
  } catch (err) {
    console.error('Failed to load user info', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/user-info
 *
 * Updates the authenticated user's own editable fields.
 * Body: { updates: [{ field: string, value: string }] }
 */
export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/user-info');
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: UpdateInput[] } | null)?.updates)
      ? ((body as { updates?: UpdateInput[] }).updates ?? [])
      : [];

    if (updates.length === 0) {
      return NextResponse.json({ ok: false, error: 'No updates provided.' }, { status: 400 });
    }

    const pool = await getPool();
    let appliedCount = 0;

    for (const entry of updates) {
      const field = typeof entry?.field === 'string' ? entry.field : null;
      if (!field) continue;

      if (field === 'SalesDivision') {
        const value = normalizeOptionalString(entry?.value);
        let divisionId: number | null = null;
        if (value) {
          const divRequest = pool.request();
          divRequest.input('divisionName', sql.NVarChar, value);
          const divResult = await divRequest.query<{ ID: number }>(`
            SELECT TOP 1 ID FROM dbo.SalesDivision WHERE Name = @divisionName ORDER BY ID
          `);
          divisionId = divResult.recordset?.[0]?.ID ?? null;
          if (divisionId == null) {
            return NextResponse.json(
              { ok: false, error: `Sales division "${value}" not found.` },
              { status: 400 },
            );
          }
        }
        const request = pool.request();
        request.input('userId', sql.Int, Number(userId));
        request.input('divisionId', sql.Int, divisionId);
        await request.query(`
          UPDATE dbo.AspNetUsers SET SalesDivisionID = @divisionId WHERE Id = @userId
        `);
        appliedCount++;
        continue;
      }

      const column = EDITABLE_FIELDS[field];
      if (!column) continue;

      const value = normalizeOptionalString(entry?.value);
      const request = pool.request();
      request.input('userId', sql.Int, Number(userId));
      request.input('value', sql.NVarChar, value);
      await request.query(`
        UPDATE dbo.AspNetUsers SET ${column} = @value WHERE Id = @userId
      `);
      appliedCount++;
    }

    if (appliedCount === 0) {
      return NextResponse.json({ ok: false, error: 'No valid updates provided.' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, updated: appliedCount });
  } catch (err) {
    console.error('Failed to update user info', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
