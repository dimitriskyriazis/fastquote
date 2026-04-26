'use client';

import { useState, useRef, useEffect, useCallback, useMemo, type DragEvent } from 'react';
import { showToastMessage } from '../../../../lib/toast';
import LookupModal from '../../../components/LookupModal';
import {
  DEFAULT_PDF_PRODUCT_COLUMNS,
  PDF_PRODUCT_COLUMNS,
  buildPdfColumnsStorageKey,
  readSavedPdfColumns,
  writeSavedPdfColumns,
  type PdfProductColumn,
} from '../../../../lib/pdfColumns';
import { useAuditUser } from '../../../components/AuditUserProvider';

type Props = {
  offerId: string;
  className?: string;
};

type Lang = 'el' | 'en';
type Orientation = 'portrait' | 'landscape';
type MenuStep = 'columns' | 'totals' | 'orientation';
type DropPosition = 'before' | 'after';
type DropPreview = { column: PdfProductColumn; position: DropPosition } | null;

const TERM_FIELD_LABELS: Record<string, string> = {
  paymentTerms: 'Payment Terms',
  deliveryTime: 'Delivery Time',
  offerValidity: 'Offer Validity',
};

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

const PRICE_COLUMN_SET = new Set<PdfProductColumn>(['listPrice', 'totalList', 'discount', 'unitPrice', 'total']);

const columnLabels: Record<PdfProductColumn, string> = {
  no: 'No',
  qty: 'Qty',
  brand: 'Brand',
  type: 'Part Number',
  modelNumber: 'Model Number',
  description: 'Description',
  warranty: 'Warranty',
  origin: 'Origin',
  comment: 'Comment',
  delivery: 'Delivery',
  listPrice: 'Unit List',
  totalList: 'Total List',
  discount: 'Discount %',
  unitPrice: 'Unit Net',
  total: 'Total Net',
  requestedBrand: 'Req. Brand',
  requestedPartNo: 'Req. Part Number',
  requestedModelNo: 'Req. Model Number',
  requestedDescription: 'Req. Description',
  requestedQuantity: 'Req. Qty',
};

export default function ExportPdfButton({ offerId, className }: Props) {
  const { userId } = useAuditUser();
  const storageKey = useMemo(() => buildPdfColumnsStorageKey(userId, offerId), [userId, offerId]);
  const [isExporting, setIsExporting] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuStep, setMenuStep] = useState<MenuStep>('columns');
  const [selectedColumns, setSelectedColumns] = useState<PdfProductColumn[]>(() => {
    const saved = readSavedPdfColumns(buildPdfColumnsStorageKey(userId, offerId));
    return saved ?? [...DEFAULT_PDF_PRODUCT_COLUMNS];
  });

  useEffect(() => {
    const saved = readSavedPdfColumns(storageKey);
    if (saved) setSelectedColumns(saved);
  }, [storageKey]);

  useEffect(() => {
    writeSavedPdfColumns(storageKey, selectedColumns);
  }, [storageKey, selectedColumns]);
  const [draggingColumn, setDraggingColumn] = useState<PdfProductColumn | null>(null);
  const draggingColumnRef = useRef<PdfProductColumn | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview>(null);
  const [selectedLang, setSelectedLang] = useState<Lang>('el');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFilename, setPreviewFilename] = useState('');
  const [noOfLevels, setNoOfLevels] = useState(0);
  const [printProducts, setPrintProducts] = useState(false);
  const [printCategories, setPrintCategories] = useState(false);
  const [printSubCategories, setPrintSubCategories] = useState(false);
  const [printSubSubCategories, setPrintSubSubCategories] = useState(false);
  const [smallOffer, setSmallOffer] = useState(false);
  const [equipmentList, setEquipmentList] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const openMenuWithValidation = useCallback(async () => {
    if (showMenu) {
      setShowMenu(false);
      setMenuStep('columns');
      return;
    }
    setLoadingSettings(true);
    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/pdf-settings`);
      if (!res.ok) {
        showToastMessage('Failed to load PDF settings.', 'error');
        return;
      }
      const data = await res.json();
      const terms = data.terms ?? {};
      const isMissing = (v: unknown) => typeof v !== 'string' || v.trim().length === 0;
      const missing: string[] = [];
      if (isMissing(terms.paymentTerms)) missing.push('paymentTerms');
      if (isMissing(terms.deliveryTime)) missing.push('deliveryTime');
      if (isMissing(terms.offerValidity)) missing.push('offerValidity');
      if (missing.length > 0) {
        const labels = missing.map((id) => TERM_FIELD_LABELS[id]).join(', ');
        window.dispatchEvent(
          new CustomEvent('fastquote:highlight-pdf-terms-missing', { detail: missing }),
        );
        showToastMessage(
          `Cannot generate PDF. Please fill in the following fields on the offer's Basic Data page: ${labels}.`,
          'error',
        );
        return;
      }
      setNoOfLevels(data.noOfLevels ?? 0);
      setPrintProducts(!!data.printProducts);
      setPrintCategories(!!data.printCategories);
      setPrintSubCategories(!!data.printSubCategories);
      setPrintSubSubCategories(!!data.printSubSubCategories);
      if (data.offerLanguage === 'English') setSelectedLang('en');
      else if (data.offerLanguage === 'Greek') setSelectedLang('el');
      setMenuStep('columns');
      setShowMenu(true);
    } catch {
      showToastMessage('Failed to load PDF settings.', 'error');
    } finally {
      setLoadingSettings(false);
    }
  }, [offerId, showMenu]);

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
        setMenuStep('columns');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const toggleColumn = (column: PdfProductColumn) => {
    setSelectedColumns((prev) => {
      if (prev.includes(column)) {
        if (prev.length === 1) return prev;
        return prev.filter((entry) => entry !== column);
      }
      // Insert at the position that preserves the master column order
      const masterIndex = PDF_PRODUCT_COLUMNS.indexOf(column);
      const next = [...prev];
      let insertAt = next.length;
      for (let i = 0; i < next.length; i++) {
        if (PDF_PRODUCT_COLUMNS.indexOf(next[i]!) > masterIndex) {
          insertAt = i;
          break;
        }
      }
      next.splice(insertAt, 0, column);
      return next;
    });
  };

  const reorderColumn = useCallback((from: PdfProductColumn, to: PdfProductColumn, dropPosition: DropPosition) => {
    setSelectedColumns((prev) => {
      const sourceIndex = prev.indexOf(from);
      const targetIndex = prev.indexOf(to);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      if (!moved) return prev;
      const normalizedTargetIndex = next.indexOf(to);
      if (normalizedTargetIndex === -1) return prev;
      const insertAt = dropPosition === 'after' ? normalizedTargetIndex + 1 : normalizedTargetIndex;
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  const clearDragState = () => {
    draggingColumnRef.current = null;
    setDraggingColumn(null);
    setDropPreview(null);
  };

  const handleColumnDragStart = (event: DragEvent<HTMLButtonElement>, column: PdfProductColumn) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', column);
    draggingColumnRef.current = column;
    setDraggingColumn(column);
  };

  const handleColumnDragOver = (event: DragEvent<HTMLDivElement>, targetColumn: PdfProductColumn) => {
    const dragging = draggingColumnRef.current;
    if (!dragging || dragging === targetColumn) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const position: DropPosition = event.clientY < midpoint ? 'before' : 'after';

    setDropPreview((prev) => {
      if (prev?.column === targetColumn && prev.position === position) return prev;
      return { column: targetColumn, position };
    });
  };

  const handleColumnDrop = (event: DragEvent<HTMLDivElement>, targetColumn: PdfProductColumn) => {
    event.preventDefault();
    const sourceRaw = draggingColumnRef.current ?? event.dataTransfer.getData('text/plain');
    if (!sourceRaw) {
      clearDragState();
      return;
    }
    const sourceColumn = sourceRaw as PdfProductColumn;
    const rect = event.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const fallbackPosition: DropPosition = event.clientY < midpoint ? 'before' : 'after';
    const position = dropPreview?.column === targetColumn ? dropPreview.position : fallbackPosition;

    reorderColumn(sourceColumn, targetColumn, position);
    clearDragState();
  };

  const handleExport = useCallback(
    async (orientation: Orientation) => {
      setShowMenu(false);
      setMenuStep('columns');
      setIsExporting(true);
      try {
        const columnsParam = encodeURIComponent(selectedColumns.join(','));
        const printParams = `&printProducts=${printProducts ? '1' : '0'}&printCategories=${printCategories ? '1' : '0'}&printSubCategories=${printSubCategories ? '1' : '0'}&printSubSubCategories=${printSubSubCategories ? '1' : '0'}&smallOffer=${smallOffer ? '1' : '0'}&equipmentList=${equipmentList ? '1' : '0'}`;
        const res = await fetch(
          `/api/offers/${encodeURIComponent(offerId)}/pdf?lang=${selectedLang}&orientation=${orientation}&columns=${columnsParam}${printParams}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const disposition = res.headers.get('Content-Disposition');
        const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
        setPreviewFilename(filenameMatch?.[1] ?? `Offer_${offerId}.pdf`);
        setPreviewUrl(url);
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
    [offerId, selectedColumns, selectedLang, printProducts, printCategories, printSubCategories, printSubSubCategories, smallOffer, equipmentList],
  );

  const handlePreviewClose = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewFilename('');
  }, [previewUrl]);

  const handlePreviewDownload = useCallback(() => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = previewFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewFilename('');
    showToastMessage('PDF printed successfully', 'success');
  }, [previewUrl, previewFilename]);

  const handleHover = (e: React.MouseEvent, enter: boolean) => {
    (e.target as HTMLElement).style.backgroundColor = enter ? '#f1f5f9' : 'transparent';
  };

  const isDefaultSelection =
    selectedColumns.length === DEFAULT_PDF_PRODUCT_COLUMNS.length &&
    selectedColumns.every((column, index) => column === DEFAULT_PDF_PRODUCT_COLUMNS[index]);

  const orderedColumns = [
    ...selectedColumns,
    ...PDF_PRODUCT_COLUMNS.filter((col) => !selectedColumns.includes(col)),
  ];

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        disabled={isExporting || loadingSettings}
        onClick={openMenuWithValidation}
      >
        {isExporting ? 'Printing...' : loadingSettings ? 'Loading...' : 'Print Offer in PDF'}
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
            minWidth: 260,
            overflow: 'hidden',
          }}
        >
          {menuStep === 'columns' && (
            <>
              <div style={menuHeaderStyle}>Columns</div>
              <div style={{ padding: '4px 16px 8px', borderBottom: '1px solid #e5e7eb' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={equipmentList}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setEquipmentList(checked);
                      if (checked) {
                        setSelectedColumns(prev => prev.filter(c => !PRICE_COLUMN_SET.has(c)));
                      }
                    }}
                  />
                  <span>Equipment List <span style={{ fontSize: 11, color: '#64748b' }}>(no prices/totals)</span></span>
                </label>
              </div>
              <div
                style={{
                  padding: '0 16px 6px',
                  fontSize: 11,
                  color: '#64748b',
                  marginTop: 6,
                }}
              >
                Drag selected columns to change print order.
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto', padding: '2px 0 6px' }}>
                {orderedColumns.map((column) => {
                  const isSelected = selectedColumns.includes(column);
                  const isPriceCol = PRICE_COLUMN_SET.has(column);
                  const isDisabled = equipmentList && isPriceCol;
                  const orderIndex = isSelected ? selectedColumns.indexOf(column) : -1;
                  const isDropBefore =
                    isSelected &&
                    draggingColumn !== null &&
                    draggingColumn !== column &&
                    dropPreview?.column === column &&
                    dropPreview.position === 'before';
                  const isDropAfter =
                    isSelected &&
                    draggingColumn !== null &&
                    draggingColumn !== column &&
                    dropPreview?.column === column &&
                    dropPreview.position === 'after';
                  return (
                    <div
                      key={column}
                      onDragOver={isSelected ? (event) => handleColumnDragOver(event, column) : undefined}
                      onDrop={isSelected ? (event) => handleColumnDrop(event, column) : undefined}
                      onDragEnd={isSelected ? clearDragState : undefined}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 16px',
                        fontSize: 13,
                        color: '#0f172a',
                        boxShadow: isDropBefore
                          ? 'inset 0 2px 0 #2563eb'
                          : isDropAfter
                            ? 'inset 0 -2px 0 #2563eb'
                            : undefined,
                      }}
                    >
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled ? 0.4 : 1 }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isDisabled}
                          onChange={() => toggleColumn(column)}
                        />
                        <span>{columnLabels[column]}</span>
                      </label>
                      {isSelected && (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <span
                            style={{
                              minWidth: 22,
                              height: 22,
                              borderRadius: 999,
                              background: '#e2e8f0',
                              color: '#0f172a',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {orderIndex + 1}
                          </span>
                          <button
                            type="button"
                            draggable
                            aria-label={`Drag ${columnLabels[column]} to reorder`}
                            onDragStart={(event) => handleColumnDragStart(event, column)}
                            onDragEnd={clearDragState}
                            style={{
                              border: '1px solid #cbd5e1',
                              background: '#fff',
                              color: '#334155',
                              borderRadius: 4,
                              width: 22,
                              height: 22,
                              lineHeight: '20px',
                              padding: 0,
                              cursor: 'grab',
                              fontSize: 13,
                            }}
                            title="Drag to reorder"
                          >
                            ::
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: '1px solid #e5e7eb', padding: '8px 12px', background: '#f8fafc' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                  Selected Order
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {selectedColumns.map((column, index) => (
                    <span
                      key={`selected-${column}`}
                      style={{
                        border: '1px solid #cbd5e1',
                        background: '#ffffff',
                        color: '#0f172a',
                        borderRadius: 999,
                        fontSize: 11,
                        padding: '3px 8px',
                      }}
                    >
                      {index + 1}. {columnLabels[column]}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ borderTop: '1px solid #e5e7eb', padding: 8 }}>
                <button
                  type="button"
                  style={{
                    width: '100%',
                    border: '1px solid #292929',
                    background: '#474747',
                    color: '#fff',
                    fontSize: 13,
                    borderRadius: 6,
                    padding: '8px 10px',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    const hasTotalColumns = !equipmentList && selectedColumns.some((c) => PRICE_COLUMN_SET.has(c));
                    if (hasTotalColumns && noOfLevels > 0) {
                      setMenuStep('totals');
                    } else {
                      setMenuStep('orientation');
                    }
                  }}
                >
                  {`Continue (${selectedColumns.length} selected)`}
                </button>
                <button
                  type="button"
                  style={{
                    width: '100%',
                    border: '1px solid #e5e7eb',
                    background: '#ffffff',
                    color: '#334155',
                    fontSize: 12,
                    borderRadius: 6,
                    padding: '7px 10px',
                    cursor: isDefaultSelection ? 'default' : 'pointer',
                    marginTop: 8,
                    opacity: isDefaultSelection ? 0.6 : 1,
                  }}
                  disabled={isDefaultSelection}
                  onClick={() => setSelectedColumns([...DEFAULT_PDF_PRODUCT_COLUMNS])}
                >
                  Reset to defaults
                </button>
              </div>
            </>
          )}

          {menuStep === 'totals' && (
            <>
              <div style={menuHeaderStyle}>
                <button
                  type="button"
                  onClick={() => setMenuStep('columns')}
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
                  &larr; Prices
                </button>
              </div>
              <div style={{ padding: '4px 16px 2px', fontSize: 11, color: '#64748b' }}>
                Show prices for:
              </div>
              <div style={{ padding: '6px 16px 10px' }}>
                {noOfLevels >= 2 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={printCategories} onChange={(e) => setPrintCategories(e.target.checked)} />
                    <span>Categories</span>
                  </label>
                )}
                {noOfLevels >= 3 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={printSubCategories} onChange={(e) => setPrintSubCategories(e.target.checked)} />
                    <span>Sub-Categories</span>
                  </label>
                )}
                {noOfLevels >= 4 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={printSubSubCategories} onChange={(e) => setPrintSubSubCategories(e.target.checked)} />
                    <span>Sub-Sub-Categories</span>
                  </label>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={printProducts} onChange={(e) => setPrintProducts(e.target.checked)} />
                  <span>Products</span>
                </label>
              </div>
              <div style={{ borderTop: '1px solid #e5e7eb', padding: 8 }}>
                <button
                  type="button"
                  style={{
                    width: '100%',
                    border: '1px solid #292929',
                    background: '#474747',
                    color: '#fff',
                    fontSize: 13,
                    borderRadius: 6,
                    padding: '8px 10px',
                    cursor: 'pointer',
                  }}
                  onClick={() => setMenuStep('orientation')}
                >
                  Continue
                </button>
              </div>
            </>
          )}

          {menuStep === 'orientation' && (
            <>
              <div style={menuHeaderStyle}>
                <button
                  type="button"
                  onClick={() => {
                    const hasTotalColumns = !equipmentList && selectedColumns.some((c) => PRICE_COLUMN_SET.has(c));
                    setMenuStep(hasTotalColumns && noOfLevels > 0 ? 'totals' : 'columns');
                  }}
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
                  &larr; Orientation
                </button>
              </div>
              <div style={{ padding: '6px 16px 10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={smallOffer} onChange={(e) => setSmallOffer(e.target.checked)} />
                  <span>Small Offer <span style={{ fontSize: 11, color: '#64748b' }}>(no cover page)</span></span>
                </label>
              </div>
              <div style={{ borderTop: '1px solid #e5e7eb' }} />
              <button
                type="button"
                onClick={() => handleExport('portrait')}
                style={menuItemStyle}
                onMouseEnter={(e) => handleHover(e, true)}
                onMouseLeave={(e) => handleHover(e, false)}
              >
                Portrait
              </button>
              <button
                type="button"
                onClick={() => handleExport('landscape')}
                style={menuItemStyle}
                onMouseEnter={(e) => handleHover(e, true)}
                onMouseLeave={(e) => handleHover(e, false)}
              >
                Landscape
              </button>
            </>
          )}
        </div>
      )}
      <LookupModal
        open={!!previewUrl}
        title="PDF Preview"
        confirmLabel="Download"
        cancelLabel="Close"
        onConfirm={handlePreviewDownload}
        onClose={handlePreviewClose}
        overlayStyle={{ padding: 0 }}
        cardStyle={{ width: '100vw', maxWidth: '100vw', height: '100vh', maxHeight: '100vh', borderRadius: 0 }}
      >
        {previewUrl && (
          <iframe
            src={previewUrl}
            style={{ width: '100%', height: 'calc(100vh - 120px)', border: 'none' }}
            title="PDF Preview"
          />
        )}
      </LookupModal>
    </div>
  );
}
