/**
 * Per-table cache of the similar-name index behind /api/duplicates.
 *
 * Building an index means reading every row of the table (11,814 customers,
 * 543 brands, 51 suppliers) and normalising each name: on the order of 100 ms
 * for customers. The create forms ask for a check at every pause in typing, so
 * that cannot be repeated per request. But a check that misses a customer
 * created ten seconds ago is exactly the failure this warning exists to
 * prevent, so a plain TTL is not good enough either.
 *
 * Instead every check first runs a fingerprint query: the row count plus a
 * CHECKSUM_AGG over the columns the index reads. The index is rebuilt only when
 * the fingerprint differs. That is one narrow scan, a few milliseconds, and it
 * catches inserts, renames, tax-id edits, enable/disable and deletes alike,
 * without relying on ModifiedOn being stamped (it is not, consistently: some
 * paths still write GETDATE(), three hours ahead of the UTC stamps). A hard
 * maximum age backs it up in case a checksum ever collides.
 */
import { getPool } from './sql';
import {
  buildSimilarNameIndex,
  type FindOptions,
  type NameEntry,
  type SimilarName,
  type SimilarNameIndex,
} from './similarNames';

export type NameEntity = 'customer' | 'supplier' | 'brand';

type Source = {
  /** Every row, shaped as a NameEntry. */
  load: string;
  /** One row, {n, ck}: changes whenever anything `load` reads changes. */
  fingerprint: string;
};

// Suppliers.TaxID is nchar(18), so it comes back space-padded; RTRIM keeps the
// value the warning shows honest. Harmless on the nvarchar column.
const SOURCES: Record<NameEntity, Source> = {
  customer: {
    load: `SELECT ID AS id, Name AS name, BrandName AS brandName, RTRIM(TaxID) AS taxId, Enabled AS enabled
           FROM dbo.Customers`,
    fingerprint: `SELECT COUNT(*) AS n, CHECKSUM_AGG(CHECKSUM(ID, Name, BrandName, TaxID, Enabled)) AS ck
                  FROM dbo.Customers`,
  },
  supplier: {
    load: `SELECT ID AS id, Name AS name, RTRIM(TaxID) AS taxId, Enabled AS enabled
           FROM dbo.Suppliers`,
    fingerprint: `SELECT COUNT(*) AS n, CHECKSUM_AGG(CHECKSUM(ID, Name, TaxID, Enabled)) AS ck
                  FROM dbo.Suppliers`,
  },
  brand: {
    load: `SELECT ID AS id, Name AS name, Enabled AS enabled
           FROM dbo.Brands`,
    fingerprint: `SELECT COUNT(*) AS n, CHECKSUM_AGG(CHECKSUM(ID, Name, Enabled)) AS ck
                  FROM dbo.Brands`,
  },
};

const MAX_AGE_MS = 10 * 60 * 1000;

type Cached = {
  index: SimilarNameIndex;
  fingerprint: string;
  builtAt: number;
};

const cache = new Map<NameEntity, Cached>();
const inflight = new Map<NameEntity, Promise<SimilarNameIndex>>();

const readFingerprint = async (entity: NameEntity): Promise<string> => {
  const pool = await getPool();
  const result = await pool.request().query<{ n: number; ck: number | null }>(SOURCES[entity].fingerprint);
  const row = result.recordset?.[0];
  return `${row?.n ?? 0}:${row?.ck ?? 0}`;
};

const rebuild = async (entity: NameEntity, fingerprint: string): Promise<SimilarNameIndex> => {
  const pool = await getPool();
  const result = await pool.request().query<NameEntry>(SOURCES[entity].load);
  const index = buildSimilarNameIndex(result.recordset ?? []);
  cache.set(entity, { index, fingerprint, builtAt: Date.now() });
  return index;
};

export const getSimilarNameIndex = async (entity: NameEntity): Promise<SimilarNameIndex> => {
  const fingerprint = await readFingerprint(entity);
  const existing = cache.get(entity);
  if (existing && existing.fingerprint === fingerprint && Date.now() - existing.builtAt < MAX_AGE_MS) {
    return existing.index;
  }
  // Two checks arriving on a stale cache share one rebuild rather than racing.
  const pending = inflight.get(entity);
  if (pending) return pending;
  const task = rebuild(entity, fingerprint).finally(() => inflight.delete(entity));
  inflight.set(entity, task);
  return task;
};

export const findSimilarNames = async (
  entity: NameEntity,
  needle: string,
  options?: FindOptions,
): Promise<SimilarName[]> => (await getSimilarNameIndex(entity)).find(needle, options);

/** Forget every cached index. The next check rebuilds from the database. */
export const invalidateSimilarNameIndexes = (): void => {
  cache.clear();
};
