import sql from 'mssql';
import type { ConnectionPool, Transaction, Request as SqlRequest } from 'mssql';

/**
 * Executes a callback inside a SQL transaction with automatic commit/rollback.
 *
 * Replaces the identical manual transaction pattern found in 13+ route files:
 *   const transaction = new sql.Transaction(pool);
 *   await transaction.begin();
 *   try { ... await transaction.commit(); }
 *   catch (err) { await transaction.rollback().catch(() => {}); throw err; }
 */
export async function withTransaction<T>(
  pool: ConnectionPool,
  fn: (transaction: Transaction, request: () => SqlRequest) => Promise<T>,
): Promise<T> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await fn(transaction, () => new sql.Request(transaction));
    await transaction.commit();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}
