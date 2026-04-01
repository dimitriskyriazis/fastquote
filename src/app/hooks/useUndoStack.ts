'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { showToastMessage } from '../../lib/toast';

export type UndoEntry = {
  label: string;
  undo: () => Promise<void>;
  timestamp: number;
};

export function useUndoStack(maxSize = 20) {
  const [stack, setStack] = useState<UndoEntry[]>([]);
  const stackRef = useRef(stack);
  const undoingRef = useRef(false);

  const pushUndo = useCallback(
    (entry: Omit<UndoEntry, 'timestamp'>) => {
      const next = [
        ...stackRef.current.slice(-(maxSize - 1)),
        { ...entry, timestamp: Date.now() },
      ];
      stackRef.current = next;
      setStack(next);
    },
    [maxSize],
  );

  const performUndo = useCallback(async () => {
    if (undoingRef.current) return;
    const current = stackRef.current;
    const last = current.at(-1);
    if (!last) return;
    undoingRef.current = true;
    const next = current.slice(0, -1);
    stackRef.current = next;
    setStack(next);
    try {
      await last.undo();
      showToastMessage(`${last.label} — reverted`, 'info');
    } catch {
      showToastMessage(`Unable to revert: ${last.label}`, 'error');
    } finally {
      undoingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (stackRef.current.length > 0) {
          e.preventDefault();
          performUndo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [performUndo]);

  return {
    pushUndo,
    performUndo,
    canUndo: stack.length > 0,
    lastLabel: stack.at(-1)?.label,
  };
}
