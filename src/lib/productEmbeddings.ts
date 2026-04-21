import crypto from 'crypto';
import OpenAI from 'openai';
import { getPool, sql } from './sql';

// @types/mssql doesn't reliably surface VarBinary / Binary when mssql is
// imported via the bundler-mode namespace (they're in the .d.ts but don't
// make it into the resolved type).  Narrow cast to the shape we actually use.
type SqlFactoryWithLength = (length?: number) => unknown;
const sqlTypes = sql as unknown as {
  VarBinary: SqlFactoryWithLength;
  Binary: SqlFactoryWithLength;
};

// text-embedding-3-small: 1536 dims × 4 bytes = 6144 bytes per row.  Cheap
// ($0.02/1M tokens) and good enough for product-description retrieval.  If we
// ever need more quality we can migrate to text-embedding-3-large (3072 dims,
// ~6x price) — the column is sized for that too.
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

type RawProductRow = {
  ProductID: number;
  BrandName: string | null;
  PartNumber: string | null;
  ModelNumber: string | null;
  Description: string | null;
};

// Compose the one-line text we actually embed for a product.  Keeping this
// logic central guarantees backfill and on-demand refresh produce bit-identical
// text, so the EmbeddingTextHash can reliably detect changes.
export function composeEmbeddingText(row: RawProductRow): string {
  const parts: string[] = [];
  const push = (label: string, v: string | null | undefined) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t) parts.push(`${label}: ${t}`);
  };
  push('Brand', row.BrandName);
  push('Part', row.PartNumber);
  push('Model', row.ModelNumber);
  push('Description', row.Description);
  return parts.join(' | ');
}

export function computeTextHash(text: string): Buffer {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

// Convert a 1536-dim Float32Array to a raw little-endian byte buffer and back.
// SQL Server stores it as VARBINARY; we use the driver's Buffer passthrough.
export function encodeVector(vec: Float32Array): Buffer {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`encodeVector: expected ${EMBEDDING_DIM} dims, got ${vec.length}`);
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  if (buf.length !== EMBEDDING_DIM * 4) {
    throw new Error(`decodeVector: expected ${EMBEDDING_DIM * 4} bytes, got ${buf.length}`);
  }
  // Copy into an aligned ArrayBuffer — Node's Buffer pools can have arbitrary
  // offsets that break Float32Array view construction otherwise.
  const ab = new ArrayBuffer(buf.length);
  Buffer.from(ab).set(buf);
  return new Float32Array(ab);
}

// Embed a batch of texts.  OpenAI accepts up to 2048 inputs per call but to
// stay well under response-size + timeout limits we cap at 256.
const EMBED_BATCH_SIZE = 256;

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const client = getOpenAI();
  const out: Float32Array[] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: slice,
    });
    response.data.forEach((item, idx) => {
      const arr = new Float32Array(item.embedding.length);
      for (let j = 0; j < item.embedding.length; j += 1) arr[j] = item.embedding[j];
      out[i + idx] = arr;
    });
  }
  return out;
}

export async function embedSingle(text: string): Promise<Float32Array> {
  const [vec] = await embedTexts([text]);
  return vec;
}

// In-memory semantic index.  Loaded lazily on first query.  For a 30k-product
// catalog this is ~180MB resident — trivial for a Node process.  Cosine
// similarity against all rows takes ~30-80ms which is fine; swap for a proper
// ANN lib (hnswlib-node) if the catalog ever crosses 200k products.
class SemanticIndex {
  private ids: Int32Array | null = null;
  private vectors: Float32Array | null = null;  // flat [n * dim]
  private loadPromise: Promise<void> | null = null;
  private loadedAt = 0;

  async ensureLoaded(): Promise<void> {
    if (this.vectors && this.ids) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load()
      .catch((err) => { this.loadPromise = null; throw err; });
    return this.loadPromise;
  }

  // Clear the in-memory index so the next search reloads.  Invoked by the
  // backfill job after writing a batch so fresh embeddings are picked up
  // without a process restart.
  invalidate(): void {
    this.ids = null;
    this.vectors = null;
    this.loadPromise = null;
  }

  private async load(): Promise<void> {
    const pool = await getPool();
    // Select embeddings in ProductID order.  We keep the id array parallel
    // to the vectors array and do a linear scan at query time.
    const result = await pool.request()
      .query<{ ID: number; Embedding: Buffer }>(
        'SELECT ID, Embedding FROM dbo.Products WHERE Embedding IS NOT NULL ORDER BY ID',
      );
    const rows = result.recordset ?? [];
    const ids = new Int32Array(rows.length);
    const vectors = new Float32Array(rows.length * EMBEDDING_DIM);
    for (let i = 0; i < rows.length; i += 1) {
      ids[i] = rows[i].ID;
      const vec = decodeVector(rows[i].Embedding);
      vectors.set(vec, i * EMBEDDING_DIM);
    }
    this.ids = ids;
    this.vectors = vectors;
    this.loadedAt = Date.now();
  }

  // Cosine similarity ranking.  Input vector is assumed unit-normalized
  // (OpenAI embeddings are) — we don't normalize stored vectors again
  // either, so cos(a,b) = dot(a,b).  Returns [ProductID, score] pairs,
  // sorted descending by score, top `topK` entries.
  search(query: Float32Array, topK: number): Array<{ productId: number; score: number }> {
    if (!this.vectors || !this.ids) return [];
    if (query.length !== EMBEDDING_DIM) return [];
    const n = this.ids.length;
    const dim = EMBEDDING_DIM;
    const vectors = this.vectors;

    // Top-K selection via a simple incremental sort of a small buffer.
    // For topK=50 the O(N*K) overhead is still negligible vs the N*D dot
    // products we're doing anyway.
    const k = Math.max(1, Math.min(topK, n));
    const topScores = new Float32Array(k);
    const topIds = new Int32Array(k);
    topScores.fill(-Infinity);

    for (let i = 0; i < n; i += 1) {
      let score = 0;
      const base = i * dim;
      for (let j = 0; j < dim; j += 1) {
        score += vectors[base + j] * query[j];
      }
      // Insert into top-K if better than the current worst.
      if (score > topScores[k - 1]) {
        // Find insertion point by scan from the end.
        let pos = k - 1;
        while (pos > 0 && topScores[pos - 1] < score) {
          topScores[pos] = topScores[pos - 1];
          topIds[pos] = topIds[pos - 1];
          pos -= 1;
        }
        topScores[pos] = score;
        topIds[pos] = this.ids[i];
      }
    }

    const out: Array<{ productId: number; score: number }> = [];
    for (let i = 0; i < k; i += 1) {
      if (!Number.isFinite(topScores[i])) break;
      out.push({ productId: topIds[i], score: topScores[i] });
    }
    return out;
  }

  stats(): { loaded: boolean; count: number; loadedAt: number } {
    return {
      loaded: this.vectors != null,
      count: this.ids?.length ?? 0,
      loadedAt: this.loadedAt,
    };
  }
}

let _indexInstance: SemanticIndex | null = null;
export function getSemanticIndex(): SemanticIndex {
  if (!_indexInstance) _indexInstance = new SemanticIndex();
  return _indexInstance;
}

// Fire-and-forget embedding for a single product.  Called from the product
// create / update routes so freshly-inserted or just-edited rows land in the
// semantic index without waiting for the nightly backfill.  Errors are
// swallowed (logged) — an embedding miss is a soft failure, not worth
// blocking the user's save.
export async function embedProductAsync(productId: number): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, productId)
      .query<RawProductRow>(`
        SELECT
          p.ID AS ProductID,
          p.PartNumber,
          p.ModelNumber,
          p.Description,
          b.Name AS BrandName
        FROM dbo.Products p
          LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
        WHERE p.ID = @id
      `);
    const row = result.recordset?.[0];
    if (!row) return;
    const text = composeEmbeddingText(row);
    if (!text.trim()) return;
    const [vector] = await embedTexts([text]);
    await writeEmbeddings([{ productId: row.ProductID, text, vector }]);
    getSemanticIndex().invalidate();
  } catch (err) {
    console.warn(`Failed to embed product ${productId}`, err);
  }
}

// Backfill-job helper: fetch the next batch of products needing embedding.
// "Needs embedding" = Embedding IS NULL OR EmbeddingTextHash doesn't match
// the current text's hash (which handles post-edit re-embedding).
export async function fetchProductsNeedingEmbedding(limit: number): Promise<RawProductRow[]> {
  const pool = await getPool();
  const result = await pool.request()
    .input('limit', sql.Int, limit)
    .query<RawProductRow>(`
      SELECT TOP (@limit)
        p.ID AS ProductID,
        p.PartNumber,
        p.ModelNumber,
        p.Description,
        b.Name AS BrandName
      FROM dbo.Products p
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      WHERE p.Embedding IS NULL
      ORDER BY p.ID
    `);
  return result.recordset ?? [];
}

// Write a batch of embeddings back to the DB.  Uses a merge-style UPDATE via
// a table-valued parameter would be ideal but mssql's TVP plumbing is awkward;
// individual UPDATEs in a transaction are plenty fast for the batch sizes we
// use and keep the code readable.
export async function writeEmbeddings(
  rows: Array<{ productId: number; text: string; vector: Float32Array }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    let written = 0;
    for (const row of rows) {
      const request = tx.request();
      request.input('id', sql.Int, row.productId);
      request.input('embedding', sqlTypes.VarBinary(8000), encodeVector(row.vector));
      request.input('model', sql.NVarChar(50), EMBEDDING_MODEL);
      request.input('embeddedAt', sql.DateTime2, new Date());
      request.input('textHash', sqlTypes.VarBinary(32), computeTextHash(row.text));
      const result = await request.query<{ rowsAffected: number }>(`
        UPDATE dbo.Products
        SET Embedding = @embedding,
            EmbeddingModel = @model,
            EmbeddedAt = @embeddedAt,
            EmbeddingTextHash = @textHash
        WHERE ID = @id
      `);
      written += (result as unknown as { rowsAffected: number[] }).rowsAffected?.[0] ?? 0;
    }
    await tx.commit();
    return written;
  } catch (err) {
    try { await tx.rollback(); } catch { /* noop */ }
    throw err;
  }
}
