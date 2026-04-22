// Next.js instrumentation hook — runs once on server startup, before any
// route handler.  Currently a no-op; previously used to warm up the
// in-memory semantic index, but that pipeline was retired when SQL Server
// 2019 ruled out native VECTOR_DISTANCE and client/server plumbing of
// embeddings proved fragile.  Ranking quality now comes from mandatory
// LLM rerank on the grid's top-50 keyword results.

export async function register(): Promise<void> {
  // Reserved for future startup work.  Intentionally empty.
}
