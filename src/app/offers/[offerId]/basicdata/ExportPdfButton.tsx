'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { showToastMessage } from '../../../../lib/toast';

type Props = {
  offerId: string;
  className?: string;
};

type Layout = 'standard' | 'detailed';
type Lang = 'el' | 'en';
type MenuStep = 'layout' | 'language';

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 16px',
  border: 'none',
  background: 'none',
  textAlign: 'left',
  fontSize: 13,
  cursor: 'pointer',
  color: '#0f172a',
};

const menuHeaderStyle: React.CSSProperties = {
  padding: '6px 16px 4px',
  fontSize: 10,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

export default function ExportPdfButton({ offerId, className }: Props) {
  const [isExporting, setIsExporting] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuStep, setMenuStep] = useState<MenuStep>('layout');
  const [selectedLayout, setSelectedLayout] = useState<Layout>('standard');
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setShowMenu(false);
        setMenuStep('layout');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const handleLayoutSelect = (layout: Layout) => {
    setSelectedLayout(layout);
    setMenuStep('language');
  };

  const handleExport = useCallback(
    async (lang: Lang) => {
      setShowMenu(false);
      setMenuStep('layout');
      setIsExporting(true);
      try {
        const res = await fetch(
          `/api/offers/${encodeURIComponent(offerId)}/pdf?lang=${lang}&layout=${selectedLayout}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // Try to use Content-Disposition filename
        const disposition = res.headers.get('Content-Disposition');
        const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
        a.download = filenameMatch?.[1] ?? `Offer_${offerId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToastMessage('PDF printed successfully', 'success');
      } catch (err) {
        console.error('PDF printing failed:', err);
        showToastMessage(
          err instanceof Error ? err.message : 'Failed to print PDF',
          'error',
        );
      } finally {
        setIsExporting(false);
      }
    },
    [offerId, selectedLayout],
  );

  const handleHover = (e: React.MouseEvent, enter: boolean) => {
    (e.target as HTMLElement).style.backgroundColor = enter ? '#f1f5f9' : 'transparent';
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        disabled={isExporting}
        onClick={() => {
          setShowMenu((prev) => !prev);
          setMenuStep('layout');
        }}
      >
        {isExporting ? 'Printing...' : 'Print Offer in PDF'}
      </button>

      {showMenu && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
            zIndex: 100,
            minWidth: 200,
            overflow: 'hidden',
          }}
        >
          {menuStep === 'layout' && (
            <>
              <div style={menuHeaderStyle}>Layout</div>
              <button
                type="button"
                onClick={() => handleLayoutSelect('standard')}
                style={menuItemStyle}
                onMouseEnter={(e) => handleHover(e, true)}
                onMouseLeave={(e) => handleHover(e, false)}
              >
                Standard
              </button>
              <button
                type="button"
                onClick={() => handleLayoutSelect('detailed')}
                style={menuItemStyle}
                onMouseEnter={(e) => handleHover(e, true)}
                onMouseLeave={(e) => handleHover(e, false)}
              >
                Detailed (with Telmaco Discount)
              </button>
            </>
          )}

          {menuStep === 'language' && (
            <>
              <div style={menuHeaderStyle}>
                <button
                  type="button"
                  onClick={() => setMenuStep('layout')}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 10,
                    fontWeight: 600,
                    color: '#64748b',
                    padding: 0,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  &larr; Language
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleExport('el')}
                style={menuItemStyle}
                onMouseEnter={(e) => handleHover(e, true)}
                onMouseLeave={(e) => handleHover(e, false)}
              >
                Ελληνικά (Greek)
              </button>
              <button
                type="button"
                onClick={() => handleExport('en')}
                style={menuItemStyle}
                onMouseEnter={(e) => handleHover(e, true)}
                onMouseLeave={(e) => handleHover(e, false)}
              >
                English
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
