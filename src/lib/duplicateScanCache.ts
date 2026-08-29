/**
 * In-process cache for the duplicate-customer scan.
 *
 * The scan reads all ~11,800 customers and compares them, which costs roughly
 * half a second. That is cheap enough to redo whenever someone opens the page,
 * but far too expensive to redo for every tab switch and page of results — so
 * the page asks for a fresh scan on mount and reuses the cache for paging.
 *
 * The cache also has to be dropped the moment the underlying data changes,
 * otherwise a customer renamed (or merged away) a second ago keeps showing up
 * with its old name. Mutations call invalidateDuplicateScans() for that; the TTL
 * is only a backstop for edits made somewhere this process never sees.
 */
import { getPool } from './sql';
import {
  findDuplicateGroups,
  type DuplicateGroup,
  type DuplicateScanCustomer,
} from './customerDuplicates';

const CACHE_TTL_MS = 2 * 60 * 1000;

export type DuplicateScan = {
  groups: DuplicateGroup[];
  scannedAt: number;
  customerCount: number;
  scanMs: number;
};

const cache = new Map<string, DuplicateScan>();

/**
 * Drops every cached scan. Called after any mutation that can change what counts
 * as a duplicate — a merge, or an edit to a name, tax id or ERP id.
 */
export const invalidateDuplicateScans = (): void => {
  cache.clear();
};

const loadCustomers = async (): Promise<DuplicateScanCustomer[]> => {
  const pool = await getPool();
  const result = await pool.request().query<DuplicateScanCustomer>(`
    SELECT
      c.ID AS CustomerID,
      c.Name, c.BrandName, c.TaxID, c.ERPID, c.City, c.Email, c.Phone,
      c.Enabled, c.IsParent,
      ISNULL(offers.n, 0) AS OfferCount,
      ISNULL(contacts.n, 0) AS ContactCount
    FROM dbo.Customers AS c
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.Offer AS o WHERE o.CustomerID = c.ID) AS offers
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.Contacts AS k WHERE k.CustomerID = c.ID) AS contacts
  `);
  return result.recordset ?? [];
};

export const getDuplicateScan = async (params: {
  enabledOnly: boolean;
  excludeParents: boolean;
  /** Skip the cache and rescan. The page passes this whenever it is opened. */
  refresh: boolean;
}): Promise<{ scan: DuplicateScan; cached: boolean }> => {
  const key = `${params.enabledOnly ? 1 : 0}:${params.excludeParents ? 1 : 0}`;
  const existing = cache.get(key);
  if (!params.refresh && existing && Date.now() - existing.scannedAt < CACHE_TTL_MS) {
    return { scan: existing, cached: true };
  }

  const customers = await loadCustomers();
  const startedAt = Date.now();
  const groups = findDuplicateGroups(customers, {
    enabledOnly: params.enabledOnly,
    excludeParents: params.excludeParents,
    // The page pages through the whole result, so the scan itself is not capped.
    limit: Number.MAX_SAFE_INTEGER,
  });
  const scan: DuplicateScan = {
    groups,
    scannedAt: Date.now(),
    customerCount: customers.length,
    scanMs: Date.now() - startedAt,
  };
  cache.set(key, scan);
  return { scan, cached: false };
};
