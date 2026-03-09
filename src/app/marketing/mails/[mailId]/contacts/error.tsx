'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '50vh', gap: '16px',
      color: '#f1f5f9', padding: '40px',
    }}>
      <h2 style={{ fontSize: '1.3rem', fontWeight: 500, margin: 0 }}>Failed to load mail contacts</h2>
      <p style={{ color: '#94a3b8', margin: 0, maxWidth: '480px', textAlign: 'center' }}>
        {error.message || 'An unexpected error occurred.'}
      </p>
      <button onClick={reset} style={{
        marginTop: '8px', padding: '8px 20px', borderRadius: '999px',
        border: '1px solid #334155', background: '#1e293b', color: '#f1f5f9',
        fontSize: '14px', cursor: 'pointer',
      }}>
        Try again
      </button>
    </div>
  );
}
