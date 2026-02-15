'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { readClipboard } from './productClipboard';

type Props = {
  onConfirm: (keepPricing: boolean) => void;
  onCancel: () => void;
};

export default function PasteProductsDialog({ onConfirm, onCancel }: Props) {
  const [keepPricing, setKeepPricing] = useState(true);
  const clipboard = readClipboard();

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }, [onCancel]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!clipboard) {
    return null;
  }

  const rowCount = clipboard.rows.length;
  const sourceLabel = clipboard.sourceOfferId;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 2147483646,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: '#ffffff',
          borderRadius: 12,
          width: 'min(420px, 90vw)',
          padding: '22px 24px',
          boxShadow: '0 20px 60px rgba(15, 23, 42, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#1e293b' }}>
          Paste Rows
        </h3>
        <p style={{ margin: 0, fontSize: '0.9rem', color: '#475569' }}>
          Clipboard contains <strong>{rowCount}</strong> row{rowCount !== 1 ? 's' : ''} from
          offer <strong>{sourceLabel}</strong>.
        </p>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: '0.9rem',
            color: '#334155',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={keepPricing}
            onChange={(e) => setKeepPricing(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          Keep original pricing and quantities
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: '#f8fafc',
              color: '#475569',
              fontSize: '0.85rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(keepPricing)}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid #3b82f6',
              background: '#3b82f6',
              color: '#ffffff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
