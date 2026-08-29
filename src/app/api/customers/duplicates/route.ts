/**
 * Possible-duplicate customer suggestions.
 *
 * The whole customer base is scanned in one pass rather than queried per row:
 * duplicate detection is a self-join, and blocking it in JavaScript over ~11,800
 * rows costs about half a second, where doing it in SQL would mean either a
 * cartesian join or a stack of LIKE queries. The scan is cached (see
 * lib/duplicateScanCache) so paging and filtering do not re-scan; the page asks
 * for a fresh one every time it is opened.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import { requirePermission } from '../../../../lib/authz';
import { getDuplicateScan } from '../../../../lib/duplicateScanCache';
import type { DuplicateConfidence } from '../../../../lib/customerDuplicates';
import { normalizeSearchText } from '../../../../lib/textSearch';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const CONFIDENCES: readonly DuplicateConfidence[] = ['high', 'medium', 'low'];

const parseBool = (value: string | null, fallback: boolean): boolean => {
  if (value == null) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

export async function GET(req: NextRequest) {
  logRequest(req, '/api/customers/duplicates');
  try {
    const auth = await requirePermission(req, 'mergeCustomers');
    if (!auth.ok) return auth.response;

    const params = req.nextUrl.searchParams;
    const enabledOnly = parseBool(params.get('enabledOnly'), true);
    const excludeParents = parseBool(params.get('excludeParents'), true);
    const refresh = parseBool(params.get('refresh'), false);

    const requestedConfidence = params.get('confidence');
    const confidenceFilter = CONFIDENCES.includes(requestedConfidence as DuplicateConfidence)
      ? (requestedConfidence as DuplicateConfidence)
      : null;

    const search = normalizeSearchText(params.get('search') ?? '');

    const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0);
    const requestedLimit = Number.parseInt(params.get('limit') ?? '', 10);
    const limit = Math.min(
      MAX_LIMIT,
      Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT,
    );

    const { scan, cached } = await getDuplicateScan({ enabledOnly, excludeParents, refresh });

    // Tier counts describe the WHOLE scan, so the page can show what the other
    // tabs hold without fetching them.
    const counts: Record<DuplicateConfidence, number> = { high: 0, medium: 0, low: 0 };
    scan.groups.forEach((group) => { counts[group.confidence] += 1; });

    let filtered = scan.groups;
    if (confidenceFilter) {
      filtered = filtered.filter((group) => group.confidence === confidenceFilter);
    }
    if (search) {
      filtered = filtered.filter((group) =>
        group.members.some((member) =>
          normalizeSearchText(member.Name).includes(search)
          || normalizeSearchText(member.BrandName).includes(search)
          || String(member.CustomerID) === search
          || normalizeSearchText(member.TaxID).includes(search)),
      );
    }

    return NextResponse.json({
      ok: true,
      groups: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      counts,
      customerCount: scan.customerCount,
      scannedAt: new Date(scan.scannedAt).toISOString(),
      scanMs: scan.scanMs,
      cached,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
