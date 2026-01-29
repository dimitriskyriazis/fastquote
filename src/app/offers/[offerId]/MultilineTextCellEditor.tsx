'use client';

import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import type { ICellEditorParams } from 'ag-grid-community';

export interface MultilineTextCellEditorRef {
  getValue: () => string;
}

const MultilineTextCellEditor = forwardRef<MultilineTextCellEditorRef, ICellEditorParams>(
  (props, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [value, setValue] = useState<string>(() => {
      const v = props.value;
      if (v == null) return '';
      return typeof v === 'string' ? v : String(v);
    });

    useImperativeHandle(ref, () => ({
      getValue() {
        return textareaRef.current?.value ?? value;
      },
    }), [value]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter') {
          if (e.altKey) {
            // Alt+Enter: insert line break, keep editing (grid must not handle this key)
            e.preventDefault();
            e.stopPropagation();
            const ta = textareaRef.current;
            if (ta) {
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const before = ta.value.slice(0, start);
              const after = ta.value.slice(end);
              const next = `${before}\n${after}`;
              ta.value = next;
              setValue(next);
              const newPos = start + 1;
              ta.setSelectionRange(newPos, newPos);
            }
          } else {
            // Enter alone: stop editing and commit
            e.preventDefault();
            props.stopEditing?.();
          }
        }
      },
      [props],
    );

    return (
      <textarea
        ref={textareaRef}
        className="ag-input-field-input ag-text-area-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        style={{
          width: '100%',
          minHeight: '60px',
          resize: 'vertical',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        aria-label="Edit cell (Alt+Enter for new line)"
      />
    );
  },
);

MultilineTextCellEditor.displayName = 'MultilineTextCellEditor';

export default MultilineTextCellEditor;
